---
name: basalt-workflow
description: The ship pipeline for the Basalt engine and its instances (static-photos, ctsmith-org, blog). Use when fixing a bug or adding a feature in functions/ or admin/, when pulling a Basalt engine change into an instance, or when asked to verify, branch, bump, document, push or PR a change in either repo.
---

# Basalt workflow

Basalt is the engine (`functions/`, `admin/`, `site/themes/basalt/`, `scripts/`).
Instances such as static-photos consume it. Fix the engine first, then pull
the change into each instance. Repos live side by side under `~/Documents/Projects/`.

## 1. Start clean

```bash
git switch main && git pull
git status            # stash or commit anything unexpected before branching
npm ci                # if node_modules is missing
git switch -c fix/<short-name>     # feat/<name> for features
```

## 2. Reproduce on main before changing code

- Photo pipeline (upload, ids, transforms, pool, rebake, purge):
  `npm run test:pipeline`. It drives the real `onRequest` with mocked R2 and
  a fetch stub that edge-caches R2-domain URLs by full URL, like Cloudflare does.
  On a known bug, run it on main first and confirm it FAILs for the right reason.
- New pipeline behaviour: add a scenario to `scripts/test-photo-pipeline.mjs`
  (keep each check's name a plain claim; exit code must stay non-zero on failure).
- No real image transforms run locally; the harness is the authority for them.

## 3. Fix

- Keep `admin/public/index.html` and `site/static/admin/index.html` identical
  (`diff` them before committing).
- Any path that rewrites a series manifest must spread the existing front matter
  (`{ ...manifest.data, ... }`) so fields like `lastPhotoId` survive.
- Photo ids are never reused: every add path calls
  `nextPhotoId(photos, manifest.data.lastPhotoId)` and persists `lastPhotoId` in
  the same `stageFile` write.

## 4. Verify

```bash
npm run test:pipeline                  # must print ALL PASSED
npm run build                          # then: git checkout -- site/static/css/style.css
npx wrangler pages dev site/public     # curl /api/version and the routes you touched
```

`npm run build` rewrites the tracked `site/static/css/style.css`; restore it
unless the change is meant to alter CSS.

## 5. Version + docs (same commit as the code — see CLAUDE.md "Documentation hygiene")

- Patch bump for fixes, minor for features. Update together:
  `package.json`, `package-lock.json` (top two `"version"` fields only),
  `wrangler.toml [vars] PACKAGE_VERSION`, `BASALT.md` (Version + Current),
  `README.md` version line, `CLAUDE.md` Versioning line.
- `CLAUDE.md`: API table, data model, current state entry (date it).
- `AGENTS.md` mirrors `CLAUDE.md` for Codex:
  `sed 's/Claude Code/Codex/g; s/CLAUDE\.md/AGENTS.md/g' CLAUDE.md > AGENTS.md`

## 6. Review, push, PR — never merge

```bash
git diff main..HEAD     # read every hunk; fix leftovers (e.g. wrong version refs in comments)
git push -u origin <branch>
gh pr create --base main
```

## Pulling an engine change into an instance

Pattern: static-photos commit f0584cb ("feat: pull Basalt …").

1. In the instance: `git switch main && git pull && git switch -c fix/pull-basalt-<name>`.
2. Reproduce there too: `npm run test:pipeline` on main.
3. Port only kernel files from the Basalt commit:
   ```bash
   git -C ../basalt format-patch -1 <sha> --stdout -- functions admin/public/index.html site/static/admin/index.html > /tmp/basalt.patch
   git apply --3way /tmp/basalt.patch
   ```
   Never port Basalt's `wrangler.toml`, content, `site/data/`, or theme overrides.
   Fix any Basalt version numbers that landed in comments.
4. Bump the instance's own version (its numbering is independent of Basalt's)
   and add a current-state entry that starts "Pulled from Basalt vX.Y.Z".
5. Same verify / docs / review / push / PR steps as above.
