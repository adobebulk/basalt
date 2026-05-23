# CLAUDE.md — static-photos

Context file for both Cowork and Claude Code. Keep this up to date as the project evolves.

> **Architecture redesigned 2026-05-21, single-host decision 2026-05-22.** The project moved from a Mac-Mini-as-hub model to a **decoupled (Jamstack) architecture**: build the site from code, store the heavy assets in object storage, run the admin as serverless code. Everything is served from **one hostname** (`photos.ctsmith.org`) via a single Cloudflare Pages project. Migration is complete — this file is the authoritative working summary.

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

The Mac Mini is **out of the serving/admin path entirely** — Caddy, `cloudflared`, launchd, and the `sauron` server account are all retired.

---

## Documentation hygiene — ENFORCED

Every commit that changes behaviour (feature, fix, refactor) **must** include all of the following in the same commit. No exceptions.

1. **Version bump** — increment `package.json` version and `wrangler.toml [vars] PACKAGE_VERSION` together (minor bump for features, patch for fixes).
2. **CLAUDE.md** — update Hugo template notes, data models, API table, known issues, current state, and version number in the Versioning section. If a TODO is done, remove it.
3. **README.md** — update the version line and any section that describes changed behaviour.
4. **Delete unused files** — remove any file that is no longer referenced.

This is not optional clean-up. A commit that skips any of these is incomplete. Claude Code sessions must treat docs and versioning as part of the same unit of work as the code change.

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
| Image processing | Cloudflare Transform via Workers | `fetch(url, { cf: { image: {...} } })` — 600/1200/2400px AVIF + JPEG; strips all metadata. Source URL must use R2 custom domain (`r2.photos.ctsmith.org`) — cf.image is not applied on same-zone Worker→Worker subrequests. |
| Admin backend | Pages Functions (`/api/*`) | Serverless. Existing monospace admin UI kept; backend rewritten to talk to R2 + GitHub. |
| Admin UI | Static HTML at `/admin` | `site/static/admin/index.html` — served by Pages, gated by Access. |
| Auth | Cloudflare Access | Gates `/admin*` and `/api*` on `photos.ctsmith.org`. |
| Deploy trigger | Cloudflare Pages deploy hook | The admin "Rebuild" button POSTs to `DEPLOY_HOOK_URL`. |

---

## Directory structure

