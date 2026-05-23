/**
 * /api/[[route]] — admin API router.
 *
 * All routes are access-gated by Cloudflare Access (configured in Phase 0).
 * Reference: CLAUDE.md "Admin API" table + admin/server.js (old Express implementation).
 *
 * Upload pipeline per photo:
 *   1. PUT original → ASSETS_BUCKET at <slug>/<id>/original.jpg (temporarily public for fetch)
 *   2. For each of 6 variants (600/1200/2400 × avif/jpg): fetch the original URL with
 *      cf.image options (Transform via Workers) → PUT response body to ASSETS_BUCKET
 *   3. If not downloadable: move original to ORIGINALS_BUCKET, delete from ASSETS_BUCKET
 *   4. Append photo entry to _index.md manifest + create <id>.md stub
 *   5. Commit both files to GitHub (single commit via Trees API)
 *
 * Image transforms use "Transform via Workers" (fetch with cf.image), not the Images
 * binding — the binding is not supported for Pages Functions.
 * Docs: https://developers.cloudflare.com/images/transform-images/transform-via-workers/
 */

import { getEnv } from "../_lib/env.js";
import { getFile, listDir, commitFiles } from "../_lib/github.js";
import {
  parseFrontMatter,
  serializeFrontMatter,
  newSeriesDoc,
  newPhotoStub,
  slugify,
  nextPhotoId,
} from "../_lib/manifest.js";

// ─── Response helpers ────────────────────────────────────────────────────────

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const err = (msg, status = 400) => json({ error: msg }, status);

// ─── Image processing ────────────────────────────────────────────────────────

const SIZES = [600, 1200, 2400];
const FORMATS = [
  { format: "avif", ext: "avif", contentType: "image/avif" },
  { format: "jpeg", ext: "jpg",  contentType: "image/jpeg" },
];

const BASE_URL = "https://photos.ctsmith.org";

/**
 * Generate all 6 variants for one photo via "Transform via Workers".
 * The original must already be in ASSETS_BUCKET before calling this.
 * Strips all metadata (metadata: "none") — no GPS or EXIF in published files.
 * Returns array of { key, buffer, contentType } ready to PUT to R2.
 *
 * Same-zone subrequests with cf.image can silently hang, so each fetch is
 * wrapped with a 25-second AbortController timeout.
 */
async function generateVariants(slug, id) {
  const originalUrl = `${BASE_URL}/assets/${slug}/${id}/original.jpg`;
  console.log(`[generateVariants] starting transforms for ${slug}/${id} from ${originalUrl}`);

  const jobs = SIZES.flatMap((size) =>
    FORMATS.map(({ format, ext, contentType }) => ({ size, format, ext, contentType }))
  );

  const variants = await Promise.all(
    jobs.map(async ({ size, format, ext, contentType }) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 25_000);

      let res;
      try {
        res = await fetch(originalUrl, {
          signal: controller.signal,
          cf: {
            image: {
              width: size,
              fit: "scale-down",
              format,
              metadata: "none",
            },
          },
        });
      } finally {
        clearTimeout(timer);
      }

      if (!res.ok) {
        console.error(`[generateVariants] transform HTTP ${res.status} for ${size}.${ext} (${slug}/${id})`);
        throw new Error(`Image transform failed for ${size}.${ext}: HTTP ${res.status}`);
      }

      console.log(`[generateVariants] OK ${size}.${ext} (${slug}/${id})`);
      return {
        key: `${slug}/${id}/${size}.${ext}`,
        buffer: await res.arrayBuffer(),
        contentType,
      };
    })
  );

  return variants;
}

// ─── CDN cache purge ─────────────────────────────────────────────────────────

/**
 * Purge a URL from Cloudflare's CDN cache.
 * Uses the Cache Purge API if CF_ZONE_ID + CF_API_TOKEN are configured (global purge).
 * Falls back to caches.default.delete() for local-datacenter purge only.
 */
async function purgeCache(env, url) {
  if (env.cfZoneId && env.cfApiToken) {
    await fetch(
      `https://api.cloudflare.com/client/v4/zones/${env.cfZoneId}/purge_cache`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.cfApiToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ files: [url] }),
      }
    );
  } else {
    // Best-effort: only purges in this PoP
    await caches.default.delete(new Request(url));
  }
}

// ─── GitHub path helpers ─────────────────────────────────────────────────────

const indexPath = (slug) => `site/content/projects/${slug}/_index.md`;
const stubPath = (slug, id) => `site/content/projects/${slug}/${id}.md`;

