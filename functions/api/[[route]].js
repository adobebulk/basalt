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

import yaml from "js-yaml";
import { getEnv } from "../_lib/env.js";
import { getFile, listDir, commitFiles } from "../_lib/github.js";
import {
  stageFile, stageDelete, readStaged,
  getStagedSlugs, isStagedDeleted, flushStaging,
  getStagedPostSlugs, isStagedPostDeleted,
} from "../_lib/staging.js";
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

// ─── Image dimensions (pure JS, no DOM — safe in Workers) ────────────────────

function getImageDimensions(buffer) {
  const u8 = new Uint8Array(buffer);
  const dv = new DataView(buffer);

  // JPEG
  if (u8[0] === 0xFF && u8[1] === 0xD8) {
    let i = 2;
    while (i < dv.byteLength - 4) {
      if (u8[i] !== 0xFF) break;
      const marker = dv.getUint16(i); i += 2;
      if (marker === 0xFFDA) break;
      const segLen = dv.getUint16(i);
      const isSOF = (marker >= 0xFFC0 && marker <= 0xFFCF)
                 && marker !== 0xFFC4 && marker !== 0xFFCC;
      if (isSOF) return { height: dv.getUint16(i + 3), width: dv.getUint16(i + 5) };
      i += segLen;
    }
    return null;
  }

  // PNG
  if (u8[0]===0x89 && u8[1]===0x50 && u8[2]===0x4E && u8[3]===0x47)
    return { width: dv.getInt32(16), height: dv.getInt32(20) };

  // WEBP
  if (u8[0]===0x52 && u8[1]===0x49 && u8[2]===0x46 && u8[3]===0x46 &&
      u8[8]===0x57 && u8[9]===0x45 && u8[10]===0x42 && u8[11]===0x50) {
    const fourCC = String.fromCharCode(u8[12],u8[13],u8[14],u8[15]);
    if (fourCC === 'VP8 ')
      return { width: dv.getUint16(26,true)&0x3FFF, height: dv.getUint16(28,true)&0x3FFF };
    if (fourCC === 'VP8L') {
      const bits = dv.getUint32(21,true);
      return { width:(bits&0x3FFF)+1, height:((bits>>14)&0x3FFF)+1 };
    }
    if (fourCC === 'VP8X')
      return { width: (u8[24]|(u8[25]<<8)|(u8[26]<<16))+1,
               height:(u8[27]|(u8[28]<<8)|(u8[29]<<16))+1 };
  }
  return null;
}

// ─── Image processing ────────────────────────────────────────────────────────

const SIZES = [600, 1200, 2400];
const FORMATS = [
  { format: "avif", ext: "avif", contentType: "image/avif" },
  { format: "jpeg", ext: "jpg",  contentType: "image/jpeg" },
];

/**
 * Generate all 6 variants for one photo via "Transform via Workers".
 * The original must already be in ASSETS_BUCKET before calling this.
 * Strips all metadata (metadata: "none") — no GPS or EXIF in published files.
 * Returns array of { key, buffer, contentType } ready to PUT to R2.
 *
 * Uses the R2 custom domain (env.assetsR2Url) as the transform source — NOT the
 * /assets/* Pages Function URL. cf.image is not applied when the source is
 * another Worker in the same zone; a direct R2 domain bypasses that restriction.
 *
 * Each fetch is wrapped with a 25-second AbortController timeout so a stalled
 * transform throws a clear error instead of hanging indefinitely.
 */
