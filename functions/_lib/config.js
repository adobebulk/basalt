/**
 * Site identity config (site/data/basalt.yaml).
 *
 * Secrets and Cloudflare bindings stay in wrangler / the Pages dashboard.
 * This file is what makes a gallery, a blog, or a personal site out of the
 * same engine: which content types exist, and which homepage the theme uses.
 *
 * Hugo must apply the same rules via layouts/partials/basalt-config.html
 * (do not read .Site.Data.basalt raw in templates).
 * Functions read it from GitHub / staging the same way as settings.yaml.
 */

import yaml from "js-yaml";
import { readStaged } from "./staging.js";
import { getFile } from "./github.js";

export const CONFIG_PATH = "site/data/basalt.yaml";

export const DEFAULT_CONFIG = {
  contentTypes: {
    series: true,
    pool: true,
    posts: true,
    pages: false,
  },
  homepage: "gallery",
  nav: "default",
};

const KNOWN_TYPES = ["series", "pool", "posts", "pages"];
const HOMEPAGES = new Set(["gallery", "posts", "splash"]);

async function githubFileFallback(env, path) {
  if (!env.githubRepo) return null;
  try {
    return await getFile(env.githubToken, env.githubRepo, path);
  } catch (e) {
    console.error(`[readConfig] ${path}:`, e);
    return null;
  }
}

function parseContentTypes(raw) {
  const types = { ...DEFAULT_CONFIG.contentTypes };
  if (Array.isArray(raw)) {
    const set = new Set(raw.map((t) => String(t)));
    for (const t of KNOWN_TYPES) types[t] = set.has(t);
    return types;
  }
  if (raw && typeof raw === "object") {
    for (const t of KNOWN_TYPES) {
      if (raw[t] !== undefined) types[t] = Boolean(raw[t]);
    }
  }
  return types;
}

export function normalizeConfig(raw = {}) {
  const contentTypes = parseContentTypes(raw.contentTypes);
  if (contentTypes.pool && !contentTypes.series) contentTypes.pool = false;

  let homepage = HOMEPAGES.has(raw.homepage) ? raw.homepage : DEFAULT_CONFIG.homepage;
  if (homepage === "gallery" && !contentTypes.series && contentTypes.posts) homepage = "posts";
  if (homepage === "posts" && !contentTypes.posts && contentTypes.series) homepage = "gallery";
  // splash is valid without pages (homepage editor only; no subpage CRUD).

  const nav = raw.nav === "configurable" ? "configurable" : "default";
  return { contentTypes, homepage, nav };
}

export async function readConfig(env) {
  const result = await readStaged(
    env.stagingBucket,
    CONFIG_PATH,
    async (p) => githubFileFallback(env, p)
  );
  if (!result) return { ...DEFAULT_CONFIG, contentTypes: { ...DEFAULT_CONFIG.contentTypes } };
  try {
    return normalizeConfig(yaml.load(result.content) ?? {});
  } catch (e) {
    console.error("[readConfig] invalid YAML:", e);
    return { ...DEFAULT_CONFIG, contentTypes: { ...DEFAULT_CONFIG.contentTypes } };
  }
}

export function typeEnabled(config, type) {
  return Boolean(config?.contentTypes?.[type]);
}
