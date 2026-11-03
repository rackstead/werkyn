import assert from "node:assert/strict";
import { test } from "node:test";
import { createHmac } from "node:crypto";
import { buildSyntheticStorageReferenceReport as build, STORAGE_REFERENCE_LIMITS as L } from "../src/utils/storage-reference-report.js";

const key = new Uint8Array(32).fill(17); // Fixed synthetic fixture bytes, not a generated report key.
const root = { slot: 0, kind: "CONFIGURED_STORAGE", bindings: [{ origin: null, routePrefix: "/s/" }] };
const envelope = () => ({ schemaVersion: 1, declaredSourceRevision: "a".repeat(40), snapshotNativeTimestamp3: "2026-01-01 12:00:00.001", roots: [structuredClone(root)],
  sources: { files: [], attachments: [], avatars: [], wikiPages: [], wikiVersions: [], cleanupQueue: [] } });
const run = data => build(Buffer.from(JSON.stringify(data)), key);
const file = (storagePath, more = {}) => ({ rootSlot: 0, storagePath, thumbnailPath: null, trashed: false, isFolder: false, ...more });
const codes = report => report.issues.map(i => i.code);
const facts = report => report.identities.flatMap(i => i.observations);
const counts = report => facts(report).reduce((sum, o) => sum + o.observedCount, 0);
const safe = report => {
  assert.equal(report.completeForDestructiveUse, false); assert.equal(report.physicalState, "NOT_OBSERVED");
  assert.equal(report.scope, "DECLARED_SYNTHETIC_ONLY"); assert.ok(Buffer.byteLength(JSON.stringify(report)) <= L.outputUtf8Bytes);
};

test("empty supplied reference strings are unknown while null references remain ordinary", () => {
  const data = envelope();
  data.sources.files = [file("", { thumbnailPath: "" }), file(null)];
  data.sources.attachments = [{ rootSlot: 0, storagePath: "", fileId: null }, { rootSlot: 0, storagePath: null, fileId: null }];
  data.sources.avatars = [{ avatarUrl: "" }, { avatarUrl: null }];
  data.sources.wikiPages = [{ contentJson: JSON.stringify("") }];
  data.sources.cleanupQueue = [{ rootSlot: 0, storagePath: "", attempts: 0, availableAt: data.snapshotNativeTimestamp3, createdAt: data.snapshotNativeTimestamp3 }];
  const report = run(data); safe(report);
  assert.deepEqual(report.identities, []); assert.equal(report.coverage.files.processedRows, 2);
  assert.equal(report.coverage.cleanupQueue.processedRows, 1);
  assert.equal(report.issues.find(i => i.code === "EMPTY_REFERENCE")?.count, 6);
  assert.deepEqual(report.issues.map(i => i.code), ["EMPTY_REFERENCE"]);
});

