# BASALT.md

Basalt is a generic Hugo CMS built on the static-photos infrastructure.
It supports multiple content types out of the box and is designed to be
the CMS backbone for any Hugo-based site.

**Version:** 0.4.0  
**Repo:** https://github.com/adobebulk/basalt  

Basalt is the **engine**. A live site is an **instance**: its own GitHub repo,
Cloudflare Pages project, R2 buckets, Access app, and secrets. The engine does
not know those keys. What the instance changes is `site/data/basalt.yaml` plus
optional Hugo template overlays.

---

## Architecture

```
basalt (this repo)          engine — functions, admin, default theme
each site repo              instance — wrangler, content, basalt.yaml, overlay theme
```

| Lives in the engine | Lives in the instance |
|---|---|
| `functions/` | `wrangler.toml`, `.dev.vars`, Pages secrets |
| `admin/` | `site/content/`, `site/data/settings.yaml` |
| `site/themes/basalt/` | `site/data/basalt.yaml` (content types + homepage) |
| `scripts/` | overlay theme (`theme = ["site", "basalt"]`) |
| | Cloudflare Access, R2 bucket names, `PUBLIC_ORIGIN` |

Updating a site: merge engine changes here, then open a PR on the instance that
bumps Basalt (submodule SHA, subtree, or copy). That PR is reviewed and merged;
that site’s Pages project rebuilds. Nothing auto-deploys to photos or ctsmith.org.

See CLAUDE.md for the Functions/R2/GitHub pipeline.

---

## Content types

Basalt ships with the following content types. Add new types alongside these
without removing or renaming existing ones (backward compatibility with static-photos).

| Type | API routes | Hugo content path | Notes |
|---|---|---|---|
| Photo series | `/api/projects/*` | `site/content/projects/` | Full image pipeline (resize, R2, AVIF/JPEG) |
| Photo pool | `/api/pool/*` | `site/content/projects/_pool/` | Bulk drop + process; never published. Requires series. |
| Text posts | `/api/posts/*` | `site/content/posts/` | Pure markdown, no images required |
| Pages | `/api/pages/*` | `site/content/pages/` | Subpages at `/:slug/`. Admin Pages tab. |

Enable or disable types in `site/data/basalt.yaml`. The admin hides tabs for
disabled types; the API returns 404. Hugo reads the same file as `.Site.Data.basalt`.

```yaml
contentTypes:
  series: true
  pool: true
  posts: true
  pages: false
homepage: gallery    # gallery | posts | splash (splash does not require pages)
nav: default         # default | configurable (navbar editor only when configurable)
```

Recipes in `examples/`:

| Instance | File | Admin |
|---|---|---|
| Photos | `examples/photos/basalt.yaml` | Series, Posts, Pool |
| Website | `examples/website/basalt.yaml` | Pages (splash + subpages + navbar), Posts |
| Blog | `examples/blog/basalt.yaml` | Posts only |

---

## Template overlay

Default layouts live in `site/themes/basalt/`. An instance that needs a different
homepage or chrome adds its own theme **in front**:

```toml
# site/hugo.toml in the instance repo
theme = ["site", "basalt"]
```

Put instance layouts in `site/themes/site/layouts/` (same paths as Basalt). Hugo
uses the instance file when it exists and falls through to Basalt otherwise.
`tailwind.config.js` scans `site/themes/**/layouts/**/*.html` so overlay utilities
are included in the CSS build. Do not fork `functions/` or `admin/` in the instance.

---

## New instance (e.g. blog)

1. New GitHub repo. Copy this engine (or add it as a submodule) and replace
   `wrangler.toml` name, `GITHUB_REPO`, `PUBLIC_ORIGIN`, and R2 bucket names.
2. Own Pages project, R2 pair, deploy-hook **secret**, Access app. Do not reuse
   photos or ctsmith.org bindings.
3. Copy `examples/blog/basalt.yaml` → `site/data/basalt.yaml` (or edit in place).
4. Overlay templates if the default posts homepage is not enough.
5. When Basalt gains a feature, PR the engine bump on the instance — do not
   edit kernel files in the instance.

### Adding a new content type

1. Add API routes in `functions/api/[[route]].js` (follow the posts pattern — it's the simplest)
2. Add staging helpers in `functions/_lib/staging.js` if the type needs staged writes
3. Add Hugo content directory under `site/content/<type>/`
4. Add Hugo templates under `site/themes/basalt/layouts/<type>/`
5. Add a tab or section to the admin UI in `admin/public/index.html` and `site/static/admin/index.html`
6. Gate it in `site/data/basalt.yaml` (`contentTypes`) and `functions/_lib/config.js`
7. Document the new type in this file

---

## Versioning

Source of truth is `package.json`. Keep `wrangler.toml [vars] PACKAGE_VERSION` in sync.
Minor bump for new content types or features; patch for fixes.
Current: **0.4.0**

This repo is the CMS source of truth. Live sites (`static-photos`, `ctsmith-org`,
future blog) consume it; they are not upstream.

---

## Cowork vs Claude Code — who does what

| Task | Tool |
|---|---|
| New content types, architecture decisions | Cowork |
| Template edits, Functions debugging, live dev loop | Claude Code in terminal |
| Git commits, wrangler deploys, package installs | Claude Code |
| Updating this BASALT.md | Whoever makes the change |

**Important:** Don't run Cowork and Claude Code git operations simultaneously — `.git/index.lock` conflict.
