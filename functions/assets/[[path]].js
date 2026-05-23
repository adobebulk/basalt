/**
 * /assets/[[path]] — streams image variants from the public R2 bucket.
 *
 * URL scheme: /assets/<key>/<size>.<fmt>
 *   e.g. /assets/iceland-2025/001/1200.avif
 *
 * Edge-cached via Cache-Control: immutable (content-addressed by key+size+fmt).
 * Variants are pre-baked by the admin upload pipeline — they don't change in place;
 * a re-process produces new objects at the same keys after a cache purge.
 *
 * NOTE: downloadable-original enforcement (checking the `downloadable` flag and
 * routing originals through the private bucket) is wired in the next session (Phase 2).
 * For now, original.jpg objects are reachable here if they happen to exist in
 * ASSETS_BUCKET — that's acceptable during development but must be locked down before
 * production cutover.
 */

export async function onRequest(ctx) {
  const { env, params } = ctx;

  // TODO (Phase 0): ensure ASSETS_BUCKET R2 binding is configured in the Pages project.
  const bucket = env.ASSETS_BUCKET;
  if (!bucket) {
    return new Response("ASSETS_BUCKET binding not configured", { status: 503 });
  }

  // params.path is an array of path segments from the [[path]] catch-all.
  const key = Array.isArray(params.path) ? params.path.join("/") : params.path ?? "";
  if (!key) return new Response("Not found", { status: 404 });

  const object = await bucket.get(key);
  if (!object) return new Response("Not found", { status: 404 });

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("Cache-Control", "public, max-age=31536000, immutable");

  return new Response(object.body, { headers });
}
