# Basalt

A self-hostable Hugo CMS with a serverless admin panel, Cloudflare R2 asset storage, and GitHub-based content versioning. Supports photo series with a full image-processing pipeline, text posts, and is designed to add new content types cleanly alongside existing ones.

Everything runs on **Cloudflare + GitHub**. Photos live in R2 (never git). Metadata commits are text-only. Current version: **0.1.0**

Content types: **photo series** (grid + lightbox + per-photo permalinks with optional long-form body text) and **text posts** (pure markdown, no photos required). The homepage supports an optional hero image (with caption overlay, linking to the photo's permalink), a curated featured row (series, posts, or individual photos), the full series grid, and a recent posts strip.

---

## How it works

```
You (phone or laptop, anywhere)
  → yourdomain.com/admin          Cloudflare Access login gate
    → Pages Function (/api/*)     admin backend — serverless, scales to zero
        1. resize via Cloudflare Image Transforms (AVIF + JPEG, strip all EXIF)
        2. PUT variants → ASSETS_BUCKET (public R2)
        3. PUT original → ORIGINALS_BUCKET (private R2)
        4. stage metadata changes to _pending/ in R2

Admin "Rebuild" button
  → flushes staged changes → one GitHub commit → Cloudflare Pages build

GitHub repo (Hugo source + manifests — NO image binaries)
  → Cloudflare Pages build (fast: no image work at build time)
    → static HTML/CSS + Functions deployed to Cloudflare CDN

Visitor → yourdomain.com          Hugo static output via Pages CDN
  → yourdomain.com/assets/*       Pages Function streams from R2, edge-cached
```

| Path | Served by |
|---|---|
| `/` and all content pages | Hugo static output (Cloudflare Pages CDN) |
| `/admin` | Static admin UI in `site/static/admin/` (Access-gated) |
| `/api/*` | Pages Function — admin backend (Access-gated) |
| `/assets/*` | Pages Function — streams from R2, immutably cached |

**One hostname, no subdomains.** No origin server to babysit.

---

## Stack

| Layer | Tech |
|---|---|
| Static site | [Hugo](https://gohugo.io) (extended) — manifest-driven, no build-time image processing |
| CSS | Tailwind CSS v3 |
| Lightbox | PhotoSwipe v5 (loaded from jsDelivr CDN) |
| Hosting | Cloudflare Pages (free tier) |
| Asset storage | Cloudflare R2 — two buckets: public variants/downloadable originals + private originals/staging |
| Image resizing | Cloudflare Image Transforms via Workers — 600/1200/2400 px AVIF + JPEG, EXIF stripped |
| Admin backend | Cloudflare Pages Functions (`/api/*`) |
| Auth | Cloudflare Access (gates `/admin*` and `/api*`) |
| Deploy trigger | Cloudflare Pages deploy hook (the admin "Rebuild" button) |

---

## Getting started

### What you need before you begin

- A **Cloudflare account** (free tier works). Your domain must be on Cloudflare (or you can use a `pages.dev` subdomain while testing).
- A **GitHub account** and a repo for this project (public or private).
- **Node.js** (v18+) and **Hugo extended** installed locally.
- The **Wrangler CLI** — installed via npm as part of this project, no global install needed.

On macOS with Homebrew:

```bash
brew install hugo node
```

---

### Step 1 — Clone the repo and install dependencies

```bash
git clone https://github.com/adobebulk/basalt.git my-site
cd my-site
npm install
```

---

### Step 2 — Verify the local site builds

```bash
npm run dev
```

This starts Hugo and Tailwind in watch mode. Open [http://localhost:1313](http://localhost:1313) — you should see the site. The admin panel and API won't work yet (they need Cloudflare bindings), but the Hugo frontend is fully functional locally.

---

### Step 3 — Create a Cloudflare Pages project

1. Go to **Cloudflare dashboard → Workers & Pages → Create → Pages → Connect to Git**.
2. Authorise Cloudflare to access your GitHub account and select your repo.
3. Set the build configuration:
   - **Build command:** `npm run build`
   - **Build output directory:** `site/public`
4. Under **Environment variables (production)**, add:
   - `HUGO_VERSION` = `0.161.1`
5. Click **Save and Deploy**. The first deploy will succeed and produce a working static site at a `*.pages.dev` URL.

---

### Step 4 — Add a custom domain (optional but recommended)

In your Pages project: **Custom domains → Add a custom domain** and enter your domain (e.g. `photos.yourdomain.com`). Cloudflare will add the DNS record automatically if your domain is on Cloudflare. If it isn't, follow the CNAME instructions shown.

---

### Step 5 — Create the R2 buckets

You need two buckets. In the Cloudflare dashboard: **R2 → Create bucket**.

| Bucket name | Purpose |
|---|---|
| `my-site-assets` | Public — web variants (600/1200/2400 px) + originals marked downloadable |
| `my-site-originals` | Private — all originals + the `_pending/` staging area |

Name them whatever you like — the names are mapped to binding names in the next step. Do **not** set a public custom domain on `my-site-originals`; it should stay private.

For `my-site-assets`, you'll want a custom domain so the image transform pipeline can use it as a source URL. In R2 → your assets bucket → **Settings → Custom domain**, add something like `r2.yourdomain.com`. This becomes the `ASSETS_R2_PUBLIC_URL` binding later.

You can also create buckets via Wrangler if you prefer the CLI:

```bash
npx wrangler r2 bucket create my-site-assets
npx wrangler r2 bucket create my-site-originals
```

---

### Step 6 — Create a GitHub fine-grained access token

The admin needs to commit metadata changes (manifests, post content) back to your repo.

1. Go to **GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**.
2. Set **Repository access** to this repo only.
3. Under **Repository permissions**, set **Contents → Read and write**. Everything else can stay at No access.
4. Generate the token and **copy it somewhere safe** — you'll enter it as a secret in the next step.

---

### Step 7 — Create a deploy hook

The admin "Rebuild" button needs a URL to POST to in order to trigger a Pages build.

1. In your Pages project: **Settings → Builds & deployments → Deploy hooks → Add deploy hook**.
2. Name it `admin-rebuild`, target the `main` branch.
3. **Copy the hook URL** — you'll enter it as a secret in the next step.

---

### Step 8 — Wire bindings and secrets into the Pages project

Go to your Pages project → **Settings → Functions → Bindings** and add the following. This is the most important step — the admin won't work until these are all present.

**R2 bucket bindings:**

| Variable name | R2 bucket |
|---|---|
| `ASSETS_BUCKET` | `my-site-assets` (your public bucket) |
| `ORIGINALS_BUCKET` | `my-site-originals` (your private bucket) |

**Plain variables:**

| Variable name | Value |
|---|---|
| `GITHUB_REPO` | `your-github-username/your-repo-name` |
| `ASSETS_R2_PUBLIC_URL` | `https://r2.yourdomain.com` (custom domain on your assets R2 bucket) |
| `CF_ZONE_ID` | *(optional)* Your Cloudflare Zone ID — enables CDN cache purge on photo deletion |

**Secrets** (use the Secrets tab, not plain variables — these are encrypted):

| Secret name | Value |
|---|---|
| `GITHUB_TOKEN` | The fine-grained token from Step 6 |
| `DEPLOY_HOOK_URL` | The deploy hook URL from Step 7 |
| `CF_API_TOKEN` | *(optional)* Token with Cache Purge permission — needed only if you set `CF_ZONE_ID` |

After adding all bindings, trigger a new deploy (push any commit, or use the Pages dashboard's "Retry deployment" button) so the Functions pick them up.

---

### Step 9 — Set up Cloudflare Access (locks down the admin)

This gates `/admin` and `/api/*` behind a login so only you can reach them. **Do this before you start uploading real content.**

1. Go to **Cloudflare Zero Trust → Access → Applications → Add an application → Self-hosted**.
2. Set the **Application domain** to your domain (e.g. `photos.yourdomain.com`).
3. Set **Path** to `/admin*` — this protects the admin UI.
4. Add a second application (or use path rules) covering `/api*` — this protects the API.
5. Under **Policies**, create an Allow policy with the condition: **Emails → is → your@email.com**.
6. Save. Cloudflare will now show a login screen for those paths — everyone else gets a 403.

Everything under `/` and `/assets/*` stays public automatically (no policy = no gate).

> **Note:** If you're on a Cloudflare Zero Trust free plan, you can gate up to 50 users at no cost.

---

### Step 10 — Configure the site

Edit `site/data/settings.yaml` (or use the Settings panel in the admin once it's live):

```yaml
title: "My Site"
navLabel: "Work"
photographer: "Your Name"
description: "A short description"
```

Update `site/hugo.toml` with your domain:

```toml
baseURL = "https://photos.yourdomain.com"
```

Update `wrangler.toml` with your repo name:

```toml
[vars]
GITHUB_REPO = "your-github-username/your-repo-name"
```

Commit and push — Cloudflare Pages will rebuild automatically.

---

### Step 11 — Local dev with the admin (optional)

To run the admin API locally with real R2 bindings:

```bash
cp .dev.vars.example .dev.vars
```

Fill in `.dev.vars` with your `GITHUB_TOKEN`, `GITHUB_REPO`, and `DEPLOY_HOOK_URL`. Then:

```bash
npx wrangler pages dev site/public \
  --r2 ASSETS_BUCKET=my-site-assets \
  --r2 ORIGINALS_BUCKET=my-site-originals
```

The Hugo frontend alone (no admin) works with just `npm run dev` — no secrets needed.

---

### Step 12 — Enable Cloudflare Image Transforms

The photo upload pipeline resizes images via Cloudflare Image Transforms. This needs to be enabled on your zone:

1. Cloudflare dashboard → your domain → **Images → Transformations → Enable**.
2. Check that your Cloudflare plan includes Image Transforms (available on all paid plans and in limited form on free).

> If Image Transforms aren't available on your plan, the fallback is to run resizing in a Cloudflare Container using Sharp — same architecture, different compute. Open an issue if you need this path.

---

## How publishing works

1. **Upload** content via the admin panel at `/admin`. Photos are resized and stored in R2; metadata is staged in `_pending/` (inside ORIGINALS_BUCKET). Text posts are staged there too.
2. **Edit** captions, settings, post body — all changes remain staged and immediately visible in the admin.
3. **Rebuild** — the "Rebuild" button flushes all staged changes into a single GitHub commit, then POSTs to the deploy hook. Cloudflare Pages rebuilds the site (~30 seconds). Visitors see the update once the build completes.

Staged changes never go to visitors until Rebuild is pressed. You can stage as many changes as you want and ship them all at once.

---

## Repo structure

```
basalt/
├── functions/
│   ├── _lib/
│   │   ├── env.js              central binding/var registry (getEnv helper)
│   │   ├── github.js           GitHub Trees API — atomic multi-file commits
│   │   ├── manifest.js         front-matter parse/serialize, slugify, ID helpers
│   │   └── staging.js          _pending/ staging layer
│   ├── assets/[[path]].js      streams R2 objects, immutably edge-cached
│   └── api/[[route]].js        admin API router
├── admin/
│   └── public/index.html       admin UI source — keep in sync with site/static/admin/
├── scripts/
│   └── rebuild.sh              local Hugo preview shortcut
├── site/
│   ├── hugo.toml               baseURL, theme, assetsBaseURL
│   ├── data/settings.yaml      site title, nav, photographer, description
│   ├── assets/css/input.css    Tailwind source
│   ├── static/
│   │   ├── css/style.css       compiled Tailwind output
│   │   └── admin/index.html    admin UI served at /admin
│   ├── content/
│   │   ├── projects/           photo series (branch bundles, manifests only — NO images)
│   │   └── posts/              text posts (leaf bundles)
│   └── themes/basalt/layouts/  Hugo templates
├── wrangler.toml               Pages project config + R2 bindings
├── package.json                Tailwind + dev scripts
├── tailwind.config.js
└── .dev.vars.example           copy to .dev.vars for local wrangler dev
```

No image files ever enter `content/` or git. All assets live in R2.

---

## Customising

**Site identity** — edit `site/data/settings.yaml` or use the admin Settings panel:
- `title` — displayed in the browser tab and header
- `navLabel` — navigation label for the projects/series section
- `photographer` — shown in the footer
- `description` — used in meta tags

**Templates** — edit files in `site/themes/basalt/layouts/`. Hugo is standard; there's nothing Basalt-specific about the template language. The key variable is `.Params.photos` on series pages (the array of photo metadata read from the manifest).

**Colors and typography** — `site/assets/css/input.css` (Tailwind source) and `tailwind.config.js`.

**Adding a content type** — see `BASALT.md` for the step-by-step pattern.

---

## Key commands

```bash
npm run dev                          # Hugo + Tailwind watch → http://localhost:1313
npm run build                        # production build (Tailwind minify + Hugo minify)
npx wrangler pages dev site/public   # run with Pages Functions (needs .dev.vars + R2 flags)
npx wrangler tail                    # live Function logs in production
```

---

## Required bindings reference

| Name | Type | Purpose |
|---|---|---|
| `ASSETS_BUCKET` | R2 binding | Public bucket — web variants + downloadable originals |
| `ORIGINALS_BUCKET` | R2 binding | Private bucket — all originals + staging (`_pending/`) |
| `GITHUB_TOKEN` | Secret | Fine-grained PAT, Contents read/write on this repo |
| `GITHUB_REPO` | Var | `"owner/repo"` |
| `DEPLOY_HOOK_URL` | Secret | Cloudflare Pages deploy hook URL |
| `ASSETS_R2_PUBLIC_URL` | Var | Custom domain on assets R2 bucket — used as image transform source |
| `CF_ZONE_ID` | Var | *(optional)* Zone ID for CDN cache purge on asset deletion |
| `CF_API_TOKEN` | Secret | *(optional)* Token with Cache Purge permission |

---

## Workflow

| Task | Tool |
|---|---|
| New features, architecture decisions | Cowork |
| Live dev loop — templates, CSS, Functions debugging | Claude Code in terminal |
| Upload content, manage series, publish | Admin panel at `/admin` |
| Git commits, scripts, wrangler deploys | Claude Code |

Do not run Cowork and Claude Code git operations simultaneously — `.git/index.lock` conflict.
