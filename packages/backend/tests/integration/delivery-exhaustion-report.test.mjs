import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

if (!process.env.TEST_DATABASE_URL) throw new Error("Set TEST_DATABASE_URL to a migrated disposable PostgreSQL database");
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.NODE_ENV = "test";
process.env.JWT_SECRET ||= "delivery-report-owned-test-jwt";
process.env.COOKIE_SECRET ||= "delivery-report-owned-test-cookie";
const { PrismaClient } = await import("@prisma/client");
const { findExhaustedDeliveries: report, parseDeliveryReportArgs: parse, DELIVERY_ATTEMPT_CAPS, MAX_REPORT_BYTES } =
  await import("../../src/scripts/delivery-exhaustion-report.js");
const { MAX_DELIVERY_ATTEMPTS } = await import("../../src/modules/chat/chat-delivery.js");
const { MAX_NOTIFICATION_ATTEMPTS } = await import("../../src/modules/notifications/notification-delivery.js");
const db = new PrismaClient();
const prefix = `~r30-${randomUUID()}-`;
const exec = promisify(execFile);
let user, workspace, channel;
const ids = { chat: [], notification: [] };
before(async () => {
  assert.deepEqual(DELIVERY_ATTEMPT_CAPS, { chat: MAX_DELIVERY_ATTEMPTS, notification: MAX_NOTIFICATION_ATTEMPTS });
  assert.equal(MAX_DELIVERY_ATTEMPTS, 20); assert.equal(MAX_NOTIFICATION_ATTEMPTS, 20);
  user = await db.user.create({ data: { email: `${randomUUID()}@report.example.test`, displayName: "Owned report fixture" } });
  workspace = await db.workspace.create({ data: { name: "Owned report fixture", slug: `r30-${randomUUID()}` } });
  channel = await db.chatChannel.create({ data: { workspaceId: workspace.id, createdById: user.id } });
});
after(async () => {
  try {
    await db.notificationDelivery.deleteMany({ where: { id: { in: ids.notification } } });
    if (workspace) await db.workspace.delete({ where: { id: workspace.id } });
    if (user) await db.user.delete({ where: { id: user.id } });
  } finally { await db.$disconnect(); }
});
async function create(kind, suffix, data = {}) {
  const id = prefix + suffix;
  if (kind === "chat") {
    await db.chatMessage.create({ data: { id, channelId: channel.id, userId: user.id, content: "Must never appear in report" } });
    await db.chatMessageDelivery.create({ data: { messageId: id, attempts: 20, ...data } });
  } else await db.notificationDelivery.create({ data: { id, type: "TASK_ASSIGNED", title: "Must never appear in report", body: "Private body", recipientIds: [user.id], attempts: 20, ...data } });
  ids[kind].push(id);
  return id;
}
const delegate = (kind) => kind === "chat" ? db.chatMessageDelivery : db.notificationDelivery;
const scope = (kind, selected) => kind === "chat" ? { messageId: { in: selected } } : { id: { in: selected } };
const rows = (kind, selected) => delegate(kind).findMany({ where: scope(kind, selected), orderBy: kind === "chat" ? { messageId: "asc" } : { id: "asc" } });

