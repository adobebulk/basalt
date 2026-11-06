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

// Every R2 call yields to the event loop so concurrent requests interleave.
const tick = () => new Promise((r) => setTimeout(r, Math.random() * 3));
let etagSeq = 0;

// Mirrors R2 conditional puts (as observed in wrangler/miniflare): If-Match on
// the quoted httpEtag, If-None-Match: * for create-only; a failed condition returns null.
function conditionHolds(onlyIf, existing) {
  if (!onlyIf) return true;
  const h = onlyIf instanceof Headers ? onlyIf : null;
  const ifMatch = h?.get("If-Match") ?? (onlyIf.etagMatches != null ? `"${onlyIf.etagMatches}"` : null);
  const ifNone = h?.get("If-None-Match");
  if (ifMatch != null && (!existing || `"${existing.etag}"` !== ifMatch)) return false;
  if (ifNone === "*" && existing) return false;
  return true;
}

class Bucket {
  constructor(name) { this.name = name; this.store = new Map(); this.puts = []; }
  async put(key, value, opts = {}) {
    const bytes = await toBytes(value);
    await tick();
    if (!conditionHolds(opts.onlyIf, this.store.get(key))) return null;
    this.puts.push(key);
    const etag = `e${++etagSeq}`;
    this.store.set(key, { bytes, etag, customMetadata: opts.customMetadata ?? {}, httpMetadata: opts.httpMetadata ?? {} });
    return { key, etag, httpEtag: `"${etag}"` };
  }
  wrap(key, o) {
    return {
      key, etag: o.etag, httpEtag: `"${o.etag}"`, customMetadata: o.customMetadata, httpMetadata: o.httpMetadata, size: o.bytes.length,
      get body() { return new Response(o.bytes.slice()).body; },
      arrayBuffer: async () => o.bytes.slice().buffer,
      text: async () => dec.decode(o.bytes),
    };
  }
  async get(key) { await tick(); const o = this.store.get(key); return o ? this.wrap(key, o) : null; }
  async head(key) { await tick(); const o = this.store.get(key); return o ? { key, etag: o.etag, httpEtag: `"${o.etag}"`, size: o.bytes.length, customMetadata: o.customMetadata } : null; }
  async delete(keys) { await tick(); for (const k of [].concat(keys)) this.store.delete(k); }
  async list({ prefix = "" } = {}) {
    await tick();
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

let assets, originals, edgeCache, transformLog, purged, failTransform, transformHook;
function reset() {
  assets = new Bucket("assets"); originals = new Bucket("originals");
  edgeCache = new Map(); transformLog = []; purged = []; failTransform = false; transformHook = null;
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
      if (transformHook) { const h = transformHook; transformHook = null; await h(); }
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
async function stageManifest(slug, front) {
  await originals.put(`_pending/files/site/content/projects/${slug}/_index.md`, `---\n${front}\n---\n`);
}
async function seedPhoto(slug, id, tag) {
  for (const size of [600, 1200, 2400]) for (const ext of ["avif", "jpg"]) await assets.put(`${slug}/${id}/${size}.${ext}`, `${size}.${ext}<-${tag}`);
  await originals.put(`${slug}/${id}/original.jpg`, jpeg(100, 100, tag));
}
const legacyPhotos = (slug, ids) => "photos:\n" + ids.map((id) => `  - id: "${id}"\n    key: "${slug}/${id}"\n    width: 100\n    height: 100\n    caption: ""`).join("\n");
const tempLeftovers = () => [...assets.store.keys()].filter((k) => k.startsWith("_transform/"));
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

// ── 2. transform source ─────────────────────────────────────────────────────
console.log("\n[2] transform source");
const last = transformLog.at(-1);
check("transform reads a unique _transform/<uuid>.jpg source", /\/_transform\/[0-9a-f-]{36}\.jpg$/.test(last), last);
check("each bake uses a distinct source URL", new Set(transformLog).size === 3, `${new Set(transformLog).size} distinct URLs over 3 bakes`);
check("non-downloadable upload never writes a public original", !assets.puts.some((k) => k.endsWith("/original.jpg")), assets.puts.filter((k) => k.endsWith("/original.jpg")).join());
check("no _transform/ objects left behind", tempLeftovers().length === 0, tempLeftovers().join());

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
  check("rebake never writes a public original", !assets.puts.some((k) => k === `${s3.slug}/001/original.jpg`));
  check("no _transform/ objects left behind", tempLeftovers().length === 0, tempLeftovers().join());
  check("purged the /assets variant URLs", purged.includes(`${ORIGIN}/assets/${s3.slug}/001/1200.jpg`));
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
  check("failed rebake leaves no public original or temp source", !assets.store.has(`${s3.slug}/001/original.jpg`) && tempLeftovers().length === 0);

  // A caption saved while transforms run must survive the rebake's manifest write.
  transformHook = () => call("PATCH", ["projects", s3.slug, "photos", "001"], { json: { caption: "edited mid-rebake" } });
  await call("POST", ["projects", s3.slug, "photos", "001", "rebake"]);
  check("caption edited during rebake is kept", /caption: edited mid-rebake/.test(await manifest(s3.slug)), (await manifest(s3.slug)).match(/caption:.*/)?.[0]);
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

// ── 5. legacy manifests (no lastPhotoId) ────────────────────────────────────
console.log("\n[5] legacy manifests without lastPhotoId");
reset();
await stageManifest("legacy", `title: Legacy\ndraft: false\ncover: "001"\n${legacyPhotos("legacy", ["001", "002"])}`);
await seedPhoto("legacy", "001", "L1"); await seedPhoto("legacy", "002", "L2");
await call("DELETE", ["projects", "legacy", "photos", "002"]);
const lu = await call("POST", ["projects", "legacy", "photos"], { files: [["n.jpg", jpeg(100, 100, "N")]] });
check("delete-then-upload on a legacy series gets 003", lu.body.uploaded?.[0]?.id === "003", lu.body.uploaded?.[0]?.id);

reset();
await stageManifest("_pool", `title: Pool\ndraft: true\n${legacyPhotos("_pool", ["001", "002"])}`);
await seedPhoto("_pool", "001", "Q1"); await seedPhoto("_pool", "002", "Q2");
await call("DELETE", ["pool", "002"]);
await call("POST", ["pool"], { files: [["q.jpg", jpeg(100, 100, "Q3")]] });
await call("POST", ["pool", "process"], { json: { limit: 10 } });
const lp = (await call("GET", ["pool"])).body.processed.map((p) => p.id);
check("discard-then-process on a legacy pool gets 003", lp.join() === "001,003", lp.join());

reset();
const { body: s5 } = await call("POST", ["projects"], { json: { title: "Dest" } });
await stageManifest("_pool", `title: Pool\ndraft: true\n${legacyPhotos("_pool", ["001", "002"])}`);
await seedPhoto("_pool", "001", "Q1"); await seedPhoto("_pool", "002", "Q2");
await call("POST", ["projects", s5.slug, "photos", "from-pool"], { json: { ids: ["002"] } });
await call("POST", ["pool"], { files: [["q.jpg", jpeg(100, 100, "Q3")]] });
await call("POST", ["pool", "process"], { json: { limit: 10 } });
const lm = (await call("GET", ["pool"])).body.processed.map((p) => p.id);
check("move-out-then-process on a legacy pool gets 003", lm.join() === "001,003", lm.join());

// ── 6. concurrent requests ──────────────────────────────────────────────────
console.log("\n[6] concurrent requests on one manifest");
reset();
const { body: s6 } = await call("POST", ["projects"], { json: { title: "Busy" } });
await call("POST", ["projects", s6.slug, "photos"], { files: [["x.jpg", jpeg(100, 100, "X")]] });
const cu = await Promise.all(["U1", "U2", "U3"].map((t) =>
  call("POST", ["projects", s6.slug, "photos"], { files: [[`${t}.jpg`, jpeg(100, 100, t)]] })));
const cuIds = cu.map((r) => r.body.uploaded?.[0]?.id);
check("concurrent uploads get distinct ids", new Set(cuIds).size === 3 && !cuIds.includes(undefined), cuIds.join());
const listed = (await call("GET", ["projects", s6.slug, "photos"])).body.map((p) => p.id);
check("all concurrent uploads are in the manifest", ["001", ...cuIds].every((id) => listed.includes(id)), listed.join());
const cuTags = await Promise.all(cuIds.map((id) => variantTag(`${s6.slug}/${id}`)));
check("each concurrent upload shows its own image", cuTags.slice().sort().join() === "U1,U2,U3", cuTags.join());

const [, edit] = await Promise.all([
  call("POST", ["projects", s6.slug, "photos"], { files: [["y.jpg", jpeg(100, 100, "Y")]] }),
  call("PATCH", ["projects", s6.slug, "photos", "001"], { json: { caption: "kept" } }),
]);
check("caption edit racing an upload is kept", edit.status === 200 && /caption: kept/.test(await manifest(s6.slug)));
check("upload racing a caption edit is kept", (await call("GET", ["projects", s6.slug, "photos"])).body.length === 5);

reset();
const { body: s6b } = await call("POST", ["projects"], { json: { title: "Dest" } });
await call("POST", ["pool"], { files: [["m.jpg", jpeg(100, 100, "M")]] });
await call("POST", ["pool", "process"], { json: { limit: 10 } });
const dupMove = await Promise.all([1, 2].map(() => call("POST", ["projects", s6b.slug, "photos", "from-pool"], { json: { ids: ["001"] } })));
const movedCount = dupMove.reduce((n, r) => n + (r.body.moved?.length ?? 0), 0);
const destPhotos = (await call("GET", ["projects", s6b.slug, "photos"])).body;
check("same pool photo moved twice at once lands once", movedCount === 1 && destPhotos.length === 1, `moved ${movedCount}, series has ${destPhotos.length}`);

// ── 7. asset revision ───────────────────────────────────────────────────────
console.log("\n[7] rebake bumps the photo's asset revision");
reset();
const { body: s7 } = await call("POST", ["projects"], { json: { title: "Rev" } });
await call("POST", ["projects", s7.slug, "photos"], { files: [["a.jpg", jpeg(100, 100, "A")]] });
const r1 = await call("POST", ["projects", s7.slug, "photos", "001", "rebake"]);
const r2 = await call("POST", ["projects", s7.slug, "photos", "001", "rebake"]);
check("rev goes 1 then 2", r1.body?.rev === 1 && r2.body?.rev === 2, `${r1.body?.rev}, ${r2.body?.rev}`);
check("manifest stores rev: 2", /rev: 2/.test(await manifest(s7.slug)));

console.log(`\n${failures ? failures + " FAILED" : "ALL PASSED"}`);
process.exit(failures ? 1 : 0);