async function generateVariants(slug, id, env) {
  const originalUrl = `${env.assetsR2Url}/${slug}/${id}/original.jpg`;
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
const postPath = (slug) => `site/content/posts/${slug}/index.md`;
const settingsPath = "site/data/settings.yaml";

const DEFAULT_SETTINGS = {
  title: "Photos",
  navLabel: "Work",
  photographer: "Your Name",
  description: "A photo gallery",
  heroPhotoKey: "",
  heroLink: "",
  featured: [],
};

async function readManifest(env, slug) {
  const result = await readStaged(
    env.stagingBucket,
    indexPath(slug),
    async (p) => getFile(env.githubToken, env.githubRepo, p)
  );
  if (!result) return null;
  return { ...parseFrontMatter(result.content), raw: result.content };
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
      const ghSlugs = entries ? entries.filter((e) => e.type === "dir").map((e) => e.name) : [];
      const stagedSlugs = await getStagedSlugs(env.stagingBucket);
      const allSlugs = [...new Set([...ghSlugs, ...stagedSlugs])];

      const projects = (await Promise.all(
        allSlugs.map(async (slug) => {
          if (await isStagedDeleted(env.stagingBucket, slug)) return null;
          const manifest = await readManifest(env, slug);
          if (!manifest) return null;
          const { data } = manifest;
          return {
            slug,
            title:       data.title       ?? slug,
            description: data.description ?? "",
            date:        data.date        ?? "",
            draft:       data.draft       ?? true,
            cover:       data.cover       ?? "",
            photoCount:  (data.photos     ?? []).length,
          };
        })
      )).filter(Boolean);

      return json(projects);
    }

    // ── POST /api/projects ───────────────────────────────────────────────────
    if (method === "POST" && segments.length === 1 && segments[0] === "projects") {
      const { title, description } = await request.json();
      if (!title) return err("title required");

      const slug = slugify(title);
      // Check staging and GitHub for existing series
      const stagedExisting = await readStaged(env.stagingBucket, indexPath(slug), null);
      if (stagedExisting) return err("series already exists", 409);
      const ghExisting = await getFile(env.githubToken, env.githubRepo, indexPath(slug));
      if (ghExisting) return err("series already exists", 409);

      const content = newSeriesDoc({ title, description, slug });
      await stageFile(env.stagingBucket, indexPath(slug), content);

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
      const manifest = await readManifest(env, slug);
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

      const manifest = await readManifest(env, slug);
      if (!manifest) return err("series not found", 404);

      const formData = await request.formData();
      const files = formData.getAll("photos");
      if (!files.length) return err("no photos in request");

      const addedPhotos = [];
      const gitFiles = [];
      let photos = [...(manifest.data.photos ?? [])];

      for (const file of files) {
        const originalBuffer = await file.arrayBuffer();
        const dims = getImageDimensions(originalBuffer) ?? { width: 0, height: 0 };
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
        const variants = await generateVariants(slug, id, env);

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

        const photo = { id, key, width: dims.width, height: dims.height, caption: "", downloadable: false };
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

      for (const { path, content } of gitFiles) {
        await stageFile(env.stagingBucket, path, content);
      }

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

      const manifest = await readManifest(env, slug);
      if (!manifest) return err("series not found", 404);

      let photos = [...(manifest.data.photos ?? [])];
      const idx = photos.findIndex((p) => p.id === id);
      if (idx === -1) return err("photo not found", 404);

      const prev = photos[idx];
      const updated = { ...prev };

      if (body.caption !== undefined) updated.caption = body.caption;
      if (body.body    !== undefined) updated.body    = body.body || undefined;

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

      await stageFile(env.stagingBucket, indexPath(slug), updatedManifest);

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

      const manifest = await readManifest(env, slug);
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

      await stageFile(env.stagingBucket, indexPath(slug), updatedManifest);
      await stageDelete(env.stagingBucket, stubPath(slug, id));

      return json({ deleted: id });
    }

    // ── DELETE /api/projects/:slug ───────────────────────────────────────────
    if (
      method === "DELETE" &&
      segments.length === 2 &&
      segments[0] === "projects"
    ) {
      const slug = segments[1];

      const manifest = await readManifest(env, slug);
      if (!manifest) return err("series not found", 404);

      const photos = manifest.data.photos ?? [];

      // Delete all R2 objects for every photo in parallel.
      const allR2Deletes = photos.flatMap((photo) => {
        const variantKeys = SIZES.flatMap((s) =>
          FORMATS.map(({ ext }) => `${slug}/${photo.id}/${s}.${ext}`)
        );
        const origKey = `${slug}/${photo.id}/original.jpg`;
        return [
          env.assetsBucket.delete([...variantKeys, origKey]),
          env.originalsBucket.delete(origKey),
        ];
      });
      await Promise.all(allR2Deletes);

      // Stage deletion of all per-photo stubs and the manifest.
      await Promise.all(photos.map((photo) =>
        stageDelete(env.stagingBucket, stubPath(slug, photo.id))
      ));
      await stageDelete(env.stagingBucket, indexPath(slug));

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

      const manifest = await readManifest(env, slug);
      if (!manifest) return err("series not found", 404);

      const updatableFields = ["title", "description", "cover", "draft", "downloadsDefault"];
      const updatedData = { ...manifest.data };
      for (const f of updatableFields) {
        if (body[f] !== undefined) updatedData[f] = body[f];
      }

      // Reorder photos by ID array
      if (Array.isArray(body.photoOrder)) {
        const photoMap = Object.fromEntries((manifest.data.photos ?? []).map(p => [p.id, p]));
        updatedData.photos = body.photoOrder.map(id => photoMap[id]).filter(Boolean);
      }

      const updatedManifest = serializeFrontMatter(updatedData, manifest.body ?? "");
      await stageFile(env.stagingBucket, indexPath(slug), updatedManifest);

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

      const manifest = await readManifest(env, slug);
      if (!manifest) return err("series not found", 404);

      const updatedData = { ...manifest.data, draft: Boolean(draft) };
      const updatedManifest = serializeFrontMatter(updatedData, manifest.body ?? "");

      await stageFile(env.stagingBucket, indexPath(slug), updatedManifest);

      return json({ slug, draft: Boolean(draft) });
    }

    // ── POST /api/rebuild ────────────────────────────────────────────────────
    if (method === "POST" && segments.length === 1 && segments[0] === "rebuild") {
      if (!env.deployHookUrl) return err("DEPLOY_HOOK_URL not configured", 503);

      const stagingResult = await flushStaging(
        env.stagingBucket, env.githubToken, env.githubRepo);

      const res = await fetch(env.deployHookUrl, { method: "POST" });
      if (!res.ok) {
        const body = await res.text();
        return err(`Deploy hook returned ${res.status}: ${body}`, 502);
      }

      return json({
        ok: true,
        message: stagingResult.noop
          ? "Build triggered (no content changes)."
          : `Committed ${stagingResult.files} file(s), triggered build.`,
      });
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

    // ── GET /api/settings ────────────────────────────────────────────────────
    if (method === "GET" && segments.length === 1 && segments[0] === "settings") {
      const result = await readStaged(
        env.stagingBucket,
        settingsPath,
        async (p) => getFile(env.githubToken, env.githubRepo, p)
      );
      const settings = result ? (yaml.load(result.content) ?? {}) : {};
      return json({ ...DEFAULT_SETTINGS, ...settings });
    }

    // ── PATCH /api/settings ──────────────────────────────────────────────────
    if (method === "PATCH" && segments.length === 1 && segments[0] === "settings") {
      const body = await request.json();
      const result = await readStaged(
        env.stagingBucket,
        settingsPath,
        async (p) => getFile(env.githubToken, env.githubRepo, p)
      );
      const current = result ? (yaml.load(result.content) ?? {}) : {};
      const allowedKeys = ["title", "navLabel", "photographer", "description", "heroPhotoKey", "heroLink", "featured"];
      const updated = { ...DEFAULT_SETTINGS, ...current };
      for (const k of allowedKeys) {
        if (body[k] !== undefined) updated[k] = body[k];
      }
      await stageFile(env.stagingBucket, settingsPath, yaml.dump(updated, { lineWidth: -1 }));
      return json(updated);
    }

    // ── GET /api/version ─────────────────────────────────────────────────────
    if (method === "GET" && segments.length === 1 && segments[0] === "version") {
      return json({ version: env.packageVersion ?? "unknown" });
    }

    // ── GET /api/posts ────────────────────────────────────────────────────────
    if (method === "GET" && segments.length === 1 && segments[0] === "posts") {
      const entries = await listDir(env.githubToken, env.githubRepo, "site/content/posts");
      const ghSlugs = entries ? entries.filter((e) => e.type === "dir").map((e) => e.name) : [];
      const stagedSlugs = await getStagedPostSlugs(env.stagingBucket);
      const allSlugs = [...new Set([...ghSlugs, ...stagedSlugs])];

      const posts = (await Promise.all(
        allSlugs.map(async (slug) => {
          if (await isStagedPostDeleted(env.stagingBucket, slug)) return null;
          const result = await readStaged(
            env.stagingBucket,
            postPath(slug),
            async (p) => getFile(env.githubToken, env.githubRepo, p)
          );
          if (!result) return null;
          const { data } = parseFrontMatter(result.content);
          return {
            slug,
            title:    data.title    ?? slug,
            date:     data.date     ?? "",
            draft:    data.draft    ?? true,
            featured: data.featured ?? false,
            excerpt:  data.excerpt  ?? "",
          };
        })
      )).filter(Boolean);

      return json(posts);
    }

    // ── POST /api/posts ───────────────────────────────────────────────────────
    if (method === "POST" && segments.length === 1 && segments[0] === "posts") {
      const { title, body: postBody = "", excerpt = "", featured = false } = await request.json();
      if (!title) return err("title required");

      const slug = slugify(title);
      const existing = await readStaged(env.stagingBucket, postPath(slug), null)
        ?? await getFile(env.githubToken, env.githubRepo, postPath(slug));
      if (existing) return err("post already exists", 409);

      const data = {
        title,
        date: new Date().toISOString().split("T")[0],
        draft: true,
        featured,
        excerpt,
      };
      const content = serializeFrontMatter(data, postBody);
      await stageFile(env.stagingBucket, postPath(slug), content);

      return json({ slug, title, draft: true }, 201);
    }

    // ── GET /api/posts/:slug ──────────────────────────────────────────────────
    if (method === "GET" && segments.length === 2 && segments[0] === "posts") {
      const slug = segments[1];
      if (await isStagedPostDeleted(env.stagingBucket, slug)) return err("post not found", 404);
      const result = await readStaged(
        env.stagingBucket,
        postPath(slug),
        async (p) => getFile(env.githubToken, env.githubRepo, p)
      );
      if (!result) return err("post not found", 404);
      const { data, body: postBody } = parseFrontMatter(result.content);
      return json({ slug, ...data, body: postBody });
    }

    // ── PATCH /api/posts/:slug ────────────────────────────────────────────────
    if (method === "PATCH" && segments.length === 2 && segments[0] === "posts") {
      const slug = segments[1];
      const updates = await request.json();

      if (await isStagedPostDeleted(env.stagingBucket, slug)) return err("post not found", 404);
      const result = await readStaged(
        env.stagingBucket,
        postPath(slug),
        async (p) => getFile(env.githubToken, env.githubRepo, p)
      );
      if (!result) return err("post not found", 404);
      const { data, body: postBody } = parseFrontMatter(result.content);

      const updatableFields = ["title", "excerpt", "featured", "draft"];
      const updatedData = { ...data };
      for (const f of updatableFields) {
        if (updates[f] !== undefined) updatedData[f] = updates[f];
      }
      const updatedBody = updates.body !== undefined ? updates.body : postBody;
      const content = serializeFrontMatter(updatedData, updatedBody);
      await stageFile(env.stagingBucket, postPath(slug), content);

      return json({ slug, ...updatedData, body: updatedBody });
    }

    // ── DELETE /api/posts/:slug ───────────────────────────────────────────────
    if (method === "DELETE" && segments.length === 2 && segments[0] === "posts") {
      const slug = segments[1];
      const result = await readStaged(
        env.stagingBucket,
        postPath(slug),
        async (p) => getFile(env.githubToken, env.githubRepo, p)
      );
      if (!result) return err("post not found", 404);
      await stageDelete(env.stagingBucket, postPath(slug));
      return json({ deleted: slug });
    }

    // ── POST /api/posts/:slug/publish ─────────────────────────────────────────
    if (
      method === "POST" &&
      segments.length === 3 &&
      segments[0] === "posts" &&
      segments[2] === "publish"
    ) {
      const slug = segments[1];
      const { draft } = await request.json();

      const result = await readStaged(
        env.stagingBucket,
        postPath(slug),
        async (p) => getFile(env.githubToken, env.githubRepo, p)
      );
      if (!result) return err("post not found", 404);
      const { data, body: postBody } = parseFrontMatter(result.content);
      const updatedData = { ...data, draft: Boolean(draft) };
      await stageFile(env.stagingBucket, postPath(slug), serializeFrontMatter(updatedData, postBody));
      return json({ slug, draft: Boolean(draft) });
    }

    // ── 404 ──────────────────────────────────────────────────────────────────
    return json({ error: "not found" }, 404);
  } catch (e) {
    console.error(e);
    return json({ error: e.message }, 500);
  }
}
