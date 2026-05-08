# CLAUDE.md — static-photos

Context file for both Cowork and Claude Code. Keep this up to date as the project evolves.

---

## What this is

A self-hosted photo gallery for an amateur photographer. Static Hugo site (fast, no server-side rendering for visitors) + a private Node.js admin panel for managing photos from anywhere (phone or laptop). Hosted on a Mac Mini at home, served via Cloudflare Tunnel.

**Repo:** https://github.com/adobebulk/static-photos

---

## Target architecture (partially implemented — see Current State)

```
Phone / laptop (owner)
  → Cloudflare Access (login gate)
    → Cloudflare Tunnel
      → Admin panel :3001 on Mac Mini
          → saves photos to site/content/projects/<slug>/
          → git push → GitHub
              → (optional) Cloudflare Pages build
          OR  → Hugo rebuilds locally on Mac Mini
              → Caddy serves site/public/ directly

Browser (visitor)
  → Cloudflare Tunnel
    → Caddy :80 on Mac Mini
      → site/public/   ← Hugo static output
```

**Photos live on the Mac Mini** — never need to go to GitHub or a cloud service. The Mac Mini is the hub. Cloudflare Tunnel makes it reachable from anywhere without exposing a home IP or opening router ports.

---

## Tech stack

| Layer | Tech | Notes |
|---|---|---|
| Static site | Hugo (extended) | `brew install hugo` |
| CSS | Tailwind CSS v3 | Built via CLI, not PostCSS |
| Lightbox | PhotoSwipe v5 | Loaded from jsDelivr CDN |
| Admin panel | Node.js + Express + Multer + Sharp | Port 3001 |
| Image processing | Sharp | Normalises uploads to JPEG, max 4000px |
| Web server | Caddy | Auto-HTTPS, serves Hugo output |
| Tunnel | Cloudflare Tunnel (`cloudflared`) | Exposes Caddy + admin panel securely |
| Auth | Cloudflare Access | Login gate in front of admin panel |

---

## Directory structure

```
static-photos/
├── CLAUDE.md               ← you are here
├── README.md               ← user-facing setup guide
├── package.json            ← root: Tailwind + dev scripts
├── package-lock.json
├── tailwind.config.js      ← scans site/themes/gallery/layouts/**
├── wrangler.toml           ← Cloudflare Workers config (kept for reference)
├── Caddyfile               ← web server config
├── scripts/
│   ├── setup.sh            ← Mac Mini one-time setup (installs Hugo, Caddy, Node, launchd)
│   ├── rebuild.sh          ← CSS + Hugo rebuild in one command
│   └── initial-commit.sh   ← one-time script, safe to delete
├── admin/
│   ├── server.js           ← Express server (API + static)
│   ├── package.json
│   └── public/
│       └── index.html      ← admin UI (monospace catalog aesthetic, vanilla JS)
└── site/                   ← Hugo site root (pass --source site to hugo commands)
    ├── hugo.toml           ← site config: baseURL="/", set photographer name
    ├── assets/css/
    │   └── input.css       ← Tailwind source
    ├── static/css/
    │   └── style.css       ← committed generated CSS
    ├── content/
    │   └── projects/
    │       ├── _index.md
    │       └── <series-slug>/
    │           ├── index.md    ← title, description, date, cover, draft (boolean)
    │           └── *.jpg       ← photos (normalised to JPEG on upload via sharp)
    └── themes/gallery/
        └── layouts/
            ├── index.html      ← homepage: grid of series covers
            ├── 404.html
            ├── projects/
            │   └── single.html ← series page: photo grid + PhotoSwipe lightbox
            └── partials/
                ├── head.html
                └── header.html
```

---

## Key commands

```bash
# Install all dependencies (run once after cloning)
npm install && cd admin && npm install && cd ..

# Dev mode — Tailwind watch + Hugo server together
npm run dev
# → gallery at http://localhost:1313

# Admin panel (separate terminal)
node admin/server.js
# → admin at http://localhost:3001

# Production build (CSS + Hugo minified)
npm run build

# Quick rebuild (useful after manual edits)
bash scripts/rebuild.sh

# Mac Mini first-time setup
bash scripts/setup.sh
```

---

## Series / photo data model

Each series is a Hugo **leaf bundle**:

```
site/content/projects/iceland-2025/
  index.md      ← front matter
  001.jpg
  002.jpg
```

`index.md` front matter:
```yaml
---
title: "Iceland 2025"
description: "Volcanic landscapes and midnight sun."
date: "2025-08-01"
cover: "001.jpg"    # filename of cover photo; first image used if empty
draft: false        # boolean — true = hidden from public site
---
```

Photos are sorted **alphabetically by filename**. Name them accordingly (001.jpg, 002.jpg…) to control order.

**On upload**, the admin panel runs photos through Sharp: normalised to JPEG, max 4000px on longest dimension, quality 88. Keeps files well under Cloudflare's 25 MiB limit and Hugo processes them further at build time (thumbnails at 900x600, full-size at 2400px wide).

