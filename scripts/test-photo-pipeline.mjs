// Usage: npm run test:pipeline   (or: node scripts/test-photo-pipeline.mjs [repo-root])
// Drives functions/api/[[route]].js with mocked R2 buckets and a fetch stub that
// edge-caches R2 custom-domain responses by full URL (honouring the purge API),
// so photo-id reuse and stale transform sources show up as wrong variant bytes.
// Exits non-zero on any failure. Run it against main to reproduce, the branch to confirm.
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = path.resolve(process.argv[2] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));
const { onRequest } = await import(pathToFileURL(path.join(repo, "functions/api/[[route]].js")).href);

const R2 = "https://r2.example.com";
const ORIGIN = "https://example.com";
const enc = new TextEncoder();
const dec = new TextDecoder();

async function toBytes(v) {
  if (v == null) return new Uint8Array();
  if (typeof v === "string") return enc.encode(v);
  if (v instanceof Uint8Array) return new Uint8Array(v);
  if (v instanceof ArrayBuffer) return new Uint8Array(v.slice(0));
  if (v instanceof ReadableStream) return new Uint8Array(await new Response(v).arrayBuffer());
  throw new Error("unsupported put value " + Object.prototype.toString.call(v));
}

class Bucket {
  constructor(name) { this.name = name; this.store = new Map(); }
  async put(key, value, opts = {}) {
    this.store.set(key, { bytes: await toBytes(value), customMetadata: opts.customMetadata ?? {}, httpMetadata: opts.httpMetadata ?? {} });
  }
  wrap(key, o) {
    return {
      key, customMetadata: o.customMetadata, httpMetadata: o.httpMetadata, size: o.bytes.length,
      get body() { return new Response(o.bytes.slice()).body; },
      arrayBuffer: async () => o.bytes.slice().buffer,
      text: async () => dec.decode(o.bytes),
    };
  }
  async get(key) { const o = this.store.get(key); return o ? this.wrap(key, o) : null; }
  async head(key) { const o = this.store.get(key); return o ? { key, size: o.bytes.length, customMetadata: o.customMetadata } : null; }
  async delete(keys) { for (const k of [].concat(keys)) this.store.delete(k); }
  async list({ prefix = "" } = {}) {
    const objects = [...this.store.keys()].filter((k) => k.startsWith(prefix)).sort()
      .map((k) => ({ key: k, customMetadata: this.store.get(k).customMetadata }));
    return { objects, truncated: false };
  }
}

function jpeg(w, h, tag) {
  const head = [0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 255, w >> 8, w & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1];
  return new Uint8Array([...head, 0xff, 0xd9, ...enc.encode(`TAG:${tag}`)]);
}
const tagOf = (bytes) => { const s = dec.decode(bytes); const i = s.indexOf("TAG:"); return i < 0 ? "?" : s.slice(i + 4); };

let assets, originals, edgeCache, transformLog, purged, failTransform;
function reset() {
  assets = new Bucket("assets"); originals = new Bucket("originals");
  edgeCache = new Map(); transformLog = []; purged = []; failTransform = false;
}

globalThis.caches = { default: { delete: async () => true } };
globalThis.fetch = async (input, opts = {}) => {
  const url = typeof input === "string" ? input : input.url;
  if (url.includes("/purge_cache")) {
    const { files } = JSON.parse(opts.body);
    for (const f of files) { purged.push(f); edgeCache.delete(f); }
    return new Response("{}", { status: 200 });
  }
  if (url.startsWith(R2)) {
    if (opts.cf?.image) transformLog.push(url);
    let src = edgeCache.get(url);
    if (!src) {
      const key = new URL(url).pathname.slice(1);
      const o = assets.store.get(key);
      if (!o) return new Response("not found", { status: 404 });
      src = o.bytes;
      edgeCache.set(url, src);
    }
    if (opts.cf?.image) {
      if (failTransform) return new Response("boom", { status: 500 });
      return new Response(`${opts.cf.image.width}.${opts.cf.image.format}<-${tagOf(src)}`);
    }
    return new Response(src.slice());
  }
  if (url.includes("githubusercontent.com") || url.includes("api.github.com")) return new Response("", { status: 404 });
  throw new Error("unexpected fetch " + url);
};

