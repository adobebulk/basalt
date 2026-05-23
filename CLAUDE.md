# CLAUDE.md — static-photos

Context file for both Cowork and Claude Code. Keep this up to date as the project evolves.

> **Architecture redesigned 2026-05-21, single-host decision 2026-05-22.** The project moved from a Mac-Mini-as-hub model to a **decoupled (Jamstack) architecture**: build the site from code, store the heavy assets in object storage, run the admin as serverless code. Everything is served from **one hostname** (`photos.ctsmith.org`) via a single Cloudflare Pages project. The full migration plan, rationale, and open decisions live in **`DEPLOYMENT-PLAN.md`** — read that first. This file is the working summary.

---

## What this is

A self-hosted photo gallery for an amateur photographer. A fast **static Hugo site** for visitors, plus a private **serverless admin** for managing photos from anywhere (phone or laptop). Everything runs on **Cloudflare + GitHub** (both already in use) — no new vendor, and no always-on server to babysit. The owner keeps RAW originals on a personal backup drive; only web-ready exports enter the pipeline.

**Repo:** https://github.com/adobebulk/static-photos

---

## Target architecture

```
You (phone / laptop, anywhere)
  → photos.ctsmith.org/admin     [Cloudflare Access login gate]
    → Pages Function (/api/*)    [admin backend — serverless, scales to zero]
        1. Resize via Cloudflare's image-transform binding (AVIF + JPEG, strip all metadata)
        2. PUT variants → ASSETS_BUCKET (public R2); original → ORIGINALS_BUCKET (private R2)
        3. Commit series metadata (TEXT ONLY) → GitHub
        4. Ping Cloudflare Pages deploy hook   ← the "Rebuild" button

GitHub repo (Hugo source + per-series manifest, NO binaries)
  → Cloudflare Pages build (fast — no image processing)
    → static HTML/CSS + Functions on Cloudflare's CDN

Visitor → photos.ctsmith.org          [Pages / CDN for HTML]
  → photos.ctsmith.org/assets/*       [Pages Function → R2 stream, edge-cached]

RAW originals → personal backup drive (never enter this pipeline)
```

**Single hostname.** Everything is `photos.ctsmith.org` — no `admin.` or `assets.` subdomains:

| Path | What serves it |
|---|---|
| `/` and all gallery pages | Hugo static output (Cloudflare Pages CDN) |
| `/admin` | Static admin UI HTML (served by Pages from `site/static/admin/`) |
| `/api/*` | Pages Function (`functions/api/[[route]].js`) — gated by Cloudflare Access |
| `/assets/*` | Pages Function (`functions/assets/[[path]].js`) — streams from R2, edge-cached |

Cloudflare Access is configured to gate `/admin*` and `/api*`; gallery pages and `/assets/*` are public.

The Mac Mini is **out of the serving/admin path entirely** — Caddy, `cloudflared`, launchd, and the `sauron` server account are all retired. The design stays portable: see "Future option — self-host" in `DEPLOYMENT-PLAN.md` §6a.

---

## Tech stack

| Layer | Tech | Notes |
|---|---|---|
| Static site | Hugo (extended) | `brew install hugo`. No longer processes images at build. |
| CSS | Tailwind CSS v3 | Built via CLI, not PostCSS |
| Lightbox | PhotoSwipe v5 | Loaded from jsDelivr CDN |
| Hosting | Cloudflare Pages | Builds Hugo on push + on deploy-hook. Free tier. |
| Asset serving | Pages Function `/assets/*` | Streams from R2; edge-cached immutably. |
| Asset storage | Cloudflare R2 | Two buckets: `ASSETS_BUCKET` (public variants + public originals) + `ORIGINALS_BUCKET` (all originals, private). No egress fees. |
| Image processing | Cloudflare image-transform binding (`IMAGES`) | Pre-bakes 600/1200/2400px AVIF + JPEG; strips all metadata. |
| Admin backend | Pages Functions (`/api/*`) | Serverless. Existing monospace admin UI kept; backend rewritten to talk to R2 + GitHub. |
| Admin UI | Static HTML at `/admin` | `site/static/admin/index.html` — served by Pages, gated by Access. |
| Auth | Cloudflare Access | Gates `/admin*` and `/api*` on `photos.ctsmith.org`. |
| Deploy trigger | Cloudflare Pages deploy hook | The admin "Rebuild" button POSTs to `DEPLOY_HOOK_URL`. |

---

## Directory structure

