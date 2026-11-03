import { createHmac } from "node:crypto";

/** Synthetic metadata only. This module performs no I/O and establishes no absence. */
export const STORAGE_REFERENCE_LIMITS = Object.freeze({
  inputUtf8Bytes: 1048576, roots: 8, urlBindingsTotal: 16, rowsPerSourceKind: 100,
  candidateTokenUtf8Bytes: 4096, contentJsonUtf8BytesPerRow: 16384, walkDepth: 32,
  containerWidth: 64, visitedJsonNodesAggregate: 8192, referenceObservations: 1024,
  pathIdentities: 256, outputUtf8Bytes: 262144, unicodeScanCodeUnitsAggregate: 4194304,
  candidateInterpretationsPerWholeString: 4, sourceKinds: 6, issueCodes: 32, reportKeyBytes: 32,
});
const kinds = ["files", "attachments", "avatars", "wikiPages", "wikiVersions", "cleanupQueue"] as const;
type Kind = typeof kinds[number];
type Obj = Record<string, unknown>;
type Mode = "stored_path" | "raw_full" | "raw_uri" | "decoded_full" | "decoded_uri";
interface Binding { origin: string | null; routePrefix: string }
interface Root { slot: number; kind: string; bindings: Binding[]; id: string }
interface Observation { interpretationId: string; mode: Mode; sourceKind: Kind; field: string; observedCount: number; flags: string[] }
interface Identity { pathId: string; rootId: string; observations: Observation[]; queueClasses: { class: string; count: number }[] }
interface Coverage { supplied: boolean; providedRows: number | null; processedRows: number; omittedRows: number | null }
export interface SyntheticReferenceReport {
  schemaVersion: 1;
  scope: "DECLARED_SYNTHETIC_ONLY";
  physicalState: "NOT_OBSERVED";
  completeForDestructiveUse: false;
  status: "INCOMPLETE_SYNTHETIC" | "INVALID_INPUT";
  declaredSourceRevision?: string;
  countSemantics: "OBSERVED_LOWER_BOUNDS";
  coverage: Partial<Record<Kind, Coverage>> | "UNKNOWN_NOT_ZERO";
  identities: Identity[];
  issues: { code: string; count: number }[];
  excludedCoverage: readonly string[];
  limits: typeof STORAGE_REFERENCE_LIMITS;
}
const excluded = ["physical-bytes", "legacy-blobs", "unknown-producers", "external-copies",
  "non-selected-fields", "concurrent-lifecycle", "environment-truth"] as const;
function object(value: unknown): value is Obj { return value !== null && typeof value === "object" && !Array.isArray(value); }
function fields(value: Obj, allowed: readonly string[]) { return Object.keys(value).every(k => allowed.includes(k)); }
function nativeTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/.test(value)) return false;
  const [year, month, day, hour, minute, second] = value.match(/\d+/g)!.map(Number);
  if (!year || month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return day > 0 && day <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}
const unsafe = (value: string) => /[\u0000-\u001f\u007f\\]/.test(value) || value.split("/").some(s => s === "." || s === "..");

