# Deployment Plan — Decoupled Rebuild

**Status:** proposed (pending your sign-off on the open decisions in §10)
**Created:** 2026-05-21
**Supersedes:** the Mac-Mini-as-hub model in `CLAUDE.md` (Option A / Option B) and the launchd/BTM debugging effort.

---

## 0. Why we're doing this

The current design puts an always-on Node admin server, Caddy, and a Cloudflare Tunnel on a home Mac, and pushes photos through git. Nearly all the recent pain — the macOS Sequoia BTM autostart fight, the restricted server account, the tunnel plumbing — exists only to keep that one server alive and reachable. Separately, committing photos to git means the repo grows forever and never shrinks.

The fix is to stop self-hosting the moving parts and adopt the standard professional pattern for a media-heavy site: **build the website from code, store the heavy assets somewhere else.** This is a *decoupled* (a.k.a. Jamstack) architecture.

**Goals, in priority order:** a fast, responsive, high-quality public gallery; dead-simple publishing from phone or laptop, anywhere; very low cost; and the Mac out of the serving/admin path entirely (it keeps the RAW originals on its backup drives and nothing else).

---

## 1. Target architecture

```
You (phone / laptop, anywhere)
  → admin.ctsmith.org   [Cloudflare Access login gate]
    → Admin (Cloudflare Worker / Pages Function — serverless, scales to zero)
        1. Resize via Cloudflare's image-transform binding (AVIF + JPEG)
        2. PUT variants → public R2 bucket; original → private R2 bucket
        3. Commit series metadata (TEXT ONLY) → GitHub
        4. Ping Cloudflare Pages deploy hook   ← the "Rebuild" button

GitHub repo (Hugo source + per-series metadata, no binaries)
  → Cloudflare Pages build (fast — no image processing)
    → static HTML/CSS on Cloudflare's CDN

Visitor → photos.ctsmith.org  [Pages/CDN for HTML]
                              [images streamed from R2 via assets.ctsmith.org]

RAW originals → your backup drive (never enter this pipeline)
```

The Mac Mini is no longer in any request path, and there's no separate admin host to keep alive — the admin is just serverless code on Cloudflare. Everything runs on Cloudflare + GitHub, both of which you already use; no new vendor is added. Caddy, `cloudflared`, the launchd services, and the restricted `sauron` account are all retired.

---

## 2. What changes versus today

The **theme and the admin UI aesthetic stay** — this is a plumbing change, not a redesign. The pieces that actually change:

- **Photo storage** moves from `site/content/projects/<slug>/*.jpg` (in git) to Cloudflare R2 (out of git). Git keeps only `index.md` per series.
- **Hugo stops processing images.** Today `single.html` and `index.html` use `.Resources.ByType "image"`, `.Fill`, and `.Resize`. Those require the image files to live inside the Hugo bundle. In the new model the templates read a `photos` list from front matter and emit `srcset` URLs pointing at R2. The `[imaging]` block in `hugo.toml` becomes irrelevant.
- **The admin panel** moves from filesystem writes to R2 uploads, generates its variants with Cloudflare's image-transform binding, and runs as a serverless Cloudflare Worker / Pages Function instead of a process on the Mac. (If we later want Sharp's exact encoding and "keep EXIF, strip GPS" control, the same logic runs in a Cloudflare Container — see §4 and §10.)
- **The front-matter parser in `server.js`** (the regex-based `readFrontMatter`/`writeFrontMatter`) cannot represent a nested `photos:` list of objects. It must be replaced with a real YAML library (`gray-matter` + `js-yaml`).
- **The "Rebuild"/deploy action** changes from "run Hugo locally" / "git push and let Pages build" to "ping a Cloudflare Pages deploy hook." A local-preview mode stays for laptop dev.

---

## 3. Data model

Each series is a Hugo branch bundle (`_index.md`) carrying the photo manifest instead of image files; each photo also gets a tiny stub page `<id>.md` so it has its own permalink (resolved at scaffold time — see §5a):