```
static-photos/
├── CLAUDE.md                   ← you are here (working summary)
├── DEPLOYMENT-PLAN.md          ← full migration plan + rationale + open decisions
├── .dev.vars.example           ← copy to .dev.vars for local wrangler dev
├── package.json                ← root: Tailwind + dev scripts
├── tailwind.config.js          ← scans site/themes/gallery/layouts/**
├── wrangler.toml               ← Pages project config + R2 bindings (Phase 0)
├── functions/                  ← Cloudflare Pages Functions
│   ├── _lib/env.js             ← central binding/var registry (getEnv helper)
│   ├── assets/[[path]].js      ← R2 stream handler (edge-cached)
│   └── api/[[route]].js        ← admin API router (stubbed → Phase 2)
├── admin/
│   ├── server.js               ← OLD Express server (reference only; being replaced)
│   └── public/
│       └── index.html          ← admin UI source (monospace catalog aesthetic — KEEP)
└── site/                       ← Hugo site root (run hugo --source site)
    ├── hugo.toml               ← assetsBaseURL = "/assets"; baseURL = production domain
    ├── assets/css/input.css
    ├── static/
    │   ├── css/style.css
    │   └── admin/index.html    ← admin UI served at /admin (copied from admin/public/)
    ├── content/projects/
    │   ├── _index.md
    │   └── <series-slug>/      ← branch bundle
    │       ├── _index.md       ← manifest: front matter + photos[] (NO image files)
    │       └── <id>.md         ← per-photo permalink stub (photoid only)
    └── themes/gallery/layouts/
        ├── index.html           ← homepage: series grid (manifest-driven)
        ├── 404.html
        ├── projects/
        │   ├── section.html    ← series page: photo grid + PhotoSwipe (R2 srcset)
        │   └── single.html     ← per-photo permalink + OG tags
        └── partials/{head.html, header.html, og.html, getphoto.html}
```

**Retired / deletable** (carry-overs from the Mac-hub design): `Caddyfile`, `scripts/setup.sh`, `scripts/initial-commit.sh`, `scripts/teardown-sauron.sh`. `scripts/rebuild.sh` stays useful for local preview.

---

## Key commands

```bash
# Local dev: Tailwind watch + Hugo live server → http://localhost:1313
npm run dev

# Production build (CI / Cloudflare Pages runs this)
npm run build            # tailwind --minify && hugo --source site --minify

# Local Pages Functions dev (stubs return 501; /assets/* errors without R2 binding)
npx wrangler pages dev site/public

# Live admin Worker logs (production)
npx wrangler tail
```

Publishing photos happens through the **admin UI** (at `photos.ctsmith.org/admin`, gated by Cloudflare Access), not the CLI.

---

## Series / photo data model

Each series is a Hugo **branch bundle** (`_index.md`) carrying a **manifest** instead of image files (no binaries in git). Each photo additionally gets a tiny stub page `<id>.md` (just `photoid: "<id>"`) so it has its own permalink; all photo data is still read from the manifest (single source of truth):

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
    width: 6000              # original pixel dimensions (srcset / lightbox / OG)
    height: 4000
    caption: "Midnight sun over the glacier"
    downloadable: true       # per-photo override of downloadsDefault
---
```

Photo order = array order (reorder freely without renaming; permalinks key off the fixed `id`).

**R2 object layout, per photo** (`<series>/<id>/...`):

```
iceland-2025/001/original.jpg   # full-res (ORIGINALS_BUCKET by default; ASSETS_BUCKET if downloadable)
iceland-2025/001/2400.avif  2400.jpg   # desktop lightbox
iceland-2025/001/1200.avif  1200.jpg   # mid / mobile lightbox + OG preview (use .jpg)
iceland-2025/001/600.avif   600.jpg    # grid thumbnail
```

**On upload** the admin: resizes to 600/1200/2400px AVIF + JPEG via Cloudflare's image binding; strips all metadata (privacy-first — protects GPS, also drops camera EXIF); PUTs variants to ASSETS_BUCKET and original to ORIGINALS_BUCKET; updates the manifest; commits text to GitHub; pings the deploy hook.

**Downloadable originals:** the original lives in ORIGINALS_BUCKET. Marking a photo `downloadable` copies it into ASSETS_BUCKET; un-marking deletes the public copy and purges the CDN cache. No Worker sits in the download path — the original is a plain CDN object once public.

---

## Admin API

| Method | Path | Description |
|---|---|---|
| GET | `/api/projects` | List all series (from manifests) |
| POST | `/api/projects` | Create series `{ title, description }` |
| GET | `/api/projects/:slug/photos` | List photos in a series |
| POST | `/api/projects/:slug/photos` | Upload photos → resize → R2 → manifest |
| PATCH | `/api/projects/:slug/photos/:id` | Edit `{ caption, downloadable }`, reorder |
| DELETE | `/api/projects/:slug/photos/:id` | Delete a photo (all R2 objects + manifest entry) |
| PATCH | `/api/projects/:slug` | Update metadata `{ title, description, cover, draft, downloadsDefault }` |
| POST | `/api/projects/:slug/publish` | Publish/unpublish `{ draft: bool }` |
| POST | `/api/deploy` | Commit manifest changes → GitHub + ping Pages deploy hook |

All routes implemented in `functions/api/[[route]].js` (currently stubbed 501 → Phase 2).

---

## Hugo template notes

- **No build-time image processing.** Templates read the `photos` manifest and emit `srcset` URLs at `{{ .Site.Params.assetsBaseURL }}/<key>/<size>.<fmt>` → `/assets/...` — they do not use `.Resources`, `.Fill`, or `.Resize`.
- **og:image / twitter:image** must be absolute. `og.html` uses `absURL` on the root-relative asset path to produce `https://photos.ctsmith.org/assets/<key>/1200.jpg`. (Always JPEG, never AVIF — unfurlers don't render AVIF.)
- **Homepage** (`index.html`): lists series via `(site.GetPage "/projects").Sections`; cover = manifest `cover` id → `<key>/600.jpg`; photo count = `len .Params.photos`.
- **Series page** (`projects/section.html`): grid thumbnails (600) + PhotoSwipe full (2400). First 6 eager, rest lazy.
- **Per-photo permalink** (`projects/single.html`): `/projects/<slug>/<id>/` with OG tags + prev/next + conditional download link.
- Run Hugo as `hugo --source site` from repo root.

