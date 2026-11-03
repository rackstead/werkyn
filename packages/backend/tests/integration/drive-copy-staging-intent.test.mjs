import assert from "node:assert/strict";
let precisionDefaultsVerified = false;
import crypto from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { finished } from "node:stream/promises";

if (!process.env.TEST_DATABASE_URL) throw new Error("Set a migrated disposable TEST_DATABASE_URL");
const testURL = new URL(process.env.TEST_DATABASE_URL);
const testDatabase = decodeURIComponent(testURL.pathname.slice(1));
assert.equal(testDatabase === "werkyn_ci" || testDatabase.startsWith("werkyn_audit_"), true, "Disposable database name required before app import");
assert.equal(["127.0.0.1", "localhost", "[::1]"].includes(testURL.hostname), true, "Loopback disposable PostgreSQL only");
Object.assign(process.env, {
  DATABASE_URL: process.env.TEST_DATABASE_URL, NODE_ENV: "test", LOG_LEVEL: "error",
  JWT_SECRET: "owned-copy-staging-test-secret", COOKIE_SECRET: "owned-copy-staging-cookie-secret",
});
const bytes = Buffer.from("Ordinary copy staging fixture.\n");
const ids = Object.fromEntries(["actor", "peer", "workspace", "source", "missingSource", "peerFolder"].map(key => [key, crypto.randomUUID()]));
const sourcePath = `${ids.workspace}/files/${ids.actor}/${ids.source}.txt`;
const missingSourcePath = `${ids.workspace}/files/${ids.actor}/${ids.missingSource}.txt`;
const familyIds = new Set(), ownedPaths = new Set([sourcePath, missingSourcePath]), facts = [], tokens = {};
const secrets = new Set([process.env.JWT_SECRET, process.env.COOKIE_SECRET]);
const pending = new Map(), serverRequests = new Map();
let operationSequence = 0, fixtureBlocked = false, persistence = Promise.resolve();
let app, address, directory, recordPath, current, cleanupBlobsNow, processBlobCleanup;
let writesPlanned = false, failureSeen = false;
const originals = {};
const base = `/api/workspaces/${ids.workspace}/files`;
const fault = label => new Error(`Owned copy fixture: ${label}`);

