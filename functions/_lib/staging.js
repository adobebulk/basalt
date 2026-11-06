/**
 * Staging layer — holds pending file changes in ORIGINALS_BUCKET under
 * _pending/ until Rebuild flushes them to GitHub in one commit.
 *
 * Key layout in ORIGINALS_BUCKET:
 *   _pending/files/{github-path}   → file content (text)
 *   _pending/deletes/{github-path} → "1"  (mark for deletion)
 *
 * Rebuild never deletes staging records. It marks the exact revision it committed
 * as published with a conditional rewrite (If-Match on the snapshot etag), so a
 * record replaced during the commit fails the condition and stays pending. Every
 * reader treats a published record as absent, which leaves GitHub as the source
 * of truth after a Rebuild, exactly as when staging used to be cleared.
 */

import { commitFiles, getFile } from "./github.js";

const PUBLISHED = "published";

/** True for a staged record that is still pending (not yet committed by Rebuild). */
export function isLive(obj) {
  return Boolean(obj) && !obj.customMetadata?.[PUBLISHED];
}

async function listLive(bucket, prefix) {
  return (await listAll(bucket, { prefix, include: ["customMetadata"] })).filter(isLive);
}

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
  const del = await bucket.head(`_pending/deletes/${path}`);
  if (isLive(del)) return null;
  const pending = await bucket.get(`_pending/files/${path}`);
  if (isLive(pending)) return { content: await pending.text() };
  return githubFallback ? githubFallback(path) : null;
}

/**
 * Return slugs of series staged but not yet in GitHub.
 * Scans _pending/files/site/content/projects/<slug>/_index.md keys.
 */
export async function getStagedSlugs(bucket) {
  const objects = await listLive(bucket, "_pending/files/site/content/projects/");
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
  const objects = await listLive(bucket, "_pending/files/site/content/posts/");
  const slugs = new Set();
  for (const { key } of objects) {
    const m = key.match(/^_pending\/files\/site\/content\/posts\/([^/]+)\/index\.md$/);
    if (m) slugs.add(m[1]);
  }
  return [...slugs];
}

/** True if the post index.md is staged for deletion. */
export async function isStagedPostDeleted(bucket, slug) {
  return isLive(await bucket.head(`_pending/deletes/site/content/posts/${slug}/index.md`));
}

/**
 * Return slugs of pages staged but not yet in GitHub.
 * Scans _pending/files/site/content/pages/<slug>/index.md keys.
 */
export async function getStagedPageSlugs(bucket) {
  const objects = await listLive(bucket, "_pending/files/site/content/pages/");
  const slugs = new Set();
  for (const { key } of objects) {
    const m = key.match(/^_pending\/files\/site\/content\/pages\/([^/]+)\/index\.md$/);
    if (m) slugs.add(m[1]);
  }
  return [...slugs];
}

/** True if the page index.md is staged for deletion. */
export async function isStagedPageDeleted(bucket, slug) {
  return isLive(await bucket.head(`_pending/deletes/site/content/pages/${slug}/index.md`));
}

/** True if the series _index.md is staged for deletion. */
export async function isStagedDeleted(bucket, slug) {
  return isLive(await bucket.head(`_pending/deletes/site/content/projects/${slug}/_index.md`));
}

/** Counts of pending writes and deletes. Used by the admin rebuild indicator. */
export async function pendingCounts(bucket) {
  const [files, deletions] = await Promise.all([
    listLive(bucket, "_pending/files/"),
    listLive(bucket, "_pending/deletes/"),
  ]);
  return { files: files.length, deletions: deletions.length };
}

/**
 * Flush all staged changes to GitHub in one commit and clear staging.
 * Returns { noop: true } if nothing pending, else { files, deletions }.
 */
export async function flushStaging(bucket, token, repo) {
  const filesObjects   = await listLive(bucket, "_pending/files/");
  const deletesObjects = await listLive(bucket, "_pending/deletes/");

  // Snapshot each record with its etag; the ack below is conditional on it.
  const files = (await Promise.all(
    filesObjects.map(async ({ key }) => {
      const obj = await bucket.get(key);
      if (!isLive(obj)) return null;
      return {
        key, etag: obj.httpEtag, body: await obj.text(),
        contentType: "text/plain; charset=utf-8", path: key.slice("_pending/files/".length),
      };
    })
  )).filter(Boolean);
  const deleteMarkers = (await Promise.all(
    deletesObjects.map(async ({ key }) => {
      const obj = await bucket.head(key);
      return isLive(obj) ? { key, etag: obj.httpEtag, body: "1", contentType: "text/plain" } : null;
    })
  )).filter(Boolean);

  if (!files.length && !deleteMarkers.length)
    return { noop: true };

  const deletions = deleteMarkers.map(({ key }) => key.slice("_pending/deletes/".length));

  // Skip deletions for paths that don't exist in GitHub — sending sha:null for a
  // path GitHub has never seen causes a 422 GitRPC::BadObjectState error.
  const existingDeletions = (
    await Promise.all(
      deletions.map(async (path) => ((await getFile(token, repo, path)) ? path : null))
    )
  ).filter(Boolean);

  await commitFiles({ token, repo,
    message: "content: publish staged changes",
    files: files.map(({ path, body }) => ({ path, content: body })),
    deletions: existingDeletions });

  // Acknowledge exactly the revisions that were committed (including phantom
  // deletes that were skipped). The rewrite is atomic with respect to other
  // writers: if a record was replaced after the snapshot, If-Match fails and the
  // newer revision stays pending for the next Rebuild. Whether an etag is
  // per-write or a content hash, a match means the record holds the committed bytes.
  // Records are never deleted here — an unconditional delete could drop a newer write.
  const publishedAt = new Date().toISOString();
  await Promise.all([...files, ...deleteMarkers].map(({ key, etag, body, contentType }) =>
    bucket.put(key, body, {
      httpMetadata: { contentType },
      customMetadata: { [PUBLISHED]: publishedAt },
      onlyIf: new Headers({ "If-Match": etag }),
    })
  ));

  return { files: files.length, deletions: existingDeletions.length };
}
