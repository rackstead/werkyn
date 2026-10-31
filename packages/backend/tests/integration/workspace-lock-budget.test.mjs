import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { after, before, test } from "node:test";
import AdmZip from "adm-zip";
import { png } from "../fixtures/passive-media.mjs";

if (!process.env.TEST_DATABASE_URL)
  throw new Error("Set TEST_DATABASE_URL to a migrated, disposable PostgreSQL database");
const actorUrl = new URL(process.env.TEST_DATABASE_URL);
actorUrl.searchParams.set("connection_limit", "5");
const controlUrl = new URL(actorUrl);
controlUrl.searchParams.set("connection_limit", "2");
const storageDir = await mkdtemp(path.join(os.tmpdir(), "werkyn-workspace-lock-"));
Object.assign(process.env, {
  DATABASE_URL: actorUrl.toString(), NODE_ENV: "test", LOG_LEVEL: "error",
  JWT_SECRET: "workspace-lock-budget-jwt", COOKIE_SECRET: "workspace-lock-budget-cookie",
  STORAGE_DIR: storageDir,
});
const { PrismaClient } = await import("@prisma/client");
const { buildApp } = await import("../../src/app.ts");
const { signAccessToken } = await import("../../src/utils/tokens.ts");
const { withWorkspaceLock, lockWorkspace, lockWorkspaces } = await import("../../src/utils/workspace-lock.ts");
const { backupConcurrency } = await import("../../src/modules/backup/backup-concurrency.ts");
const users = [], workspaces = [], callbacks = [], events = [];
let app, control, port, requests = 0;

before(async () => {
  control = new PrismaClient({ datasources: { db: { url: controlUrl.toString() } } });
  await control.$connect();
  app = await buildApp();
  // Production helper and error handler over real TCP. Authentication queries
  // do not compete with this controlled pool fill; caller tests use real auth.
  app.post("/lock-probe/:id", async (request) => withWorkspaceLock(app.prisma, request.params.id, async (tx) => {
    callbacks.push(request.params.id);
    return tx.wikiSpace.create({ data: {
      workspaceId: request.params.id, name: "Probe write", slug: crypto.randomUUID(),
    } });
  }));
  app.post("/child-probe/:id/:spaceId", async (request) => withWorkspaceLock(app.prisma, request.params.id, async (tx) => {
    await tx.wikiSpace.create({ data: { workspaceId: request.params.id, name: "Rolled back", slug: crypto.randomUUID() } });
    return tx.wikiSpace.update({ where: { id: request.params.spaceId }, data: { name: "Blocked update" } });
  }));
  await app.listen({ host: "127.0.0.1", port: 0 });
  port = app.server.address().port;
  app.broadcastToWorkspace = (...args) => { events.push(args); };
  app.broadcastToUser = (...args) => { events.push(args); };
});

after(async () => {
  try {
    if (app) {
      await app.prisma.workspace.deleteMany({ where: { id: { in: workspaces } } });
      await app.prisma.user.deleteMany({ where: { id: { in: users } } });
    }
  } finally {
    await Promise.all([app?.close(), control?.$disconnect()]);
    await rm(storageDir, { recursive: true, force: true });
  }
});

async function fixture() {
  const suffix = crypto.randomUUID();
  const admin = await app.prisma.user.create({ data: {
    email: `workspace-lock-${suffix}@example.test`, displayName: "Lock admin", emailVerified: true,
  } });
  users.push(admin.id);
  const workspace = await app.prisma.workspace.create({ data: {
    name: "Lock workspace", slug: `lock-${suffix}`, members: { create: { userId: admin.id, role: "ADMIN" } },
  } });
  workspaces.push(workspace.id);
  return { admin, workspace, token: signAccessToken({ sub: admin.id, email: admin.email }) };
}

function call(method, url, body, token, contentType = "application/json") {
  const n = ++requests;
  const payload = body === undefined ? undefined : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1", port, method, path: url, agent: false,
      localAddress: `127.79.${Math.floor(n / 250) % 250}.${n % 250 + 1}`,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(payload ? { "content-type": contentType, "content-length": payload.length } : {}),
      },
    }, (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { text += chunk; });
      response.on("end", () => resolve({ status: response.statusCode, body: text }));
    });
    req.on("error", reject);
    req.setTimeout(20_000, () => req.destroy(new Error(`${method} ${url} timed out`)));
    req.end(payload);
  });
}