async function readManifest(token, repo, slug) {
  const file = await getFile(token, repo, indexPath(slug));
  if (!file) return null;
  return { ...parseFrontMatter(file.content), raw: file.content };
}

// ─── Router ──────────────────────────────────────────────────────────────────

export async function onRequest(ctx) {
  const { request, params } = ctx;
  const env = getEnv(ctx);

  const method = request.method.toUpperCase();
  const segments = Array.isArray(params.route)
    ? params.route
    : params.route
    ? [params.route]
    : [];

  try {
    // ── GET /api/projects ────────────────────────────────────────────────────
    if (method === "GET" && segments.length === 1 && segments[0] === "projects") {
      const entries = await listDir(env.githubToken, env.githubRepo, "site/content/projects");
      if (!entries) return json([]);

      const dirs = entries.filter((e) => e.type === "dir");
      const projects = await Promise.all(
        dirs.map(async (d) => {
          const file = await getFile(env.githubToken, env.githubRepo, `${d.path}/_index.md`);
          if (!file) return null;
          const { data } = parseFrontMatter(file.content);
          return {
            slug: d.name,
            title: data.title ?? d.name,
            description: data.description ?? "",
            date: data.date ?? "",
            draft: data.draft ?? true,
            cover: data.cover ?? "",
            photoCount: (data.photos ?? []).length,
          };
        })
      );

      return json(projects.filter(Boolean));
    }

    // ── POST /api/projects ───────────────────────────────────────────────────
    if (method === "POST" && segments.length === 1 && segments[0] === "projects") {
      const { title, description } = await request.json();
      if (!title) return err("title required");

      const slug = slugify(title);
      const existing = await getFile(env.githubToken, env.githubRepo, indexPath(slug));
      if (existing) return err("series already exists", 409);

      const content = newSeriesDoc({ title, description, slug });
      await commitFiles({
        token: env.githubToken,
        repo: env.githubRepo,
        message: `content: create series ${slug}`,
        files: [{ path: indexPath(slug), content }],
      });

      return json({ slug, title, draft: true }, 201);
    }

    // ── GET /api/projects/:slug/photos ───────────────────────────────────────
    if (
      method === "GET" &&
      segments.length === 3 &&
      segments[0] === "projects" &&
      segments[2] === "photos"
    ) {
      const slug = segments[1];
      const manifest = await readManifest(env.githubToken, env.githubRepo, slug);
      if (!manifest) return err("series not found", 404);
      return json(manifest.data.photos ?? []);
    }

    // ── POST /api/projects/:slug/photos ──────────────────────────────────────
    if (
      method === "POST" &&
      segments.length === 3 &&
      segments[0] === "projects" &&
      segments[2] === "photos"
    ) {
      const slug = segments[1];
      if (!env.assetsBucket) return err("ASSETS_BUCKET not configured", 503);
      if (!env.originalsBucket) return err("ORIGINALS_BUCKET not configured", 503);

      const manifest = await readManifest(env.githubToken, env.githubRepo, slug);
      if (!manifest) return err("series not found", 404);

      const formData = await request.formData();
      const files = formData.getAll("photos");
      if (!files.length) return err("no photos in request");

      const addedPhotos = [];
      const gitFiles = [];
      let photos = [...(manifest.data.photos ?? [])];

      for (const file of files) {
        const originalBuffer = await file.arrayBuffer();
        const id = nextPhotoId(photos);
        const key = `${slug}/${id}`;
        const originalKey = `${key}/original.jpg`;

        // 1. PUT original to ASSETS_BUCKET so the transform fetch URL resolves.
        await env.assetsBucket.put(originalKey, originalBuffer, {
          httpMetadata: { contentType: "image/jpeg" },
        });
        console.log(`[upload] original PUT to ASSETS_BUCKET OK: ${originalKey}`);

        // 2. Generate 6 variants via Transform via Workers (fetch with cf.image).
        //    width/height default to 0 — templates degrade gracefully without them.
        const variants = await generateVariants(slug, id);

        // 3. PUT variants to ASSETS_BUCKET.
        for (const v of variants) {
          await env.assetsBucket.put(v.key, v.buffer, {
            httpMetadata: { contentType: v.contentType },
          });
        }

        // 4. If not downloadable: move original to private bucket, remove from public.
        //    If downloadable: original stays in ASSETS_BUCKET (already public).
        await env.originalsBucket.put(originalKey, originalBuffer, {
          httpMetadata: { contentType: "image/jpeg" },
        });
        // Default is not downloadable — delete the temporarily-public original.
        await env.assetsBucket.delete(originalKey);

        const photo = { id, key, width: 0, height: 0, caption: "", downloadable: false };
        photos.push(photo);
        addedPhotos.push(photo);

        // Per-photo stub file
        gitFiles.push({ path: stubPath(slug, id), content: newPhotoStub(id) });
      }

      // Update manifest: set cover if first photo
      const updatedData = { ...manifest.data, photos };
      if (!updatedData.cover && photos.length > 0) {
        updatedData.cover = photos[0].id;
      }
      const updatedManifest = serializeFrontMatter(updatedData, manifest.body ?? "");
      gitFiles.push({ path: indexPath(slug), content: updatedManifest });

      await commitFiles({
        token: env.githubToken,
        repo: env.githubRepo,
        message: `content: add ${addedPhotos.length} photo(s) to ${slug}`,
        files: gitFiles,
      });

      return json({ uploaded: addedPhotos }, 201);
    }

    // ── PATCH /api/projects/:slug/photos/:id ─────────────────────────────────
    if (
      method === "PATCH" &&
      segments.length === 4 &&
      segments[0] === "projects" &&
      segments[2] === "photos"
    ) {
      const [, slug, , id] = segments;
      const body = await request.json();

      const manifest = await readManifest(env.githubToken, env.githubRepo, slug);
      if (!manifest) return err("series not found", 404);

      let photos = [...(manifest.data.photos ?? [])];
      const idx = photos.findIndex((p) => p.id === id);
      if (idx === -1) return err("photo not found", 404);

      const prev = photos[idx];
      const updated = { ...prev };

      if (body.caption !== undefined) updated.caption = body.caption;

      // Handle downloadable toggle: copy-to-public or delete-from-public
      if (body.downloadable !== undefined && body.downloadable !== prev.downloadable) {
        const originalKey = `${slug}/${id}/original.jpg`;
        if (body.downloadable) {
          // Copy original from private → public bucket
          const obj = await env.originalsBucket.get(originalKey);
          if (obj) {
            await env.assetsBucket.put(originalKey, obj.body, {
              httpMetadata: { contentType: "image/jpeg" },
            });
          }
        } else {
          // Delete from public bucket and purge CDN cache
          await env.assetsBucket.delete(originalKey);
          const publicUrl = `https://photos.ctsmith.org/assets/${originalKey}`;
          await purgeCache(env, publicUrl);
        }
        updated.downloadable = body.downloadable;
      }

      // Handle reorder: move this photo to the given 0-based index
      if (body.order !== undefined) {
        photos.splice(idx, 1);
        photos.splice(Math.max(0, Math.min(body.order, photos.length)), 0, updated);
      } else {
        photos[idx] = updated;
      }

      const updatedData = { ...manifest.data, photos };
      const updatedManifest = serializeFrontMatter(updatedData, manifest.body ?? "");

      await commitFiles({
        token: env.githubToken,
        repo: env.githubRepo,
        message: `content: update photo ${slug}/${id}`,
        files: [{ path: indexPath(slug), content: updatedManifest }],
      });

      return json(updated);
    }

    // ── DELETE /api/projects/:slug/photos/:id ────────────────────────────────
    if (
      method === "DELETE" &&
      segments.length === 4 &&
      segments[0] === "projects" &&
      segments[2] === "photos"
    ) {
      const [, slug, , id] = segments;

      const manifest = await readManifest(env.githubToken, env.githubRepo, slug);
      if (!manifest) return err("series not found", 404);

      const photos = manifest.data.photos ?? [];
      const photo = photos.find((p) => p.id === id);
      if (!photo) return err("photo not found", 404);

      // Delete all R2 objects: variants in ASSETS_BUCKET + original in both buckets
      const variantKeys = SIZES.flatMap((s) =>
        FORMATS.map(({ ext }) => `${slug}/${id}/${s}.${ext}`)
      );
      const originalKey = `${slug}/${id}/original.jpg`;

      await env.assetsBucket.delete([...variantKeys, originalKey]);
      await env.originalsBucket.delete(originalKey);

      // Remove from manifest
      const updatedData = {
        ...manifest.data,
        photos: photos.filter((p) => p.id !== id),
      };
      // Clear cover if it was this photo
      if (updatedData.cover === id) {
        updatedData.cover = updatedData.photos[0]?.id ?? "";
      }
      const updatedManifest = serializeFrontMatter(updatedData, manifest.body ?? "");

      await commitFiles({
        token: env.githubToken,
        repo: env.githubRepo,
        message: `content: delete photo ${slug}/${id}`,
        files: [{ path: indexPath(slug), content: updatedManifest }],
        deletions: [stubPath(slug, id)],
      });

      return json({ deleted: id });
    }

    // ── DELETE /api/projects/:slug ───────────────────────────────────────────
    if (
      method === "DELETE" &&
      segments.length === 2 &&
      segments[0] === "projects"
    ) {
      const slug = segments[1];

      const manifest = await readManifest(env.githubToken, env.githubRepo, slug);
      if (!manifest) return err("series not found", 404);

      const photos = manifest.data.photos ?? [];

      // Delete all R2 objects for every photo (variants in ASSETS_BUCKET + originals in both).
      for (const photo of photos) {
        const variantKeys = SIZES.flatMap((s) =>
          FORMATS.map(({ ext }) => `${slug}/${photo.id}/${s}.${ext}`)
        );
        const origKey = `${slug}/${photo.id}/original.jpg`;
        await env.assetsBucket.delete([...variantKeys, origKey]);
        await env.originalsBucket.delete(origKey);
      }

      // Build GitHub deletions: _index.md + all per-photo stubs.
      const deletions = [
        indexPath(slug),
        ...photos.map((photo) => stubPath(slug, photo.id)),
      ];

      await commitFiles({
        token: env.githubToken,
        repo: env.githubRepo,
        message: `content: delete series ${slug}`,
        deletions,
      });

      return json({ deleted: slug });
    }

    // ── PATCH /api/projects/:slug ────────────────────────────────────────────
    if (
      method === "PATCH" &&
      segments.length === 2 &&
      segments[0] === "projects"
    ) {
      const slug = segments[1];
      const body = await request.json();

      const manifest = await readManifest(env.githubToken, env.githubRepo, slug);
      if (!manifest) return err("series not found", 404);

      const updatableFields = ["title", "description", "cover", "draft", "downloadsDefault"];
      const updatedData = { ...manifest.data };
      for (const f of updatableFields) {
        if (body[f] !== undefined) updatedData[f] = body[f];
      }

      const updatedManifest = serializeFrontMatter(updatedData, manifest.body ?? "");
      await commitFiles({
        token: env.githubToken,
        repo: env.githubRepo,
        message: `content: update series metadata for ${slug}`,
        files: [{ path: indexPath(slug), content: updatedManifest }],
      });

      return json(updatedData);
    }

    // ── POST /api/projects/:slug/publish ─────────────────────────────────────
    if (
      method === "POST" &&
      segments.length === 3 &&
      segments[0] === "projects" &&
      segments[2] === "publish"
    ) {
      const slug = segments[1];
      const { draft } = await request.json();

      const manifest = await readManifest(env.githubToken, env.githubRepo, slug);
      if (!manifest) return err("series not found", 404);

      const updatedData = { ...manifest.data, draft: Boolean(draft) };
      const updatedManifest = serializeFrontMatter(updatedData, manifest.body ?? "");

      await commitFiles({
        token: env.githubToken,
        repo: env.githubRepo,
        message: `content: ${draft ? "unpublish" : "publish"} series ${slug}`,
        files: [{ path: indexPath(slug), content: updatedManifest }],
      });

      // Ping the deploy hook to trigger a Pages rebuild
      if (env.deployHookUrl) {
        await fetch(env.deployHookUrl, { method: "POST" });
      }

      return json({ slug, draft: Boolean(draft) });
    }

    // ── POST /api/rebuild ────────────────────────────────────────────────────
    if (method === "POST" && segments.length === 1 && segments[0] === "rebuild") {
      if (!env.deployHookUrl) return err("DEPLOY_HOOK_URL not configured", 503);

      const res = await fetch(env.deployHookUrl, { method: "POST" });
      if (!res.ok) {
        const body = await res.text();
        return err(`Deploy hook returned ${res.status}: ${body}`, 502);
      }

      return json({ ok: true, message: "Cloudflare Pages build triggered." });
    }

    // ── POST /api/deploy ─────────────────────────────────────────────────────
    if (method === "POST" && segments.length === 1 && segments[0] === "deploy") {
      if (!env.deployHookUrl) return err("DEPLOY_HOOK_URL not configured", 503);

      const res = await fetch(env.deployHookUrl, { method: "POST" });
      if (!res.ok) {
        const body = await res.text();
        return err(`Deploy hook returned ${res.status}: ${body}`, 502);
      }

      return json({ ok: true, message: "Cloudflare Pages build triggered." });
    }

    // ── 404 ──────────────────────────────────────────────────────────────────
    return json({ error: "not found" }, 404);
  } catch (e) {
    console.error(e);
    return json({ error: e.message }, 500);
  }
}