function safeJSON(value) {
  const text = JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item);
  for (const secret of secrets) assert.equal(text.includes(secret), false, "Evidence excludes credentials");
  return text;
}
async function capture(label, actual) {
  facts.push({ label, at: new Date().toISOString(), actual });
  const snapshot = safeJSON({ ids, familyIds: [...familyIds], ownedPaths: [...ownedPaths], writesPlanned, directory, facts }) + "\n";
  persistence = persistence.then(() => recordPath ? writeFile(recordPath, snapshot, { mode: 0o600 }) : undefined);
  await persistence;
}
function owned(label, work, c = current) {
  const entry = { id: ++operationSequence, label, case: c?.label ?? null };
  const actual = Promise.resolve().then(work);
  pending.set(entry, actual);
  actual.then(() => pending.delete(entry), () => pending.delete(entry));
  return actual;
}
async function bounded(actual, milliseconds, label) {
  let timer;
  try { return await Promise.race([actual, new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(fault(`unsettled ${label}`)), milliseconds);
  })]); }
  finally { clearTimeout(timer); }
}
async function requireSettled(label, c = null) {
  // The bounded wrapper is not mistaken for settlement of its losing operation.
  // Those actual promises stay tracked; failure forbids restoration/deletion.
  const actual = [...pending.values()];
  try { await bounded(Promise.allSettled(actual), 2000, label); }
  catch (error) { fixtureBlocked = true; throw error; }
  const remaining = [...pending.keys()];
  const uncompleted = [...serverRequests.values()].filter(row => (!c || row.case === c.label) && !row.completed)
    .map(({ key, case: caseName, started, completed, requestId, method, url }) => ({ key, case: caseName, started, completed, requestId, method, url }));
  await capture(`${label}:actual-settlement-before-assert`, { remaining, uncompleted });
  if (remaining.length || uncompleted.length) fixtureBlocked = true;
  assert.deepEqual(remaining, []); assert.deepEqual(uncompleted, []);
}
async function request(actor, body = { parentId: null }, sourceId = ids.source, health = false) {
  const c = current, key = crypto.randomUUID();
  let resolveTerminal;
  const terminal = new Promise(resolve => { resolveTerminal = resolve; });
  const receipt = { key, case: c?.label ?? null, started: false, completed: false, resolveTerminal };
  serverRequests.set(key, receipt);
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 5000);
  const operation = owned("actual-client-fetch-and-body", async () => {
    const response = await fetch(health ? `${address}/api/live` : `${address}${base}/${sourceId}/copy`, {
      method: health ? "GET" : "POST", signal: controller.signal,
      headers: health ? { "x-owned-copy-probe": key } : { "x-owned-copy-probe": key, authorization: `Bearer ${tokens[actor]}`, "content-type": "application/json" },
      body: health ? undefined : JSON.stringify(body),
    });
    const raw = Buffer.from(await response.arrayBuffer());
    return { status: response.status, headers: response.headers, body: JSON.parse(raw.toString()) };
  }, c);
  try { return await operation; }
  finally {
    clearTimeout(timer); controller.abort();
    try { await bounded(terminal, 2000, "server terminal response"); }
    catch (error) { fixtureBlocked = true; await capture("server-response-not-settled", { key, case: receipt.case, started: receipt.started, completed: receipt.completed }); throw error; }
    await requireSettled("request-return", c);
  }
}
async function queueRow(storagePath) {
  return app.prisma.blobCleanup.findUnique({ where: { storagePath } });
}
async function stageShape(storagePath) {
  const rows = await app.prisma.$queryRaw`
    SELECT "attempts", "lastError", "createdAt", "availableAt",
      ((EXTRACT(EPOCH FROM ("availableAt" - "createdAt"))) * 1000)::double precision AS "graceMs"
    FROM "BlobCleanup" WHERE "storagePath" = ${storagePath}`;
  assert(rows.length <= 1); return rows[0] ?? null;
}
async function rememberPlanned(c, storagePath) {
  const prefix = `${ids.workspace}/files/${ids.actor}/`;
  const relative = typeof storagePath === "string" && storagePath.startsWith(prefix) ? storagePath.slice(prefix.length) : "";
  const owned = /^[0-9a-f-]{36}\.txt$/.test(relative) && ![sourcePath, missingSourcePath].includes(storagePath);
  await capture(`${c.label}:plan-before-assert`, { storagePath, owned });
  assert.equal(owned, true, "Only the freshly planned fixture target may be written or cleaned");
  c.paths.add(storagePath); ownedPaths.add(storagePath); await capture(`${c.label}:planned-before-write`, { paths: [...c.paths] });
}
async function makeDue(storagePath) {
  await app.prisma.$executeRaw`UPDATE "BlobCleanup" SET "availableAt" = CURRENT_TIMESTAMP - interval '1 second' WHERE "storagePath" = ${storagePath}`;
}
async function sweepOne(c, storagePath, failDelete) {
  const prior = await queueRow(storagePath);
  await capture(`${c.label}:worker-prerequisite-before-assert`, { storagePath, row: prior });
  assert.equal(prior?.attempts, 0, "The new stage must exist before this after-only worker boundary");
  c.workerMode = true; c.workerDeleteFailure = failDelete;
  try {
    await makeDue(storagePath);
    const actual = await processBlobCleanup(app.prisma, app.storage, { paths: [storagePath], limit: 1 });
    c.sweep = actual; c.rowAfterSweep = await queueRow(storagePath);
    await capture(`${c.label}:settled-one-path-worker`, { actual, row: c.rowAfterSweep });
  } finally { c.workerMode = false; c.workerDeleteFailure = false; }
}
// Only these fixed synthetic clocks are substituted for exact owned fixture SQL.
// This proves the native precision boundary, not any observed CI fractional timing.
const PRODUCER = "TIMESTAMPTZ '2026-11-03 07:26:39.125600+00'";
const CONSUMER = "TIMESTAMPTZ '2026-11-03 07:26:39.125900+00'";
function isFailureProducer(args) {
  return /^\s*INSERT INTO "BlobCleanup"/.test(sqlText(args)) && /ON CONFLICT \("storagePath"\) DO UPDATE SET "availableAt"/.test(sqlText(args));
}
function withStrings(args, strings) {
  assert.equal(strings.length, args[0].length);
  Object.defineProperty(strings, 'raw', { value: [...strings] });
  return [strings, ...args.slice(1)];
}
function freezeFailureProducer(args, ownedPath, verifiedDefault) {
  assert.equal(verifiedDefault, true, 'Native schema/type/default precondition required');
  assert.ok(isFailureProducer(args)); assert.equal(args.length, 2); assert.equal(args[1], ownedPath);
  assert.ok(Array.isArray(args[0].raw));
  const originalSQL = sqlText(args), strings = [...args[0]];
  const prefix = strings[0].match(/INSERT INTO "BlobCleanup" \(([^)]*)\) VALUES \(\s*$/);
  assert.ok(prefix, 'Exact failure INSERT header required');
  const defaultInjected = prefix[1].trim() === '"storagePath"';
  if (defaultInjected) {
    // The original delegates to DEFAULT CURRENT_TIMESTAMP. Freeze only that
    // verified default evaluation; preserve path binding/conflict expression.
    strings[0] = strings[0].replace('(\"storagePath\")', '(\"storagePath\", \"availableAt\")');
    assert.match(strings[1], /^\s*\)/);
    strings[1] = strings[1].replace(/^(\s*)\)/, `$1, ${PRODUCER})`);
  } else {
    assert.equal(prefix[1].replace(/\s/g, ''), '"storagePath","availableAt"');
  }
  const count = strings.join('?').match(/CURRENT_TIMESTAMP/g)?.length || 0;
  assert.ok(count >= 2 && count <= 3, 'Only expected due-now plus claimed-lease clocks');
  for (let i = 0; i < strings.length; i++) strings[i] = strings[i].replaceAll('CURRENT_TIMESTAMP', PRODUCER);
  const output = withStrings(args, strings);
  return { args: output, originalSQL, transformedSQL: sqlText(output), defaultInjected };
}
function bindingStrings(value, depth = 0) {
  assert.ok(depth <= 8, 'Bounded fixture binding walk');
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) { assert.ok(value.length <= 8); return value.flatMap(v => bindingStrings(v, depth + 1)); }
  if (value && typeof value === 'object' && Array.isArray(value.values)) return bindingStrings(value.values, depth + 1);
  assert.ok(value == null || typeof value === 'number'); return [];
}
function isOwnedWorkerClaim(args, ownedPath) {
  const text = sqlText(args);
  if (!/^\s*UPDATE "BlobCleanup"/.test(text) || !/RETURNING "storagePath", "attempts", "availableAt"/.test(text)) return false;
  const paths = args.slice(1).flatMap(v => bindingStrings(v));
  return paths.length === 1 && paths[0] === ownedPath;
}
function freezeWorkerClaim(args, ownedPath) {
  assert.ok(isOwnedWorkerClaim(args, ownedPath));
  const originalSQL = sqlText(args), strings = [...args[0]];
  assert.equal(strings.join('?').match(/CURRENT_TIMESTAMP/g)?.length, 2);
  for (let i = 0; i < strings.length; i++) strings[i] = strings[i].replaceAll('CURRENT_TIMESTAMP', CONSUMER);
  const output = withStrings(args, strings);
  return { args: output, originalSQL, transformedSQL: sqlText(output) };
}

function sqlText(args) {
  return Array.isArray(args[0]) ? args[0].join("?") : "";
}
async function state(c) {
  const paths = [...c.paths];
  return {
    files: await app.prisma.file.findMany({ where: { workspaceId: ids.workspace }, orderBy: { id: "asc" } }),
    queue: paths.length ? await app.prisma.blobCleanup.findMany({ where: { storagePath: { in: paths } }, orderBy: { storagePath: "asc" } }) : [],
    sourceQueue: await app.prisma.blobCleanup.findMany({ where: { storagePath: { in: [sourcePath, missingSourcePath] } }, orderBy: { storagePath: "asc" } }),
    targetPresent: Object.fromEntries(await Promise.all(paths.map(async storagePath => [storagePath, await app.storage.exists(storagePath)]))),
    sourceBytesEqual: Buffer.from(await originals.read(sourcePath)).equals(bytes),
  };
}

