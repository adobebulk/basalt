# CLAUDE.md — static-photos

Context file for both Cowork and Claude Code. Keep this up to date as the project evolves.

---

## What this is

A self-hosted photo gallery for an amateur photographer. Static Hugo site (fast, no server-side rendering for visitors) + a private Node.js admin panel for managing photos from anywhere (phone or laptop). Hosted on a Mac Mini at home.

**Repo:** https://github.com/adobebulk/static-photos

---

## Architecture

```
Browser (visitor)
  → Caddy (port 80/443)
    → site/public/          ← Hugo static output, rebuilt on demand

Browser (owner, private)
  → localhost:3001           ← Node.js admin panel
    → creates/edits content/projects/<slug>/
    → triggers Hugo rebuild
    → site/public/ updated
```

Photos live as **Hugo page bundle resources** — each series is a directory under `site/content/projects/<slug>/` containing `index.md` (metadata) and the image files. Hugo processes them at build time (resize, thumbnail generation).

---

## Tech stack

| Layer | Tech | Notes |
|---|---|---|
| Static site | Hugo (extended) | `brew install hugo` |
| CSS | Tailwind CSS v3 | Built via CLI, not PostCSS |
| Lightbox | PhotoSwipe v5 | Loaded from jsDelivr CDN |
| Admin panel | Node.js + Express + Multer | Port 3001, LAN only |
| Web server | Caddy | Auto-HTTPS when domain configured |
| Remote access | Tailscale (planned) | Not yet set up |

---

## Directory structure

```
static-photos/
├── CLAUDE.md               ← you are here
├── README.md               ← user-facing setup guide
├── package.json            ← root: Tailwind + dev scripts
├── package-lock.json
├── tailwind.config.js      ← scans site/themes/gallery/layouts/**
├── Caddyfile               ← web server config
├── scripts/
│   ├── setup.sh            ← Mac Mini one-time setup (installs Hugo, Caddy, Node, launchd)
│   ├── rebuild.sh          ← CSS + Hugo rebuild in one command
│   └── initial-commit.sh   ← one-time script used during init (can be deleted)
├── admin/
│   ├── server.js           ← Express server (API + static)
│   ├── package.json
│   └── public/
│       └── index.html      ← mobile-friendly admin UI (vanilla JS, no framework)
└── site/                   ← Hugo site root (pass --source site to hugo commands)
    ├── hugo.toml           ← site config: set photographer name here
    ├── assets/css/
    │   └── input.css       ← Tailwind source — edit this for custom styles
    ├── static/css/
    │   └── style.css       ← GENERATED — gitignored, run `npm run css:build`
    ├── content/
    │   └── projects/
    │       ├── _index.md
    │       └── <series-slug>/
    │           ├── index.md    ← title, description, date, cover, draft
    │           └── *.jpg/png   ← photos (Hugo page bundle resources)
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
  003.jpg
```

`index.md` front matter:
```yaml
---
title: "Iceland 2025"
description: "Volcanic landscapes and midnight sun."
date: "2025-08-01"
cover: "001.jpg"    # filename of cover photo; first image used if empty
draft: "false"      # "true" = hidden from public site
---
```

Photos are sorted **alphabetically by filename** in the gallery. Name them accordingly (001.jpg, 002.jpg…) to control order.

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
| POST | `/api/rebuild` | Trigger Tailwind + Hugo rebuild |
| GET | `/photos/:slug/:filename` | Serve raw photo for admin preview |

---

## Hugo template notes

- **Homepage** (`layouts/index.html`): queries `site.RegularPages` filtered to section `projects`, sorted by date descending. Uses `.Resources.ByType "image"` for cover.
- **Series page** (`layouts/projects/single.html`): `.Resources.ByType "image"` lists all photos. Hugo resizes them at build time — thumbnails at `900x600`, full-size at `2400px wide`. First 6 load eagerly, rest lazy.
- **Tailwind classes**: theme uses `group` / `group-hover:` for card hover effects. Custom utilities (`scale-102`, `scale-103`, `duration-400`) are defined in `tailwind.config.js`.
- Hugo must be run as `hugo --source site` (not from repo root) because the Hugo project root is `site/`, not the repo root.

---

## Logging

The admin panel writes timestamped logs to `logs/admin.log` (gitignored, auto-created).
Every request, rebuild, file write, and error is captured there.

To watch live:
```bash
tail -f logs/admin.log
```

This is the first place to look when something breaks.

---

## Known issues / TODO

- [ ] Admin photo thumbnails don't load (CSS `object-fit` on broken img tags — needs investigation)
- [ ] No drag-to-reorder photos in admin panel yet
- [ ] No image EXIF stripping before serving (privacy — camera GPS data)
- [ ] Tailscale not yet set up for remote access
- [ ] No auth on admin panel (safe for now since it's LAN-only, but needed before any public exposure)
- [ ] `scripts/initial-commit.sh` can be deleted now that history is clean

---

## Cowork vs Claude Code — who does what

| Task | Tool |
|---|---|
| New features, redesigns, architecture decisions | **Cowork** |
| Live dev loop: template edits, CSS tweaks, Hugo debugging | **Claude Code** in terminal |
| Upload photos, manage series while traveling | **Admin panel** at :3001 |
| Git commits, running scripts, installing packages | **Claude Code** |
| Updating this CLAUDE.md | Whoever makes the change |

**Important:** Both tools share the same repo directory. Don't run both simultaneously with git operations — one will lock the other out (the `.git/index.lock` problem). Close whichever isn't actively being used for git work.

---

## Current state (last updated: 2026-05-07)

- Hugo site scaffolded, custom theme built, Tailwind wired up
- Admin panel running at :3001 with full request/error logging to `logs/admin.log`
- Generated CSS (`site/static/css/style.css`) is committed — no more missing stylesheet on cold start
- Cover photo lookup bug fixed in homepage template
- Upload limit raised to 300 MB per file
- Sample series "Pictures" has 2 real photos (`_CTS2746.png`, `_CTS3942.png`)
- Second series `test-2026` created via admin panel
- Git history is clean, pushed to GitHub
- Mac Mini deployment not yet attempted
- Tailscale not yet set up
