/**
 * Staging layer — holds pending file changes in ORIGINALS_BUCKET under
 * _pending/ until Rebuild flushes them to GitHub in one commit.
 *
 * Key layout in ORIGINALS_BUCKET:
 *   _pending/files/{github-path}   → file content (text)
 *   _pending/deletes/{github-path} → "1"  (mark for deletion)
 */

import { commitFiles, getFile } from "./github.js";

async function listAll(bucket, options) {
  const objects = [];
  let cursor;
  do {
    const page = await bucket.list({ ...options, cursor });
    objects.push(...page.objects);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return objects;
}

/** Stage a file write. Removes any pending-delete for the same path. */
export async function stageFile(bucket, path, content) {
  await bucket.put(`_pending/files/${path}`, content,
    { httpMetadata: { contentType: "text/plain; charset=utf-8" } });
  await bucket.delete(`_pending/deletes/${path}`);
}

/** Stage a file deletion. Removes any pending-write for the same path. */
export async function stageDelete(bucket, path) {
  await bucket.put(`_pending/deletes/${path}`, "1",
    { httpMetadata: { contentType: "text/plain" } });
  await bucket.delete(`_pending/files/${path}`);
}

/**
 * Read a file: staging first, then a GitHub fallback function.
 * Returns { content } or null if staged-deleted / not found.
 * githubFallback is async (path) => { content } | null
 */
export async function readStaged(bucket, path, githubFallback) {
  const del = await bucket.get(`_pending/deletes/${path}`);
  if (del) return null;
  const pending = await bucket.get(`_pending/files/${path}`);
  if (pending) return { content: await pending.text() };
  return githubFallback ? githubFallback(path) : null;
}

/**
 * Return slugs of series staged but not yet in GitHub.
 * Scans _pending/files/site/content/projects/<slug>/_index.md keys.
 */
export async function getStagedSlugs(bucket) {
  const objects = await listAll(bucket, { prefix: "_pending/files/site/content/projects/" });
  const slugs = new Set();
  for (const { key } of objects) {
    const m = key.match(/^_pending\/files\/site\/content\/projects\/([^/]+)\/_index\.md$/);
    if (m) slugs.add(m[1]);
  }
  return [...slugs];
}

/**
 * Return slugs of posts staged but not yet in GitHub.
 * Scans _pending/files/site/content/posts/<slug>/index.md keys.
 */
export async function getStagedPostSlugs(bucket) {
  const objects = await listAll(bucket, { prefix: "_pending/files/site/content/posts/" });
  const slugs = new Set();
  for (const { key } of objects) {
    const m = key.match(/^_pending\/files\/site\/content\/posts\/([^/]+)\/index\.md$/);
    if (m) slugs.add(m[1]);
  }
  return [...slugs];
}

/** True if the post index.md is staged for deletion. */
export async function isStagedPostDeleted(bucket, slug) {
  const o = await bucket.get(`_pending/deletes/site/content/posts/${slug}/index.md`);
  return !!o;
}

/**
 * Return slugs of pages staged but not yet in GitHub.
 * Scans _pending/files/site/content/pages/<slug>/index.md keys.
 */
export async function getStagedPageSlugs(bucket) {
  const objects = await listAll(bucket, { prefix: "_pending/files/site/content/pages/" });
  const slugs = new Set();
  for (const { key } of objects) {
    const m = key.match(/^_pending\/files\/site\/content\/pages\/([^/]+)\/index\.md$/);
    if (m) slugs.add(m[1]);
  }
  return [...slugs];
}

/** True if the page index.md is staged for deletion. */
export async function isStagedPageDeleted(bucket, slug) {
  const o = await bucket.get(`_pending/deletes/site/content/pages/${slug}/index.md`);
  return !!o;
}

/** True if the series _index.md is staged for deletion. */
export async function isStagedDeleted(bucket, slug) {
  const o = await bucket.get(
    `_pending/deletes/site/content/projects/${slug}/_index.md`);
  return !!o;
}

/** Counts of pending writes and deletes. Used by the admin rebuild indicator. */
export async function pendingCounts(bucket) {
  const [files, deletions] = await Promise.all([
    listAll(bucket, { prefix: "_pending/files/" }),
    listAll(bucket, { prefix: "_pending/deletes/" }),
  ]);
  return { files: files.length, deletions: deletions.length };
}

/**
 * Flush all staged changes to GitHub in one commit and clear staging.
 * Returns { noop: true } if nothing pending, else { files, deletions }.
 */
export async function flushStaging(bucket, token, repo) {
  const filesObjects   = await listAll(bucket, { prefix: "_pending/files/" });
  const deletesObjects = await listAll(bucket, { prefix: "_pending/deletes/" });

  if (!filesObjects.length && !deletesObjects.length)
    return { noop: true };

  const files = await Promise.all(
    filesObjects.map(async ({ key }) => {
      const path = key.slice("_pending/files/".length);
      const obj  = await bucket.get(key);
      return { path, content: await obj.text() };
    })
  );
  const deletions = deletesObjects.map(({ key }) =>
    key.slice("_pending/deletes/".length)
  );

  // Skip deletions for paths that don't exist in GitHub — sending sha:null for a
  // path GitHub has never seen causes a 422 GitRPC::BadObjectState error.
  const existingDeletions = (
    await Promise.all(
      deletions.map(async (path) => ((await getFile(token, repo, path)) ? path : null))
    )
  ).filter(Boolean);

  await commitFiles({ token, repo,
    message: "content: publish staged changes", files, deletions: existingDeletions });

  // Always clear ALL staging (including phantom deletes that were skipped).
  await Promise.all([
    ...filesObjects.map(  ({ key }) => bucket.delete(key)),
    ...deletesObjects.map(({ key }) => bucket.delete(key)),
  ]);

  return { files: files.length, deletions: existingDeletions.length };
}