```yaml
---
title: "Iceland 2025"
description: "Volcanic landscapes and midnight sun."
date: "2025-08-01"
draft: false
cover: "001"                 # photo id used for the homepage cover
downloadsDefault: false      # series-level default for public original downloads
photos:
  - id: "001"
    key: "iceland-2025/001"  # R2 key prefix for this photo's objects
    width: 6000              # original pixel dimensions (for srcset / lightbox)
    height: 4000
    caption: "Midnight sun over the glacier"
    downloadable: true       # per-photo override of downloadsDefault
  - id: "002"
    key: "iceland-2025/002"
    width: 4000
    height: 6000
    caption: ""
---
```

Photo order is the array order (the admin can reorder later without renaming files — a nice side benefit). The naive sort-by-filename rule goes away.

**R2 object layout, per photo** (`<bucket>/<series>/<id>/...`):

```
iceland-2025/001/original.jpg     # full-res, the "Flickr original" download
iceland-2025/001/2400.avif        # desktop lightbox
iceland-2025/001/2400.jpg         #   JPEG fallback
iceland-2025/001/1200.avif        # mid / mobile lightbox
iceland-2025/001/1200.jpg
iceland-2025/001/600.avif         # grid thumbnail
iceland-2025/001/600.jpg
```

Templates build `<img>`/`<picture>` with `srcset` from `assets.ctsmith.org/<key>/<size>.<fmt>`, so adding/removing sizes is a config + reprocess job, not a template rewrite.

---

## 4. Image pipeline — pre-bake the variants

On upload, for each photo the admin:

1. Reads the uploaded export (your processed JPEG/TIFF, not the RAW).
2. Generates **600 / 1200 / 2400 px** wide variants, each as **AVIF** (primary — best quality-per-byte for photos: ~20–50% smaller than JPEG at equal quality, with cleaner gradients and wider color) and **JPEG** (universal fallback), using **Cloudflare's image-transform binding**. WebP is intentionally omitted; AVIF + JPEG covers every modern and legacy browser, and it's easy to add later. AVIF is expensive to *encode* but cheap to *view* — Cloudflare's resizer does the encoding, so it never touches your compute budget.
3. Stores the **original** as uploaded (optionally capped at ~6000px) at `<key>/original.jpg` in the private bucket.
4. PUTs variants to the public bucket and the original to the private bucket; records `key`, `width`, `height` in the series manifest.

**Metadata / privacy.** Cloudflare's transforms treat metadata as all-or-nothing, so the default is to **strip all metadata** from published files — this guarantees no GPS leaks, at the cost of also dropping the camera/lens/exposure EXIF. If you'd rather *keep* the camera EXIF while stripping only GPS (the Flickr-style display), that needs Sharp + `exiftool`, which is the reason to choose the **Cloudflare Containers** compute option in §10 — same architecture, your own container does the processing.

Because the full-res original lives in R2, it doubles as the **reprocessing master**: if you ever change the size set, a batch job pulls originals from R2 → resizer → new variants, with no need to touch your backup drive.

---

## 5. Downloadable originals + public/private toggle

Every photo keeps a downloadable full-res original in R2. Whether the public can download it is controlled per photo (`downloadable`), with a per-series default (`downloadsDefault`). We do this with **two buckets and no Worker in the download path** — fewer moving parts and the fastest delivery:

- **Public bucket** — served by the `assets.ctsmith.org` CDN domain. Holds all web variants (always public) plus any original that's been marked downloadable.
- **Private bucket** — no public domain; reachable only by the admin via the R2 API. Holds every original by default.
- **Toggling a photo public** copies its original from the private bucket into the public one. Toggling it back deletes the public copy and purges the CDN cache.
- The gallery template shows a "Download original" control only when `downloadable: true`.
- *Your own* download of any original always works through the Access-gated admin.

Why this beats a Worker-enforced gate: "public = it's in the public bucket" is trivial to reason about and audit, there's no per-request auth logic that could accidentally leak a private file, and downloads are plain static CDN objects (free egress). The only costs are a duplicated object per public original (storage is pennies) and a cache purge on un-publish.

---

## 5a. Shareable per-photo permalinks

Each photo gets its own real page (`/projects/<slug>/<id>/`), generated by Hugo from the manifest, carrying Open Graph / Twitter-card tags so the link **unfurls with a preview** in Messages, Slack, and social — plus a caption and prev/next navigation. This is the Flickr "photo page" equivalent, on your own domain. The permalinks are stable: they key off each photo's fixed `id`, so reordering a series never breaks a shared link.

Implementation notes (and the minor downsides):

