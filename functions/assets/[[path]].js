/**
 * /assets/[[path]] — streams image variants from the public R2 bucket.
 *
 * URL scheme: /assets/<key>/<size>.<fmt>   e.g. /assets/iceland-2025/001/1200.avif
 *             /assets/<slug>/<id>/original.jpg  (only if marked downloadable)
 *
 * Variants (600/1200/2400 px, AVIF + JPEG) are always public once uploaded.
 * original.jpg is only served if it has been explicitly copied into ASSETS_BUCKET
 * via the "copy-to-public" downloadable toggle in the admin — otherwise 404.
 * This means the access check is purely "does it exist in ASSETS_BUCKET?" — no
 * per-request auth logic, no race conditions, easy to audit.
 *
 * Edge-cached via Cache-Control: immutable (content is never mutated in place;
 * reprocessing produces new R2 objects, and a CDN purge is issued by the admin).
 */

export async function onRequest(ctx) {
  const { env, params } = ctx;

  const bucket = env.ASSETS_BUCKET;
  if (!bucket) {
    return new Response("ASSETS_BUCKET binding not configured", { status: 503 });
  }

  // params.path is an array of path segments from the [[path]] catch-all.
  const key = Array.isArray(params.path) ? params.path.join("/") : (params.path ?? "");
  if (!key) return new Response("Not found", { status: 404 });

  const object = await bucket.get(key);
  if (!object) return new Response("Not found", { status: 404 });

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("Cache-Control", "public, max-age=31536000, immutable");
  // Allow <img> on the same origin (and social unfurlers)
  headers.set("Access-Control-Allow-Origin", "*");

  return new Response(object.body, { headers });
}