```
static-photos/
├── CLAUDE.md                   ← you are here (working summary)
├── RUNBOOK.md                  ← Cloudflare/GitHub account setup guide
├── README.md                   ← orientation for developers
├── .dev.vars.example           ← copy to .dev.vars for local wrangler dev
├── package.json                ← root: Tailwind + dev scripts
├── tailwind.config.js          ← scans site/themes/gallery/layouts/**
├── wrangler.toml               ← Pages project config + R2 bindings
├── functions/                  ← Cloudflare Pages Functions
│   ├── _lib/
│   │   ├── env.js              ← central binding/var registry (getEnv helper)
│   │   ├── github.js           ← GitHub Trees API — atomic multi-file commits
│   │   ├── manifest.js         ← front-matter parse/serialize, slugify, ID helpers
│   │   └── staging.js          ← _pending/ staging layer
│   ├── assets/[[path]].js      ← R2 stream handler (edge-cached)
│   └── api/[[route]].js        ← admin API router
├── admin/
│   └── public/
│       └── index.html          ← admin UI source (keep in sync with site/static/admin/)
├── scripts/
│   └── rebuild.sh              ← local Hugo preview shortcut
└── site/                       ← Hugo site root (run hugo --source site)
    ├── hugo.toml               ← assetsBaseURL = "/assets"; baseURL = production domain
    ├── data/settings.yaml      ← site title, navLabel, photographer, description
    ├── assets/css/input.css
    ├── static/
    │   ├── css/style.css
    │   └── admin/index.html    ← admin UI served at /admin (keep in sync with admin/public/)
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

## Versioning

Source of truth is `package.json`. When bumping the version, update `package.json` **and** `wrangler.toml [vars] PACKAGE_VERSION` together. `site/data/version.yaml` is generated at build time by `scripts/write-version.js` — do not commit it (it is gitignored). Current version: **1.2.3**

---

## Data models

### Series / photo manifest

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
    body: |                  # optional long-form markdown; shown on per-photo permalink
      The light at 2am was unlike anything I'd seen.
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

**On upload** the admin: resizes to 600/1200/2400px AVIF + JPEG via Transform via Workers (source = R2 custom domain); strips all metadata (privacy-first — protects GPS, also drops camera EXIF); PUTs variants to ASSETS_BUCKET and original to ORIGINALS_BUCKET; stages the updated manifest to `_pending/` in ORIGINALS_BUCKET. Changes reach GitHub only when the admin "Rebuild" button is pressed (`POST /api/rebuild` → `flushStaging` → one commit → deploy hook).

**Downloadable originals:** the original lives in ORIGINALS_BUCKET. Marking a photo `downloadable` copies it into ASSETS_BUCKET; un-marking deletes the public copy and purges the CDN cache. No Worker sits in the download path — the original is a plain CDN object once public.

### Text posts

Pure markdown content pages — no photos required. Hugo leaf bundles under `site/content/posts/<slug>/index.md`. All staged to `_pending/` in ORIGINALS_BUCKET like series.

```yaml
---
title: "On Shooting in Flat Light"
date: "2026-05-23"
draft: false
featured: false
excerpt: ""
---
Full markdown body here...
```

Staging helpers in `functions/_lib/staging.js`: `getStagedPostSlugs`, `isStagedPostDeleted`.

### Site settings (`site/data/settings.yaml`)

```yaml
title: "Photos"
navLabel: "Work"
photographer: "Your Name"
description: "A photo gallery"
heroPhotoKey: ""      # "<series-slug>/<photo-id>" — parsed at build time to derive caption + permalink
heroLink: ""          # unused (permalink is always derived from heroPhotoKey); kept for backwards compat
featured: []          # ordered list of { type: "series"|"post"|"photo", slug, label, photoId? }
```

---

## Admin API

| Method | Path | Description |
|---|---|---|
| GET | `/api/projects` | List all series (from manifests) |
| POST | `/api/projects` | Create series `{ title, description }` |
| GET | `/api/projects/:slug/photos` | List photos in a series |
| POST | `/api/projects/:slug/photos` | Upload photos → resize → R2 → manifest |
| PATCH | `/api/projects/:slug/photos/:id` | Edit `{ caption, body, downloadable }`, reorder |
| DELETE | `/api/projects/:slug/photos/:id` | Delete a photo (all R2 objects + manifest entry) |
| PATCH | `/api/projects/:slug` | Update metadata `{ title, description, cover, draft, downloadsDefault }` |
| POST | `/api/projects/:slug/publish` | Publish/unpublish `{ draft: bool }` |
| POST | `/api/rebuild` | Flush staged changes → GitHub commit + ping Pages deploy hook |
| GET | `/api/settings` | Read `site/data/settings.yaml` |
| PATCH | `/api/settings` | Update settings (merges; does not wipe missing keys) |
| GET | `/api/posts` | List all posts (GitHub + staging, exclude staged-deleted) |
| POST | `/api/posts` | Create post `{ title, body, excerpt, featured }` |
| GET | `/api/posts/:slug` | Get one post (front matter + body) |
| PATCH | `/api/posts/:slug` | Update `{ title, body, excerpt, featured, draft }` |
| DELETE | `/api/posts/:slug` | Delete post |
| POST | `/api/posts/:slug/publish` | Toggle draft `{ draft: bool }` |
| GET | `/api/version` | Returns `{ version }` from `PACKAGE_VERSION` env var |

All routes implemented in `functions/api/[[route]].js`. Write routes stage to `_pending/` (ORIGINALS_BUCKET); `POST /api/rebuild` calls `flushStaging()` then pings the deploy hook.

---

## Hugo template notes

- **No build-time image processing.** Templates read the `photos` manifest and emit `srcset` URLs at `{{ .Site.Params.assetsBaseURL }}/<key>/<size>.<fmt>` → `/assets/...` — they do not use `.Resources`, `.Fill`, or `.Resize`.
- **og:image / twitter:image** must be absolute. `og.html` uses `absURL` on the root-relative asset path to produce `https://photos.ctsmith.org/assets/<key>/1200.jpg`. (Always JPEG, never AVIF — unfurlers don't render AVIF.)
- **Homepage** (`index.html`): 4 sections — hero, featured row, series grid, recent posts strip.
  - Hero: `heroPhotoKey` is split on `/` to get `<series-slug>/<photo-id>`; series page is looked up via `site.GetPage` to find the photo's caption; clicking the hero goes to `/projects/<slug>/<id>/` (always derived, never from `heroLink`); caption renders as a gradient overlay if present.
  - Featured row: supports `type: series`, `post`, or `photo`. Photo type looks up the photo in the series manifest and links to the photo permalink. Recent posts strip deduplicates against featured posts.
