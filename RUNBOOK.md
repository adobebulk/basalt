# RUNBOOK — finishing the static-photos migration

Operator guide for completing the decoupled rebuild. Written 2026-05-22.
**A new session should read this file, then `CLAUDE.md`, then `DEPLOYMENT-PLAN.md`.**
This runbook is for *driving the human through the account setup and the final wiring* —
the architecture decisions are already made (don't reopen them).

---

## Where we are

| Phase | What | Status |
|---|---|---|
| 1 | Hugo refactor — manifest-driven templates, per-photo permalinks, no build-time images | ✅ done, pushed |
| 1.5 | Single-host refactor + Pages Functions skeleton (`/admin`, `/api/*`, `/assets/*`) | ✅ done, pushed |
| **0** | **Cloudflare/GitHub account setup (buckets, bindings, deploy hook, Access, token)** | **⬅ YOU ARE HERE** |
| 2 | Replace the `/api` 501 stubs with the real upload→resize→R2→commit→deploy pipeline | ⏳ blocked on Phase 0 |

The live site builds on Cloudflare Pages but **images are broken until Phase 0** (R2 + the
`IMAGES` binding don't exist yet). That's expected, not a bug.

---

## Architecture in one paragraph (orientation)

Everything is served from **one hostname, `photos.ctsmith.org`**, via a **single Cloudflare
Pages project**: `/` is the static Hugo gallery; `/admin` is the static admin UI (Access-gated);
`/api/*` are Pages Functions (the admin backend, Access-gated); `/assets/*` is a Pages Function
that streams images from R2 (edge-cached). Photos live in **R2, never git** (two buckets: public
variants + downloadable originals, and a private originals bucket). On upload the admin pre-bakes
**600/1200/2400 px AVIF + JPEG** via Cloudflare's image-transform binding and **strips all
metadata** (protects GPS; no camera EXIF kept). Series are Hugo **branch bundles** (`_index.md`
manifest + one `<id>.md` stub per photo). Full detail: `DEPLOYMENT-PLAN.md`.

---

## The bindings contract (what Phase 0 produces, what Phase 2 consumes)

These are referenced by name in `functions/_lib/env.js` and `.dev.vars.example`. Configure them
on the **Pages project → Settings → Functions → Bindings & Variables**.

| Name | Type | Value / notes |
|---|---|---|
| `ASSETS_BUCKET` | R2 binding | Public bucket — web variants + originals marked downloadable |
| `ORIGINALS_BUCKET` | R2 binding | Private bucket — all originals |
| `IMAGES` | Images (transform) binding | Cloudflare resize binding used in the upload pipeline |
| `GITHUB_TOKEN` | Secret | Fine-grained PAT, scoped to this repo, Contents: read/write |
| `GITHUB_REPO` | Plain var | `adobebulk/static-photos` |
| `DEPLOY_HOOK_URL` | Secret | Cloudflare Pages deploy-hook URL (the admin "Rebuild" target) |

---

## Phase 0 — step by step (Cloudflare + GitHub dashboards)

Do these in order. Where it says **"copy this down,"** paste the value somewhere safe — you'll
enter it as a binding/secret in step 6.

1. **Create the R2 buckets.** R2 → Create bucket → `static-photos-assets` (public/variants).
   Repeat → `static-photos-originals` (private). Do **not** add custom domains — images are
   served through the `/assets` Function. (CLI alt: `npx wrangler r2 bucket create static-photos-assets`.)

2. **Confirm the Pages build settings.** Pages → your project → Settings → Builds & deployments:
   Build command `npm run build`, Output directory `site/public`, and add an environment variable
   `HUGO_VERSION=0.161.1`.

3. **Add the custom domain.** Pages → Custom domains → add `photos.ctsmith.org`.

4. **Create the deploy hook.** Pages → Settings → Builds & deployments → Deploy hooks → create one
   (name it `admin-rebuild`) on the **production** branch → **copy this down** = `DEPLOY_HOOK_URL`.

5. **Create the GitHub token.** GitHub → Settings → Developer settings → Fine-grained tokens →
   new token, repository access = `adobebulk/static-photos` only, Repository permissions →
   **Contents: Read and write** → generate → **copy this down** = `GITHUB_TOKEN`.

6. **Wire the bindings/vars** (Pages → Settings → Functions → Bindings & Variables): add the six
   rows from the contract table above (`ASSETS_BUCKET`, `ORIGINALS_BUCKET`, `IMAGES`,
   `GITHUB_TOKEN`, `GITHUB_REPO`, `DEPLOY_HOOK_URL`).

7. **Set up Cloudflare Access** (Zero Trust → Access → Applications): a **self-hosted application**
   on `photos.ctsmith.org` covering paths `/admin*` and `/api*`, with a policy that allows your
   email. Leave `/` and `/assets/*` public. **Do this before Phase 2 ships**, so the admin is never
   open to the internet.

8. **Re-deploy** so the Functions pick up the new bindings (push any commit, or hit the deploy hook).

### ⚠ The one likely snag — the `IMAGES` binding

The resize step depends on **Image Transformations** being enabled on the zone, and the Workers
**Images binding** availability can vary by plan. Before relying on it: dashboard → Images →
Transformations → enable for `ctsmith.org`, and confirm the binding is selectable when you add it
in step 6. If it's **not** available on your plan, the fallback is to run the resize in a
**Cloudflare Container** (Sharp + libvips) instead of the binding — same architecture otherwise.
A session with web access should verify current Cloudflare Images-binding availability/pricing
before committing.

---

## After Phase 0 — Phase 2 wiring prompt (paste into Claude Code)

Run this only once the six bindings are configured. It replaces the `/api` 501 stubs with the real
pipeline. (It uses bindings by name, so it doesn't need the secret *values*.)

```
Context: static-photos, final wiring step. Read CLAUDE.md, DEPLOYMENT-PLAN.md, and RUNBOOK.md.
Phase 0 is done — the six bindings (ASSETS_BUCKET, ORIGINALS_BUCKET, IMAGES, GITHUB_TOKEN,
GITHUB_REPO, DEPLOY_HOOK_URL) are configured on the Pages project. Implement the admin backend
in functions/api/[[route]].js, replacing the 501 stubs. Keep the admin UI and theme unchanged.

IMPORTANT: the Cloudflare Images binding and R2 Workers APIs are evolving — before coding, fetch
the CURRENT Cloudflare docs for (a) the Images binding (env.IMAGES input/transform/output) and
(b) R2 Workers bindings (.put/.get/.delete), and follow the live signatures, not memory.

Implement these endpoints (see CLAUDE.md "Admin API" table):
- POST /api/projects {title, description} → create a series: write site/content/projects/<slug>/
  _index.md with empty photos[] (branch bundle) and commit to GitHub.
- POST /api/projects/:slug/photos (multipart upload) → for each image:
    • generate 600/1200/2400px AVIF + JPEG via the IMAGES binding, stripping ALL metadata
    • PUT variants to ASSETS_BUCKET; PUT the original to ORIGINALS_BUCKET, at key <slug>/<id>/...
    • append the photo to the series _index.md manifest AND create the per-photo stub <id>.md
    • commit both files to GitHub
- PATCH /api/projects/:slug/photos/:id {caption, downloadable, order} → edit the manifest entry.
    • toggling downloadable=true copies <slug>/<id>/original.jpg into ASSETS_BUCKET (copy-to-public);
      =false deletes the public copy and purges the CDN cache.
- DELETE /api/projects/:slug/photos/:id → delete all R2 objects for the photo (both buckets) +
  remove the manifest entry + delete the stub <id>.md; commit.
- PATCH /api/projects/:slug {title, description, cover, draft, downloadsDefault} → edit _index.md.
- POST /api/projects/:slug/publish {draft} → flip draft in _index.md.
- POST /api/deploy → commit any pending manifest changes, then POST to DEPLOY_HOOK_URL.

Also finish functions/assets/[[path]].js: serve variants from ASSETS_BUCKET; for */original.* serve
only if the object exists in ASSETS_BUCKET (i.e. it was made public via copy-to-public), else 404.

Use a pure-JS YAML lib (e.g. js-yaml) to read/modify the _index.md front matter. Read the current
manifest from GitHub via the Contents API, edit, and commit back (include the stub file in the same
change). Reference the OLD admin/server.js for the intended behavior/shapes.

Verify with `npx wrangler pages dev site/public` against the real bindings (or a local R2), test an
upload end-to-end, then commit. Do NOT commit any secrets or photos.
```

---

## Guardrails (do not violate)

- **No photos or binaries in git.** Ever. Images live in R2.
- **No Hugo build-time image processing** (`.Resources` / `.Fill` / `.Resize`).
- **Don't run Cowork and Claude Code git operations at the same time** — `.git/index.lock` clash.
  Let Claude Code own commits.
- Keep the **monospace admin UI** and the gallery theme as-is.
- The `iceland-2025` series is a **build fixture** with placeholder R2 keys; it's expected to show
  broken images until real photos are uploaded through the admin. Remove it whenever you like.
- Decisions are settled (single host, Worker compute, AVIF+JPEG, strip-all metadata, copy-to-public
  originals). Don't reopen them unless the owner asks.

---

## Kickoff line for the next (Sonnet) session

> Read RUNBOOK.md, CLAUDE.md, and DEPLOYMENT-PLAN.md in /Users/.../static-photos. I'm doing the
> Phase 0 account setup — walk me through it step by step and help me troubleshoot. When it's done,
> hand me the Phase 2 wiring prompt from the runbook to paste into Claude Code.
