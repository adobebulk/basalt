/**
 * /api/[[route]] — admin API router.
 *
 * All routes are access-gated by Cloudflare Access (configured in Phase 0).
 * Reference: CLAUDE.md "Admin API" table + admin/server.js (old Express implementation).
 *
 * Upload pipeline per photo:
 *   1. Resize via IMAGES binding → 600/1200/2400 px × AVIF + JPEG (strips all metadata)
 *   2. PUT variants → ASSETS_BUCKET at <slug>/<id>/{600,1200,2400}.{avif,jpg}
 *   3. PUT original → ORIGINALS_BUCKET at <slug>/<id>/original.jpg
 *   4. Append photo entry to _index.md manifest + create <id>.md stub
 *   5. Commit both files to GitHub (single commit via Trees API)
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
  { format: "image/avif", ext: "avif" },
  { format: "image/jpeg", ext: "jpg" },
];

/**
 * Generate all 6 variants (3 sizes × 2 formats) for a single photo.
 * Returns an array of { key, buffer, contentType } ready to PUT to R2.
 * Cloudflare Images strips all metadata by default (no GPS leaks).
 */
async function generateVariants(images, slug, id, originalBuffer) {
  const variants = [];

  for (const size of SIZES) {
    for (const { format, ext } of FORMATS) {
      // Each transform needs a fresh ReadableStream from the original buffer.
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(originalBuffer));
          controller.close();
        },
      });

      const result = await images
        .input(stream)
        .transform({ width: size, fit: "scale-down" })
        .output({ format });

      const response = result.response();
      const buffer = await response.arrayBuffer();

      variants.push({
        key: `${slug}/${id}/${size}.${ext}`,
        buffer,
        contentType: format,
      });
    }
  }

  return variants;
}

/**
 * Get pixel dimensions of an image via the IMAGES binding .info() call.
 */
async function getImageDimensions(images, buffer) {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(buffer));
      controller.close();
    },
  });
  const info = await images.input(stream).info();
  return { width: info.width, height: info.height };
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
      if (!env.images) return err("IMAGES binding not configured", 503);

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

        // Get dimensions
        const { width, height } = await getImageDimensions(env.images, originalBuffer);

        // Generate 6 variants
        const variants = await generateVariants(env.images, slug, id, originalBuffer);

        // PUT variants to ASSETS_BUCKET
        for (const v of variants) {
          await env.assetsBucket.put(v.key, v.buffer, {
            httpMetadata: { contentType: v.contentType },
          });
        }

        // PUT original to ORIGINALS_BUCKET (private)
        await env.originalsBucket.put(`${key}/original.jpg`, originalBuffer, {
          httpMetadata: { contentType: "image/jpeg" },
        });

        const photo = { id, key, width, height, caption: "", downloadable: false };
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

      return json({ added: addedPhotos }, 201);
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
