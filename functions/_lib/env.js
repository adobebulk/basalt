/**
 * Central registry of Cloudflare bindings and environment variables.
 *
 * ALL values come from context.env — never hardcoded here.
 * Production bindings are configured in the Cloudflare Pages project
 * (dashboard → Settings → Functions → Bindings & Variables) during Phase 0.
 * Local dev: copy .dev.vars.example → .dev.vars and fill in real values,
 * then run: npx wrangler pages dev site/public
 *
 * Required bindings/vars (all six configured in Phase 0):
 *
 *   ASSETS_BUCKET      R2 binding — public bucket (web variants + public originals)
 *   ORIGINALS_BUCKET   R2 binding — private bucket (all originals; no public domain)
 *   GITHUB_TOKEN       Secret — fine-grained PAT, Contents read/write on this repo
 *   GITHUB_REPO        Var — "owner/repo", e.g. "adobebulk/static-photos"
 *   DEPLOY_HOOK_URL    Secret — Cloudflare Pages deploy hook URL (admin "Rebuild" button)
 *
 * Optional (for global CDN cache purge on downloadable toggle):
 *   CF_ZONE_ID         Var — Cloudflare zone ID for photos.ctsmith.org
 *   CF_API_TOKEN       Secret — token with Cache Purge permission on the zone
 *   Without these, cache purge falls back to local datacenter only (caches.default.delete).
 */

/** @param {import("@cloudflare/workers-types").EventContext} ctx */
export function getEnv(ctx) {
  const e = ctx.env;
  return {
    assetsBucket:    e.ASSETS_BUCKET,
    originalsBucket: e.ORIGINALS_BUCKET,
    assetsR2Url:     e.ASSETS_R2_PUBLIC_URL,
    githubToken:     e.GITHUB_TOKEN,
    githubRepo:      e.GITHUB_REPO,
    deployHookUrl:   e.DEPLOY_HOOK_URL,
    cfZoneId:        e.CF_ZONE_ID,       // optional
    cfApiToken:      e.CF_API_TOKEN,     // optional
  };
}