export function buildSyntheticStorageReferenceReport(inputBytes: Uint8Array, perReportKey: Uint8Array): SyntheticReferenceReport {
  const issues = new Map<string, number>();
  const issue = (code: string) => issues.set(code, (issues.get(code) ?? 0) + 1);
  const coverage: Partial<Record<Kind, Coverage>> = {};
  const identities = new Map<string, Identity>();
  let revision: string | undefined;
  let scanUnits = 0, visited = 0, references = 0, bindingsCount = 0, stringOrdinal = 0;
  let stopped = false;
  const shell = (status: SyntheticReferenceReport["status"]): SyntheticReferenceReport => ({
    schemaVersion: 1, scope: "DECLARED_SYNTHETIC_ONLY", physicalState: "NOT_OBSERVED",
    completeForDestructiveUse: false, status, ...(revision ? { declaredSourceRevision: revision } : {}),
    countSemantics: "OBSERVED_LOWER_BOUNDS", coverage, identities: [], issues: [],
    excludedCoverage: excluded, limits: STORAGE_REFERENCE_LIMITS,
  });
  const invalid = (code: string) => { const report = shell("INVALID_INPUT"); report.coverage = "UNKNOWN_NOT_ZERO"; report.issues = [{ code, count: 1 }]; return report; };
  // JSON escapes may produce invalid UTF16 even after fatal UTF8 decoding.
  // No matching, byte encoding or HMAC receives a string before this check.
  const unicode = (value: string) => {
    if (scanUnits + value.length > STORAGE_REFERENCE_LIMITS.unicodeScanCodeUnitsAggregate) { issue("UNICODE_WORK_LIMIT"); stopped = true; return false; }
    scanUnits += value.length;
    for (let i = 0; i < value.length; i++) {
      const unit = value.charCodeAt(i);
      if (unit >= 0xd800 && unit <= 0xdbff) {
        const next = value.charCodeAt(++i);
        if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
    }
    return true;
  };
  if (!(inputBytes instanceof Uint8Array) || inputBytes.byteLength > STORAGE_REFERENCE_LIMITS.inputUtf8Bytes) return invalid("INPUT_LIMIT");
  if (!(perReportKey instanceof Uint8Array) || perReportKey.byteLength !== 32) return invalid("INVALID_KEY");
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(inputBytes)); }
  catch { return invalid("INVALID_UTF8_OR_JSON"); }
  if (!object(parsed) || Object.keys(parsed).some(k => !unicode(k))) return invalid("MALFORMED_UTF16_DECLARATION");
  if (!fields(parsed, ["schemaVersion", "declaredSourceRevision", "snapshotNativeTimestamp3", "roots", "sources"]) || parsed.schemaVersion !== 1) return invalid("INVALID_SCHEMA");
  if (typeof parsed.declaredSourceRevision !== "string" || !unicode(parsed.declaredSourceRevision) ||
      typeof parsed.snapshotNativeTimestamp3 !== "string" || !unicode(parsed.snapshotNativeTimestamp3)) return invalid("MALFORMED_UTF16_DECLARATION");
  if (!/^[a-f0-9]{40}$/.test(parsed.declaredSourceRevision) || !nativeTimestamp(parsed.snapshotNativeTimestamp3)) return invalid("INVALID_SCHEMA");
  revision = parsed.declaredSourceRevision;
  const snapshot = parsed.snapshotNativeTimestamp3;
  // Every field is independently length-framed; the key is caller-owned and never emitted.
  const digest = (domain: string, ...values: string[]) => {
    const hash = createHmac("sha256", perReportKey);
    for (const value of [domain, ...values]) {
      const bytes = Buffer.from(value, "utf8"), length = Buffer.alloc(4);
      length.writeUInt32BE(bytes.length); hash.update(length); hash.update(bytes);
    }
    return hash.digest("hex");
  };
  if (!Array.isArray(parsed.roots) || parsed.roots.length > STORAGE_REFERENCE_LIMITS.roots) return invalid("INVALID_ROOTS");
  const roots = new Map<number, Root>();
  for (const value of parsed.roots) {
    if (!object(value) || Object.keys(value).some(k => !unicode(k))) return invalid("MALFORMED_UTF16_DECLARATION");
    if (typeof value.kind !== "string" || !unicode(value.kind)) return invalid("MALFORMED_UTF16_DECLARATION");
    if (!fields(value, ["slot", "kind", "bindings"]) || !Number.isInteger(value.slot) || (value.slot as number) < 0 ||
        (value.slot as number) >= 8 || roots.has(value.slot as number) || !["CONFIGURED_STORAGE", "AVATAR_STORAGE", "LEGACY_UPLOAD"].includes(value.kind) || !Array.isArray(value.bindings)) return invalid("INVALID_ROOTS");
    const bindings: Binding[] = [];
    for (const binding of value.bindings) {
      if (++bindingsCount > STORAGE_REFERENCE_LIMITS.urlBindingsTotal) return invalid("INVALID_ROOTS");
      if (!object(binding) || Object.keys(binding).some(k => !unicode(k)) ||
          typeof binding.routePrefix !== "string" || !unicode(binding.routePrefix) ||
          (binding.origin !== null && (typeof binding.origin !== "string" || !unicode(binding.origin)))) return invalid("MALFORMED_UTF16_DECLARATION");
      if (!fields(binding, ["origin", "routePrefix"]) || Buffer.byteLength(binding.routePrefix) > 4096 ||
          !binding.routePrefix.startsWith("/") || !binding.routePrefix.endsWith("/") || /[\s?#\\]/.test(binding.routePrefix)) return invalid("INVALID_ROOTS");
      if (binding.origin !== null) {
        if (Buffer.byteLength(binding.origin as string) > 4096 || !/^https?:\/\/[^/?#]+$/.test(binding.origin as string)) return invalid("INVALID_ROOTS");
        try { const url = new URL(binding.origin as string); if (url.username || url.password || !url.hostname) return invalid("INVALID_ROOTS"); }
        catch { return invalid("INVALID_ROOTS"); }
      }
      bindings.push({ origin: binding.origin as string | null, routePrefix: binding.routePrefix });
    }
    bindings.sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : JSON.stringify(a) > JSON.stringify(b) ? 1 : 0);
    const slot = value.slot as number;
    roots.set(slot, { slot, kind: value.kind, bindings, id: digest("r26/root/v1", String(slot), value.kind, ...bindings.flatMap(b => [b.origin ?? "RELATIVE", b.routePrefix])) });
  }
  if (!object(parsed.sources) || Object.keys(parsed.sources).some(k => !unicode(k))) return invalid("MALFORMED_UTF16_DECLARATION");
  const sources = parsed.sources;
  if (!fields(sources, kinds) || !kinds.every(k => k in sources)) return invalid("INVALID_SCHEMA");
  const identity = (root: Root | undefined, token: string, kind: Kind, row: number, position: number) => {
    const rootId = root?.id ?? digest("r26/unresolved-root/v1", kind, String(row), String(position));
    if (!root) issue("UNRESOLVED_ROOT");
    const pathId = digest("r26/path/v1", rootId, token);
    let entry = identities.get(pathId);
    if (!entry) {
      if (identities.size >= STORAGE_REFERENCE_LIMITS.pathIdentities) { issue("IDENTITY_LIMIT"); stopped = true; return; }
      entry = { pathId, rootId, observations: [], queueClasses: [] }; identities.set(pathId, entry);
    }
    return entry;
  };
  const tokenValid = (value: string) => {
    if (!unicode(value)) { if (!stopped) issue("MALFORMED_UTF16_REFERENCE"); return false; }
    if (Buffer.byteLength(value) > 4096) { issue("TOKEN_LIMIT"); return false; }
    return true;
  };
  const observe = (value: string, root: Root | undefined, kind: Kind, field: string, row: number, position: number, mode: Mode, flags: string[] = [], queueClass?: string) => {
    if (stopped || !tokenValid(value)) return;
    if (!value) { issue("EMPTY_REFERENCE"); return; }
    if (references >= STORAGE_REFERENCE_LIMITS.referenceObservations) { issue("REFERENCE_LIMIT"); stopped = true; return; }
    references++;
    if (mode === "stored_path" && unsafe(value)) { issue("UNSAFE_STORED_PATH"); flags = [...flags, "UNSAFE_STORED_PATH"]; }
    const entry = identity(root, value, kind, row, position); if (!entry) return;
    if (queueClass) {
      const prior = entry.queueClasses.find(v => v.class === queueClass);
      if (prior) prior.count++; else entry.queueClasses.push({ class: queueClass, count: 1 });
      return;
    }
    const interpretationId = digest("r26/interpretation/v1", entry.rootId, mode, value);
    const sortedFlags = [...new Set(flags)].sort();
    const prior = entry.observations.find(o => o.interpretationId === interpretationId && o.sourceKind === kind && o.field === field && JSON.stringify(o.flags) === JSON.stringify(sortedFlags));
    if (prior) prior.observedCount++;
    else entry.observations.push({ interpretationId, mode, sourceKind: kind, field, observedCount: 1, flags: sortedFlags });
  };
  const uri = (value: string, kind: Kind, field: string, row: number) => {
    const position = stringOrdinal++;
    if (stopped || !tokenValid(value)) return;
    if (!value) { issue("EMPTY_REFERENCE"); return; }
    const matches: { root: Root; tail: string }[] = [];
    for (const root of roots.values()) for (const binding of root.bindings) {
      const prefix = (binding.origin ?? "") + binding.routePrefix;
      if (value.startsWith(prefix)) matches.push({ root, tail: value.slice(prefix.length) });
    }
    if (matches.length !== 1 || /[\s<>"']/.test(value)) { issue(matches.length > 1 ? "AMBIGUOUS_BINDING" : "UNPARSED_EMBEDDED_OR_TEXT"); return; }
    const { root, tail } = matches[0];
    const rawUri = tail.split(/[?#]/, 1)[0];
    const candidates: [Mode, string][] = [["raw_full", tail]];
    if (rawUri !== tail) candidates.push(["raw_uri", rawUri]);
    for (const [mode, token] of [["decoded_full", tail], ["decoded_uri", rawUri]] as const) {
      if (mode === "decoded_uri" && rawUri === tail) continue;
      try { const decoded = decodeURIComponent(token); if (decoded !== token && !candidates.some(([m, t]) => m === mode && t === decoded)) candidates.push([mode, decoded]); }
      catch { issue("MALFORMED_PERCENT"); }
    }
    for (const [mode, token] of candidates) {
      if (!tokenValid(token)) continue;
      if (unsafe(token)) { issue("UNSAFE_URI_CANDIDATE"); continue; }
      observe(token, root, kind, field, row, position, mode, candidates.length > 1 ? ["AMBIGUOUS_INTERPRETATION"] : []);
    }
  };
  const walk = (text: string, kind: Kind, row: number) => {
    if (!unicode(text)) { if (!stopped) issue("MALFORMED_UTF16_REFERENCE"); return; }
    if (Buffer.byteLength(text) > STORAGE_REFERENCE_LIMITS.contentJsonUtf8BytesPerRow) { issue("CONTENT_LIMIT"); return; }
    let value: unknown; try { value = JSON.parse(text); } catch { issue("INVALID_CONTENT_JSON"); return; }
    // Iterator frames avoid enqueueing an unchecked level of children.
    const stack: { value: unknown; depth: number; keys?: string[]; index?: number }[] = [{ value, depth: 0 }];
    while (stack.length && !stopped) {
      const frame = stack[stack.length - 1];
      if (!frame.keys) {
        if (++visited > STORAGE_REFERENCE_LIMITS.visitedJsonNodesAggregate) { issue("NODE_LIMIT"); stopped = true; break; }
        if (frame.depth > STORAGE_REFERENCE_LIMITS.walkDepth) { issue("DEPTH_LIMIT"); stack.pop(); continue; }
        if (typeof frame.value === "string") { uri(frame.value, kind, "content", row); stack.pop(); continue; }
        if (!object(frame.value) && !Array.isArray(frame.value)) { stack.pop(); continue; }
        const keys = Object.keys(frame.value);
        if (keys.length > STORAGE_REFERENCE_LIMITS.containerWidth) { issue("WIDTH_LIMIT"); stack.pop(); continue; }
        frame.keys = keys; frame.index = 0;
      }
      if (frame.index! >= frame.keys.length) { stack.pop(); continue; }
      const index = frame.index ?? 0; frame.index = index + 1;
      const key = frame.keys[index];
      if (!unicode(key)) { if (!stopped) issue("MALFORMED_UTF16_REFERENCE"); continue; }
      if (!Array.isArray(frame.value)) uri(key, kind, "contentKey", row);
      stack.push({ value: (frame.value as Obj)[key], depth: frame.depth + 1 });
    }
  };
  const rowFields: Record<Kind, string[]> = {
    files: ["rootSlot", "storagePath", "thumbnailPath", "trashed", "isFolder"],
    attachments: ["rootSlot", "storagePath", "fileId"], avatars: ["avatarUrl"],
    wikiPages: ["contentJson"], wikiVersions: ["contentJson"],
    cleanupQueue: ["rootSlot", "storagePath", "attempts", "availableAt", "createdAt"],
  };
  for (const kind of kinds) {
    const rows = sources[kind];
    if (rows === null) { coverage[kind] = { supplied: false, providedRows: null, processedRows: 0, omittedRows: null }; issue("SOURCE_NOT_SUPPLIED"); continue; }
    if (!Array.isArray(rows)) return invalid("INVALID_SCHEMA");
    const info: Coverage = { supplied: true, providedRows: rows.length, processedRows: 0, omittedRows: rows.length }; coverage[kind] = info;
    if (rows.length > 100) issue("ROW_LIMIT");
    for (let index = 0; index < Math.min(rows.length, 100) && !stopped; index++) {
      const row = rows[index]; info.processedRows++; info.omittedRows = (info.omittedRows ?? 0) - 1;
      if (!object(row)) { issue("INVALID_ROW"); continue; }
      if (Object.keys(row).some(k => !unicode(k))) return invalid("MALFORMED_UTF16_DECLARATION");
      if (!fields(row, rowFields[kind]) || !rowFields[kind].every(k => k in row)) { issue("INVALID_ROW"); continue; }
      if (kind === "wikiPages" || kind === "wikiVersions") { if (typeof row.contentJson === "string") walk(row.contentJson, kind, index); else issue("INVALID_ROW"); continue; }
      if (kind === "avatars") { if (typeof row.avatarUrl === "string") uri(row.avatarUrl, kind, "avatarUrl", index); else if (row.avatarUrl !== null) issue("INVALID_ROW"); continue; }
      if (row.rootSlot !== null && (!Number.isInteger(row.rootSlot) || !roots.has(row.rootSlot as number))) { issue("INVALID_ROW"); continue; }
      const root = roots.get(row.rootSlot as number);
      if (kind === "files" && (typeof row.trashed !== "boolean" || typeof row.isFolder !== "boolean")) { issue("INVALID_ROW"); continue; }
      if (kind === "attachments" && row.fileId !== null && (typeof row.fileId !== "string" || !tokenValid(row.fileId))) { issue("INVALID_ROW"); continue; }
      let queueClass: string | undefined;
      if (kind === "cleanupQueue") {
        const times = [row.availableAt, row.createdAt];
        const validTimes = times.every(t => typeof t === "string" && unicode(t) && nativeTimestamp(t));
        queueClass = !validTimes || !Number.isInteger(row.attempts) || (row.attempts as number) < 0 || (row.attempts as number) > 2147483647 ? "invalid_or_unknown_metadata" :
          (row.availableAt as string) <= snapshot ? "due_at_snapshot" : row.attempts === 0 ? "unattempted_deferred" : "attempted_deferred_ambiguous";
      }
      for (const field of kind === "files" ? ["storagePath", "thumbnailPath"] : ["storagePath"]) {
        const value = row[field];
        if (typeof value !== "string") { if (value !== null || kind === "cleanupQueue") issue("INVALID_ROW"); continue; }
        observe(value, root, kind, field, index, stringOrdinal++, "stored_path", kind === "files" ? [row.trashed ? "TRASHED" : "NOT_TRASHED", row.isFolder ? "FOLDER_ROW" : "FILE_ROW"] : kind === "attachments" ? [row.fileId === null ? "NULL_OR_LEGACY_UNKNOWN" : "LINKED_CACHE_NOT_AUTHORITY"] : [], queueClass);
      }
    }
  }
  const report = shell("INCOMPLETE_SYNTHETIC");
  report.identities = [...identities.values()].sort((a, b) => a.pathId < b.pathId ? -1 : a.pathId > b.pathId ? 1 : 0);
  for (const entry of report.identities) { entry.observations.sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : 1); entry.queueClasses.sort((a, b) => a.class < b.class ? -1 : 1); }
  report.issues = [...issues].sort(([a], [b]) => a < b ? -1 : 1).map(([code, count]) => ({ code, count }));
  if (Buffer.byteLength(JSON.stringify(report)) > STORAGE_REFERENCE_LIMITS.outputUtf8Bytes) {
    const fallback = shell("INCOMPLETE_SYNTHETIC"); fallback.coverage = "UNKNOWN_NOT_ZERO"; fallback.issues = [{ code: "OUTPUT_LIMIT", count: 1 }]; return fallback;
  }
  return report;
}
