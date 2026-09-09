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
 *   4. Stage the updated manifest + <id>.md stub immediately (crash-safe; not left until
 *      the end of a multi-photo request). GitHub is only written on Rebuild.
 *
 * Image transforms use "Transform via Workers" (fetch with cf.image), not the Images
 * binding — the binding is not supported for Pages Functions.
 * Docs: https://developers.cloudflare.com/images/transform-images/transform-via-workers/
 */

import yaml from "js-yaml";
import { getEnv } from "../_lib/env.js";
import { getFile, listDir } from "../_lib/github.js";
import {
  stageFile, stageDelete, readStaged,
  getStagedSlugs, isStagedDeleted, flushStaging,
  getStagedPostSlugs, isStagedPostDeleted, pendingCounts,
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
const MAX_DIRECT_UPLOAD_FILES = 8;
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
  await purgeCacheFiles(env, [url]);
}

async function purgeCacheFiles(env, urls) {
  if (!urls.length) return;
  if (env.cfZoneId && env.cfApiToken) {
    const batchSize = 30;
    for (let i = 0; i < urls.length; i += batchSize) {
      const body = JSON.stringify({ files: urls.slice(i, i + batchSize) });
      let lastErr = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        const res = await fetch(
          `https://api.cloudflare.com/client/v4/zones/${env.cfZoneId}/purge_cache`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${env.cfApiToken}`,
              "Content-Type": "application/json",
            },
            body,
          }
        );
        if (res.ok) { lastErr = null; break; }
        lastErr = `HTTP ${res.status} ${await res.text()}`;
        console.error(`[purgeCache] attempt ${attempt + 1} failed: ${lastErr}`);
      }
      if (lastErr) console.error(`[purgeCache] giving up on batch ${i}: ${lastErr}`);
    }
  } else {
    // Best-effort: only purges in this PoP. Deleted objects can linger on other
    // edges until TTL if CF_ZONE_ID / CF_API_TOKEN are not configured.
    console.warn("[purgeCache] CF_ZONE_ID/CF_API_TOKEN unset; purging this PoP only");
    await Promise.all(urls.map((url) => caches.default.delete(new Request(url))));
  }
}

const assetUrl = (env, key) => `${env.publicOrigin}/assets/${key}`;

const photoAssetKeys = (slug, id) => [
  ...SIZES.flatMap((s) => FORMATS.map(({ ext }) => `${slug}/${id}/${s}.${ext}`)),
  `${slug}/${id}/original.jpg`,
];

async function purgeAssetKeys(env, keys) {
  await purgeCacheFiles(env, keys.map((key) => assetUrl(env, key)));
}

async function cleanupPhotoAssets(env, slug, id) {
  const keys = photoAssetKeys(slug, id);
  await Promise.all([
    env.assetsBucket.delete(keys),
    env.originalsBucket.delete(`${slug}/${id}/original.jpg`),
  ]);
}

/**
 * Bake one original into private original + 6 public variants.
 * The original is temporarily public so Transform via Workers can fetch it.
 * On failure, any objects written for this slug/id are removed so a retry is clean.
 */
async function bakePhoto(env, slug, id, originalBuffer, { publicOriginal = false } = {}) {
  const originalKey = `${slug}/${id}/original.jpg`;
  await env.assetsBucket.put(originalKey, originalBuffer, {
    httpMetadata: { contentType: "image/jpeg" },
  });
  try {
    const variants = await generateVariants(slug, id, env);
    for (const v of variants) {
      await env.assetsBucket.put(v.key, v.buffer, {
        httpMetadata: { contentType: v.contentType },
      });
    }
    await env.originalsBucket.put(originalKey, originalBuffer, {
      httpMetadata: { contentType: "image/jpeg" },
    });
    if (!publicOriginal) {
      await env.assetsBucket.delete(originalKey);
    }
  } catch (e) {
    console.error(`[bakePhoto] failed ${slug}/${id}:`, e);
    try {
      await cleanupPhotoAssets(env, slug, id);
    } catch (cleanupErr) {
      console.error(`[bakePhoto] cleanup failed ${slug}/${id}:`, cleanupErr);
    }
    throw e;
  }
}

async function listAllObjects(bucket, options) {
  const objects = [];
  let cursor;
  do {
    const page = await bucket.list({ ...options, cursor });
    objects.push(...page.objects);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return objects;
}

// ─── GitHub path helpers ─────────────────────────────────────────────────────

const indexPath = (slug) => `site/content/projects/${slug}/_index.md`;
const stubPath = (slug, id) => `site/content/projects/${slug}/${id}.md`;
const postPath = (slug) => `site/content/posts/${slug}/index.md`;
const settingsPath = "site/data/settings.yaml";

const POOL_SLUG = "_pool";
const rawPoolKey = (pid) => `_pool/raw/${pid}/original.jpg`;

/**
 * Generates a random 6-character alphanumeric slug for a new series.
 * Opaque and permanent — never derived from or changed with the title.
 */
function randomSeriesSlug() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from(crypto.getRandomValues(new Uint8Array(6)))
    .map(b => chars[b % chars.length]).join('');
}

async function newSeriesSlug(env) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const slug = randomSeriesSlug();
    const existing = await readStaged(env.stagingBucket, indexPath(slug), null)
      ?? await getFile(env.githubToken, env.githubRepo, indexPath(slug));
    if (!existing) return slug;
  }
  throw new Error("unable to allocate unique series slug");
}

const DEFAULT_SETTINGS = {
  title: "Photos",
  navLabel: "Work",
  photographer: "Your Name",
  description: "A photo gallery",
  heroPhotoKey: "",
  heroLink: "",
  featured: [],
};

async function listGithubDirs(env, path) {
  if (!env.githubToken || !env.githubRepo) return [];
  try {
    const entries = await listDir(env.githubToken, env.githubRepo, path);
    return entries ? entries.filter((e) => e.type === "dir").map((e) => e.name) : [];
  } catch (e) {
    console.error(`[listGithubDirs] ${path}:`, e);
    return [];
  }
}

async function githubFileFallback(env, path) {
  if (!env.githubToken || !env.githubRepo) return null;
  try {
    return await getFile(env.githubToken, env.githubRepo, path);
  } catch (e) {
    console.error(`[githubFileFallback] ${path}:`, e);
    return null;
  }
}

async function githubFileRequired(env, path) {
  if (!env.githubToken || !env.githubRepo) {
    throw new Error("GitHub credentials not configured");
  }
  return getFile(env.githubToken, env.githubRepo, path);
}

async function readManifest(env, slug) {
  const result = await readStaged(
    env.stagingBucket,
    indexPath(slug),
    async (p) => githubFileFallback(env, p)
  );
  if (!result) return null;
  return { ...parseFrontMatter(result.content), raw: result.content };
}

async function readSettings(env, { requireGithub = false } = {}) {
  const result = await readStaged(
    env.stagingBucket,
    settingsPath,
    // Reads may degrade to defaults, but writes must never treat an unavailable
    // GitHub baseline as an empty settings file and overwrite real configuration.
    async (p) => requireGithub
      ? githubFileRequired(env, p)
      : githubFileFallback(env, p)
  );
  const settings = result ? (yaml.load(result.content) ?? {}) : {};
  return { ...DEFAULT_SETTINGS, ...settings };
}

async function stageSettings(env, settings) {
  await stageFile(env.stagingBucket, settingsPath, yaml.dump(settings, { lineWidth: -1 }));
}

async function removeDeletedReferences(env, { seriesSlug, photoId, postSlug }) {
  const settings = await readSettings(env);
  const before = JSON.stringify(settings);

  if (seriesSlug && photoId && settings.heroPhotoKey === `${seriesSlug}/${photoId}`) {
    settings.heroPhotoKey = "";
    settings.heroLink = "";
  } else if (seriesSlug && !photoId && settings.heroPhotoKey?.startsWith(`${seriesSlug}/`)) {
    settings.heroPhotoKey = "";
    settings.heroLink = "";
  }

  settings.featured = (Array.isArray(settings.featured) ? settings.featured : []).filter((item) => {
    if (seriesSlug && !photoId && item.type === "series" && item.slug === seriesSlug) return false;
    if (seriesSlug && !photoId && item.type === "photo" && item.slug === seriesSlug) return false;
    if (seriesSlug && photoId && item.type === "photo" && item.slug === seriesSlug && item.photoId === photoId) return false;
    if (postSlug && item.type === "post" && item.slug === postSlug) return false;
    return true;
  });

  if (JSON.stringify(settings) !== before) {
    await stageSettings(env, settings);
  }
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
      const ghSlugs = await listGithubDirs(env, "site/content/projects");
      const stagedSlugs = await getStagedSlugs(env.stagingBucket);
      const allSlugs = [...new Set([...ghSlugs, ...stagedSlugs])].filter(s => s !== POOL_SLUG);

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
            seriesPosts: data.seriesPosts ?? [],
          };
        })
      )).filter(Boolean);

      return json(projects);
    }

    // ── POST /api/projects ───────────────────────────────────────────────────
    if (method === "POST" && segments.length === 1 && segments[0] === "projects") {
      const { title, description } = await request.json();
      if (!title) return err("title required");

      const slug = await newSeriesSlug(env);

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
      if (files.length > MAX_DIRECT_UPLOAD_FILES) {
        return err(`upload at most ${MAX_DIRECT_UPLOAD_FILES} photos per request`, 413);
      }

      const addedPhotos = [];
      let photos = [...(manifest.data.photos ?? [])];
      const downloadsDefault = manifest.data.downloadsDefault === true;
      let cover = manifest.data.cover || "";

      for (const file of files) {
        const originalBuffer = await file.arrayBuffer();
        const dims = getImageDimensions(originalBuffer) ?? { width: 0, height: 0 };
        const id = nextPhotoId(photos);
        const key = `${slug}/${id}`;

        await bakePhoto(env, slug, id, originalBuffer, { publicOriginal: downloadsDefault });

        const photo = { id, key, width: dims.width, height: dims.height, caption: "" };
        photos.push(photo);
        addedPhotos.push(photo);
        if (!cover) cover = id;

        // Stage immediately so a later photo failing this request cannot orphan
        // already-baked R2 objects (they would be unlisted and unretryable).
        const updatedManifest = serializeFrontMatter(
          { ...manifest.data, photos, cover },
          manifest.body ?? ""
        );
        await stageFile(env.stagingBucket, stubPath(slug, id), newPhotoStub(id));
        await stageFile(env.stagingBucket, indexPath(slug), updatedManifest);
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
          await purgeCache(env, assetUrl(env, originalKey));
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
      await purgeAssetKeys(env, [...variantKeys, originalKey]);

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
      await removeDeletedReferences(env, { seriesSlug: slug, photoId: id });

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
      await purgeAssetKeys(env, photos.flatMap((photo) => photoAssetKeys(slug, photo.id)));

      // Stage deletion of all per-photo stubs and the manifest.
      await Promise.all(photos.map((photo) =>
        stageDelete(env.stagingBucket, stubPath(slug, photo.id))
      ));
      await stageDelete(env.stagingBucket, indexPath(slug));
      await removeDeletedReferences(env, { seriesSlug: slug });

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

      const updatableFields = ["title", "description", "cover", "draft", "downloadsDefault", "seriesPosts"];
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

    // ── GET /api/deploy-status ───────────────────────────────────────────────
    if (method === "GET" && segments.length === 1 && segments[0] === "deploy-status") {
      if (!env.cfApiToken || !env.cfAccountId) {
        return json({ configured: false });
      }
      const project = encodeURIComponent(env.cfPagesProject);
      const url =
        `https://api.cloudflare.com/client/v4/accounts/${env.cfAccountId}` +
        `/pages/projects/${project}/deployments?env=production&per_page=1`;
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${env.cfApiToken}` },
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok || !payload.success) {
        const msg = payload.errors?.[0]?.message || `Cloudflare API ${res.status}`;
        return err(msg, 502);
      }
      const dep = payload.result?.[0];
      if (!dep) return json({ configured: true, id: null, live: false, ok: true, message: "No deployments yet" });

      const stage = dep.latest_stage || {};
      const stageStatus = stage.status || "";
      const stageName = stage.name || "";
      const live = stageStatus === "active" || stageName === "queued";
      const failed = stageStatus === "failure" || stageStatus === "canceled" || dep.is_skipped;
      const ok = !failed && !live;
      const short = (dep.deployment_trigger?.metadata?.commit_hash || dep.id || "").slice(0, 7);
      let message = "Site up to date";
      if (live) message = stageName ? `Building — ${stageName}` : "Building…";
      else if (stageStatus === "failure") message = "Build failed";
      else if (stageStatus === "canceled") message = "Build canceled";
      else if (dep.is_skipped) message = "Build skipped";
      else if (short) message = `Live — ${short}`;

      return json({
        configured: true,
        id: dep.id,
        live,
        ok,
        status: stageStatus,
        stage: stageName,
        commit: short,
        message,
        created_on: dep.created_on,
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
      return json(await readSettings(env));
    }

    // ── PATCH /api/settings ──────────────────────────────────────────────────
    if (method === "PATCH" && segments.length === 1 && segments[0] === "settings") {
      const body = await request.json();
      const allowedKeys = ["title", "navLabel", "photographer", "description", "heroPhotoKey", "heroLink", "featured"];
      const updated = await readSettings(env, { requireGithub: true });
      for (const k of allowedKeys) {
        if (body[k] !== undefined) updated[k] = body[k];
      }
      await stageSettings(env, updated);
      return json(updated);
    }

    // ── GET /api/version ─────────────────────────────────────────────────────
    if (method === "GET" && segments.length === 1 && segments[0] === "version") {
      return json({ version: env.packageVersion ?? "unknown" });
    }

    // ── GET /api/staging ─────────────────────────────────────────────────────
    if (method === "GET" && segments.length === 1 && segments[0] === "staging") {
      if (!env.stagingBucket) return err("ORIGINALS_BUCKET not configured", 503);
      return json(await pendingCounts(env.stagingBucket));
    }

    // ── GET /api/posts ────────────────────────────────────────────────────────
    if (method === "GET" && segments.length === 1 && segments[0] === "posts") {
      const ghSlugs = await listGithubDirs(env, "site/content/posts");
      const stagedSlugs = await getStagedPostSlugs(env.stagingBucket);
      const allSlugs = [...new Set([...ghSlugs, ...stagedSlugs])];

      const posts = (await Promise.all(
        allSlugs.map(async (slug) => {
          if (await isStagedPostDeleted(env.stagingBucket, slug)) return null;
          const result = await readStaged(
            env.stagingBucket,
            postPath(slug),
            async (p) => githubFileFallback(env, p)
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
        async (p) => githubFileFallback(env, p)
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
        async (p) => githubFileFallback(env, p)
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
        async (p) => githubFileFallback(env, p)
      );
      if (!result) return err("post not found", 404);
      await stageDelete(env.stagingBucket, postPath(slug));
      await removeDeletedReferences(env, { postSlug: slug });
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
        async (p) => githubFileFallback(env, p)
      );
      if (!result) return err("post not found", 404);
      const { data, body: postBody } = parseFrontMatter(result.content);
      const updatedData = { ...data, draft: Boolean(draft) };
      await stageFile(env.stagingBucket, postPath(slug), serializeFrontMatter(updatedData, postBody));
      return json({ slug, draft: Boolean(draft) });
    }

    // ── POST /api/pool ────────────────────────────────────────────────────────
    if (method === "POST" && segments.length === 1 && segments[0] === "pool") {
      if (!env.originalsBucket) return err("ORIGINALS_BUCKET not configured", 503);
      const formData = await request.formData();
      const files = formData.getAll("photos");
      if (!files.length) return err("no photos in request");

      const uploaded = [];
      for (const file of files) {
        const buf = await file.arrayBuffer();
        const dims = getImageDimensions(buf) ?? { width: 0, height: 0 };
        const pid = crypto.randomUUID();
        const uploadedAt = new Date().toISOString();
        await env.originalsBucket.put(rawPoolKey(pid), buf, {
          httpMetadata: { contentType: "image/jpeg" },
          customMetadata: {
            filename: file.name || "photo.jpg",
            width: String(dims.width),
            height: String(dims.height),
            uploadedAt,
            status: "raw",
          },
        });
        uploaded.push({ pid, filename: file.name || "photo.jpg", width: dims.width, height: dims.height, uploadedAt });
      }
      return json({ uploaded }, 201);
    }

    // ── GET /api/pool ─────────────────────────────────────────────────────────
    if (method === "GET" && segments.length === 1 && segments[0] === "pool") {
      const rawObjects = await listAllObjects(env.originalsBucket, { prefix: "_pool/raw/", include: ["customMetadata"] });
      const raw = rawObjects
        .filter(obj => obj.key.endsWith("/original.jpg"))
        .map(obj => {
          const pid = obj.key.slice("_pool/raw/".length, -"/original.jpg".length);
          const m = obj.customMetadata ?? {};
          return {
            pid,
            status: "raw",
            filename: m.filename ?? "photo.jpg",
            width: parseInt(m.width ?? "0", 10),
            height: parseInt(m.height ?? "0", 10),
            uploadedAt: m.uploadedAt ?? "",
          };
        })
        .sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt));

      const poolManifest = await readManifest(env, POOL_SLUG);
      const processed = (poolManifest?.data?.photos ?? []).map(p => ({
        id: p.id,
        key: p.key,
        status: "processed",
        caption: p.caption ?? "",
        width: p.width ?? 0,
        height: p.height ?? 0,
      }));

      return json({ raw, processed });
    }

    // ── POST /api/pool/process ────────────────────────────────────────────────
    if (method === "POST" && segments.length === 2 && segments[0] === "pool" && segments[1] === "process") {
      if (!env.assetsBucket) return err("ASSETS_BUCKET not configured", 503);
      if (!env.originalsBucket) return err("ORIGINALS_BUCKET not configured", 503);

      let reqBody = {};
      const ct = request.headers.get("content-type") ?? "";
      if (ct.includes("application/json")) {
        try { reqBody = await request.json(); } catch (_) {}
      }
      const limit = typeof reqBody.limit === "number" ? reqBody.limit : 6;

      // Ensure pool manifest exists (draft: true enforced permanently)
      let poolManifest = await readManifest(env, POOL_SLUG);
      if (!poolManifest) {
        const initData = {
          title: "Pool",
          description: "Unassigned uploads",
          date: new Date().toISOString().split("T")[0],
          draft: true,
          cover: "",
          downloadsDefault: false,
          photos: [],
        };
        await stageFile(env.stagingBucket, indexPath(POOL_SLUG), serializeFrontMatter(initData));
        poolManifest = { data: initData, body: "" };
      }

      const rawListObjects = await listAllObjects(env.originalsBucket, { prefix: "_pool/raw/", include: ["customMetadata"] });
      const rawObjects = rawListObjects.filter(obj => obj.key.endsWith("/original.jpg"));
      const toProcess = rawObjects.slice(0, limit);

      let photos = [...(poolManifest.data.photos ?? [])];
      let processedCount = 0;

      for (const rawObj of toProcess) {
        const pid = rawObj.key.slice("_pool/raw/".length, -"/original.jpg".length);
        const obj = await env.originalsBucket.get(rawPoolKey(pid));
        if (!obj) continue;

        const buf = await obj.arrayBuffer();
        const meta = rawObj.customMetadata ?? {};
        const width = parseInt(meta.width ?? "0", 10);
        const height = parseInt(meta.height ?? "0", 10);

        const id = nextPhotoId(photos);
        const key = `${POOL_SLUG}/${id}`;

        await bakePhoto(env, POOL_SLUG, id, buf, { publicOriginal: false });

        const photoEntry = { id, key, width, height, caption: "" };
        photos.push(photoEntry);

        // Persist the pool manifest before deleting raw. A crash between these
        // two writes can duplicate the photo on retry; a crash the other way
        // used to drop it permanently (raw gone, unlisted variants in R2).
        const updatedPoolData = { ...poolManifest.data, photos, draft: true };
        await stageFile(env.stagingBucket, stubPath(POOL_SLUG, id), newPhotoStub(id));
        await stageFile(env.stagingBucket, indexPath(POOL_SLUG), serializeFrontMatter(updatedPoolData, poolManifest.body ?? ""));

        await env.originalsBucket.delete(rawPoolKey(pid));
        processedCount++;
      }

      const remaining = Math.max(0, rawObjects.length - processedCount);
      return json({ processed: processedCount, remaining });
    }

    // ── DELETE /api/pool/raw/:pid ─────────────────────────────────────────────
    if (method === "DELETE" && segments.length === 3 && segments[0] === "pool" && segments[1] === "raw") {
      const pid = segments[2];
      await env.originalsBucket.delete(rawPoolKey(pid));
      return json({ deleted: pid });
    }

    // ── DELETE /api/pool/:id ──────────────────────────────────────────────────
    if (method === "DELETE" && segments.length === 2 && segments[0] === "pool") {
      const id = segments[1];
      const poolManifest = await readManifest(env, POOL_SLUG);
      if (!poolManifest) return err("pool not found", 404);
      const photos = poolManifest.data.photos ?? [];
      const photo = photos.find(p => p.id === id);
      if (!photo) return err("photo not found", 404);

      const variantKeys = SIZES.flatMap(s => FORMATS.map(({ ext }) => `${POOL_SLUG}/${id}/${s}.${ext}`));
      const originalKey = `${POOL_SLUG}/${id}/original.jpg`;
      await env.assetsBucket.delete([...variantKeys, originalKey]);
      await env.originalsBucket.delete(originalKey);
      await purgeAssetKeys(env, [...variantKeys, originalKey]);

      const updatedData = { ...poolManifest.data, photos: photos.filter(p => p.id !== id), draft: true };
      await stageFile(env.stagingBucket, indexPath(POOL_SLUG), serializeFrontMatter(updatedData, poolManifest.body ?? ""));
      await stageDelete(env.stagingBucket, stubPath(POOL_SLUG, id));

      return json({ deleted: id });
    }

    // ── POST /api/projects/:slug/photos/from-pool ─────────────────────────────
    if (
      method === "POST" &&
      segments.length === 4 &&
      segments[0] === "projects" &&
      segments[2] === "photos" &&
      segments[3] === "from-pool"
    ) {
      // Client sends batches of ≤5 ids to stay within subrequest budget per call.
      const slug = segments[1];
      if (!env.assetsBucket || !env.originalsBucket) return err("R2 not configured", 503);

      const { ids } = await request.json();
      if (!Array.isArray(ids) || ids.length === 0) return err("ids array required");

      const [targetManifest, poolManifest] = await Promise.all([
        readManifest(env, slug),
        readManifest(env, POOL_SLUG),
      ]);
      if (!targetManifest) return err("series not found", 404);
      if (!poolManifest) return json({ moved: [], skipped: ids });

      let targetPhotos = [...(targetManifest.data.photos ?? [])];
      let poolPhotos = [...(poolManifest.data.photos ?? [])];
      const downloadsDefault = targetManifest.data.downloadsDefault === true;
      const moved = [];
      const skipped = [];

      for (const id of ids) {
        const poolPhoto = poolPhotos.find(p => p.id === id);
        if (!poolPhoto) { skipped.push(id); continue; }

        const newId = nextPhotoId(targetPhotos);
        const newKey = `${slug}/${newId}`;
        const variantCopies = [];

        // Preflight all source objects before writing or deleting anything.
        for (const size of SIZES) {
          for (const { ext, contentType } of FORMATS) {
            const srcKey = `${POOL_SLUG}/${id}/${size}.${ext}`;
            const dstKey = `${newKey}/${size}.${ext}`;
            const obj = await env.assetsBucket.get(srcKey);
            if (!obj) throw new Error(`Pool photo ${id} is missing ${size}.${ext}`);
            variantCopies.push({ srcKey, dstKey, obj, contentType });
          }
        }

        const srcOrigKey = `${POOL_SLUG}/${id}/original.jpg`;
        const dstOrigKey = `${newKey}/original.jpg`;
        const origObj = await env.originalsBucket.get(srcOrigKey);
        if (!origObj) throw new Error(`Pool photo ${id} is missing original.jpg`);
        const origBuffer = await origObj.arrayBuffer();

        // Copy all destination objects before touching manifests or sources.
        for (const { dstKey, obj, contentType } of variantCopies) {
          await env.assetsBucket.put(dstKey, obj.body, { httpMetadata: { contentType } });
        }
        await env.originalsBucket.put(dstOrigKey, origBuffer, { httpMetadata: { contentType: "image/jpeg" } });
        if (downloadsDefault) {
          await env.assetsBucket.put(dstOrigKey, origBuffer.slice(0), { httpMetadata: { contentType: "image/jpeg" } });
        }

        const newPhoto = { id: newId, key: newKey, width: poolPhoto.width, height: poolPhoto.height, caption: poolPhoto.caption || "" };
        targetPhotos.push(newPhoto);
        poolPhotos = poolPhotos.filter(p => p.id !== id);
        moved.push(newPhoto);

        // Stage both manifests before deleting pool sources. A crash after
        // delete-but-before-stage used to drop the photo from both places.
        const updatedTargetData = { ...targetManifest.data, photos: targetPhotos };
        if (!updatedTargetData.cover && targetPhotos.length > 0) {
          updatedTargetData.cover = targetPhotos[0].id;
        }
        const updatedPoolData = { ...poolManifest.data, photos: poolPhotos, draft: true };
        await stageFile(env.stagingBucket, stubPath(slug, newId), newPhotoStub(newId));
        await stageFile(env.stagingBucket, indexPath(slug), serializeFrontMatter(updatedTargetData, targetManifest.body ?? ""));
        await stageFile(env.stagingBucket, indexPath(POOL_SLUG), serializeFrontMatter(updatedPoolData, poolManifest.body ?? ""));
        await stageDelete(env.stagingBucket, stubPath(POOL_SLUG, id));

        await Promise.all(variantCopies.map(({ srcKey }) => env.assetsBucket.delete(srcKey)));
        await env.originalsBucket.delete(srcOrigKey);
        await purgeAssetKeys(env, [...variantCopies.map(({ srcKey }) => srcKey), srcOrigKey]);
      }

      return json({ moved, skipped });
    }

    // ── 404 ──────────────────────────────────────────────────────────────────
    return json({ error: "not found" }, 404);
  } catch (e) {
    console.error(e);
    return json({ error: e.message }, 500);
  }
}
