/**
 * /api/[[route]] — admin API catch-all router.
 *
 * All routes are access-gated by Cloudflare Access (configured in Phase 0).
 * Each handler is stubbed with HTTP 501 until Phase 2 implements the real logic.
 *
 * Reference: CLAUDE.md "Admin API" table + admin/server.js (old Express implementation).
 *
 * Phase 2 pipeline per upload:
 *   1. Resize via IMAGES binding → 600/1200/2400 px AVIF + JPEG (strip all metadata)
 *   2. PUT variants → ASSETS_BUCKET; PUT original → ORIGINALS_BUCKET
 *   3. Update series _index.md manifest (photos[] array) in the repo via GitHub API
 *   4. Ping DEPLOY_HOOK_URL to trigger a Cloudflare Pages rebuild
 */

import { getEnv } from "../_lib/env.js";

const NOT_IMPLEMENTED = (msg) =>
  new Response(JSON.stringify({ error: "not implemented", detail: msg }), {
    status: 501,
    headers: { "Content-Type": "application/json" },
  });

const NOT_FOUND = () =>
  new Response(JSON.stringify({ error: "not found" }), {
    status: 404,
    headers: { "Content-Type": "application/json" },
  });

export async function onRequest(ctx) {
  const { request, params } = ctx;
  const _env = getEnv(ctx); // available for Phase 2 handlers

  const method = request.method.toUpperCase();
  // params.route is an array of path segments after /api/
  const segments = Array.isArray(params.route) ? params.route : (params.route ? [params.route] : []);

  // Route: GET /api/projects
  if (method === "GET" && segments.length === 1 && segments[0] === "projects") {
    // TODO (Phase 2): read all series _index.md manifests from ASSETS_BUCKET or GitHub
    // and return an array of { slug, title, description, cover, draft, photoCount }.
    return NOT_IMPLEMENTED("GET /api/projects — list all series from manifests");
  }

  // Route: POST /api/projects
  if (method === "POST" && segments.length === 1 && segments[0] === "projects") {
    // TODO (Phase 2): create a new series branch bundle (_index.md) and commit to GitHub.
    // Body: { title, description }
    return NOT_IMPLEMENTED("POST /api/projects — create series, commit _index.md to GitHub");
  }

  // Route: GET /api/projects/:slug/photos
  if (method === "GET" && segments.length === 3 && segments[0] === "projects" && segments[2] === "photos") {
    // TODO (Phase 2): read the series _index.md from GitHub and return photos[].
    return NOT_IMPLEMENTED(`GET /api/projects/${segments[1]}/photos — list photos from manifest`);
  }

  // Route: POST /api/projects/:slug/photos
  if (method === "POST" && segments.length === 3 && segments[0] === "projects" && segments[2] === "photos") {
    // TODO (Phase 2):
    //   1. Accept multipart upload (the processed JPEG export, not the RAW).
    //   2. Resize via IMAGES binding → 600/1200/2400 px AVIF + JPEG; strip all metadata.
    //   3. PUT variants to ASSETS_BUCKET at <slug>/<id>/{600,1200,2400}.{avif,jpg}.
    //   4. PUT original to ORIGINALS_BUCKET at <slug>/<id>/original.jpg.
    //   5. Append photo entry to series _index.md photos[] and commit via GitHub API.
    //   6. Return the new photo object.
    return NOT_IMPLEMENTED(`POST /api/projects/${segments[1]}/photos — upload: resize → R2 → manifest → GitHub`);
  }

  // Route: PATCH /api/projects/:slug/photos/:id
  if (method === "PATCH" && segments.length === 4 && segments[0] === "projects" && segments[2] === "photos") {
    // TODO (Phase 2): update caption and/or downloadable flag in the manifest.
    // If downloadable toggled true → copy original from ORIGINALS_BUCKET to ASSETS_BUCKET.
    // If toggled false → delete public copy + purge CDN cache.
    // Commit manifest change to GitHub.
    return NOT_IMPLEMENTED(`PATCH /api/projects/${segments[1]}/photos/${segments[3]} — edit caption/downloadable, copy-to-public logic`);
  }

  // Route: DELETE /api/projects/:slug/photos/:id
  if (method === "DELETE" && segments.length === 4 && segments[0] === "projects" && segments[2] === "photos") {
    // TODO (Phase 2): delete all R2 objects for this photo (variants + originals in both
    // buckets), remove entry from manifest, commit to GitHub.
    return NOT_IMPLEMENTED(`DELETE /api/projects/${segments[1]}/photos/${segments[3]} — delete R2 objects + manifest entry`);
  }

  // Route: PATCH /api/projects/:slug
  if (method === "PATCH" && segments.length === 2 && segments[0] === "projects") {
    // TODO (Phase 2): update series metadata { title, description, cover, draft,
    // downloadsDefault } in _index.md and commit to GitHub.
    return NOT_IMPLEMENTED(`PATCH /api/projects/${segments[1]} — update series metadata`);
  }

  // Route: POST /api/projects/:slug/publish
  if (method === "POST" && segments.length === 3 && segments[0] === "projects" && segments[2] === "publish") {
    // TODO (Phase 2): set draft: bool in _index.md, commit to GitHub, ping deploy hook.
    // Body: { draft: bool }
    return NOT_IMPLEMENTED(`POST /api/projects/${segments[1]}/publish — set draft flag + ping deploy hook`);
  }

  // Route: POST /api/deploy
  if (method === "POST" && segments.length === 1 && segments[0] === "deploy") {
    // TODO (Phase 2): commit any pending manifest changes to GitHub via GITHUB_TOKEN,
    // then POST to DEPLOY_HOOK_URL to trigger a Cloudflare Pages rebuild.
    return NOT_IMPLEMENTED("POST /api/deploy — commit manifests to GitHub + ping Pages deploy hook");
  }

  return NOT_FOUND();
}