---

## Admin panel API

| Method | Path | Description |
|---|---|---|
| GET | `/api/projects` | List all series |
| POST | `/api/projects` | Create series `{ title, description }` |
| GET | `/api/projects/:slug/photos` | List photos in a series |
| POST | `/api/projects/:slug/photos` | Upload photos (multipart, field: `photos`) |
| DELETE | `/api/projects/:slug/photos/:filename` | Delete a photo |
| PATCH | `/api/projects/:slug` | Update metadata `{ title, description, cover, draft }` |
| POST | `/api/projects/:slug/publish` | Publish/unpublish `{ draft: bool }` |
| POST | `/api/rebuild` | Trigger Tailwind + Hugo rebuild (local preview) |
| POST | `/api/deploy` | `git add site/content/ && git commit && git push` |
| GET | `/photos/:slug/:filename` | Serve raw photo for admin preview |

---

## Hugo template notes

- **Homepage** (`layouts/index.html`): queries `site.RegularPages` filtered to section `projects`, sorted by date descending. Cover lookup uses project's own `.Resources.GetMatch`, not `$` (homepage context).
- **Series page** (`layouts/projects/single.html`): Hugo resizes at build time — thumbnails at `900x600`, full-size at `2400px wide`. First 6 images load eagerly, rest lazy.
- **Tailwind**: theme uses `group` / `group-hover:`. Custom utilities (`scale-102`, `scale-103`, `duration-400`) in `tailwind.config.js`.
- Hugo must be run as `hugo --source site` from repo root.

---

## Logging

The admin panel writes timestamped logs to `logs/admin.log` (gitignored, auto-created).

```bash
tail -f logs/admin.log
```

First place to look when something breaks.

---

## Security model

The Mac Mini runs the server on a **restricted user account** that only has access to the repo directory and an external drive — not the admin account's backup drives.

- **Cloudflare Access** gates the admin panel — login required before any request reaches the Mac Mini
- **Caddy** serves only the Hugo static output publicly (no dynamic routes)
- **Admin panel** has no built-in auth — relies entirely on Cloudflare Access being in front
- **GitHub deploy key** (to be set up): scoped only to this repo, so a compromise can't touch other repos

**Never expose the admin panel (port 3001) without Cloudflare Access in front of it.**

---

## Known issues / TODO

- [ ] Cloudflare Tunnel not yet set up (next priority)
- [ ] Cloudflare Access not yet set up (must happen before tunnel goes live)
- [ ] GitHub deploy key on Mac Mini (scoped to this repo only)
- [ ] Admin photo thumbnails don't load in detail view — needs investigation
- [ ] No drag-to-reorder photos yet
- [ ] No EXIF stripping (camera GPS data) — Sharp can do this, just not wired up
- [ ] `scripts/initial-commit.sh` can be deleted
- [ ] Decide: serve site from Mac Mini via Caddy, or keep Cloudflare Pages? (Currently both exist)

---

## Deployment options (decision pending)

Two valid approaches — pick one and remove the other:

**Option A — Mac Mini serves everything (preferred)**
- Caddy serves `site/public/` via Cloudflare Tunnel
- Hugo rebuilds locally when admin hits "Rebuild"
- No Cloudflare Pages needed
- Photos never leave the Mac Mini (no GitHub file size limits)

**Option B — Cloudflare Pages serves the gallery**
- CF Pages builds Hugo on every `git push`
- Mac Mini only runs the admin panel
- Photos go through GitHub (25 MiB per file limit — Sharp normalisation handles this)
- Currently connected to the repo but not the active serving method

---

## Cowork vs Claude Code — who does what

| Task | Tool |
|---|---|
| New features, redesigns, architecture decisions | **Cowork** |
| Live dev loop: template edits, CSS tweaks, Hugo debugging | **Claude Code** in terminal |
| Upload photos, manage series | **Admin panel** at :3001 |
| Git commits, running scripts, installing packages | **Claude Code** |
| Updating this CLAUDE.md | Whoever makes the change |

**Important:** Don't run both Cowork and Claude Code with git operations simultaneously — `.git/index.lock` conflict.

---

## Current state (last updated: 2026-05-07)

- Hugo site scaffolded, custom theme built, Tailwind wired up
- Admin panel running at :3001 — catalog/monospace aesthetic (US Graphics inspired)
- Admin panel logs to `logs/admin.log`
- Photos normalised to JPEG on upload via Sharp (max 4000px, q88)
- Draft field fixed to write proper YAML booleans
- `baseURL = "/"` set for portability
- `POST /api/deploy` endpoint added — commits content + pushes to GitHub
- Cloudflare Pages connected to repo (builds on push) — first deploy blocked by large PNG files, now removed from repo
- Large source photos removed from repo — re-upload via admin after Mac Mini is set up
- Mac Mini deployment not yet attempted
- Cloudflare Tunnel + Access not yet set up