test("all positive source facts coexist with queue observations without inferring absence", () => {
  const data = envelope();
  data.sources.files = [file("photo", { thumbnailPath: "photo", trashed: true, isFolder: true }), file("photo")];
  data.sources.attachments = [{ rootSlot: 0, storagePath: "photo", fileId: "fixture-link" }, { rootSlot: 0, storagePath: "photo", fileId: null }];
  data.sources.avatars = [{ avatarUrl: "/s/photo" }];
  data.sources.wikiPages = [{ contentJson: JSON.stringify({ arbitrary: "/s/photo" }) }];
  data.sources.wikiVersions = [{ contentJson: JSON.stringify({ "/s/photo": "/s/version-only" }) }];
  data.sources.cleanupQueue = [{ rootSlot: 0, storagePath: "photo", attempts: 3, availableAt: "2026-01-02 12:00:00.000", createdAt: "2025-01-01 00:00:00.000" }];
  const report = run(data); safe(report); assert.equal(report.identities.length, 2);
  assert.deepEqual(new Set(facts(report).map(o => o.sourceKind)), new Set(["files", "attachments", "avatars", "wikiPages", "wikiVersions"]));
  const main = report.identities.find(i => i.queueClasses.length); assert.equal(main.queueClasses[0].class, "attempted_deferred_ambiguous");
  assert.ok(main.observations.some(o => o.flags.includes("TRASHED") && o.flags.includes("FOLDER_ROW")));
  assert.ok(main.observations.some(o => o.flags.includes("NULL_OR_LEGACY_UNKNOWN")));
});
test("configured, avatar and legacy roots and unresolved row contexts never collapse", () => {
  const data = envelope(); data.roots.push({ slot: 1, kind: "LEGACY_UPLOAD", bindings: [] }, { slot: 2, kind: "AVATAR_STORAGE", bindings: [] });
  data.sources.files = [file("same"), file("same", { rootSlot: 1 }), file("same", { rootSlot: 2 }), file("same", { rootSlot: null }), file("same", { rootSlot: null })];
  const report = run(data); assert.equal(report.identities.length, 5); assert.equal(new Set(report.identities.map(i => i.rootId)).size, 5); safe(report);
});
test("raw stored identities, URI modes and one decoding retain ordinary filename alternatives", () => {
  const data = envelope(); data.sources.files = [file("a%20+b?x#f")]; data.sources.avatars = [{ avatarUrl: "/s/a%20+b?x#f" }];
  const report = run(data); assert.equal(report.identities.length, 4); const modes = new Set(facts(report).map(o => o.mode));
  assert.deepEqual(modes, new Set(["stored_path", "raw_full", "raw_uri", "decoded_full", "decoded_uri"]));
  const shared = report.identities.find(i => i.observations.some(o => o.mode === "stored_path"));
  assert.ok(shared.observations.some(o => o.mode === "raw_full"));
  assert.equal(new Set(shared.observations.map(o => o.interpretationId)).size, 2);
  const twice = envelope(); twice.sources.avatars = [{ avatarUrl: "/s/a%2520" }]; assert.equal(run(twice).identities.length, 2);
});
test("foreign, embedded, ambiguous, unsafe and malformed URI values remain explicit unknown", () => {
  const data = envelope(); data.roots.push({ ...structuredClone(root), slot: 1, kind: "AVATAR_STORAGE" });
  data.sources.avatars = [{ avatarUrl: "/s/overlap" }, { avatarUrl: "https://foreign.invalid/s/file" }, { avatarUrl: "<img src='/s/embedded'>" }];
  let report = run(data); assert.equal(report.identities.length, 0); assert.ok(codes(report).includes("AMBIGUOUS_BINDING")); assert.ok(codes(report).includes("UNPARSED_EMBEDDED_OR_TEXT"));
  data.roots.pop(); data.sources.avatars = [{ avatarUrl: "/s/../outside" }, { avatarUrl: "/s/%ZZ" }]; report = run(data);
  assert.ok(codes(report).includes("UNSAFE_URI_CANDIDATE")); assert.ok(codes(report).includes("MALFORMED_PERCENT")); safe(report);
});
test("native timestamp precision has four observational classes, without timezone conversion", () => {
  const data = envelope();
  data.sources.cleanupQueue = [
    { attempts: 9, availableAt: data.snapshotNativeTimestamp3 }, { attempts: 0, availableAt: "2026-01-01 12:00:00.002" },
    { attempts: 2, availableAt: "2026-01-01 12:00:00.002" }, { attempts: 0, availableAt: "2026-02-30 00:00:00.000" },
  ].map((row, index) => ({ ...row, rootSlot: 0, storagePath: String(index), createdAt: "2025-01-01 00:00:00.000" }));
  const report = run(data); assert.deepEqual(new Set(report.identities.flatMap(i => i.queueClasses.map(q => q.class))), new Set(["due_at_snapshot", "unattempted_deferred", "attempted_deferred_ambiguous", "invalid_or_unknown_metadata"]));
  data.snapshotNativeTimestamp3 = "2026-01-01T12:00:00.001Z"; assert.equal(run(data).status, "INVALID_INPUT");
});
test("missing sources and bounded row/token/depth/width traversal mark omissions unknown", () => {
  const data = envelope(); data.sources.files = Array.from({ length: 101 }, () => file("shared")); data.sources.attachments = null;
  data.sources.avatars = [{ avatarUrl: "/s/" + "x".repeat(4097) }];
  let nested = "/s/too-deep"; for (let n = 0; n < 33; n++) nested = [nested];
  data.sources.wikiPages = [{ contentJson: JSON.stringify(nested) }, { contentJson: JSON.stringify(Array(65).fill("/s/wide")) }];
  const report = run(data); assert.equal(report.coverage.files.omittedRows, 1);
  for (const code of ["SOURCE_NOT_SUPPLIED", "ROW_LIMIT", "TOKEN_LIMIT", "DEPTH_LIMIT", "WIDTH_LIMIT"]) assert.ok(codes(report).includes(code), code); safe(report);
});
test("byte preflights, node and identity budgets refuse bounded synthetic expansion", () => {
  assert.equal(build(new Uint8Array(L.inputUtf8Bytes + 1), key).status, "INVALID_INPUT");
  const data = envelope(); data.sources.wikiPages = [{ contentJson: " ".repeat(16385) }]; assert.ok(codes(run(data)).includes("CONTENT_LIMIT"));
  data.sources.wikiPages = Array.from({ length: 4 }, () => ({ contentJson: JSON.stringify(Array.from({ length: 50 }, () => Array(50).fill(null))) }));
  assert.ok(codes(run(data)).includes("NODE_LIMIT"));
  const many = envelope(); many.sources.files = Array.from({ length: 100 }, (_, i) => file(`f${i}`, { thumbnailPath: `t${i}` }));
  many.sources.attachments = Array.from({ length: 100 }, (_, i) => ({ rootSlot: 0, storagePath: `a${i}`, fileId: null }));
  const report = run(many); assert.equal(report.identities.length, 256); assert.ok(codes(report).includes("IDENTITY_LIMIT")); safe(report);
});
test("lone high and low surrogates never reach identities while U+FFFD and valid pairs remain exact", () => {
  const data = envelope(); data.sources.files = [file("\ud800"), file("\udc00"), file("\ufffd"), file("\ud83e\uddea"), file("🧪"), file("é"), file("e\u0301")];
  const report = run(data); assert.equal(report.identities.length, 4); assert.equal(counts(report), 5);
  assert.ok(codes(report).includes("MALFORMED_UTF16_REFERENCE"));
  const replacement = envelope(); replacement.sources.files = [file("\ufffd")]; assert.equal(run(replacement).identities.length, 1);
});
test("malformed wiki strings/keys and outer JSON payload remain redacted unknown", () => {
  const data = envelope(); data.sources.wikiPages = [{ contentJson: JSON.stringify({ "\ud800": "/s/skipped", valid: "\udc00", okay: "/s/kept" }) }, { contentJson: "\ud800" }];
  const report = run(data); assert.equal(report.identities.length, 1); assert.ok(codes(report).includes("MALFORMED_UTF16_REFERENCE")); safe(report);
});
test("invalid roots/schema/UTF8/key return fixed diagnostics without raw data", () => {
  for (const value of ["\ud800", "\udc00"]) {
    const data = envelope(); data.roots[0].bindings[0].routePrefix = value;
    const report = run(data); assert.equal(report.status, "INVALID_INPUT"); assert.equal(report.identities.length, 0); assert.equal(report.issues[0].code, "MALFORMED_UTF16_DECLARATION");
  }
  assert.equal(build(new Uint8Array([255]), key).issues[0].code, "INVALID_UTF8_OR_JSON");
  assert.equal(build(Buffer.from("{}"), new Uint8Array(31)).issues[0].code, "INVALID_KEY");
  const data = envelope(); data.roots[0].kind = "RAW_PRIVATE_SENTINEL"; assert.ok(!JSON.stringify(run(data)).includes("RAW_PRIVATE_SENTINEL"));
});
test("length-framed root/path HMAC is deterministic, key-separated and does not mutate input", () => {
  const data = envelope(); data.sources.files = [file("ab"), file("a")]; const bytes = Buffer.from(JSON.stringify(data)), before = Buffer.from(bytes), beforeKey = Uint8Array.from(key);
  const report = build(bytes, key); assert.deepEqual(build(bytes, key), report); assert.deepEqual(bytes, before); assert.deepEqual(key, beforeKey);
  const alternate = build(bytes, new Uint8Array(32).fill(18)); assert.notEqual(alternate.identities[0].pathId, report.identities[0].pathId);
  // Independent fixed wire framing expectation; catches unframed or LE concatenation.
  const hmac = chunks => createHmac("sha256", key).update(Buffer.concat(chunks)).digest("hex");
  const part = s => { const b = Buffer.from(s), n = Buffer.alloc(4); n.writeUInt32BE(b.length); return Buffer.concat([n, b]); };
  assert.equal(Buffer.concat([part("ab"), part("c")]).toString("hex"), "0000000261620000000163");
  assert.equal(Buffer.concat([part("a"), part("bc")]).toString("hex"), "0000000161000000026263");
  const rootId = hmac([part("r26/root/v1"), part("0"), part("CONFIGURED_STORAGE"), part("RELATIVE"), part("/s/")]);
  assert.ok(report.identities.every(i => i.rootId === rootId));
  assert.ok(report.identities.some(i => i.pathId === hmac([part("r26/path/v1"), part(rootId), part("ab")])));
});
test("default report and bounded output fallback never expose fixture sentinels or key", () => {
  const data = envelope(); data.sources.files = [file("PRIVATE_PATH_SENTINEL")]; data.sources.avatars = [{ avatarUrl: "https://private.invalid/email@example.invalid" }];
  const text = JSON.stringify(run(data)); for (const secret of ["PRIVATE_PATH_SENTINEL", "private.invalid", "email@example.invalid"]) assert.ok(!text.includes(secret));
  const dense = envelope(); const urls = Array.from({ length: 64 }, (_, n) => `/s/a%61-${n}?q#f`);
  dense.sources.avatars = urls.map(avatarUrl => ({ avatarUrl }));
  dense.sources.wikiPages = [{ contentJson: JSON.stringify(Object.fromEntries(urls.map(u => [u, u]))) }];
  dense.sources.wikiVersions = structuredClone(dense.sources.wikiPages);
  const report = run(dense); assert.deepEqual(report.issues, [{ code: "OUTPUT_LIMIT", count: 1 }]);
  assert.deepEqual(report.identities, []); assert.equal(report.coverage, "UNKNOWN_NOT_ZERO"); assert.ok(Buffer.byteLength(JSON.stringify(report)) <= 2048); safe(report);
});