before(async () => {
  try {
    directory = await mkdtemp(path.join(os.tmpdir(), "werkyn-copy-staging-")); process.env.STORAGE_DIR = directory;
    recordPath = process.env.COPY_STAGING_OBSERVATIONS_FILE ?? path.join(os.tmpdir(), `werkyn-copy-staging-record-${crypto.randomUUID()}.json`);
    const { buildApp } = await import("../../src/app.ts");
    const { signAccessToken } = await import("../../src/utils/tokens.ts");
    const { startRefreshSession } = await import("../../src/modules/auth/refresh-sessions.ts");
    ({ cleanupBlobsNow, processBlobCleanup } = await import("../../src/services/blob-cleanup.ts"));
    app = await buildApp();
    // Install before ready/listen. This exact controller returns reply.send only
    // after copyFile settles; errors/denials also finish through Fastify onResponse.
    app.addHook("onRequest", (request, _reply, done) => {
      const row = serverRequests.get(request.headers["x-owned-copy-probe"]);
      if (!row) return done();
      row.started = true; row.requestId = request.id; row.method = request.method; row.url = request.url;
      capture("owned-server-request-start", { key: row.key, case: row.case, requestId: row.requestId, method: row.method, url: row.url }).then(() => done(), done);
    });
    app.addHook("onResponse", (request, reply, done) => {
      const row = serverRequests.get(request.headers["x-owned-copy-probe"]);
      if (!row) return done();
      capture("owned-server-response-terminal", { key: row.key, case: row.case, requestId: request.id, status: reply.statusCode }).then(async () => {
        const c = current;
        if (c?.releaseQueueDelete && !c.workerReleased) {
          c.workerReleased = true;
          await capture(`${c.label}:failure-cleanup-finished-before-worker-row-delete`, {
            queue: await app.prisma.blobCleanup.findMany({ where: { storagePath: { in: [...c.paths] } } }),
          });
          c.releaseQueueDelete();
          c.sweep = await c.workerPromise;
          await capture(`${c.label}:held-worker-actually-settled`, { result: c.sweep });
        }
        row.completed = true; row.resolveTerminal(); done();
      }, done);
    });
    await app.ready();
    const identity = await app.prisma.$queryRawUnsafe(`SELECT current_database()::text AS database, current_user::text AS role, pg_get_userbyid(datdba)::text AS owner FROM pg_database WHERE datname=current_database()`);
    await capture("database-identity-before-assert", identity);
    assert.equal(identity.length, 1); assert.equal(identity[0].database, testDatabase);
    assert.equal(identity[0].role, decodeURIComponent(testURL.username)); assert.equal(identity[0].owner, identity[0].role);
    const precisionSchema = await app.prisma.$queryRaw`SELECT column_name, data_type, datetime_precision, column_default FROM information_schema.columns WHERE table_schema='public' AND table_name='BlobCleanup' AND column_name IN ('availableAt','createdAt') ORDER BY column_name`;
    await capture("precision-schema-default-before-assert", precisionSchema);
    assert.equal(precisionSchema.length, 2);
    for (const row of precisionSchema) {
      assert.equal(row.data_type, "timestamp without time zone"); assert.equal(row.datetime_precision, 3);
      assert.equal(row.column_default, "CURRENT_TIMESTAMP");
    }
    precisionDefaultsVerified = true;
    const collisions = {
      users: await app.prisma.user.count({ where: { id: { in: [ids.actor, ids.peer] } } }),
      workspace: await app.prisma.workspace.count({ where: { id: ids.workspace } }),
      files: await app.prisma.file.count({ where: { id: { in: [ids.source, ids.missingSource, ids.peerFolder] } } }),
    };
    await capture("preallocated-collisions-before-assert", collisions); assert.equal(Object.values(collisions).every(n => n === 0), true);
    writesPlanned = true; await capture("known-identities-and-source-path-before-first-write", { ids, sourcePath });
    const suffix = crypto.randomUUID();
    for (const actor of ["actor", "peer"]) {
      const user = await app.prisma.user.create({ data: { id: ids[actor], email: `copy-${actor}-${suffix}@example.test`, displayName: actor, emailVerified: true } });
      const session = await startRefreshSession(app.prisma, user.id); familyIds.add(session.familyId); secrets.add(session.refreshToken);
      tokens[actor] = signAccessToken({ sub: user.id, email: user.email, sid: session.familyId }); secrets.add(tokens[actor]);
      await capture(`normal-family-${actor}`, { familyId: session.familyId });
    }
    await app.prisma.workspace.create({ data: { id: ids.workspace, name: "Owned copy staging", slug: `copy-stage-${suffix}`,
      members: { create: ["actor", "peer"].map(actor => ({ userId: ids[actor], role: "MEMBER" })) } } });
    const saved = await app.storage.save(`${ids.workspace}/files`, ids.actor, ids.source, ".txt", bytes);
    await capture("source-path-before-assert", { saved, sourcePath }); assert.equal(saved, sourcePath);
    await app.prisma.file.create({ data: { id: ids.source, workspaceId: ids.workspace, ownerId: ids.actor, uploadedById: ids.actor,
      name: "Source notes.txt", mimeType: "text/plain", size: bytes.length, storagePath: sourcePath } });
    await app.prisma.file.create({ data: { id: ids.missingSource, workspaceId: ids.workspace, ownerId: ids.actor, uploadedById: ids.actor,
      name: "Missing notes.txt", mimeType: "text/plain", size: bytes.length, storagePath: missingSourcePath } });
    await app.prisma.file.create({ data: { id: ids.peerFolder, workspaceId: ids.workspace, ownerId: ids.peer, uploadedById: ids.peer,
      name: "Peer private folder", isFolder: true } });
    for (const name of ["saveStream", "openReadStream", "read", "delete", "exists"]) originals[name] = app.storage[name].bind(app.storage);
    // Preserve native controls separately so the witness can measure wrapper receivers.
    originals.executeRawNative = app.prisma.$executeRaw; originals.queryRawNative = app.prisma.$queryRaw;
    originals.executeRaw = app.prisma.$executeRaw; originals.queryRaw = app.prisma.$queryRaw; originals.transaction = app.prisma.$transaction.bind(app.prisma);
    originals.cleanupDeleteMany = app.prisma.blobCleanup.deleteMany.bind(app.prisma.blobCleanup);
    app.prisma.blobCleanup.deleteMany = (...args) => owned("cleanup-row-delete-wrapper", async () => {
      const c = current;
      if (c?.options.holdQueueDelete && !c.workerRowDeleteHeld) {
        c.workerRowDeleteHeld = true;
        await capture(`${c.label}:worker-after-storage-delete-before-row-delete`, { args });
        c.queueDeleteReached();
        await c.queueDeleteGate;
      }
      return originals.cleanupDeleteMany(...args);
    });
    // Interactive clients inherit these wrappers. Native raw methods use this
    // to create their transaction-specific Prisma promise; never bind root.
    app.prisma.$executeRaw = function (...args) {
      const receiver = this;
      return owned("execute-raw-wrapper", async () => {
      const c = current;
      if (c && /^\s*INSERT INTO "BlobCleanup"/.test(sqlText(args)) && !sqlText(args).includes("ON CONFLICT")) {
        c.intentCalls++; await rememberPlanned(c, args[1]);
        await capture(`${c.label}:intent-insert-called`, { calls: c.intentCalls });
        if (c.options.intentFailure) throw fault("intent insert");
      }
      if (c?.options.precisionClock && isFailureProducer(args)) {
        assert.equal(receiver, app.prisma, "Fixed failure clock only wraps root-client SQL");
        assert.equal(c.paths.size, 1); const planned = [...c.paths][0]; assert.equal(args[1], planned);
        c.precisionBeforeRow = await queueRow(planned);
        const changed = freezeFailureProducer(args, planned, precisionDefaultsVerified);
        c.precisionPath = planned; c.precisionDefaultInjected = changed.defaultInjected;
        c.precisionProducerSQL = changed.originalSQL; c.precisionProducerTransformedSQL = changed.transformedSQL;
        await capture(`${c.label}:precision-producer-before-dispatch`, { planned, beforeRow: c.precisionBeforeRow, originalSQL: changed.originalSQL, transformedSQL: changed.transformedSQL, defaultInjected: changed.defaultInjected });
        const result = await originals.executeRaw.apply(receiver, changed.args);
        c.precisionAfterRow = await queueRow(planned); c.precisionEnabled = true;
        await capture(`${c.label}:precision-producer-after`, { row: c.precisionAfterRow }); return result;
      }
      return originals.executeRaw.apply(receiver, args);
    });
    };
    app.prisma.$queryRaw = function (...args) {
      const receiver = this;
      return owned("query-raw-wrapper", async () => {
      const c = current;
      if (c?.precisionEnabled && isOwnedWorkerClaim(args, c.precisionPath)) {
        assert.equal(receiver, app.prisma, "Fixed worker clock only wraps root-client SQL");
        const changed = freezeWorkerClaim(args, c.precisionPath);
        const result = await originals.queryRaw.apply(receiver, changed.args);
        (c.precisionClaims ??= []).push({ originalSQL: changed.originalSQL, transformedSQL: changed.transformedSQL, result });
        await capture(`${c.label}:precision-worker-actual-claim`, c.precisionClaims.at(-1)); return result;
      }
      return originals.queryRaw.apply(receiver, args);
    });
    };
    app.prisma.$transaction = (...args) => owned("real-transaction-wrapper", () => {
      const c = current;
      if (!c || typeof args[0] !== "function") return originals.transaction(...args);
      const work = args[0]; c.transactionCalls++;
      return originals.transaction(async tx => {
        const result = await work(tx);
        c.insideTransaction = { file: await tx.file.findUnique({ where: { id: result.id } }),
          markers: await tx.blobCleanup.findMany({ where: { storagePath: { in: [...c.paths] } } }) };
        await capture(`${c.label}:actual-work-inside-transaction`, c.insideTransaction);
        if (c.options.rollback) throw fault("rollback after real File create");
        return result;
      }, args[1]).then(async result => {
        if (c.options.ambiguous) {
          c.settledCommittedFile = await app.prisma.file.findUnique({ where: { id: result.id } });
          await capture(`${c.label}:actual-commit-settled-before-return-error`, { file: c.settledCommittedFile });
          throw fault("return error after settled commit");
        }
        return result;
      });
    });
    app.storage.openReadStream = (...args) => owned("actual-open-source-stream", async () => {
      const c = current; if (c) c.sourceOpens++;
      const stream = await originals.openReadStream(...args);
      // Keep the real stream's terminal lifetime, including destroy/error, owned.
      owned("actual-source-stream-terminal", () => finished(stream, { cleanup: true }), c).catch(() => {});
      return stream;
    });
    app.storage.saveStream = (...args) => owned("actual-target-save-wrapper", async () => {
      const c = current;
      if (!c) return originals.saveStream(...args);
      c.targetWrites++; const planned = path.join(args[0], args[1], `${args[2]}${args[3]}`);
      await rememberPlanned(c, planned);
      c.beforeTargetWrite = await stageShape(planned);
      c.targetPresentBeforeWrite = await originals.exists(planned);
      await capture(`${c.label}:before-actual-target-write`, { planned, marker: c.beforeTargetWrite, targetPresent: c.targetPresentBeforeWrite });
      assert.equal(c.targetPresentBeforeWrite, false, "The owned target must be absent before its first write");
      if (c.options.sweepBeforeWrite) await sweepOne(c, planned, false);
      if (c.options.holdQueueDelete) {
        c.queueDeleteGate = new Promise(resolve => { c.releaseQueueDelete = resolve; });
        const reached = new Promise(resolve => { c.queueDeleteReached = resolve; });
        await makeDue(planned);
        c.workerPromise = owned("held-one-path-worker", () => processBlobCleanup(app.prisma, app.storage, { paths: [planned], limit: 1 }), c);
        c.workerPromise.catch(() => {});
        await bounded(reached, 2000, "worker reached queue-row deletion");
        c.claimBeforeLateWrite = await queueRow(planned);
        await capture(`${c.label}:claim-before-late-write`, { row: c.claimBeforeLateWrite });
        assert.equal(c.claimBeforeLateWrite.attempts, 1);
      }
      const result = await originals.saveStream(...args);
      c.actualWritesFinished++; c.targetPresentAfterWrite = await originals.exists(planned);
      await capture(`${c.label}:actual-target-write-settled`, { result, targetPresent: c.targetPresentAfterWrite });
      assert.equal(c.targetPresentAfterWrite, true);
      if (c.options.writeFailure) throw fault("after settled tiny target write");
      if (c.options.claimAfterWrite) await sweepOne(c, planned, true);
      if (c.options.sweepAfterWrite) await sweepOne(c, planned, false);
      return c.options.unexpectedReturn ? { ...result, storagePath: sourcePath } : result;
    });
    app.storage.delete = storagePath => owned("actual-storage-delete-wrapper", async () => {
      const c = current;
      if (c) { c.deletePaths.push(storagePath); await capture(`${c.label}:delete-called`, { storagePath, workerMode: c.workerMode }); }
      if (c?.workerDeleteFailure || (c?.options.cleanupDeleteFailure && c.paths.has(storagePath))) throw fault("planned delete");
      return originals.delete(storagePath);
    });
    await capture("installed-hook-identities", { storageHook: typeof app.storage.saveStream === "function", transactionHook: typeof app.prisma.$transaction === "function" });
    address = await app.listen({ host: "127.0.0.1", port: 0 });
  } catch (error) {
    failureSeen = true;
    await capture("fixture-before-failure-preserved", { name: error.name, code: error.code ?? null });
    throw error;
  }
});

