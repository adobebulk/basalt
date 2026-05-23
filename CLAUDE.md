# CLAUDE.md — static-photos

Context file for both Cowork and Claude Code. Keep this up to date as the project evolves.

> **Architecture redesigned 2026-05-21.** The project moved from a Mac-Mini-as-hub model to a **decoupled (Jamstack) architecture**: build the site from code, store the heavy assets in object storage, run the admin as serverless code. The full migration plan, rationale, and open decisions live in **`DEPLOYMENT-PLAN.md`** — read that first. This file is the working summary the scaffold should target.

---

## What this is

A self-hosted photo gallery for an amateur photographer. A fast **static Hugo site** for visitors, plus a private **serverless admin** for managing photos from anywhere (phone or laptop). Everything runs on **Cloudflare + GitHub** (both already in use) — no new vendor, and no always-on server to babysit. The owner keeps RAW originals on a personal backup drive; only web-ready exports enter the pipeline.

**Repo:** https://github.com/adobebulk/static-photos

---

## Target architecture

```
You (phone / laptop, anywhere)
  → admin.ctsmith.org            [Cloudflare Access login gate]
    → Admin (Cloudflare Worker / Pages Function — serverless, scales to zero)
        1. Resize via Cloudflare's image-transform binding (AVIF + JPEG)
        2. PUT variants → public R2 bucket ; original → private R2 bucket
        3. Commit series metadata (TEXT ONLY) → GitHub
        4. Ping Cloudflare Pages deploy hook   ← the "Rebuild" button

GitHub repo (Hugo source + per-series manifest, NO binaries)
  → Cloudflare Pages build (fast — no image processing)
    → static HTML/CSS on Cloudflare's CDN

Visitor → photos.ctsmith.org      [Pages / CDN for HTML]
                                  [images streamed from R2 via assets.ctsmith.org]

RAW originals → personal backup drive (never enter this pipeline)
```

The Mac Mini is **out of the serving/admin path entirely** — Caddy, `cloudflared`, launchd, and the `sauron` server account are all retired. The design stays portable: see "Future option — self-host" in `DEPLOYMENT-PLAN.md` §6a.

---

## Tech stack

| Layer | Tech | Notes |
|---|---|---|
| Static site | Hugo (extended) | `brew install hugo`. No longer processes images at build. |
| CSS | Tailwind CSS v3 | Built via CLI, not PostCSS |
| Lightbox | PhotoSwipe v5 | Loaded from jsDelivr CDN |
| Hosting (gallery) | Cloudflare Pages | Builds Hugo on push + on deploy-hook. Free tier. |
| Asset storage | Cloudflare R2 | Two buckets: public (variants + public originals) + private (originals). No egress fees. |
| Image processing | Cloudflare image-transform binding | Pre-bakes 600/1200/2400px AVIF + JPEG. (Sharp + exiftool only if we take the Containers route — see Open decisions.) |
| Admin | Cloudflare Worker / Pages Function | Serverless. Existing monospace admin UI kept; backend rewritten to talk to R2 + GitHub. |
| Auth | Cloudflare Access | Self-hosted application gating the admin. |
| Deploy trigger | Cloudflare Pages deploy hook | The admin "Rebuild" button POSTs to it. |

---

## Directory structure (target after scaffold)

```
static-photos/
├── CLAUDE.md               ← you are here (working summary)
├── DEPLOYMENT-PLAN.md      ← full migration plan + rationale + open decisions
├── README.md               ← user-facing setup guide
├── package.json            ← root: Tailwind + dev scripts
├── tailwind.config.js      ← scans site/themes/gallery/layouts/**
├── wrangler.toml           ← Cloudflare Worker (admin) config + R2 bindings
├── admin/
│   ├── worker.js           ← admin backend (Worker): uploads → R2, manifest → GitHub, deploy hook
│   └── public/
│       └── index.html      ← admin UI (monospace catalog aesthetic, US Graphics inspired — KEEP)
└── site/                   ← Hugo site root (run hugo --source site)
    ├── hugo.toml           ← + assetsBaseURL param (R2 image domain)
    ├── assets/css/input.css
    ├── static/css/style.css
    ├── content/projects/
    │   ├── _index.md
    │   └── <series-slug>/        ← branch bundle
    │       ├── _index.md   ← manifest: front matter + photos[] (NO image files)
    │       └── <id>.md     ← per-photo permalink stub (photoid only); admin generates these
    └── themes/gallery/layouts/
        ├── index.html       ← homepage: grid of series covers (reads manifest, not .Resources)
        ├── 404.html
        ├── projects/
        │   ├── section.html ← series page: photo grid + PhotoSwipe (R2 srcset)
        │   └── single.html  ← per-photo permalink page w/ Open Graph tags
        └── partials/{head.html, header.html, og.html, getphoto.html}
```

