/**
 * Central registry of Cloudflare bindings and environment variables.
 *
 * ALL values come from context.env — never hardcoded here.
 * Production bindings are configured in the Cloudflare Pages project
 * (dashboard → Settings → Functions → Bindings & Variables) during Phase 0.
 * Local dev: copy .dev.vars.example → .dev.vars and fill in real values,
 * then run: npx wrangler pages dev site/public
 *
 * Required bindings/vars:
 *
 *   ASSETS_BUCKET      R2 binding — public bucket (web variants + public originals)
 *   ORIGINALS_BUCKET   R2 binding — private bucket (all originals; no public domain)
 *   GITHUB_TOKEN       Secret — fine-grained PAT, Contents read/write on this repo
 *   GITHUB_REPO        Var — "owner/repo", e.g. "adobebulk/basalt"
 *   DEPLOY_HOOK_URL    Secret — Cloudflare Pages deploy hook URL (admin "Rebuild" button)
 *   PUBLIC_ORIGIN      Var — public site origin, e.g. "https://example.com"
 *
 * Optional (CDN purge + admin build status):
 *   CF_ZONE_ID         Var — Cloudflare zone ID (cache purge)
 *   CF_ACCOUNT_ID      Var — account ID (admin build-status poll)
 *   CF_API_TOKEN       Secret — Cache Purge and/or Cloudflare Pages Read
 *   CF_PAGES_PROJECT   Var — Pages project name; defaults to basalt
 *   Without CF_ZONE_ID/token, cache purge is this PoP only.
 *   Without CF_ACCOUNT_ID/token, Rebuild still works but the admin cannot show live build status.
 */

/** @param {import("@cloudflare/workers-types").EventContext} ctx */
export function getEnv(ctx) {
  const e = ctx.env;
  return {
    assetsBucket:    e.ASSETS_BUCKET,
    originalsBucket: e.ORIGINALS_BUCKET,
    stagingBucket:   e.ORIGINALS_BUCKET,   // staging uses _pending/ prefix in the private bucket
    assetsR2Url:     e.ASSETS_R2_PUBLIC_URL,
    githubToken:     e.GITHUB_TOKEN,
    githubRepo:      e.GITHUB_REPO,
    deployHookUrl:   e.DEPLOY_HOOK_URL,
    publicOrigin:    e.PUBLIC_ORIGIN || "",
    cfZoneId:        e.CF_ZONE_ID,       // optional
    cfAccountId:     e.CF_ACCOUNT_ID,    // optional — admin build status
    cfApiToken:      e.CF_API_TOKEN,     // optional
    cfPagesProject:  e.CF_PAGES_PROJECT || "basalt",
    packageVersion:  e.PACKAGE_VERSION,
  };
}