for (const kind of ["chat", "notification"]) {
  test(`${kind}: capped states, live lease priority and omitted normal rows are read-only`, async () => {
    const now = Date.now(), past = new Date(now - 60_000), future = new Date(now + 120_000);
    const selected = [];
    const states = [
      ["a", { nextAttemptAt: null, lockedUntil: future }, "cap_reached_lease_active"],
      ["b", { nextAttemptAt: null, lockedUntil: null }, "cap_reached_unscheduled"],
      ["c", { nextAttemptAt: past, lockedUntil: past }, "cap_reached_lease_expired"],
      ["d", { nextAttemptAt: future, lockedUntil: null }, "cap_reached_scheduled_unleased"],
    ];
    for (const [suffix, data] of states) selected.push(await create(kind, suffix, { ...data, lastError: "Private error and credential marker", notificationIds: ["Private notification ID"], notifiedAt: past }));
    const ordinary = [];
    for (const [suffix, data] of [["due", { nextAttemptAt: past }], ["backoff", { nextAttemptAt: future }], ["leased", { nextAttemptAt: past, lockedUntil: future }]])
      ordinary.push(await create(kind, suffix, { attempts: 19, ...data }));
    const beforeRows = await rows(kind, [...selected, ...ordinary]);
    const got = await report(db, { kind, after: prefix, limit: 100 });
    const owned = got.rows.filter((row) => selected.includes(row.id));
    assert.deepEqual(owned.map((row) => row.status), states.map((row) => row[2]));
    assert.equal(got.rows.some((row) => ordinary.includes(row.id)), false);
    assert.equal(got.attemptCap, 20); assert.equal(got.readOnly, true);
    assert.equal(got.kind, kind); assert.equal(got.completeAfterCursor, !got.hasMore);
    for (const row of owned) assert.deepEqual(Object.keys(row), ["id", "attempts", "status", "nextAttemptAt", "lockedUntil", "notifiedAt", "createdAt"]);
    const text = JSON.stringify(got);
    for (const secret of ["Private error", "credential marker", "Private notification ID", "Must never appear", "Private body", user.id]) assert.equal(text.includes(secret), false);
    assert(Buffer.byteLength(text) <= MAX_REPORT_BYTES);
    assert.deepEqual(await rows(kind, [...selected, ...ordinary]), beforeRows);
    // Remove only this case's owned rows so later cases have independent inputs.
    await delegate(kind).deleteMany({ where: scope(kind, [...selected, ...ordinary]) });
  });

  test(`${kind}: C-collation keyset pagination is complete for unchanged rows`, async () => {
    const selected = [];
    for (const suffix of ["P-a", "P-Z", "P-é", "P-A", "P-🙂"]) selected.push(await create(kind, suffix));
    const expected = [...selected].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
    const collected = []; let after = prefix;
    for (let page = 0; page < 6; page++) {
      const got = await report(db, { kind, after, limit: 1 });
      const row = got.rows[0];
      if (!row || !selected.includes(row.id)) break;
      collected.push(row.id);
      if (!got.hasMore) { assert.equal(got.nextAfter, null); break; }
      assert.equal(got.nextAfter, row.id); after = got.nextAfter;
    }
    assert.deepEqual(collected, expected);
    assert.equal(new Set(collected).size, selected.length);
    const last = await report(db, { kind, after: expected.at(-1), limit: 1 });
    assert.equal(last.rows.some((row) => selected.includes(row.id)), false);
    await delegate(kind).deleteMany({ where: scope(kind, selected) });
  });

  test(`${kind}: oversized selected and lookahead IDs refuse whole page without leakage`, async () => {
    const small = await create(kind, "Q-a"), large = await create(kind, "Q-z" + "x".repeat(1024));
    const beforeRows = await rows(kind, [small, large]);
    for (const options of [{ kind, after: prefix + "Q-", limit: 1 }, { kind, after: small, limit: 1 }]) {
      await assert.rejects(report(db, options), (error) => error.code === "oversized_id" && !error.message.includes(large));
    }
    assert.deepEqual(await rows(kind, [small, large]), beforeRows);
    await delegate(kind).deleteMany({ where: scope(kind, [small, large]) });
  });

  test(`${kind}: PostgreSQL rejects an actual write in the report transaction`, async () => {
    const id = await create(kind, "R-read-only");
    let refused = false;
    const wrapped = { $transaction: (work, options) => db.$transaction(async (tx) => {
      const result = await work(tx);
      const [setting] = await tx.$queryRaw`SELECT current_setting('transaction_read_only') AS mode`;
      assert.equal(setting.mode, "on");
      try {
        if (kind === "chat") await tx.$executeRaw`UPDATE "ChatMessageDelivery" SET attempts = attempts + 1 WHERE "messageId" = ${id}`;
        else await tx.$executeRaw`UPDATE "NotificationDelivery" SET attempts = attempts + 1 WHERE id = ${id}`;
      } catch (error) { refused = error.meta?.code === "25006"; throw error; }
      return result;
    }, options) };
    await assert.rejects(report(wrapped, { kind, after: prefix, limit: 1 }), (error) => error.code === "query_failed");
    assert.equal(refused, true); assert.equal((await rows(kind, [id]))[0].attempts, 20);
    await delegate(kind).deleteMany({ where: scope(kind, [id]) });
  });

  test(`${kind}: maximum page remains bounded with escaped legacy IDs`, async () => {
    const selected = [];
    for (let i = 0; i < 100; i++) selected.push(await create(kind, `S-${String(i).padStart(3, "0")}-` + "\u0001".repeat(180)));
    const got = await report(db, { kind, after: prefix + "S-", limit: 100 });
    assert.equal(got.rows.length, 100);
    assert.deepEqual(got.rows.map((row) => row.id), selected);
    assert(Buffer.byteLength(JSON.stringify(got), "utf8") <= MAX_REPORT_BYTES);
    assert.equal(got.hasMore, false); assert.equal(got.nextAfter, null);
    await delegate(kind).deleteMany({ where: scope(kind, selected) });
  });

  test(`${kind}: actual standalone CLI emits one JSON page and fixed exit codes`, async () => {
    const id = await create(kind, "T-cli");
    const script = fileURLToPath(new URL("../../src/scripts/delivery-exhaustion-report.ts", import.meta.url));
    const cwd = fileURLToPath(new URL("../..", import.meta.url));
    const invoke = async (args) => {
      try { return { ...(await exec(process.execPath, ["--import", "tsx", script, ...args], { cwd, env: process.env, timeout: 10_000, maxBuffer: 512 * 1024 })), code: 0 }; }
      catch (error) { return { stdout: error.stdout, stderr: error.stderr, code: error.code }; }
    };
    const found = await invoke([`--kind=${kind}`, `--after=${prefix}T-`, "--limit=1"]);
    assert.equal(found.code, 2); assert.equal(found.stderr, "");
    const page = JSON.parse(found.stdout); assert.deepEqual(page.rows.map((row) => row.id), [id]);
    assert.equal(found.stdout.trim().split("\n").length, 1);
    const empty = await invoke([`--kind=${kind}`, `--after=${prefix}T-z`]);
    assert.equal(empty.code, 0); assert.deepEqual(JSON.parse(empty.stdout).rows, []);
    const bad = await invoke(["--kind=secret-invalid-kind"]);
    assert.equal(bad.code, 1); assert.equal(bad.stdout, "");
    assert.deepEqual(JSON.parse(bad.stderr), { error: "invalid_options" });
    assert.equal(bad.stderr.includes("secret-invalid-kind"), false);
    await delegate(kind).deleteMany({ where: scope(kind, [id]) });
  });
}

test("options refuse malformed values before any database operation", async () => {
  let queries = 0;
  const unused = { $transaction() { queries++; throw new Error("must not query"); } };
  for (const options of [null, [], {}, { kind: "all" }, { kind: ["chat"] }, { kind: "chat", limit: null }, { kind: "chat", limit: 0 }, { kind: "chat", limit: 101 }, { kind: "chat", limit: 1.5 }, { kind: "chat", after: "🙂".repeat(65) }, { kind: "chat", after: "\ud800" }, { kind: "chat", after: "\0" }, { kind: "chat", extra: true }])
    await assert.rejects(report(unused, options), (error) => error.code === "invalid_options");
  assert.equal(queries, 0);
  for (const args of [null, [null], [], ["--kind=all"], ["--kind=chat", "--limit=01"], ["--kind=chat", "--limit=1.2"], ["--kind=chat", "--limit=101"], ["--kind=chat", "--kind=notification"], ["--kind=chat", "--json"], ["--kind=chat", "--after=" + "x".repeat(257)]])
    assert.throws(() => parse(args), (error) => error.code === "invalid_options");
  assert.deepEqual(parse(["--kind=notification", "--limit=100", "--after="]), { kind: "notification", limit: 100, after: "" });
});