async function cleanupCase(c) {
  await requireSettled(`${c.label}:before-fixture-teardown`, c);
  assert.equal(fixtureBlocked, false, "No restoration or deletion after an unsettled operation");
  current = null;
  await app.prisma.file.deleteMany({ where: { workspaceId: ids.workspace, storagePath: { in: [...c.paths] } } });
  // All fixture work/one-path workers settled before this teardown. Only
  // these recorded fixture paths are made due or queued for final cleanup.
  if (c.paths.size) {
    await app.prisma.blobCleanup.createMany({ data: [...c.paths].map(storagePath => ({ storagePath })), skipDuplicates: true });
    for (const storagePath of c.paths) await makeDue(storagePath);
    await cleanupBlobsNow(app.prisma, app.storage, [...c.paths]);
  }
  const rows = await app.prisma.blobCleanup.findMany({ where: { storagePath: { in: [...c.paths] } } });
  const present = Object.fromEntries(await Promise.all([...c.paths].map(async p => [p, await originals.exists(p)])));
  await capture(`${c.label}:fixture-cleanup-before-assert`, { rows, present });
  assert.deepEqual(rows, []); assert.equal(Object.values(present).every(value => value === false), true);
}
async function runCase(t, label, options, verify, actor = "actor", body = { parentId: null }) {
  if (fixtureBlocked) { t.skip("Earlier fixture work did not settle; no further requests or mutation"); return; }
  const c = { label, options, paths: new Set(), intentCalls: 0, targetWrites: 0, actualWritesFinished: 0, sourceOpens: 0,
    transactionCalls: 0, deletePaths: [], workerMode: false, workerDeleteFailure: false };
  current = c;
  let primaryError;
  try {
    const sourceBefore = await app.prisma.file.findUnique({ where: { id: ids.source } });
    c.initialFiles = await app.prisma.file.findMany({ where: { workspaceId: ids.workspace }, orderBy: { id: "asc" } });
    const sourceQueueBefore = await app.prisma.blobCleanup.findMany({ where: { storagePath: { in: [sourcePath, missingSourcePath] } }, orderBy: { storagePath: "asc" } });
    const response = await request(actor, body, options.missingSource ? ids.missingSource : ids.source), actual = await state(c);
    const healthy = await request(null, undefined, undefined, true);
    await capture(`${label}:response-and-pg-before-assert`, { status: response.status, healthyStatus: healthy.status,
      bodyShape: { statusCode: response.body.statusCode ?? null, dataId: response.body.data?.id ?? null,
        unavailableCopyMessage: response.body.message === "The copy could not keep its stored file; nothing was copied. Please try again." },
      intentCalls: c.intentCalls, targetWrites: c.targetWrites, actualWritesFinished: c.actualWritesFinished, sourceOpens: c.sourceOpens,
      transactionCalls: c.transactionCalls, deletePaths: c.deletePaths, actual });
    assert.equal(healthy.status, 200);
    assert.deepEqual(await app.prisma.file.findUnique({ where: { id: ids.source } }), sourceBefore);
    assert.equal(actual.sourceBytesEqual, true);
    assert.equal(c.deletePaths.some(storagePath => [sourcePath, missingSourcePath].includes(storagePath)), false);
    assert.deepEqual(actual.sourceQueue, sourceQueueBefore);
    const initialIds = new Set(c.initialFiles.map(file => file.id));
    assert.deepEqual(actual.files.filter(file => initialIds.has(file.id)), c.initialFiles);
    assert.deepEqual(actual.files.filter(file => !initialIds.has(file.id)), copies(c, actual));
    await verify(c, response, actual); t.diagnostic(safeJSON({ label, status: response.status, controlsPassed: true }));
  } catch (error) {
    primaryError = error; failureSeen = true;
    await capture(`${label}:failure-preserved`, { name: error.name, code: error.code ?? null, phase: c.assertionPhase ?? "ordinary-controls" });
  } finally {
    try { await cleanupCase(c); }
    catch (error) {
      failureSeen = true; primaryError ??= error;
      await capture(`${label}:cleanup-failure-preserved`, { name: error.name, code: error.code ?? null });
    }
  }
  if (primaryError) throw primaryError;
}
function copies(c, actual) { return actual.files.filter(file => c.paths.has(file.storagePath)); }
function unchangedNoTarget(c, actual) {
  assert.equal(c.targetWrites, 0); assert.equal(c.intentCalls, 0); assert.equal(c.transactionCalls, 0);
  assert.deepEqual(actual.queue, []); assert.deepEqual(actual.files, c.initialFiles); assert.deepEqual(copies(c, actual), []);
}
function refused(c, response, actual) {
  assert.equal(response.status, 503); assert.equal(response.body.statusCode, 503);
  assert.equal(response.body.message, "The copy could not keep its stored file; nothing was copied. Please try again.");
  assert.deepEqual(copies(c, actual), []); assert.deepEqual(actual.files, c.initialFiles);
}

