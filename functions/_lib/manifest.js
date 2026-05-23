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
  return `---\n${yaml.dump(data, { lineWidth: -1 }).trimEnd()}\n---\n${body}`;
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

/** Generate the next sequential 3-digit photo id given an existing photos array. */
export function nextPhotoId(photos) {
  const max = photos.reduce((m, p) => {
    const n = parseInt(p.id, 10);
    return isNaN(n) ? m : Math.max(m, n);
  }, 0);
  return String(max + 1).padStart(3, "0");
}