- **OG preview image must be JPEG, not AVIF.** Most link unfurlers don't render AVIF, so `og:image` points at the `1200.jpg` variant. The page itself still serves AVIF to browsers.
- **More output files** — one HTML page per photo. Hugo builds these in seconds and images stay in R2, so only small HTML files reach the Pages deployment; comfortably under Cloudflare Pages' ~20,000-file limit until you're in the many-thousands-of-photos range.
- **A URL commitment** — once links are shared, the `/projects/<slug>/<id>/` scheme is locked in. Fixed `id`s make this safe; only renaming a series slug would break inbound links (a redirect rule covers that if it ever happens).
- One extra template to maintain (a single-photo layout + an OG partial).

---

## 6. Hosting & services

**Single-hostname decision (2026-05-22):** everything is served from `photos.ctsmith.org` via one Cloudflare Pages project. No `admin.` or `assets.` subdomains. Path routing:

| Path | Served by |
|---|---|
| `/` + gallery pages | Hugo static output (Pages CDN) |
| `/admin` | Static admin UI HTML (in `site/static/admin/`) |
| `/api/*` | Pages Function — gated by Cloudflare Access |
| `/assets/*` | Pages Function — streams from R2, edge-cached |

*Trade-off vs a dedicated `assets.` subdomain:* the `/assets/*` Function adds one Function invocation per image request until the edge cache warms; after that it's pure CDN. The `/assets/*` scheme also prevents a subdomain cookie scope issue and keeps the entire project on one Pages project with zero DNS juggling. Reversible: if asset traffic ever warrants a dedicated domain, update `assetsBaseURL` in `hugo.toml` and add a CNAME — no template changes needed.

| Concern | Choice | Notes |
|---|---|---|
| Static gallery + admin UI | **Cloudflare Pages** | Already connected to the repo. Builds Hugo on push + on deploy-hook. |
| Asset serving | **Pages Function `/assets/*`** | Streams from `ASSETS_BUCKET` R2; `Cache-Control: immutable`. |
| Asset storage | **Cloudflare R2** | Two buckets: `ASSETS_BUCKET` (public variants + public originals) + `ORIGINALS_BUCKET` (private originals). No egress fees. |
| Admin backend | **Pages Functions `/api/*`** | Serverless. Resizing via Cloudflare's image-transform binding (`IMAGES`). |
| Auth | **Cloudflare Access** | Gates `/admin*` and `/api*` on `photos.ctsmith.org`. |
| Originals | **Two R2 buckets** | Copy-to-public on toggle — no Function in the download path (see §5). |
| Deploy trigger | **Pages deploy hook** | The admin "Rebuild" button POSTs to `DEPLOY_HOOK_URL`. |

**Security note:** Access gates `/admin*` and `/api*` natively — there's no separately-addressable origin to bypass. Gallery pages and `/assets/*` are intentionally public.

---

## 6a. Future option — self-host on a home server

The decoupled design stays portable, so moving to a dedicated home box later is a config change, not a rebuild — and it's cleaner than the original Mac setup ever was. The **gallery** is static Hugo output: serve `public/` with Caddy or nginx on a Linux box, expose it via Cloudflare Tunnel (no open ports), and flip `assetsBaseURL` + DNS. The **images** are portable because R2 is S3-compatible: mirror the bucket to a self-hosted store (MinIO, Garage) or serve the files locally, and change one config value. The **admin** is the only Cloudflare-specific piece *if* it's a Worker using the image-transform binding — self-hosting it then means swapping the resizer back to Sharp (the code already exists). If the admin is built as a **Cloudflare Container**, it's already a portable artifact that runs identically on Cloudflare or a home box, with zero rewrite to move.

A real Linux home server (systemd + Docker) sidesteps the macOS Sequoia BTM autostart problem entirely — that pain was Mac-specific, not inherent to self-hosting. So if a home server is a likely future, that's another point in favor of the Containers compute option in §10.

---

## 7. Implementation phases (suggested order)

**Phase 0 — Cloudflare/GitHub prep (no code). OPEN.**
Create `ASSETS_BUCKET` and `ORIGINALS_BUCKET` R2 buckets (no public custom domain needed — served via the `/assets/*` Function); confirm the Pages project and create a deploy hook (`DEPLOY_HOOK_URL`); create the Cloudflare Access application gating `/admin*` and `/api*` on `photos.ctsmith.org`; create a scoped GitHub token (`GITHUB_TOKEN`) for the admin's metadata commits; wire all bindings + secrets into the Pages project (dashboard or `wrangler.toml`).