test("copy staging baseline: normal tiny copy keeps bytes and records intent before target write", { timeout: 15000 }, async t => {
  await runCase(t, "normal", {}, async (c, response, actual) => {
    assert.equal(response.status, 201); assert.equal(c.targetWrites, 1); assert.equal(c.actualWritesFinished, 1);
    assert.equal(c.transactionCalls, 1); const file = copies(c, actual)[0]; assert.equal(copies(c, actual).length, 1);
    assert.equal(file.id, response.body.data.id); assert.notEqual(file.id, ids.source);
    assert.equal(file.name, "Source notes (copy).txt"); assert.equal(file.mimeType, "text/plain");
    assert.equal(file.ownerId, ids.actor); assert.equal(file.uploadedById, ids.actor); assert.equal(Number(file.size), bytes.length);
    assert.deepEqual(await originals.read(file.storagePath), bytes); assert.deepEqual(actual.queue, []);
    assert.equal(c.insideTransaction.file.id, file.id); assert.deepEqual(c.insideTransaction.markers, []);
    await capture("normal:ordinary-controls-passed-before-final-intent-assert", { passed: true });
    // This is the intended final BEFORE failure. Grace is derived from the
    // captured row's own timestamps, never a drifting wall-clock comparison.
    c.assertionPhase = "normal-final-intent";
    assert.deepEqual(c.beforeTargetWrite && {
      attempts: c.beforeTargetWrite.attempts, lastError: c.beforeTargetWrite.lastError,
      graceMs: c.beforeTargetWrite.graceMs,
    }, { attempts: 0, lastError: null, graceMs: 3600000 });
    assert.equal(c.intentCalls, 1);
  });
});
test("copy staging control: denied source performs no target write or intent", { timeout: 15000 }, async t => {
  await runCase(t, "source-denied", {}, async (c, response, actual) => {
    assert.equal(response.status, 403); unchangedNoTarget(c, actual); assert.equal(c.sourceOpens, 0);
  }, "peer");
});
test("copy staging control: denied destination performs no target write or intent", { timeout: 15000 }, async t => {
  await runCase(t, "destination-denied", {}, async (c, response, actual) => {
    assert.equal(response.status, 403); unchangedNoTarget(c, actual); assert.equal(c.sourceOpens, 0);
  }, "actor", { parentId: ids.peerFolder });
});
test("copy staging: intent insertion failure never opens source or writes target", { timeout: 15000 }, async t => {
  await runCase(t, "intent-failure", { intentFailure: true }, async (c, response, actual) => {
    assert.equal(c.intentCalls, 1); assert.equal(response.status, 500); assert.equal(c.sourceOpens, 0);
    assert.equal(c.targetWrites, 0); assert.equal(c.transactionCalls, 0); assert.deepEqual(actual.queue, []);
    assert.deepEqual(copies(c, actual), []);
  });
});
test("copy staging: missing source content preserves410 and removes only its empty planned stage", { timeout: 15000 }, async t => {
  await runCase(t, "missing-source", { missingSource: true }, async (c, response, actual) => {
    assert.equal(response.status, 410); assert.equal(response.body.statusCode, 410);
    assert.equal(response.body.message, "File content is no longer available");
    assert.equal(c.intentCalls, 1); assert.equal(c.sourceOpens, 1); assert.equal(c.targetWrites, 0);
    assert.equal(c.transactionCalls, 0); assert.deepEqual(copies(c, actual), []); assert.deepEqual(actual.queue, []);
  });
});
test("copy staging: settled storage failure cleans only its planned target", { timeout: 15000 }, async t => {
  await runCase(t, "write-failure", { writeFailure: true }, async (c, response, actual) => {
    assert.equal(response.status, 500); assert.equal(c.intentCalls, 1); assert.equal(c.actualWritesFinished, 1);
    assert.equal(c.transactionCalls, 0); assert.deepEqual(copies(c, actual), []); assert.deepEqual(actual.queue, []);
    assert.equal(Object.values(actual.targetPresent).every(present => !present), true);
  });
});
test("copy staging: transaction rollback restores durable cleanup before failure cleanup", { timeout: 15000 }, async t => {
  await runCase(t, "rollback", { rollback: true }, async (c, response, actual) => {
    assert.equal(response.status, 500); assert.equal(c.transactionCalls, 1); assert(c.insideTransaction.file);
    assert.deepEqual(c.insideTransaction.markers, []); assert.deepEqual(copies(c, actual), []);
    assert.deepEqual(actual.queue, []); assert.equal(Object.values(actual.targetPresent).every(present => !present), true);
  });
});
test("copy staging: error after settled commit preserves its live File and bytes", { timeout: 15000 }, async t => {
  await runCase(t, "ambiguous-commit", { ambiguous: true }, async (c, response, actual) => {
    assert.equal(response.status, 500); assert.equal(c.transactionCalls, 1); assert(c.settledCommittedFile);
    assert.equal(copies(c, actual).length, 1); assert.deepEqual(await originals.read(c.settledCommittedFile.storagePath), bytes);
    assert.equal(actual.queue.length, 1); assert.equal(actual.queue[0].attempts, 1);
    assert.equal(actual.queue[0].lastError, "Still referenced by a live File");
  });
});
test("copy staging: an already claimed failed-delete lease is not reset to permit commit", { timeout: 15000 }, async t => {
  await runCase(t, "claimed-lease", { claimAfterWrite: true }, async (c, response, actual) => {
    refused(c, response, actual); assert.equal(c.sweep.claimed, 1); assert.equal(c.sweep.failed, 1);
    assert.equal(c.rowAfterSweep.attempts, 1); assert.equal(actual.queue.length, 1);
    const { availableAt: previousLease, ...previousClaim } = c.rowAfterSweep;
    const { availableAt: renewedLease, ...renewedClaim } = actual.queue[0];
    assert.deepEqual(renewedClaim, previousClaim); assert(renewedLease > previousLease);
    assert.equal(Object.values(actual.targetPresent).every(Boolean), true);
    for (const storagePath of c.paths) assert.deepEqual(await originals.read(storagePath), bytes);
  });
});
test("copy staging: failure-only requeue cleans a late writer after a pre-open sweep", { timeout: 15000 }, async t => {
  await runCase(t, "late-writer", { sweepBeforeWrite: true }, async (c, response, actual) => {
    refused(c, response, actual); assert.equal(c.sweep.claimed, 1); assert.equal(c.sweep.deleted, 1);
    assert.equal(c.rowAfterSweep, null); assert.equal(c.targetPresentBeforeWrite, false);
    assert.equal(c.actualWritesFinished, 1); assert.equal(c.transactionCalls, 1);
    assert.deepEqual(actual.queue, []); assert.equal(Object.values(actual.targetPresent).every(present => !present), true);
  });
});
test("copy staging: a swept target cannot acquire a recreated staging claim", { timeout: 15000 }, async t => {
  await runCase(t, "swept-target", { sweepAfterWrite: true }, async (c, response, actual) => {
    refused(c, response, actual); assert.equal(c.sweep.claimed, 1); assert.equal(c.sweep.deleted, 1);
    assert.equal(c.rowAfterSweep, null); assert.deepEqual(actual.queue, []);
    assert.equal(Object.values(actual.targetPresent).every(present => !present), true);
  });
});
test("copy staging: unexpected returned path is never adopted, queued or deleted", { timeout: 15000 }, async t => {
  await runCase(t, "unexpected-return", { unexpectedReturn: true }, async (c, response, actual) => {
    refused(c, response, actual); assert.equal(c.transactionCalls, 0); assert.deepEqual(actual.queue, []);
    assert.equal(Object.values(actual.targetPresent).every(present => !present), true);
    assert.equal(await app.prisma.blobCleanup.count({ where: { storagePath: sourcePath } }), 0);
  });
});
test("copy staging: failed cleanup deletion retains retry work and the original failure", { timeout: 15000 }, async t => {
  await runCase(t, "cleanup-delete-failure", { writeFailure: true, cleanupDeleteFailure: true }, async (c, response, actual) => {
    assert.equal(response.status, 500); assert.deepEqual(copies(c, actual), []); assert.equal(actual.queue.length, 1);
    assert.equal(actual.queue[0].attempts, 1); assert.equal(actual.queue[0].lastError, "Owned copy fixture: planned delete");
    assert.equal(Object.values(actual.targetPresent).every(Boolean), true);
  });
});