**Retired / deletable** (carry-overs from the Mac-hub design): `Caddyfile`, `scripts/setup.sh`, `scripts/initial-commit.sh`, `scripts/teardown-sauron.sh`. `scripts/rebuild.sh` stays useful for local preview.

---

## Key commands

```bash
# Local dev: Tailwind watch + Hugo live server → http://localhost:1313
npm run dev

# Local admin (Worker) dev with Wrangler → talks to R2 (or a local mock)
npx wrangler dev admin/worker.js

# Production build of the static site (CI / Cloudflare Pages runs this)
npm run build            # tailwind --minify && hugo --source site --minify

# Deploy the admin Worker
npx wrangler deploy
```

Publishing photos happens through the **admin UI** (at `admin.ctsmith.org`, gated by Cloudflare Access), not the CLI. The admin's "Rebuild" button pings the Pages deploy hook; there is nothing to start at boot anywhere.

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
iceland-2025/001/original.jpg   # full-res "download original" (private bucket by default)
iceland-2025/001/2400.avif  2400.jpg   # desktop lightbox
iceland-2025/001/1200.avif  1200.jpg   # mid / mobile lightbox + OG preview (use the .jpg)
iceland-2025/001/600.avif   600.jpg    # grid thumbnail
```

**On upload** the admin: resizes to 600/1200/2400px AVIF + JPEG via Cloudflare's image binding; strips metadata (privacy-first default — protects GPS, also drops camera EXIF); PUTs variants to the public bucket and the original to the private bucket; updates the manifest; commits text to GitHub; pings the deploy hook.

**Downloadable originals:** the original lives in the private bucket. Marking a photo `downloadable` copies it into the public bucket ("copy-to-public" — no Worker in the download path); un-publishing deletes the public copy and purges the CDN cache. The original also serves as the **reprocessing master** if the variant sizes ever change.

---

## Admin API (target — to be (re)built on the Worker)

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

The existing Express routes in the old `server.js` are the reference shape; the Worker rewrite swaps filesystem + local-Hugo for R2 + deploy-hook.

---

## Hugo template notes

- **No build-time image processing.** Templates read the `photos` manifest and emit `srcset` URLs at `{{ .Site.Params.assetsBaseURL }}/<key>/<size>.<fmt>` — they no longer use `.Resources`, `.Fill`, or `.Resize`.
- **Homepage** (`index.html`): lists series via `(site.GetPage "/projects").Sections`; cover = manifest `cover` id → `<key>/600.jpg`; photo count = `len .Params.photos`.
- **Series page** (`projects/section.html`): grid thumbnails (600) + PhotoSwipe full (2400, with 1200 for mobile). First 6 eager, rest lazy. Conditional "Download original" link when a photo is downloadable.
- **Per-photo permalink** (`projects/single.html`): page at `/projects/<slug>/<id>/` with Open Graph tags. **`og:image` must point at the JPEG variant (1200.jpg), not AVIF** — most link unfurlers don't render AVIF. **Resolved at scaffold:** series are branch bundles and each photo is a stub `<id>.md`; the `getphoto.html` partial resolves the photo from the parent manifest, keeping the manifest the single source of truth.
- **Tailwind**: theme uses `group` / `group-hover:`; custom utilities (`scale-102`, `scale-103`, `duration-400`) in `tailwind.config.js`.
- Run Hugo as `hugo --source site` from repo root.

---

## Logging

The admin is serverless, so logs go to Cloudflare, not a local file:

```bash
npx wrangler tail        # live admin Worker logs
```

(During local `wrangler dev`, logs print to the terminal.) This replaces the old `logs/admin.log`.

---

## Security model

- **Cloudflare Access** gates the admin natively. Because the admin is a Worker/Pages Function, there's no separately-addressable origin to hit directly and bypass the login.
- **Public R2 bucket** serves only finished web variants + originals explicitly marked downloadable. **Private R2 bucket** (no public domain) holds all originals; reachable only via the admin's R2 credentials.
- **Scoped GitHub token** for the admin's metadata commits — limited to this repo.
- **Metadata stripped** from published files by default (no GPS leaks).
- RAW originals never enter the pipeline; they stay on the personal backup drive.

---

## Cowork vs Claude Code — who does what

| Task | Tool |
|---|---|
| New features, redesigns, architecture decisions | **Cowork** |
| Live dev loop: template edits, CSS tweaks, Worker/Hugo debugging | **Claude Code** in terminal |
| Upload photos, manage series | **Admin UI** (`admin.ctsmith.org`) |
| Git commits, running scripts, installing packages, `wrangler` deploys | **Claude Code** |
| Updating this CLAUDE.md | Whoever makes the change |

**Important:** Don't run Cowork and Claude Code git operations simultaneously — `.git/index.lock` conflict.

---

## Known issues / TODO

- [ ] **Confirm Cloudflare Containers availability** on the account — only needed if we want "keep camera EXIF, strip GPS" (otherwise the Worker + strip-all path stands).
- [ ] Configure hostnames: `admin.` / `assets.` / `photos.` (currently TBD).
- [ ] Decide per-photo page generation approach (stub content file vs. build step).
- [ ] Wire EXIF/GPS handling per the chosen compute path.
- [ ] Drag-to-reorder photos in the admin (manifest array order makes this clean now).
- [ ] Delete retired files once migration is proven (`Caddyfile`, Mac setup scripts).

---

## Open decisions (see DEPLOYMENT-PLAN.md §10)

1. **Admin compute — DECIDED:** Cloudflare Worker + image-transform binding. Fallback for EXIF/portability: Cloudflare Container running Sharp + exiftool (pending availability check).
2. **Originals — DECIDED:** copy-to-public via two R2 buckets; no Worker in the download path.
3. **Variant sizes — DECIDED:** 600 / 1200 / 2400 px.
4. **Format / metadata — DECIDED (reversible):** AVIF + JPEG; strip all metadata by default.
5. **Hostnames — TBD.**

---

## Current state (last updated: 2026-05-21)

- **Architecture redesigned and agreed** — decoupled, all-Cloudflare. Plan written to `DEPLOYMENT-PLAN.md`. **Next step: scaffold Phases 0–1.**
- Existing assets to carry forward: Hugo site + custom theme (monospace/catalog aesthetic), Tailwind config, the admin UI HTML, the `git push`-based deploy idea (now → deploy hook).
- Existing code to rewrite: `admin/server.js` (filesystem + local Hugo) → Worker (R2 + deploy hook); `single.html` / `index.html` (Hugo image processing) → manifest-driven R2 `srcset`; front-matter parser → real YAML (`gray-matter` / `js-yaml`) to handle the `photos[]` list.
- Cloudflare Pages was already connected to the repo (builds on push) — keep and use it.
- Large source photos already removed from the repo — good; they'll be re-uploaded via the new admin into R2.

### Handoff — next session (start Phase 0–1)

**Phase 1 (Hugo refactor) was scaffolded in Cowork on 2026-05-21** — status below. Phase 0 (Cloudflare account setup) and Phase 2 (admin → Worker) are still open. For a fresh start:

- **Read first:** this file, then `DEPLOYMENT-PLAN.md` §3 (data model), §4–§5a (pipeline / originals / permalinks), §7 (phases).
- **Best entry point: Phase 1** (Hugo refactor) — it's pure local code (swap the front-matter parser to real YAML, make `single.html` / `index.html` manifest-driven, add the `photo.html` permalink layout) with **no Cloudflare account needed**, so it's safe to do first and verify against a hand-written sample `index.md`.
- **Phase 0** (create the two R2 buckets, the Pages deploy hook, the Access app, a scoped GitHub token) needs the owner's Cloudflare/GitHub account actions — do alongside or after Phase 1.
- **Do NOT** reintroduce photos into git, Hugo build-time image processing, or any Mac/launchd/Caddy/cloudflared pieces.

### Phase 1 scaffold status (2026-05-21, done in Cowork)

**Done — local code, no Cloudflare account needed:**
- `hugo.toml`: added `assetsBaseURL`, set `baseURL` to the production domain (absolute OG URLs), removed the `[imaging]` block.
- Series converted to **branch bundles**. Sample series `iceland-2025` (3 photos + per-photo stubs) added as a build fixture — R2 keys are placeholders, so images won't load locally until R2 + hostnames exist.
- Templates rewritten manifest-driven: `index.html`, `projects/section.html` (series grid + PhotoSwipe), `projects/single.html` (per-photo permalink + prev/next + conditional download), partials `og.html` and `getphoto.html`; `head.html` wired for OG tags + per-photo titles.

**Still to do (needs a machine with network / Cloudflare):**
- **Verify the build locally:** `npm run build` then `hugo --source site` — the Cowork sandbox has no network to fetch Hugo, so templates are reviewed but the build hasn't been run.
- **Remove leftover test content:** `git rm -r site/content/projects/sample-series site/content/projects/test-2026` (includes a committed PNG). The sandbox couldn't delete these; they don't break the build but render as orphan "Photo not found" pages until removed.
- Phase 2 (admin → Worker) and Phase 0 (Cloudflare R2 / Pages / Access setup) remain open.

### Retired (no longer relevant under the new architecture)
The Mac-Mini hosting stack — Caddy, `cloudflared` tunnel, launchd services, the `sauron` server account, and the **macOS Sequoia BTM / launchd autostart blocker** that consumed the prior debugging effort — is all moot now that the admin is serverless and the gallery is served by Cloudflare Pages. (Detail preserved in git history if ever needed.)
