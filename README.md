# static-photos

A self-hosted photo gallery for an amateur photographer. A fast static Hugo site for visitors, with a private serverless admin panel for managing photos from a phone or laptop — no always-on server.

Everything runs on **Cloudflare + GitHub**. Photos live in R2 (never git). Metadata commits are text-only. Current version: **1.2.3**

Content types: **photo series** (grid + lightbox + per-photo permalinks with optional long-form body text) and **text posts** (pure markdown, no photos required). The homepage supports an optional hero image (with caption overlay, linking to the photo's permalink), a curated featured row (series, posts, or individual photos), the full series grid, and a recent posts strip.

---

## Architecture

```
You (phone / laptop)
  → photos.ctsmith.org/admin       Cloudflare Access login gate
    → Pages Function (/api/*)      admin backend — serverless
        1. resize via Transform via Workers (AVIF + JPEG, strip EXIF)
        2. PUT variants → ASSETS_BUCKET (public R2)
        3. PUT original → ORIGINALS_BUCKET (private R2)
        4. stage metadata to _pending/ in R2

Admin "Rebuild" button
  → flushes staged changes → one GitHub commit → Pages build

GitHub (Hugo source + manifests, NO binaries)
  → Cloudflare Pages build (fast — no image work)
    → static HTML/CSS + Functions on CF CDN

Visitor → photos.ctsmith.org       Pages CDN for HTML
  → photos.ctsmith.org/assets/*    Pages Function → R2 stream, edge-cached
```

| Path | Served by |
|---|---|
| `/` and gallery pages | Hugo static output (Cloudflare Pages CDN) |
| `/admin` | Static HTML in `site/static/admin/` (Access-gated) |
| `/api/*` | Pages Function `functions/api/[[route]].js` (Access-gated) |
| `/assets/*` | Pages Function `functions/assets/[[path]].js` → R2 |

---

## Stack

| Layer | Tech |
|---|---|
| Static site | [Hugo](https://gohugo.io) (extended) — manifest-driven, no build-time image processing |
| CSS | Tailwind CSS v3 |
| Lightbox | PhotoSwipe v5 (jsDelivr CDN) |
| Hosting | Cloudflare Pages |
| Asset storage | Cloudflare R2 — two buckets: `ASSETS_BUCKET` (public variants + downloadable originals) and `ORIGINALS_BUCKET` (private originals + staging area) |
| Image resizing | Cloudflare Transform via Workers — 600/1200/2400 px AVIF + JPEG, EXIF stripped |
| Admin backend | Pages Functions (`/api/*`) |
| Auth | Cloudflare Access (gates `/admin*` and `/api*`) |
| Deploy trigger | Cloudflare Pages deploy hook (admin "Rebuild" button) |

---

## Local dev

### Prerequisites

```bash
brew install hugo node
```

### Install dependencies

```bash
npm install
```

### Run the site (Hugo + Tailwind watch)

```bash
npm run dev
# → http://localhost:1313
```

### Run with Pages Functions (needs R2 bindings)

```bash
cp .dev.vars.example .dev.vars   # fill in real values
npx wrangler pages dev site/public
```

The `/api/*` and `/assets/*` routes require real R2 bindings from `.dev.vars`. The Hugo site itself works with just `npm run dev`.

---

## Repo structure

```
static-photos/
├── functions/
│   ├── _lib/
│   │   ├── env.js          central binding/var registry (getEnv helper)
│   │   ├── github.js       GitHub Trees API — atomic multi-file commits
│   │   ├── manifest.js     front-matter parse/serialize, slugify, ID helpers
│   │   └── staging.js      _pending/ layer — holds changes until Rebuild
│   ├── assets/[[path]].js  streams R2 objects, edge-cached immutably
│   └── api/[[route]].js    admin API router
├── admin/
│   └── public/index.html   admin UI source (keep in sync with site/static/admin/)
├── scripts/
│   └── rebuild.sh          local Hugo preview shortcut
├── site/
│   ├── hugo.toml
│   ├── data/settings.yaml  title, navLabel, photographer, description
│   ├── static/admin/       admin UI served at /admin by Pages
│   ├── content/projects/   series branch bundles (_index.md manifests, NO images)
│   └── themes/gallery/layouts/
├── wrangler.toml
├── package.json
└── tailwind.config.js
```

No image files ever enter `content/` or git. All photos live in R2.

---

## How publishing works

1. **Upload photos** via the admin panel — photos are resized and stored in R2; metadata is staged in `_pending/` (ORIGINALS_BUCKET).
2. **Edit metadata** (captions, cover, series settings) — all changes are staged.
3. **Rebuild** — the admin "Rebuild" button flushes all staged changes into one GitHub commit, then pings the Cloudflare Pages deploy hook. Pages rebuilds the site.

Staged changes are visible in the admin immediately (the API reads staging before falling back to GitHub). Visitors see the updated site after the Pages build completes (~30 s).

---

## Required Cloudflare bindings

| Binding | Type | Purpose |
|---|---|---|
| `ASSETS_BUCKET` | R2 | Public bucket — web variants + downloadable originals |
| `ORIGINALS_BUCKET` | R2 | Private bucket — all originals + staging (`_pending/`) |
| `GITHUB_TOKEN` | Secret | Fine-grained PAT, Contents read/write on this repo |
| `GITHUB_REPO` | Var | `"owner/repo"` |
| `DEPLOY_HOOK_URL` | Secret | Cloudflare Pages deploy hook URL |
| `ASSETS_R2_PUBLIC_URL` | Var | Public custom domain for ORIGINALS_BUCKET, e.g. `https://r2.photos.ctsmith.org` — used as Transform via Workers source |
| `CF_ZONE_ID` | Var | (optional) Zone ID for global CDN cache purge |
| `CF_API_TOKEN` | Secret | (optional) Token with Cache Purge permission |

See **RUNBOOK.md** for full account setup instructions.

---

## Customising

- **Site title, nav label, photographer name, description** — admin Settings panel (or edit `site/data/settings.yaml` directly)
- **Colors / typography** — `site/assets/css/input.css` and `tailwind.config.js`
- **Templates** — `site/themes/gallery/layouts/`

---

## Workflow

| Task | Tool |
|---|---|
| New features, redesigns, architecture decisions | Cowork |
| Live dev loop — templates, CSS, Functions | Claude Code in terminal |
| Upload photos, manage series, publish | Admin panel at `/admin` |
| Git commits, scripts, wrangler deploys | Claude Code |

Do not run Cowork and Claude Code git operations simultaneously (`.git/index.lock` conflict).