test("copy staging: late writer keeps cleanup when an earlier worker finishes its row", { timeout: 15000 }, async t => {
  await runCase(t, "held-worker-late-writer", { holdQueueDelete: true }, async (c, response, actual) => {
    refused(c, response, actual);
    assert.equal(c.workerReleased, true); assert.equal(c.sweep.claimed, 1); assert.equal(c.sweep.deleted, 1);
    assert.equal(c.actualWritesFinished, 1); assert.equal(actual.queue.length, 1);
    assert.equal(actual.queue[0].attempts, c.claimBeforeLateWrite.attempts);
    assert.equal(actual.queue[0].lastError, c.claimBeforeLateWrite.lastError);
    assert(actual.queue[0].availableAt > c.claimBeforeLateWrite.availableAt);
    for (const storagePath of c.paths) {
      assert.equal(actual.targetPresent[storagePath], true);
      assert.deepEqual(await originals.read(storagePath), bytes);
    }
  });
});

test("copy transaction receiver: inherited raw methods use the actual interactive client", { timeout: 15000 }, async t => {
  const actual = await app.prisma.$transaction(async tx => {
    const nativeQuery = originals.queryRawNative.bind(tx), nativeExecute = originals.executeRawNative.bind(tx);
    const [expected] = await nativeQuery`SELECT txid_current()::text AS xid, pg_backend_pid()::text AS pid`;
    await nativeExecute`SET LOCAL werkyn_copy_test.receiver = 'native-control'`;
    const [control] = await nativeQuery`SELECT txid_current()::text AS xid, pg_backend_pid()::text AS pid, current_setting('werkyn_copy_test.receiver', true) AS marker`;
    const [observed] = await tx.$queryRaw`SELECT txid_current()::text AS xid, pg_backend_pid()::text AS pid`;
    await tx.$executeRaw`SET LOCAL werkyn_copy_test.receiver = 'wrapped-control'`;
    const [after] = await nativeQuery`SELECT current_setting('werkyn_copy_test.receiver', true) AS marker`;
    return { expected, control, observed, wrappedExecuteStayedLocal: after.marker === 'wrapped-control' };
  });
  await requireSettled("transaction-receiver-witness-settled");
  await capture("transaction-receiver-witness-before-assert", actual);
  assert.equal(actual.control.xid, actual.expected.xid); assert.equal(actual.control.pid, actual.expected.pid);
  assert.equal(actual.control.marker, "native-control");
  // Intended BEFORE failure: both reads must use the same actual transaction,
  // not an outer pooled client's autocommit query. The custom GUC is LOCAL and
  // has no policy, timezone, timestamp or application-data effect.
  assert.deepEqual(actual.observed, actual.expected);
  assert.equal(actual.wrappedExecuteStayedLocal, true);
  t.diagnostic(safeJSON({ receiverWitnessPassed: true }));
});