const env = () => ({
  ASSETS_BUCKET: assets, ORIGINALS_BUCKET: originals, ASSETS_R2_PUBLIC_URL: R2,
  PUBLIC_ORIGIN: ORIGIN, CF_ZONE_ID: "zone", CF_API_TOKEN: "tok", PACKAGE_VERSION: "test",
});

async function call(method, segs, { json, files } = {}) {
  const init = { method };
  if (json) { init.body = JSON.stringify(json); init.headers = { "content-type": "application/json" }; }
  if (files) { const fd = new FormData(); for (const [n, b] of files) fd.append("photos", new File([b], n, { type: "image/jpeg" })); init.body = fd; }
  const res = await onRequest({ request: new Request(`${ORIGIN}/api/${segs.join("/")}`, init), params: { route: segs }, env: env() });
  const text = await res.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
}

async function manifest(slug) {
  const o = await originals.get(`_pending/files/site/content/projects/${slug}/_index.md`);
  return o ? await o.text() : "";
}
const variantTag = async (key) => { const o = await assets.get(`${key}/1200.jpg`); return o ? (await o.text()).split("<-")[1] : null; };

let failures = 0;
const check = (name, ok, detail = "") => { if (!ok) failures++; console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`); };

// ── 1. delete top photo, upload a different one ─────────────────────────────
console.log("\n[1] series 001–002 → delete 002 → upload a different photo");
reset();
const { body: s } = await call("POST", ["projects"], { json: { title: "Trip" } });
const slug = s.slug;
await call("POST", ["projects", slug, "photos"], { files: [["a.jpg", jpeg(4000, 3000, "A")], ["b.jpg", jpeg(4000, 3000, "B")]] });
await call("DELETE", ["projects", slug, "photos", "002"]);
const up = await call("POST", ["projects", slug, "photos"], { files: [["c.jpg", jpeg(3000, 2000, "C")]] });
const newId = up.body.uploaded?.[0]?.id;
check("new photo gets id 003", newId === "003", `got ${newId}`);
check("new photo's variants show the new image (C)", (await variantTag(`${slug}/${newId}`)) === "C", `1200.jpg baked from ${await variantTag(`${slug}/${newId}`)}`);
check("manifest has lastPhotoId: 3", /^lastPhotoId: 3$/m.test(await manifest(slug)));
check("delete purged the R2-domain original", purged.includes(`${R2}/${slug}/002/original.jpg`));
check("private original saved correctly", tagOf(originals.store.get(`${slug}/${newId}/original.jpg`)?.bytes ?? new Uint8Array()) === "C");

// ── 2. transform URL carries a nonce ────────────────────────────────────────
console.log("\n[2] transform source URL");
const last = transformLog.at(-1);
check("transform fetch URL carries ?v=<uuid>", /\/original\.jpg\?v=[0-9a-f-]{36}$/.test(last), last);
check("each bake uses a distinct nonce", new Set(transformLog.map((u) => u.split("?v=")[1])).size === 3, `${new Set(transformLog.map((u) => u.split("?v=")[1])).size} distinct nonces over 3 bakes`);

// ── 3. rebake ───────────────────────────────────────────────────────────────
console.log("\n[3] rebake repairs a stale photo");
reset();
const { body: s3 } = await call("POST", ["projects"], { json: { title: "Repair" } });
await call("POST", ["projects", s3.slug, "photos"], { files: [["a.jpg", jpeg(4000, 3000, "A")]] });
// Simulate the pre-fix damage: variants baked from an old photo, wrong dims.
for (const k of [...assets.store.keys()]) if (k.startsWith(`${s3.slug}/001/`)) await assets.put(k, "1200.jpeg<-OLD");
const r = await call("POST", ["projects", s3.slug, "photos", "001", "rebake"]);
if (r.status === 404 && r.body?.error === "not found") {
  check("rebake route exists", false, "POST .../rebake → 404 (not implemented)");
} else {
  check("rebake returns 200", r.status === 200, `${r.status} ${JSON.stringify(r.body)}`);
  check("variants regenerated from the stored original", (await variantTag(`${s3.slug}/001`)) === "A");
  check("ORIGINALS_BUCKET original kept", originals.store.has(`${s3.slug}/001/original.jpg`));
  check("temporary public original removed", !assets.store.has(`${s3.slug}/001/original.jpg`));
  check("purged /assets URLs and R2 URL", purged.includes(`${ORIGIN}/assets/${s3.slug}/001/1200.jpg`) && purged.includes(`${R2}/${s3.slug}/001/original.jpg`));
  check("manifest width/height from original", /width: 4000/.test(await manifest(s3.slug)) && /height: 3000/.test(await manifest(s3.slug)));

  // Downloadable photo: public original must survive a rebake.
  await assets.put(`${s3.slug}/001/original.jpg`, originals.store.get(`${s3.slug}/001/original.jpg`).bytes);
  await call("POST", ["projects", s3.slug, "photos", "001", "rebake"]);
  check("already-public original stays public", assets.store.has(`${s3.slug}/001/original.jpg`));
  await assets.delete(`${s3.slug}/001/original.jpg`);

  // Failed rebake must not destroy anything.
  failTransform = true;
  const before = (await assets.get(`${s3.slug}/001/1200.jpg`)) && (await (await assets.get(`${s3.slug}/001/1200.jpg`)).text());
  const rf = await call("POST", ["projects", s3.slug, "photos", "001", "rebake"]);
  failTransform = false;
  check("failed rebake returns an error", rf.status >= 400, String(rf.status));
  check("failed rebake keeps the private original", originals.store.has(`${s3.slug}/001/original.jpg`));
  check("failed rebake keeps existing variants", (await (await assets.get(`${s3.slug}/001/1200.jpg`))?.text()) === before);
  check("failed rebake removes temporary public original", !assets.store.has(`${s3.slug}/001/original.jpg`));
}

// ── 4. pool ─────────────────────────────────────────────────────────────────
console.log("\n[4] pool: drop → process → move all → drop more → process");
reset();
const { body: s4 } = await call("POST", ["projects"], { json: { title: "Dest" } });
await call("POST", ["pool"], { files: [["p1.jpg", jpeg(100, 100, "P1")], ["p2.jpg", jpeg(100, 100, "P2")]] });
await call("POST", ["pool", "process"], { json: { limit: 10 } });
const pool1 = (await call("GET", ["pool"])).body.processed.map((p) => p.id);
const mv = await call("POST", ["projects", s4.slug, "photos", "from-pool"], { json: { ids: pool1 } });
check("move purged R2-domain URLs of pool sources", pool1.every((id) => purged.includes(`${R2}/_pool/${id}/original.jpg`)));
await call("POST", ["pool"], { files: [["p3.jpg", jpeg(100, 100, "P3")], ["p4.jpg", jpeg(100, 100, "P4")]] });
await call("POST", ["pool", "process"], { json: { limit: 10 } });
const pool2 = (await call("GET", ["pool"])).body.processed.map((p) => p.id);
check("first batch pool ids 001,002", pool1.join() === "001,002", pool1.join());
check("second batch pool ids continue 003,004", pool2.join() === "003,004", pool2.join());
const tags2 = await Promise.all(pool2.map((id) => variantTag(`_pool/${id}`)));
check("second batch shows the new images", tags2.sort().join() === "P3,P4", tags2.join());
check("pool manifest lastPhotoId: 4", /^lastPhotoId: 4$/m.test(await manifest("_pool")));
check("series manifest lastPhotoId: 2", /^lastPhotoId: 2$/m.test(await manifest(s4.slug)), mv.body.moved?.map((p) => p.id).join());
// Move the second batch after deleting the series' top photo: ids must not be reused.
await call("DELETE", ["projects", s4.slug, "photos", "002"]);
const mv2 = await call("POST", ["projects", s4.slug, "photos", "from-pool"], { json: { ids: pool2 } });
check("second move into series continues 003,004", mv2.body.moved?.map((p) => p.id).join() === "003,004", mv2.body.moved?.map((p) => p.id).join());

console.log(`\n${failures ? failures + " FAILED" : "ALL PASSED"}`);
process.exit(failures ? 1 : 0);
