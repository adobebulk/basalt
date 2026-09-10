/**
 * GitHub Contents + Git Trees API helpers.
 *
 * All writes use the Git Trees API so multiple files can land in a single commit.
 * Authenticated reads use Contents; public reads without a PAT use
 * raw.githubusercontent.com (unauthenticated Contents is 60 req/hr).
 */

const GH_API = "https://api.github.com";
const RAW_GH = "https://raw.githubusercontent.com";
const DEFAULT_BRANCH = "main";

function isUsableToken(token) {
  if (!token || typeof token !== "string") return false;
  if (/your_scoped_token_here|ghp_your_/i.test(token)) return false;
  return true;
}

function headers(token, { write = false } = {}) {
  const h = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "basalt-admin",
    "Content-Type": "application/json",
  };
  if (isUsableToken(token)) {
    h.Authorization = `Bearer ${token}`;
  } else if (write) {
    throw new Error("GITHUB_TOKEN not configured");
  }
  return h;
}

async function getRawFile(repo, path, branch = DEFAULT_BRANCH) {
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  const res = await fetch(`${RAW_GH}/${repo}/${branch}/${encoded}`, {
    headers: { "User-Agent": "basalt-admin", Accept: "text/plain" },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub raw GET ${path}: ${res.status} ${await res.text()}`);
  return { content: await res.text(), sha: null };
}

/**
 * Read a single file from the repo.
 * Returns { content: string (utf-8), sha: string|null } or null if not found.
 */
export async function getFile(token, repo, path, { branch = DEFAULT_BRANCH } = {}) {
  if (!isUsableToken(token)) {
    return getRawFile(repo, path, branch);
  }
  const res = await fetch(
    `${GH_API}/repos/${repo}/contents/${path}?ref=${encodeURIComponent(branch)}`,
    { headers: headers(token) }
  );
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub GET ${path}: ${res.status} ${await res.text()}`);
  const json = await res.json();
  return {
    content: new TextDecoder().decode(
      Uint8Array.from(atob(json.content.replace(/\s/g, "")), c => c.charCodeAt(0))
    ),
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
export async function commitFiles({ token, repo, branch = DEFAULT_BRANCH, message, files = [], deletions = [] }) {
  const h = headers(token, { write: true });

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
