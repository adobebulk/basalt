/**
 * Staging layer — holds pending file changes in ORIGINALS_BUCKET under
 * _pending/ until Rebuild flushes them to GitHub in one commit.
 *
 * Key layout in ORIGINALS_BUCKET:
 *   _pending/files/{github-path}   → file content (text)
 *   _pending/deletes/{github-path} → "1"  (mark for deletion)
 */

import { commitFiles } from "./github.js";

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
  const list = await bucket.list({ prefix: "_pending/files/site/content/projects/" });
  const slugs = new Set();
  for (const { key } of list.objects) {
    const m = key.match(/^_pending\/files\/site\/content\/projects\/([^/]+)\/_index\.md$/);
    if (m) slugs.add(m[1]);
  }
  return [...slugs];
}

/** True if the series _index.md is staged for deletion. */
export async function isStagedDeleted(bucket, slug) {
  const o = await bucket.get(
    `_pending/deletes/site/content/projects/${slug}/_index.md`);
  return !!o;
}

/**
 * Flush all staged changes to GitHub in one commit and clear staging.
 * Returns { noop: true } if nothing pending, else { files, deletions }.
 */
export async function flushStaging(bucket, token, repo) {
  const filesList   = await bucket.list({ prefix: "_pending/files/" });
  const deletesList = await bucket.list({ prefix: "_pending/deletes/" });

  if (!filesList.objects.length && !deletesList.objects.length)
    return { noop: true };

  const files = await Promise.all(
    filesList.objects.map(async ({ key }) => {
      const path = key.slice("_pending/files/".length);
      const obj  = await bucket.get(key);
      return { path, content: await obj.text() };
    })
  );
  const deletions = deletesList.objects.map(({ key }) =>
    key.slice("_pending/deletes/".length)
  );

  await commitFiles({ token, repo,
    message: "content: publish staged changes", files, deletions });

  await Promise.all([
    ...filesList.objects.map(  ({ key }) => bucket.delete(key)),
    ...deletesList.objects.map(({ key }) => bucket.delete(key)),
  ]);

  return { files: files.length, deletions: deletions.length };
}
