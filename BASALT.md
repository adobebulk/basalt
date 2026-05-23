# BASALT.md

Basalt is a generic Hugo CMS built on the static-photos infrastructure.
It supports multiple content types out of the box and is designed to be
the CMS backbone for any Hugo-based site.

**Version:** 0.1.0  
**Repo:** https://github.com/adobebulk/basalt  
**Upstream:** static-photos (git remote `static-photos`) — CMS layer fixes are
periodically cherry-picked from there.

---

## Architecture

Same as static-photos. See CLAUDE.md for the full architecture diagram and
data models. This file covers Basalt-specific concerns.

---

## Content types

Basalt ships with the following content types. Add new types alongside these
without removing or renaming existing ones (backward compatibility with static-photos).

| Type | API routes | Hugo content path | Notes |
|---|---|---|---|
| Photo series | `/api/projects/*` | `site/content/projects/` | Full image pipeline (resize, R2, AVIF/JPEG) |
| Text posts | `/api/posts/*` | `site/content/posts/` | Pure markdown, no images required |

### Adding a new content type

1. Add API routes in `functions/api/[[route]].js` (follow the posts pattern — it's the simplest)
2. Add staging helpers in `functions/_lib/staging.js` if the type needs staged writes
3. Add Hugo content directory under `site/content/<type>/`
4. Add Hugo templates under `site/themes/basalt/layouts/<type>/`
5. Add a tab or section to the admin UI in `admin/public/index.html` and `site/static/admin/index.html`
6. Document the new type in this file

---

## Upstream sync (static-photos → basalt)

static-photos is registered as a git remote:

```bash
git remote add static-photos git@github.com:adobebulk/static-photos.git
```

To pull a CMS fix from static-photos:

```bash
git fetch static-photos
git log static-photos/main --oneline   # find the commit
git cherry-pick <sha>
```

Only cherry-pick commits that touch `functions/` or `admin/`. Hugo template
commits from static-photos are photo-specific and should not be pulled.

---

## Versioning

Source of truth is `package.json`. Keep `wrangler.toml [vars] PACKAGE_VERSION` in sync.
Minor bump for new content types or features; patch for fixes.
Current: **0.1.0**

---

## Cowork vs Claude Code — who does what

| Task | Tool |
|---|---|
| New content types, architecture decisions | Cowork |
| Template edits, Functions debugging, live dev loop | Claude Code in terminal |
| Git commits, wrangler deploys, package installs | Claude Code |
| Updating this BASALT.md | Whoever makes the change |

**Important:** Don't run Cowork and Claude Code git operations simultaneously — `.git/index.lock` conflict.