async function waiters(holderPid) {
  return control.$queryRaw`
    SELECT pid, query, pg_blocking_pids(pid) AS blockers FROM pg_stat_activity
    WHERE datname = current_database() AND wait_event_type = 'Lock'
      AND pid <> pg_backend_pid() AND pid <> ${holderPid}::int
  `;
}
async function until(predicate, timeout = 4000) {
  const start = performance.now();
  do {
    if (await predicate()) return true;
    await sleep(20);
  } while (performance.now() - start < timeout);
  return false;
}
async function hold(workspaceId, callback, { remove = false, table = "Workspace", mode = "NO KEY UPDATE" } = {}) {
  assert(["Workspace", "WikiSpace", "User"].includes(table));
  assert(["NO KEY UPDATE", "UPDATE"].includes(mode));
  let ready, release, pid;
  const acquired = new Promise((resolve) => { ready = resolve; });
  const released = new Promise((resolve) => { release = resolve; });
  const holder = control.$transaction(async (tx) => {
    [{ pid }] = await tx.$queryRaw`SELECT pg_backend_pid()::int AS pid`;
    await tx.$queryRawUnsafe(`SELECT id FROM "${table}" WHERE id = $1 FOR ${mode}`, workspaceId);
    if (remove) await tx.workspace.delete({ where: { id: workspaceId } });
    ready();
    await released;
  }, { timeout: 20_000, maxWait: 5000 });
  await acquired;
  try { return await callback(pid, release); }
  finally { release(); await holder; }
}
const busyBody = {
  statusCode: 409, error: "Conflict", message: "The workspace is busy. Please try again.",
};

test("held workspace cancels acquisition on the server and releases the full pool before the holder commits", async () => {
  const hot = await fixture(), other = await fixture();
  const before = callbacks.length;
  await hold(hot.workspace.id, async (pid, release) => {
    const start = performance.now();
    const timed = (pending) => pending.then((response) => ({ ...response, ms: Math.round(performance.now() - start) }));
    const queued = Array.from({ length: 5 }, () => timed(call("POST", `/lock-probe/${hot.workspace.id}`)));
    assert(await until(async () => (await waiters(pid)).length === 5), "pool never filled with lock waiters");
    // Bound the reproduction even when Prisma does not cancel a blocked
    // statement at its own 10 s interactive-transaction deadline.
    const deadline = setTimeout(release, 12_000);
    const unrelated = timed(call("POST", `/lock-probe/${other.workspace.id}`));
    const read = timed(call("GET", `/api/workspaces/${other.workspace.id}`, undefined, other.token));
    const write = timed(call("POST", `/api/workspaces/${other.workspace.id}/wiki/spaces`, { name: "Unrelated real caller" }, other.token));
    const observation = sleep(11_000).then(async () => ({ ms: Math.round(performance.now() - start), waiters: (await waiters(pid)).length }));
    const answers = await Promise.all(queued);
    const otherAnswer = await unrelated;
    const [readAnswer, writeAnswer] = await Promise.all([read, write]);
    const blocked = (await waiters(pid)).length;
    console.info("workspace lock budget", JSON.stringify({
      queued: answers.map(({ status, ms }) => ({ status, ms })), other: { status: otherAnswer.status, ms: otherAnswer.ms },
      otherRead: { status: readAnswer.status, ms: readAnswer.ms }, otherWrite: { status: writeAnswer.status, ms: writeAnswer.ms },
      remainingWaiters: blocked, observation: await observation,
    }));
    clearTimeout(deadline);
    for (const answer of answers) {
      assert.equal(answer.status, 409, answer.body);
      assert.deepEqual(JSON.parse(answer.body), busyBody);
      assert(answer.ms >= 4000 && answer.ms < 9000, `acquisition took ${answer.ms} ms`);
    }
    assert.equal(blocked, 0, "server still waits after returning busy");
    assert.equal(otherAnswer.status, 200, otherAnswer.body);
    assert(otherAnswer.ms < 9000, `unrelated workspace waited ${otherAnswer.ms} ms`);
    assert.equal(readAnswer.status, 200, readAnswer.body);
    assert.equal(writeAnswer.status, 201, writeAnswer.body);
    assert(Math.max(readAnswer.ms, writeAnswer.ms) < 9000, "unrelated authenticated callers waited for the holder");
    assert.deepEqual(callbacks.slice(before), [other.workspace.id], "a refused callback ran");
    release();
  });
  assert.equal(await app.prisma.wikiSpace.count({ where: { workspaceId: hot.workspace.id } }), 0, "late write after release");
});