---

## Logging

```bash
npx wrangler tail        # live Pages Function logs (production)
```

During local `wrangler pages dev`, logs print to the terminal.

---

## Security model

- **Cloudflare Access** gates `/admin*` and `/api*` natively on `photos.ctsmith.org`. Because these are Pages Functions, there's no separately-addressable origin to bypass.
- **ASSETS_BUCKET** (public) serves only finished web variants + originals explicitly marked downloadable. **ORIGINALS_BUCKET** (private, no public domain) holds all originals.
- **Scoped GitHub token** for the admin's metadata commits — limited to this repo.
- **All metadata stripped** from published files by default (no GPS leaks).
- RAW originals never enter the pipeline; they stay on the personal backup drive.

---

## Cowork vs Claude Code — who does what

| Task | Tool |
|---|---|
| New features, redesigns, architecture decisions | **Cowork** |
| Live dev loop: template edits, CSS tweaks, Functions debugging | **Claude Code** in terminal |
| Upload photos, manage series | **Admin UI** (`photos.ctsmith.org/admin`) |
| Git commits, running scripts, installing packages, `wrangler` deploys | **Claude Code** |
| Updating this CLAUDE.md | Whoever makes the change |

**Important:** Don't run Cowork and Claude Code git operations simultaneously — `.git/index.lock` conflict.

---

## Known issues / TODO

- [ ] **Confirm Cloudflare Containers availability** — only needed if we want "keep camera EXIF, strip GPS"; otherwise Worker + strip-all path stands.
- [ ] Wire EXIF/GPS handling per the chosen compute path.
- [ ] Drag-to-reorder photos in the admin (manifest array order makes this clean).
- [ ] Delete retired files once migration is proven (`Caddyfile`, Mac setup scripts).
- [ ] Keep `site/static/admin/index.html` in sync with `admin/public/index.html` until the old server.js is fully retired.

---

## Open decisions (see DEPLOYMENT-PLAN.md §10)

1. **Admin compute — DECIDED:** Cloudflare Pages Functions + image-transform binding.
2. **Originals — DECIDED:** copy-to-public via two R2 buckets; no Function in the download path.
3. **Variant sizes — DECIDED:** 600 / 1200 / 2400 px.
4. **Format / metadata — DECIDED (reversible):** AVIF + JPEG; strip all metadata by default.
5. **Hostnames — DECIDED:** single hostname `photos.ctsmith.org`; paths `/admin`, `/api/*`, `/assets/*`.

---

## Current state (last updated: 2026-05-22)

### Phase 1 — DONE (committed + pushed)
Hugo refactored: manifest-driven templates, per-photo permalinks, no build-time image processing, Iceland 2025 fixture. assetsBaseURL changed to `/assets` (same-origin). og:image absolute via `absURL`. Admin UI copied to `site/static/admin/index.html` (served at `/admin` by Pages).

### Phase 1.5 — DONE (this session)
Single-host refactor + Pages Functions skeleton:
- `site/hugo.toml`: `assetsBaseURL = "/assets"`
- `partials/og.html`: `absURL` for og:image/twitter:image
- `site/static/admin/index.html`: admin UI in Hugo static output (served at `/admin`)
- `functions/assets/[[path]].js`: real R2 stream logic (ASSETS_BUCKET binding required)
- `functions/api/[[route]].js`: full route table stubbed with 501 + TODO comments
- `functions/_lib/env.js`: binding/var registry
- `.dev.vars.example`: documents all required vars for local dev

### Phase 0 — OPEN (needs Cloudflare/GitHub account)
Create ASSETS_BUCKET and ORIGINALS_BUCKET R2 buckets; configure Pages deploy hook; create Cloudflare Access application gating `/admin*` and `/api*`; create scoped GitHub token; wire all bindings/secrets into the Pages project.

### Phase 2 — OPEN (implement the Functions)
Replace 501 stubs in `functions/api/[[route]].js` with real logic: resize via IMAGES binding → PUT to R2 → update manifest → commit to GitHub → ping deploy hook. Wire downloadable copy-to-public/purge logic. Reference: `admin/server.js` (old Express implementation).

### Retired (no longer relevant)
The Mac-Mini hosting stack — Caddy, `cloudflared` tunnel, launchd services, the `sauron` server account, and the macOS Sequoia BTM autostart debugging — is all moot. Detail preserved in git history.