test("copy precision component: native millisecond boundary and claimed fence controls", { timeout: 15000 }, async t => {
  assert.equal(precisionDefaultsVerified, true);
  for (const zone of ["UTC", "Asia/Kolkata"]) {
    const rows = await app.prisma.$transaction(async tx => {
      if (zone === "UTC") await tx.$executeRaw`SET LOCAL TIME ZONE 'UTC'`;
      else await tx.$executeRaw`SET LOCAL TIME ZONE 'Asia/Kolkata'`;
      return tx.$queryRaw`WITH clocks AS (SELECT TIMESTAMPTZ '2026-11-03 07:26:39.125600+00' AS p, TIMESTAMPTZ '2026-11-03 07:26:39.125900+00' AS c, TIMESTAMPTZ '2026-11-03 07:26:39.126100+00' AS d)
        SELECT (p::timestamp(3) <= c) AS "oldDue", (p::timestamp(3) <= d) AS "laterDue",
        (date_trunc('milliseconds', p::timestamp) <= c) AS "floorDue",
        (TIMESTAMPTZ '2026-11-03 07:26:39.125100+00'::timestamp(3) <= TIMESTAMPTZ '2026-11-03 07:26:39.125400+00') AS "lowerDue",
        (TIMESTAMPTZ '2026-11-03 07:26:39.125000+00'::timestamp(3) <= TIMESTAMPTZ '2026-11-03 07:26:39.125000+00') AS "equalDue",
        to_char(p::timestamp(3), 'SS.US') AS "rounded", to_char(date_trunc('milliseconds',p::timestamp), 'SS.US') AS "floored",
        (GREATEST(TIMESTAMP '2030-01-01 00:00:00.000' + interval '1 millisecond', p::timestamp)::timestamp(3) = TIMESTAMP '2030-01-01 00:00:00.001') AS "claimedAdvanced",
        (TIMESTAMP '2030-01-01 00:00:00.001' <> TIMESTAMP '2030-01-01 00:00:00.000') AS "oldTupleMismatch"
        FROM clocks`;
    });
    await capture("precision-component-before-assert", { zone, rows });
    assert.deepEqual(rows, [{ oldDue: false, laterDue: true, floorDue: true, lowerDue: true, equalDue: true, rounded: "39.126000", floored: "39.125000", claimedAdvanced: true, oldTupleMismatch: true }]);
    t.diagnostic(safeJSON({ zone, precisionComponentPassed: true }));
  }
});
for (const [label, options, expectMissing] of [
  ["fixed-default-insert", { sweepBeforeWrite: true, precisionClock: true }, true],
  ["fixed-unclaimed-renewal", { unexpectedReturn: true, precisionClock: true }, false],
]) {
  test(`copy precision producer: ${label} is due before the next fractional millisecond`, { timeout: 15000 }, async t => {
    await runCase(t, label, options, async (c, response, actual) => {
      refused(c, response, actual); assert.equal(c.actualWritesFinished, 1);
      assert.equal(c.precisionAfterRow.attempts, 0);
      assert.equal(c.precisionBeforeRow === null, expectMissing);
      if (!expectMissing) assert.equal(c.precisionBeforeRow.attempts, 0);
      assert.equal(c.precisionClaims.length, 1);
      // The intended BEFORE failure is a real claim result0 under the fixed,
      // later consumer clock. Full state/SQL/default qualification is captured first.
      assert.equal(c.precisionClaims[0].result.length, 1);
      assert.deepEqual(actual.queue, []); assert.equal(Object.values(actual.targetPresent).every(v => !v), true);
    });
  });
}