**Phase 1 — Repo / Hugo refactor. DONE (2026-05-21/22).**
Manifest-driven templates, per-photo permalinks, `assetsBaseURL = "/assets"`, og:image absolute via `absURL`. Admin UI at `site/static/admin/index.html`. Functions skeleton scaffolded.

**Phase 1.5 — Single-host refactor + Functions skeleton. DONE (2026-05-22).**
`assetsBaseURL` changed to `/assets`; og:image made absolute; admin UI moved to Hugo static; `functions/assets/[[path]].js` (real R2 logic), `functions/api/[[route]].js` (stubbed 501), `functions/_lib/env.js`, `.dev.vars.example` all added.

**Phase 2 — Implement the Functions. OPEN.**
Replace 501 stubs in `functions/api/[[route]].js` with real logic: resize via `IMAGES` binding → PUT to R2 → update `_index.md` manifest → commit to GitHub via `GITHUB_TOKEN` → ping `DEPLOY_HOOK_URL`. Wire `downloadable` copy-to-public / CDN purge in `PATCH /api/projects/:slug/photos/:id`. Reference: `admin/server.js` (old Express implementation is the shape to port).

**Phase 3 — Deploy & verify. OPEN.**
Deploy via `wrangler pages deploy` or push to main (Pages auto-builds). Confirm `/api/*` returns real data; `/assets/*` streams from R2; `/admin` is Access-gated; gallery pages are public.

**Phase 4 — Cutover. OPEN.**
Re-upload series through the new admin (variants → `ASSETS_BUCKET`; originals → `ORIGINALS_BUCKET`; manifests commit to git). Point `photos.ctsmith.org` at Pages. Decommission the Mac.

**Phase 5 — Cleanup. OPEN.**
Delete dead infrastructure (see §8); update CLAUDE.md final state.

---

## 8. What gets retired / deleted

- `Caddyfile` and the Caddy service.
- `cloudflared` tunnel + its launchd service + credentials.
- The launchd plists and all the BTM/autostart workarounds (the entire "Active debugging" section in `CLAUDE.md`).
- `scripts/setup.sh` (Mac-server bootstrap) and `scripts/teardown-sauron.sh` once migration is done; `scripts/initial-commit.sh` (already flagged).
- The restricted `sauron` server account plan.
- `wrangler.toml` if unused (or repurposed for the new Worker).
- The Apache-on-port-8000 workaround.

---

## 9. Cost

Roughly **$0–3/month total.** Pages is free. R2 storage is ~$0.015/GB-month with **no egress fees** — even with full-res originals, tens of GB is well under a dollar, and downloads are free bandwidth. The admin Worker runs within the Workers free tier for personal use, and image transforms have a free monthly allowance — pre-baking means one transform per size per photo, so you stay well inside it. Cloudflare Access is free up to 50 users. Domain already owned.

---

## 10. Open decisions (need your call)

1. **Admin compute — DECIDED:** Cloudflare Worker / Pages Function with Cloudflare's image-transform binding — no new vendor, nothing to keep alive. *Fallback if you later want Sharp's exact encoding + "keep camera EXIF, strip GPS":* run the same logic in a **Cloudflare Container** (still all-Cloudflare). Action: confirm Containers is enabled on the account before relying on it.
2. **Originals — DECIDED:** copy-to-public via two R2 buckets; no Worker in the path.
3. **Variant sizes — DECIDED:** 600 / 1200 / 2400 px, reprocessable later from the R2 originals.
4. **Format & metadata — DECIDED (reversible):** AVIF + JPEG, no WebP. Published files have **all metadata stripped** by default (privacy-first; protects GPS). To instead keep camera EXIF and strip only GPS, choose the Containers option in (1).
5. **Hostnames — DECIDED (2026-05-22):** single hostname `photos.ctsmith.org` only. No `admin.` or `assets.` subdomains. Paths: `/admin` (UI), `/api/*` (Functions, Access-gated), `/assets/*` (R2 stream Function, public). See §6 for trade-off notes.
