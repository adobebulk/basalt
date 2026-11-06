/**
 * Front-matter parsing helpers for Hugo _index.md / <id>.md files.
 * Uses js-yaml so the photos[] array of objects round-trips correctly.
 */

import yaml from "js-yaml";

/** Parse a Hugo markdown file → { data, body } where data is the front-matter object. */
export function parseFrontMatter(raw) {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { data: {}, body: "" };
  return {
    data: yaml.load(match[1]) ?? {},
    body: match[2] ?? "",
  };
}

/** Serialize front-matter object + optional body back into a Hugo markdown file. */
export function serializeFrontMatter(data, body = "") {
  return `---\n${yaml.dump(data, { lineWidth: -1 }).trimEnd()}\n---\n\n${body}`;
}

/** Build a minimal series _index.md for a brand-new series. */
export function newSeriesDoc({ title, description, slug }) {
  const data = {
    title,
    description: description ?? "",
    date: new Date().toISOString().split("T")[0],
    draft: true,
    cover: "",
    downloadsDefault: false,
    photos: [],
  };
  return serializeFrontMatter(data);
}

/** Build a minimal per-photo stub <id>.md. */
export function newPhotoStub(photoid) {
  return `---\nphotoid: "${photoid}"\n---\n`;
}

/** Turn a title string into a URL-safe slug. */
export function slugify(str) {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/, "");
}

/**
 * Generate the next sequential 3-digit photo id.
 *
 * IDs must never be reused: asset URLs (/assets/<slug>/<id>/...) are served as
 * immutable and the transform source is edge-cached, so a reused ID can show the
 * previous photo. `lastPhotoId` is a per-manifest high-water mark that survives
 * deleting or moving out the highest-numbered photo; callers must persist the
 * returned id's number back to `lastPhotoId` in the same manifest write.
 */
export function nextPhotoId(photos, lastPhotoId = 0) {
  return String(photoIdHighWater(photos, lastPhotoId) + 1).padStart(3, "0");
}

/**
 * Highest photo id number ever issued for a manifest. Paths that remove photos
 * persist this (computed from the list *before* removal) as `lastPhotoId`, so
 * legacy manifests without the field cannot hand a removed id out again.
 */
export function photoIdHighWater(photos, lastPhotoId = 0) {
  return photos.reduce((m, p) => {
    const n = parseInt(p.id, 10);
    return isNaN(n) ? m : Math.max(m, n);
  }, Number(lastPhotoId) || 0);
}
