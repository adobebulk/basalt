/**
 * Page content-type helpers (optional; gated by site/data/basalt.yaml).
 *
 * Homepage lives at site/content/_index.md (title + tagline + optional body).
 * Subpages live at site/content/pages/<slug>/index.md and publish at /<slug>/.
 */

export const HOME_PATH = "site/content/_index.md";
export const PAGES_DIR = "site/content/pages";

export const RESERVED_PAGE_SLUGS = new Set([
  "admin",
  "api",
  "assets",
  "css",
  "projects",
  "posts",
  "pages",
  "index",
  "home",
  "sitemap",
  "tags",
  "categories",
  "_index",
  "_pool",
  "_pending",
]);

export function pagePath(slug) {
  return `${PAGES_DIR}/${slug}/index.md`;
}

export function isReservedPageSlug(slug) {
  if (!slug || typeof slug !== "string") return true;
  return RESERVED_PAGE_SLUGS.has(slug);
}

export function assertPageSlug(slug) {
  if (!slug || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    throw new Error("invalid slug");
  }
  if (isReservedPageSlug(slug)) {
    throw new Error(`slug '${slug}' is reserved`);
  }
  return slug;
}

/** Drop the blank line serializeFrontMatter inserts after closing ---. */
export function pageBody(raw) {
  return (raw ?? "").replace(/^\r?\n/, "");
}