test("a later child-row lock wait is bounded and rolls back earlier writes", async () => {
  const f = await fixture();
  const child = await app.prisma.wikiSpace.create({ data: { workspaceId: f.workspace.id, name: "Original", slug: crypto.randomUUID() } });
  await hold(child.id, async (pid, release) => {
    const deadline = setTimeout(release, 12_000);
    const start = performance.now();
    try {
      const pending = call("POST", `/child-probe/${f.workspace.id}/${child.id}`);
      assert(await until(async () => (await waiters(pid)).length === 1));
      const response = await pending;
      const ms = Math.round(performance.now() - start);
      console.info("workspace child lock budget", JSON.stringify({ status: response.status, ms, waiters: (await waiters(pid)).length }));
      assert.equal(response.status, 409, response.body);
      assert.deepEqual(JSON.parse(response.body), busyBody);
      assert(ms >= 4000 && ms < 9000, `child wait took ${ms} ms`);
      assert.equal((await waiters(pid)).length, 0);
    } finally { clearTimeout(deadline); }
  }, { table: "WikiSpace" });
  assert.equal(await app.prisma.wikiSpace.count({ where: { workspaceId: f.workspace.id } }), 1);
  assert.equal((await app.prisma.wikiSpace.findUnique({ where: { id: child.id } })).name, "Original");
});

test("release before the bound runs the callback once and NKU preserves foreign-key inserts", async () => {
  const f = await fixture(), before = callbacks.length;
  await hold(f.workspace.id, async (pid, release) => {
    const pending = call("POST", `/lock-probe/${f.workspace.id}`);
    assert(await until(async () => (await waiters(pid)).length === 1));
    // A Workspace foreign-key check takes KEY SHARE, compatible with NKU.
    await app.prisma.project.create({ data: { workspaceId: f.workspace.id, name: "FK insert" } });
    release();
    assert.equal((await pending).status, 200);
  });
  assert.deepEqual(callbacks.slice(before), [f.workspace.id]);
  assert.equal(await app.prisma.wikiSpace.count({ where: { workspaceId: f.workspace.id } }), 1);
});

test("missing and deleted-during-wait workspaces retain false, 404 and onMissing", async () => {
  const missing = crypto.randomUUID();
  assert.equal(await app.prisma.$transaction((tx) => lockWorkspace(tx, missing)), false);
  assert.equal(await withWorkspaceLock(app.prisma, missing, async () => assert.fail("missing callback"), { onMissing: () => "missing" }), "missing");
  assert.equal((await call("POST", `/lock-probe/${missing}`)).status, 404);
  const f = await fixture(), before = callbacks.length;
  await hold(f.workspace.id, async (pid, release) => {
    const pending = call("POST", `/lock-probe/${f.workspace.id}`);
    assert(await until(async () => (await waiters(pid)).length === 1));
    release();
    assert.equal((await pending).status, 404);
  }, { remove: true });
  assert.equal(callbacks.length, before);
});

test("oppositely ordered multi-workspace callers use ascending locks without a deadlock", async () => {
  const a = await fixture(), b = await fixture();
  const ids = [a.workspace.id, b.workspace.id].sort();
  await hold(ids[0], async (pid, release) => {
    const first = app.prisma.$transaction((tx) => lockWorkspaces(tx, [ids[1], ids[0], ids[1], "missing"]));
    const second = app.prisma.$transaction((tx) => lockWorkspaces(tx, [ids[0], ids[1]]));
    assert(await until(async () => (await waiters(pid)).length === 2));
    const blockedQueries = await waiters(pid);
    assert(blockedQueries.every(({ query }) => query.includes('FROM "Workspace"')));
    release();
    assert.deepEqual([...(await first)], ids);
    assert.deepEqual([...(await second)], ids);
  });
});

