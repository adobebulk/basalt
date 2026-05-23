/**
 * GitHub Contents + Git Trees API helpers.
 *
 * All writes use the Git Trees API so multiple files can land in a single commit.
 * Reads use the simpler Contents API.
 */

const GH_API = "https://api.github.com";

function headers(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "static-photos-admin",
    "Content-Type": "application/json",
  };
}

/**
 * Read a single file from the repo.
 * Returns { content: string (utf-8), sha: string } or null if not found.
 */
export async function getFile(token, repo, path) {
  const res = await fetch(`${GH_API}/repos/${repo}/contents/${path}`, {
    headers: headers(token),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub GET ${path}: ${res.status} ${await res.text()}`);
  const json = await res.json();
  return {
    content: atob(json.content.replace(/\s/g, "")),
    sha: json.sha,
  };
}

/**
 * List directory contents.
 * Returns array of { name, path, type } or null if not found.
 */
export async function listDir(token, repo, path) {
  const res = await fetch(`${GH_API}/repos/${repo}/contents/${path}`, {
    headers: headers(token),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub LIST ${path}: ${res.status}`);
  return res.json();
}

/**
 * Commit one or more files to the repo in a single commit using the Git Trees API.
 *
 * files: Array of { path: string, content: string (utf-8) }
 * deletions: Array of path strings to remove in the same commit (optional)
 */
export async function commitFiles({ token, repo, branch = "main", message, files = [], deletions = [] }) {
  const h = headers(token);

  // 1. Get current HEAD ref
  const refRes = await fetch(`${GH_API}/repos/${repo}/git/ref/heads/${branch}`, { headers: h });
  if (!refRes.ok) throw new Error(`GitHub ref: ${refRes.status}`);
  const { object: { sha: headSha } } = await refRes.json();

  // 2. Get the commit to find the base tree SHA
  const commitRes = await fetch(`${GH_API}/repos/${repo}/git/commits/${headSha}`, { headers: h });
  if (!commitRes.ok) throw new Error(`GitHub commit: ${commitRes.status}`);
  const { tree: { sha: baseTreeSha } } = await commitRes.json();

  // 3. Build tree entries — blobs for writes, null-mode for deletions
  const treeItems = [];

  for (const f of files) {
    // Create a blob for each file
    const blobRes = await fetch(`${GH_API}/repos/${repo}/git/blobs`, {
      method: "POST",
      headers: h,
      body: JSON.stringify({ content: btoa(unescape(encodeURIComponent(f.content))), encoding: "base64" }),
    });
    if (!blobRes.ok) throw new Error(`GitHub blob ${f.path}: ${blobRes.status}`);
    const { sha: blobSha } = await blobRes.json();
    treeItems.push({ path: f.path, mode: "100644", type: "blob", sha: blobSha });
  }

  for (const p of deletions) {
    treeItems.push({ path: p, mode: "100644", type: "blob", sha: null });
  }

  if (treeItems.length === 0) return null;

  // 4. Create new tree
  const treeRes = await fetch(`${GH_API}/repos/${repo}/git/trees`, {
    method: "POST",
    headers: h,
    body: JSON.stringify({ base_tree: baseTreeSha, tree: treeItems }),
  });
  if (!treeRes.ok) throw new Error(`GitHub tree: ${treeRes.status} ${await treeRes.text()}`);
  const { sha: newTreeSha } = await treeRes.json();

  // 5. Create commit
  const newCommitRes = await fetch(`${GH_API}/repos/${repo}/git/commits`, {
    method: "POST",
    headers: h,
    body: JSON.stringify({ message, tree: newTreeSha, parents: [headSha] }),
  });
  if (!newCommitRes.ok) throw new Error(`GitHub commit create: ${newCommitRes.status}`);
  const { sha: newCommitSha } = await newCommitRes.json();

  // 6. Update the ref
  const updateRes = await fetch(`${GH_API}/repos/${repo}/git/refs/heads/${branch}`, {
    method: "PATCH",
    headers: h,
    body: JSON.stringify({ sha: newCommitSha }),
  });
  if (!updateRes.ok) throw new Error(`GitHub ref update: ${updateRes.status}`);

  return newCommitSha;
}