- **Series page** (`projects/section.html`): grid thumbnails (600) + PhotoSwipe full (2400). First 6 eager, rest lazy. Photos with a `body` show a `✦` badge; clicking opens the lightbox; "Full post →" link appears in the lightbox when the current photo has body text.
- **Per-photo permalink** (`projects/single.html`): `/projects/<slug>/<id>/` — "← Series Title" back link at top; photo is wrapped in a PhotoSwipe anchor (single-item gallery, same CDN and init pattern as series page); prev/next navigation between photos in the series; conditional download link; optional `body` rendered as markdown below.
- **Posts list** (`posts/list.html`): `/posts/` — published posts with title, date, excerpt.
- **Post page** (`posts/single.html`): full-width readable layout, `{{ .Content }}` rendered by Hugo.
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

- [ ] Phase 0: wire Cloudflare/GitHub account bindings for production (see RUNBOOK.md).
- [ ] Admin UI: drag-to-reorder photos (currently up/down arrows; pointer drag would be smoother).

---

## Current state (last updated: 2026-05-23)

### v1.2.3 — CURRENT
- Hero image: caption overlay from photo manifest; click always goes to photo permalink (derived from `heroPhotoKey`, not `heroLink`)
- Photo permalink page: "← Series Title" back link; clicking the photo opens PhotoSwipe (single-item gallery, same pattern as series page); prev/next navigation
- Admin: feature button on every photo card shows live state ("Featured ✓" badge + "Remove" when featured, "✦ Feature" when not); in-place UI update on toggle without panel reload; `panelSettings` cached per panel open; caption helper text below caption input
- Fix: `serializeFrontMatter` now emits a blank line between closing `---` and body, so Hugo renders post body as markdown (was missing the blank line separator)
- Fix: install `@tailwindcss/typography` plugin and wire into `tailwind.config.js` so `prose` classes (headings, lists, code blocks, etc.) actually render in post and photo body text
- Fix: "Full post →" in PhotoSwipe lightbox is now a styled pill button (frosted glass, border, bold text) centered above the UI bar rather than a plain underlined link that could be missed

### v1.1.0
- Lightbox "Full post →" link in PhotoSwipe when current photo has body text (`data-has-body` attribute + `uiRegister` hook)
- Hero configuration moved from Settings overlay to series detail panel; hero dropdown + Set/Clear buttons
- Featured `photo` type (single photo card on homepage) with `photoId`; "✦ Feature" shortcut on photo cards
- Date format standardised to `YYYY-MM-DD` across all templates
- Mobile CSS: `@media (max-width: 480px)` with 44 px touch targets, stacked layouts, iOS zoom prevention

### v1.0.0
- Hugo manifest-driven templates, per-photo permalinks, no build-time image processing
- Pages Functions: full admin API, R2 asset streaming, staging layer (`_pending/`), Transform via Workers via R2 custom domain
- Semantic versioning (package.json → wrangler.toml → site/data/version.yaml); footer version display
- Photo body text; text posts content type; homepage hero + featured row + recent posts strip
- Admin: batch upload, client-side pre-compression, full CRUD, posts tab, settings panel, photo reorder

### Phase 0 — OPEN (account setup)
Create ASSETS_BUCKET and ORIGINALS_BUCKET R2 buckets; configure R2 custom domain; configure Pages deploy hook; create Cloudflare Access application gating `/admin*` and `/api*`; create scoped GitHub token; wire all bindings/secrets into the Pages project. See **RUNBOOK.md**.

### Retired
Mac-Mini hosting stack (Caddy, cloudflared tunnel, launchd, sauron account), Express admin server (`admin/server.js`), `DEPLOYMENT-PLAN.md`, Mac setup scripts — all deleted. Detail preserved in git history.