test("stricter transaction-local statement and lock settings remain stricter", async () => {
  const f = await fixture();
  await hold(f.workspace.id, async () => {
    for (const [statement, lock] of [[175, 0], [0, 125]]) {
      const start = performance.now();
      await assert.rejects(app.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('statement_timeout', ${`${statement}ms`}, true), set_config('lock_timeout', ${`${lock}ms`}, true)`;
        await lockWorkspace(tx, f.workspace.id);
      }), (error) => error.statusCode === 409);
      assert(performance.now() - start < 1500, "stricter setting was widened");
    }
  });
  await app.prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('statement_timeout', '200ms', true), set_config('lock_timeout', '125ms', true)`;
    await lockWorkspace(tx, f.workspace.id);
    const [settings] = await tx.$queryRaw`SELECT current_setting('statement_timeout') AS statement, current_setting('lock_timeout') AS lock`;
    assert.deepEqual(settings, { statement: "200ms", lock: "125ms" });
    await assert.rejects(tx.$queryRaw`SELECT pg_sleep(0.5)`, (error) => error.code === "P2010" && error.meta.code === "57014" && error.statusCode === undefined);
    // A canceled PostgreSQL statement aborts the caller's transaction.
    throw new Error("expected rollback");
  }).catch((error) => { assert.equal(error.message, "expected rollback"); });
});

test("a busy later workspace in an ordered acquisition releases every earlier lock", async () => {
  const a = await fixture(), b = await fixture();
  const ids = [a.workspace.id, b.workspace.id].sort();
  await hold(ids[1], async (pid) => {
    const start = performance.now();
    const pending = app.prisma.$transaction((tx) => lockWorkspaces(tx, [ids[1], ids[0]]), { timeout: 10_000 });
    const rejected = assert.rejects(pending, (error) => error.statusCode === 409 && error.message === busyBody.message);
    assert(await until(async () => (await waiters(pid)).length === 1));
    await rejected;
    assert(performance.now() - start < 9000);
    assert.equal((await waiters(pid)).length, 0);
    assert.equal(await app.prisma.$transaction((tx) => lockWorkspace(tx, ids[0])), true, "earlier workspace lock leaked");
  });
});


function upload(url, f, bytes, filename = "file.txt") {
  const boundary = `workspace-lock-${crypto.randomUUID()}`;
  const payload = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`),
    bytes,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return call("POST", url, payload, f.token, `multipart/form-data; boundary=${boundary}`);
}
function backupJson(name, asset = false) {
  return Buffer.from(JSON.stringify({
    metadata: { version: "1.1", exportedAt: new Date().toISOString(), sourceWorkspace: { name: "Fixture", slug: "fixture" }, userRefs: [] },
    projects: [], channels: [], wikiSpaces: [{ space: { name }, pages: [{
      _originalId: "page", title: name, position: 0,
      content: asset ? [{ type: "image", props: { url: "assets/image.png" } }] : [],
    }] }],
  }));
}
function backupZip(name) {
  const zip = new AdmZip();
  zip.addFile("backup.json", backupJson(name, true));
  zip.addFile("assets/image.png", png);
  return zip.toBuffer();
}
async function storedFiles(dir = storageDir) {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true }).catch((error) => { if (error.code === "ENOENT") return []; throw error; })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await storedFiles(full));
    else files.push(path.relative(storageDir, full));
  }
  return files.sort();
}

test("file, wiki, membership and admission callers refuse without staged bytes or side effects", async () => {
  const f = await fixture(), applicant = await fixture();
  const member = await app.prisma.workspaceMember.create({ data: { workspaceId: f.workspace.id, userId: applicant.admin.id, role: "MEMBER" } });
  const joiner = await fixture();
  const invite = await app.prisma.workspaceInvite.create({ data: { workspaceId: f.workspace.id, token: crypto.randomUUID(), role: "MEMBER", maxUses: 1 } });
  const beforeFiles = await storedFiles(), beforeEvents = events.length;
  const notificationCount = await app.prisma.notification.count();
  const outboxCount = await app.prisma.notificationDelivery.count();
  await hold(f.workspace.id, async (pid) => {
    const start = performance.now();
    const pending = [
      call("POST", `/api/workspaces/${f.workspace.id}/wiki/spaces`, { name: "Refused wiki" }, f.token),
      upload(`/api/workspaces/${f.workspace.id}/files/upload`, f, Buffer.from("refused bytes")),
      call("PATCH", `/api/workspaces/${f.workspace.id}/members/${applicant.admin.id}`, { role: "VIEWER" }, f.token),
      call("POST", `/api/invites/${invite.token}/accept`, {}, joiner.token),
    ];
    assert(await until(async () => (await waiters(pid)).length === 4));
    for (const response of await Promise.all(pending)) {
      assert.equal(response.status, 409, response.body);
      assert.deepEqual(JSON.parse(response.body), busyBody);
    }
    assert(performance.now() - start < 9000);
    assert.equal((await waiters(pid)).length, 0);
    assert.deepEqual(await storedFiles(), beforeFiles, "refused upload left bytes");
  });
  assert.equal(await app.prisma.file.count({ where: { workspaceId: f.workspace.id } }), 0);
  assert.equal(await app.prisma.wikiSpace.count({ where: { workspaceId: f.workspace.id } }), 0);
  assert.equal((await app.prisma.workspaceMember.findUnique({ where: { id: member.id } })).role, "MEMBER");
  assert.equal(await app.prisma.workspaceMember.count({ where: { workspaceId: f.workspace.id, userId: joiner.admin.id } }), 0);
  assert.equal((await app.prisma.workspaceInvite.findUnique({ where: { id: invite.id } })).useCount, 0);
  assert.equal(await app.prisma.notification.count(), notificationCount);
  assert.equal(await app.prisma.notificationDelivery.count(), outboxCount);
  assert.equal(events.length, beforeEvents);
});

test("busy restore cleans staged assets and upload, and releases backup admission before the workspace holder", async () => {
  const f = await fixture(), name = `Refused restore ${crypto.randomUUID()}`;
  const beforeFiles = await storedFiles();
  await hold(f.workspace.id, async (pid) => {
    const pending = upload(`/api/workspaces/${f.workspace.id}/backup/restore`, f, backupZip(name), "backup.zip");
    assert(await until(async () => (await waiters(pid)).length === 1));
    assert.equal((await upload(`/api/workspaces/${f.workspace.id}/backup/preview`, f, backupJson(name), "backup.json")).status, 429);
    const response = await pending;
    assert.equal(response.status, 409, response.body);
    assert.deepEqual(JSON.parse(response.body), busyBody);
    assert.equal((await waiters(pid)).length, 0);
    assert.deepEqual(backupConcurrency.usage, { admitted: 0, workspaces: 0, exclusiveRunning: 0 });
    assert.deepEqual(await storedFiles(), beforeFiles, "refused restore left staged data");
    assert.equal((await upload(`/api/workspaces/${f.workspace.id}/backup/preview`, f, backupJson(name), "backup.json")).status, 200);
  });
  assert.equal(await app.prisma.wikiSpace.count({ where: { workspaceId: f.workspace.id } }), 0);
  assert.equal(await app.prisma.blobCleanup.count({ where: { storagePath: { startsWith: `${f.workspace.id}/` } } }), 0);
});

test("direct restore bounds a later foreign-key lock wait and rolls back the whole body", async () => {
  const f = await fixture();
  await hold(f.admin.id, async (pid) => {
    const start = performance.now();
    const pending = upload(`/api/workspaces/${f.workspace.id}/backup/restore`, f, backupJson("Blocked FK restore"), "backup.json");
    assert(await until(async () => (await waiters(pid)).length === 1));
    const response = await pending;
    const ms = Math.round(performance.now() - start);
    console.info("restore later FK lock budget", JSON.stringify({ status: response.status, ms }));
    assert.equal(response.status, 409, response.body);
    assert.deepEqual(JSON.parse(response.body), busyBody);
    assert(ms >= 4000 && ms < 9000);
    assert.equal((await waiters(pid)).length, 0);
  }, { table: "User", mode: "UPDATE" });
  assert.equal(await app.prisma.wikiSpace.count({ where: { workspaceId: f.workspace.id } }), 0);
  assert.equal(await app.prisma.wikiPage.count({ where: { space: { workspaceId: f.workspace.id } } }), 0);
  assert.deepEqual(backupConcurrency.usage, { admitted: 0, workspaces: 0, exclusiveRunning: 0 });
});

test("restore keeps its legitimate long statement body after acquisition", async () => {
  const f = await fixture(), suffix = crypto.randomBytes(5).toString("hex");
  const fn = `workspace_lock_sleep_${suffix}`;
  // A real statement doing work for longer than the acquisition bound must
  // still complete inside restore's existing 60 s transaction budget.
  await control.$executeRawUnsafe(`CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(5.2); RETURN NEW; END $$`);
  try {
    await control.$executeRawUnsafe(`CREATE TRIGGER ${fn} BEFORE INSERT ON "WikiSpace" FOR EACH ROW WHEN (NEW."workspaceId" = '${f.workspace.id}') EXECUTE FUNCTION ${fn}()`);
    const start = performance.now();
    const response = await upload(`/api/workspaces/${f.workspace.id}/backup/restore`, f, backupJson("Long body restore"), "backup.json");
    const ms = Math.round(performance.now() - start);
    console.info("long restore body", JSON.stringify({ status: response.status, ms }));
    assert.equal(response.status, 200, response.body);
    assert(ms >= 5200 && ms < 15_000);
    assert.equal(await app.prisma.wikiSpace.count({ where: { workspaceId: f.workspace.id } }), 1);
    assert.equal(await app.prisma.wikiPage.count({ where: { space: { workspaceId: f.workspace.id } } }), 1);
  } finally {
    await control.$executeRawUnsafe(`DROP FUNCTION ${fn}() CASCADE`);
  }
});

test("a manual cancellation after acquisition keeps its original error", async () => {
  const f = await fixture();
  let ready, pid;
  const started = new Promise((resolve) => { ready = resolve; });
  const pending = withWorkspaceLock(app.prisma, f.workspace.id, async (tx) => {
    [{ pid }] = await tx.$queryRaw`SELECT pg_backend_pid()::int AS pid`;
    ready();
    await tx.$queryRaw`SELECT pg_sleep(10)`;
  });
  // Attach the rejection handler immediately so a fast cancel cannot create
  // an unhandled rejection while the separate observer confirms it.
  const rejected = assert.rejects(pending, (error) => error.code === "P2010" && error.meta.code === "57014" && error.statusCode === undefined);
  await started;
  assert(await until(async () => (await control.$queryRaw`SELECT query FROM pg_stat_activity WHERE pid = ${pid}::int AND state = 'active'`)[0]?.query.includes("pg_sleep")));
  await control.$queryRaw`SELECT pg_cancel_backend(${pid}::int)`;
  await rejected;
});

test("pooled connections retain no local timeout settings after success or refusal", async () => {
  let ready, release, arrived = 0;
  const allReady = new Promise((resolve) => { ready = resolve; });
  const finish = new Promise((resolve) => { release = resolve; });
  const settings = Array.from({ length: 5 }, () => app.prisma.$transaction(async (tx) => {
    const [row] = await tx.$queryRaw`SELECT pg_backend_pid()::int AS pid, current_setting('statement_timeout') AS statement, current_setting('lock_timeout') AS lock`;
    if (++arrived === 5) ready();
    await finish;
    return row;
  }));
  await allReady;
  release();
  const rows = await Promise.all(settings);
  assert.equal(new Set(rows.map(({ pid }) => pid)).size, 5);
  assert(rows.every(({ statement, lock }) => statement === "0" && lock === "0"), JSON.stringify(rows));
});