after(async () => {
  const failures = [];
  try { await requireSettled("after-all-cases"); }
  catch (error) { failures.push({ phase: "actual-work-collection", name: error.name }); }
  if (fixtureBlocked || failures.length) {
    failureSeen = true;
    await capture("fixture-cleanup-refused-unsettled", { failures, pending: [...pending.keys()], storageRetained: directory });
    assert.fail("Unsettled actual work: hooks, rows and storage retained; outer lifetime must stop for review");
  }
  current = null;
  // Every actual request/wrapper/stream settled before restoring instance hooks.
  for (const name of ["saveStream", "openReadStream", "read", "delete", "exists"]) if (originals[name]) app.storage[name] = originals[name];
  if (originals.executeRaw) app.prisma.$executeRaw = originals.executeRaw;
  if (originals.queryRaw) app.prisma.$queryRaw = originals.queryRaw;
  if (originals.transaction) app.prisma.$transaction = originals.transaction;
  if (originals.cleanupDeleteMany) app.prisma.blobCleanup.deleteMany = originals.cleanupDeleteMany;
  try {
    if (app && writesPlanned) {
      await app.prisma.workspace.deleteMany({ where: { id: ids.workspace } });
      const families = await app.prisma.refreshTokenFamily.findMany({ where: { userId: { in: [ids.actor, ids.peer] } }, select: { id: true } });
      for (const f of families) familyIds.add(f.id);
      await app.prisma.rotatedRefreshToken.deleteMany({ where: { familyId: { in: [...familyIds] } } });
      await app.prisma.user.deleteMany({ where: { id: { in: [ids.actor, ids.peer] } } });
      await app.prisma.blobCleanup.createMany({ data: [...ownedPaths].map(storagePath => ({ storagePath })), skipDuplicates: true });
      for (const storagePath of ownedPaths) await makeDue(storagePath);
      await cleanupBlobsNow(app.prisma, app.storage, [...ownedPaths]);
      const remaining = { users: await app.prisma.user.count({ where: { id: { in: [ids.actor, ids.peer] } } }),
        workspaces: await app.prisma.workspace.count({ where: { id: ids.workspace } }),
        files: await app.prisma.file.count({ where: { workspaceId: ids.workspace } }),
        queuedPaths: await app.prisma.blobCleanup.count({ where: { storagePath: { in: [...ownedPaths] } } }) };
      await capture("final-known-fixture-counts-before-assert", remaining); assert.equal(Object.values(remaining).every(n => n === 0), true);
    }
  } catch (error) { failureSeen = true; failures.push({ phase: "known-fixture-cleanup", name: error.name }); }
  finally {
    try { await app?.close(); } catch (error) { failureSeen = true; failures.push({ phase: "app-close", name: error.name }); }
    try { if (directory) await rm(directory, { recursive: true, force: true }); }
    catch (error) { failureSeen = true; failures.push({ phase: "owned-storage-removal", name: error.name }); }
    await capture("fixture-final", { failures, failureSeen, recordPath });
    if (!failureSeen && !process.env.COPY_STAGING_OBSERVATIONS_FILE && recordPath) await rm(recordPath, { force: true });
  }
  assert.deepEqual(failures, []);
});
