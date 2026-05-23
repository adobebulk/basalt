/**
 * Central registry of Cloudflare bindings and environment variables.
 *
 * ALL values come from context.env — never hardcoded here.
 * Production bindings are configured in the Cloudflare Pages project
 * (dashboard → Settings → Functions → Bindings, or wrangler.toml) during Phase 0.
 * Local dev: copy .dev.vars.example → .dev.vars and fill in real values,
 * then run: npx wrangler pages dev site/public --binding ...
 *
 * Bindings/vars required (Phase 0 must wire these):
 *
 *   ASSETS_BUCKET      R2 binding — public bucket (web variants + public originals)
 *   ORIGINALS_BUCKET   R2 binding — private bucket (all originals; no public domain)
 *   IMAGES             Cloudflare image-transform binding (for the admin upload pipeline)
 *   GITHUB_TOKEN       Secret — scoped to this repo; used by the admin to commit manifests
 *   GITHUB_REPO        Var — "owner/repo", e.g. "adobebulk/static-photos"
 *   DEPLOY_HOOK_URL    Secret — Cloudflare Pages deploy hook URL (the "Rebuild" button)
 */

/** @param {import("@cloudflare/workers-types").EventContext} ctx */
export function getEnv(ctx) {
  const env = ctx.env;
  return {
    assetsBucket:    env.ASSETS_BUCKET,
    originalsBucket: env.ORIGINALS_BUCKET,
    images:          env.IMAGES,
    githubToken:     env.GITHUB_TOKEN,
    githubRepo:      env.GITHUB_REPO,
    deployHookUrl:   env.DEPLOY_HOOK_URL,
  };
}
