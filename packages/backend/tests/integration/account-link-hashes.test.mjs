import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { after, before, test } from "node:test";
import { parseMessage, startSmtpCapture } from "../fixtures/smtp-capture.mjs";

if (!process.env.TEST_DATABASE_URL)
  throw new Error(
    "Set TEST_DATABASE_URL to a migrated disposable PostgreSQL database",
  );
const smtp = await startSmtpCapture();
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";
process.env.JWT_SECRET = "account-link-hash-fixture-jwt-secret";
process.env.COOKIE_SECRET = "account-link-hash-fixture-cookie-secret";
process.env.FRONTEND_URL = "https://account-links.example.test";
process.env.SMTP_HOST = "127.0.0.1";
process.env.SMTP_PORT = String(smtp.port);
process.env.SMTP_FROM = "fixture@example.test";
process.env.SMTP_USER = "";
process.env.SMTP_PASS = "";
process.env.SMTP_SECURE = "false";
const { buildApp } = await import("../../src/app.ts");
const { hashPassword, verifyPassword } =
  await import("../../src/utils/passwords.ts");
const { hashToken } = await import("../../src/utils/tokens.ts");
const { resetTransporter } = await import("../../src/utils/mailer.ts");
const { PrismaClient } = await import("@prisma/client");
const { refreshLockLimits, startRefreshSession } =
  await import("../../src/modules/auth/refresh-sessions.ts");
const { cleanupExpiredTokensAndAttempts } =
  await import("../../src/modules/auth/auth.service.ts");
const domain = `account-link-${crypto.randomBytes(5).toString("hex")}.example.test`;
const password = "Fixture-password-123";
let app, origin, passwordHash, control;
let count = 0;
let address = 0;

before(async () => {
  resetTransporter();
  app = await buildApp();
  origin = await app.listen({ host: "127.0.0.1", port: 0 });
  passwordHash = await hashPassword(password);
  const url = new URL(process.env.TEST_DATABASE_URL);
  url.searchParams.set("connection_limit", "2");
  control = new PrismaClient({ datasources: { db: { url: url.toString() } } });
  await makeUser(); // Registration must exercise the ordinary-account path.
});

after(async () => {
  try {
    await app?.prisma.workspace.deleteMany({
      where: { slug: { contains: domain } },
    });
    await app?.prisma.user.deleteMany({
      where: { email: { endsWith: `@${domain}` } },
    });
    await app?.prisma.loginAttempt.deleteMany({
      where: { email: { endsWith: `@${domain}` } },
    });
  } finally {
    await app?.close();
    await control?.$disconnect();
    resetTransporter();
    await smtp.close();
  }
});

function request(method, path, { payload, access, cookie } = {}) {
  address++;
  return new Promise((resolve, reject) => {
    const body = payload ? JSON.stringify(payload) : undefined;
    const req = http.request(
      new URL(path, origin),
      {
        method,
        localAddress: `127.46.${(address >> 8) & 255}.${address & 255}`,
        headers: {
          ...(body
            ? {
                "content-type": "application/json",
                "content-length": Buffer.byteLength(body),
              }
            : {}),
          ...(access ? { authorization: `Bearer ${access}` } : {}),
          ...(cookie ? { cookie: `refresh_token=${cookie}` } : {}),
        },
      },
      (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          text += chunk;
        });
        response.on("end", () =>
          resolve({
            status: response.statusCode,
            body: text,
            json: text ? JSON.parse(text) : null,
            cookie: /refresh_token=([^;]+)/.exec(
              response.headers["set-cookie"]?.join(";") ?? "",
            )?.[1],
          }),
        );
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

function makeUser({ emailVerified = true } = {}) {
  return app.prisma.user.create({
    data: {
      email: `user-${++count}@${domain}`,
      displayName: "Account-link fixture",
      emailVerified,
      passwordHash,
    },
  });
}

async function login(user, secret = password) {
  const response = await request("POST", "/api/auth/login", {
    payload: { email: user.email, password: secret },
  });
  assert.equal(response.status, 200, response.body);
  return { access: response.json.data.accessToken, cookie: response.cookie };
}

function textParts(part) {
  return part.text ?? part.parts.map(textParts).join("\n");
}

function linkFor(user, kind) {
  const message = smtp.messages.findLast((message) =>
    message.envelope.to.includes(`<${user.email}>`),
  );
  assert(message, "the local SMTP sink received the account email");
  const text = textParts(parseMessage(message.data));
  const match = new RegExp(
    `https://account-links\\.example\\.test/${kind}/[^\\s<\"]+`,
  ).exec(text);
  assert(match, "the account email contains the link");
  return new URL(match[0]);
}

async function forgot(user) {
  const response = await request("POST", "/api/auth/forgot-password", {
    payload: { email: user.email },
  });
  assert.equal(response.status, 200, response.body);
  return {
    raw: linkFor(user, "reset-password").pathname.split("/").at(-1),
    response,
  };
}

function reset(raw, secret = "Reset-password-123") {
  return request("POST", `/api/auth/reset-password/${raw}`, {
    payload: { password: secret },
  });
}

function change(user, session, secret = "Changed-password-123") {
  return request("PATCH", `/api/users/${user.id}/password`, {
    access: session.access,
    payload: { currentPassword: password, newPassword: secret },
  });
}

async function snapshot(user) {
  return {
    user: await app.prisma.user.findUniqueOrThrow({ where: { id: user.id } }),
    links: await app.prisma.passwordResetToken.findMany({
      where: { userId: user.id },
      orderBy: { id: "asc" },
    }),
    families: await app.prisma.refreshTokenFamily.findMany({
      where: { userId: user.id },
      orderBy: { id: "asc" },
    }),
    sessions: await app.prisma.refreshToken.findMany({
      where: { userId: user.id },
      orderBy: { id: "asc" },
    }),
  };
}

// Separate connections hold and observe real SQL row locks. The barrier
// follows the specific blocker PID, including a delete queued behind another
// waiter on that row, before the holder lets the actors proceed.
async function withLock(lock, body, { rollback = false, beforeRelease } = {}) {
  let release, ready, holderPid;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const locked = new Promise((resolve) => {
    ready = resolve;
  });
  const rollbackSignal = new Error("fixture rollback");
  const holder = control
    .$transaction(
      async (tx) => {
        [{ pid: holderPid }] =
          await tx.$queryRaw`SELECT pg_backend_pid() AS pid`;
        await lock(tx);
        ready();
        await gate;
        await beforeRelease?.(tx);
        if (rollback) throw rollbackSignal;
      },
      { timeout: 15_000 },
    )
    .catch((error) => {
      if (error !== rollbackSignal) throw error;
    });
  const running = [];
  const start = (actor) => {
    const result = actor();
    running.push(result);
    return result;
  };
  async function waitBlocked(expected = 1) {
    const deadline = performance.now() + 5000;
    while (performance.now() < deadline) {
      const [{ count }] = await control.$queryRaw`
        WITH RECURSIVE blocked(pid) AS (
          SELECT pid FROM pg_stat_activity
          WHERE datname = current_database()
            AND ${holderPid}::int = ANY(pg_blocking_pids(pid))
          UNION
          SELECT activity.pid FROM pg_stat_activity AS activity
          JOIN blocked ON blocked.pid = ANY(pg_blocking_pids(activity.pid))
          WHERE activity.datname = current_database()
        )
        SELECT count(*)::int AS count FROM blocked
      `;
      if (count >= expected) return;
      await sleep(10);
    }
    assert.fail("application did not reach its PostgreSQL row-lock barrier");
  }
  try {
    await Promise.race([
      locked,
      holder.then(() => assert.fail("holder ended before locking")),
    ]);
    await body(start, waitBlocked);
  } finally {
    release();
    await Promise.allSettled([holder, ...running]);
  }
  await holder;
  return Promise.all(running);
}

async function bounded(pending) {
  let timer;
  try {
    return await Promise.race([
      pending,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("request waited for holder")),
          3000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test("forgot-password persists only a digest; the emailed raw link works once and the stored digest does not", async () => {
  const user = await makeUser();
  const session = await login(user);
  const { raw, response } = await forgot(user);
  const row = await app.prisma.passwordResetToken.findFirstOrThrow({
    where: { userId: user.id },
  });
  assert.equal(
    row.token === raw,
    false,
    "the emailed reset bearer must not be stored verbatim",
  );
  assert.equal(
    Object.hasOwn(row, "token"),
    false,
    "the raw bearer column is absent",
  );
  assert.equal(row.tokenHash, hashToken(raw));
  assert.notEqual(row.tokenHash, raw);
  assert.equal(response.body.includes(raw), false);
  assert.equal((await reset(row.tokenHash)).status, 404);
  assert.equal(
    (
      await app.prisma.passwordResetToken.findUniqueOrThrow({
        where: { id: row.id },
      })
    ).usedAt,
    null,
  );
  assert.equal((await reset(raw)).status, 200);
  assert.equal((await reset(raw)).status, 410);
  assert.equal(
    (await request("POST", "/api/auth/refresh", { cookie: session.cookie }))
      .status,
    401,
  );
  assert(
    await verifyPassword(
      "Reset-password-123",
      (await app.prisma.user.findUniqueOrThrow({ where: { id: user.id } }))
        .passwordHash,
    ),
  );
  const missing = await request("POST", "/api/auth/forgot-password", {
    payload: { email: `absent@${domain}` },
  });
  assert.equal(missing.status, response.status);
  assert.equal(missing.body, response.body);
});

test("register and resend persist verification digests and retain subject and invitation continuation", async () => {
  const owner = await makeUser();
  const email = `registered-${++count}@${domain}`;
  const workspace = await app.prisma.workspace.create({
    data: {
      name: "Account link fixture",
      slug: `workspace-${domain}`,
      members: { create: { userId: owner.id, role: "ADMIN" } },
    },
  });
  const invite = await app.prisma.workspaceInvite.create({
    data: {
      workspaceId: workspace.id,
      token: crypto.randomBytes(24).toString("hex"),
      email,
      role: "MEMBER",
    },
  });
  const registered = await request("POST", "/api/auth/register", {
    payload: {
      email,
      password,
      displayName: "Registered fixture",
      inviteToken: invite.token,
    },
  });
  assert.equal(registered.status, 201, registered.body);
  assert.equal(registered.json.data.admission.status, "verification_required");
  const user = registered.json.data.user;
  const original = linkFor(user, "verify-email");
  assert.equal(original.searchParams.get("invite"), invite.token);
  const raw = original.pathname.split("/").at(-1);
  const first = await app.prisma.emailVerificationToken.findFirstOrThrow({
    where: { userId: user.id },
  });
  assert.equal(
    first.token === raw,
    false,
    "the emailed verification bearer must not be stored verbatim",
  );
  assert.equal(
    Object.hasOwn(first, "token"),
    false,
    "the raw bearer column is absent",
  );
  assert.equal(first.tokenHash, hashToken(raw));
  assert.equal(registered.body.includes(raw), false);
  assert.equal(
    (await request("POST", `/api/auth/verify-email/${first.tokenHash}`)).status,
    404,
  );
  const resent = await request("POST", "/api/auth/resend-verification", {
    access: registered.json.data.accessToken,
    payload: { inviteToken: invite.token },
  });
  assert.equal(resent.status, 200, resent.body);
  const newer = linkFor(user, "verify-email");
  assert.equal(newer.searchParams.get("invite"), invite.token);
  const nextRaw = newer.pathname.split("/").at(-1);
  assert.notEqual(nextRaw, raw);
  const second = await app.prisma.emailVerificationToken.findFirstOrThrow({
    where: { userId: user.id },
  });
  assert.equal(second.tokenHash, hashToken(nextRaw));
  assert.equal(
    (await request("POST", `/api/auth/verify-email/${raw}`)).status,
    404,
  );
  const ownerSession = await login(owner);
  const verified = await request("POST", `/api/auth/verify-email/${nextRaw}`, {
    access: ownerSession.access,
  });
  assert.equal(verified.status, 200, verified.body);
  assert.equal(verified.json.data.user.id, user.id);
  assert.equal(verified.json.data.user.emailVerified, true);
  assert.equal(verified.body.includes(nextRaw), false);
  assert.equal(verified.body.includes(second.tokenHash), false);
  assert.equal(
    (await request("POST", `/api/auth/verify-email/${nextRaw}`)).status,
    404,
  );
});

test("successful password change invalidates earlier reset links while keeping other accounts and used records", async () => {
  const user = await makeUser();
  const other = await makeUser();
  const session = await login(user);
  const { raw } = await forgot(user);
  const { raw: otherRaw } = await forgot(other);
  await app.prisma.passwordResetToken.createMany({
    data: [3600_000, -1000].map((offset) => ({
      userId: user.id,
      tokenHash: hashToken(crypto.randomBytes(32).toString("hex")),
      expiresAt: new Date(Date.now() + offset),
    })),
  });
  const used = await app.prisma.passwordResetToken.create({
    data: {
      userId: user.id,
      tokenHash: hashToken(crypto.randomBytes(32).toString("hex")),
      expiresAt: new Date(Date.now() - 1000),
      usedAt: new Date(),
    },
  });
  const changed = await request("PATCH", `/api/users/${user.id}/password`, {
    access: session.access,
    payload: { currentPassword: password, newPassword: "Changed-password-123" },
  });
  assert.equal(changed.status, 200, changed.body);
  const stale = await reset(raw);
  assert.equal(
    stale.status,
    404,
    "a reset link issued before a successful password change must be invalid",
  );
  assert.equal(
    await app.prisma.passwordResetToken.count({
      where: { userId: user.id, usedAt: null },
    }),
    0,
  );
  assert.deepEqual(
    await app.prisma.passwordResetToken.findUniqueOrThrow({
      where: { id: used.id },
    }),
    used,
  );
  assert.equal((await reset(otherRaw)).status, 200);
  const { raw: newer } = await forgot(user);
  assert.equal(
    (await reset(newer)).status,
    200,
    "a link requested after the change remains usable",
  );
});

for (const deleting of [false, true]) {
  test(`password change refuses a skipped ${deleting ? "deleting" : "locked"} reset row whose holder rolls back`, async () => {
    const user = await makeUser();
    const session = await login(user);
    const { raw } = await forgot(user);
    const before = await snapshot(user);
    const [busy] = await withLock(
      async (tx) => {
        if (deleting)
          await tx.passwordResetToken.deleteMany({
            where: { userId: user.id },
          });
        else
          await tx.$queryRaw`SELECT id FROM "PasswordResetToken" WHERE "userId" = ${user.id} FOR UPDATE`;
      },
      async (start) => {
        await bounded(start(() => change(user, session)));
      },
      { rollback: true },
    );
    if (busy.status === 200)
      assert.equal(
        (await reset(raw)).status,
        404,
        "a successful change cannot leave the skipped old link usable after holder rollback",
      );
    assert.equal(busy.status, 503);
    assert.match(busy.json.message, /account is busy/);
    assert.deepEqual(
      await snapshot(user),
      before,
      "refused change and rolled-back holder have no side effects",
    );
    assert.equal(
      (await request("POST", "/api/auth/refresh", { cookie: session.cookie }))
        .status,
      200,
    );
    assert.equal((await change(user, session)).status, 200);
    assert.equal((await reset(raw)).status, 404);
  });
}

test("wrong-password and foreign-account changes preserve reset links and sessions", async () => {
  const user = await makeUser();
  const other = await makeUser();
  const session = await login(user);
  const { raw } = await forgot(user);
  await forgot(other);
  const before = await snapshot(user);
  const otherBefore = await snapshot(other);
  const wrong = await request("PATCH", `/api/users/${user.id}/password`, {
    access: session.access,
    payload: {
      currentPassword: "Wrong-password-123",
      newPassword: "Changed-password-123",
    },
  });
  assert.equal(wrong.status, 400, wrong.body);
  const foreign = await change(other, session);
  assert.equal(foreign.status, 403, foreign.body);
  assert.deepEqual(await snapshot(user), before);
  assert.deepEqual(await snapshot(other), otherBefore);
  assert.equal((await reset(raw)).status, 200);
});

test("password change rolls back reset-link invalidation if family revocation is busy", async () => {
  const user = await makeUser();
  const session = await login(user);
  const { raw } = await forgot(user);
  const before = await snapshot(user);
  const saved = refreshLockLimits.lockTimeoutMs;
  refreshLockLimits.lockTimeoutMs = 300;
  try {
    const [busy] = await withLock(
      (tx) =>
        tx.$queryRaw`SELECT id FROM "RefreshTokenFamily" WHERE "userId" = ${user.id} FOR UPDATE`,
      async (start, waitBlocked) => {
        const pending = start(() => change(user, session));
        await waitBlocked();
        assert.equal((await bounded(pending)).status, 503);
      },
    );
    assert.equal(busy.status, 503);
    assert.deepEqual(await snapshot(user), before);
    assert.equal(
      (await reset(raw)).status,
      200,
      "a rolled-back invalidation leaves the link usable",
    );
  } finally {
    refreshLockLimits.lockTimeoutMs = saved;
  }
});

test("a stale change preserves a newer reset link and session", async () => {
  const user = await makeUser();
  const session = await login(user);
  const newerPasswordHash = await hashPassword("Newer-password-123");
  const raw = crypto.randomBytes(32).toString("hex");
  let newerSession;
  const [denied] = await withLock(
    (tx) =>
      tx.$queryRaw`SELECT id FROM "User" WHERE id = ${user.id} FOR NO KEY UPDATE`,
    async (start, waitBlocked) => {
      start(() => change(user, session));
      await waitBlocked();
    },
    {
      beforeRelease: async (tx) => {
        await tx.user.update({
          where: { id: user.id },
          data: { passwordHash: newerPasswordHash },
        });
        await tx.passwordResetToken.create({
          data: {
            userId: user.id,
            tokenHash: hashToken(raw),
            expiresAt: new Date(Date.now() + 3600_000),
          },
        });
        newerSession = await startRefreshSession(tx, user.id);
      },
    },
  );
  assert.equal(denied.status, 400, denied.body);
  assert.equal(
    (
      await app.prisma.passwordResetToken.findUniqueOrThrow({
        where: { tokenHash: hashToken(raw) },
      })
    ).usedAt,
    null,
  );
  assert.equal(
    (
      await request("POST", "/api/auth/refresh", {
        cookie: newerSession.refreshToken,
      })
    ).status,
    200,
  );
  assert.equal((await reset(raw)).status, 200);
});

test("change, forgot-password and cleanup settle without deadlock and later issued links remain usable", async () => {
  const user = await makeUser();
  const session = await login(user);
  const { raw } = await forgot(user);
  const old = await app.prisma.passwordResetToken.findFirstOrThrow({
    where: { userId: user.id },
  });
  await app.prisma.passwordResetToken.update({
    where: { id: old.id },
    data: { expiresAt: new Date(Date.now() - 1000) },
  });
  let newer;
  const results = await withLock(
    (tx) =>
      tx.$queryRaw`SELECT id FROM "PasswordResetToken" WHERE id = ${old.id} FOR UPDATE`,
    async (start, waitBlocked) => {
      start(async () => {
        newer = await forgot(user);
        return newer.response;
      });
      await waitBlocked();
      start(() => cleanupExpiredTokensAndAttempts(app.prisma));
      await waitBlocked(2);
      const changed = await bounded(start(() => change(user, session)));
      assert.equal(changed.status, 503, changed.body);
    },
  );
  assert.equal(results[0].status, 200);
  assert.equal(results[2].status, 503);
  assert.equal((await reset(raw)).status, 404);
  assert.equal((await reset(newer.raw)).status, 200);
});

test("a reset link inserted after the delete makes password change retry without discarding the newer link", async () => {
  const user = await makeUser();
  const session = await login(user);
  const before = await snapshot(user);
  const name = `account_link_insert_${crypto.randomBytes(5).toString("hex")}`;
  const sequence = `${name}_seq`;
  const key = crypto.randomInt(1, 1_000_000_000);
  let issued;
  try {
    await control.$executeRawUnsafe(`CREATE SEQUENCE "${sequence}"`);
    // Statement triggers run after an empty DELETE too. Only the first
    // invocation pauses; forgot-password can insert while change holds User.
    await control.$executeRawUnsafe(`
      CREATE FUNCTION "${name}"() RETURNS trigger AS $$
      BEGIN
        IF nextval('"${sequence}"') = 1 THEN
          PERFORM pg_advisory_xact_lock(${key});
        END IF;
        RETURN NULL;
      END;
      $$ LANGUAGE plpgsql
    `);
    await control.$executeRawUnsafe(`
      CREATE TRIGGER "${name}" AFTER DELETE ON "PasswordResetToken"
      FOR EACH STATEMENT EXECUTE FUNCTION "${name}"()
    `);
    const [busy] = await withLock(
      (tx) => tx.$executeRaw`SELECT pg_advisory_xact_lock(${key}::bigint)`,
      async (start, waitBlocked) => {
        start(() => change(user, session));
        await waitBlocked();
        issued = await forgot(user);
      },
    );
    assert.equal(busy.status, 503, busy.body);
    assert.equal(
      busy.json.message,
      "This account is busy. Try again in a moment.",
    );
    const after = await snapshot(user);
    assert.deepEqual(after.user, before.user);
    assert.deepEqual(after.families, before.families);
    assert.deepEqual(after.sessions, before.sessions);
    assert.equal(after.links.length, 1);
    assert.equal(after.links[0].tokenHash, hashToken(issued.raw));
    assert.equal(after.links[0].usedAt, null);
    assert.equal((await reset(issued.raw)).status, 200);
  } finally {
    await control.$executeRawUnsafe(
      `DROP TRIGGER IF EXISTS "${name}" ON "PasswordResetToken"`,
    );
    await control.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${name}"()`);
    await control.$executeRawUnsafe(`DROP SEQUENCE IF EXISTS "${sequence}"`);
  }
});

test("reset refuses a skipped sibling delete that later rolls back", async () => {
  const user = await makeUser();
  const session = await login(user);
  const { raw } = await forgot(user);
  const sibling = crypto.randomBytes(32).toString("hex");
  const row = await app.prisma.passwordResetToken.create({
    data: {
      userId: user.id,
      tokenHash: hashToken(sibling),
      expiresAt: new Date(Date.now() + 3600_000),
    },
  });
  const before = await snapshot(user);
  const [result] = await withLock(
    (tx) => tx.passwordResetToken.delete({ where: { id: row.id } }),
    async (start) => {
      await bounded(start(() => reset(raw)));
    },
    { rollback: true },
  );
  if (result.status === 200)
    assert.equal(
      (await reset(sibling)).status,
      404,
      "a successful reset cannot leave the skipped sibling usable after holder rollback",
    );
  assert.equal(
    result.status,
    503,
    "a reset cannot succeed while a skipped sibling deletion may roll back",
  );
  assert.deepEqual(await snapshot(user), before);
  assert.equal(
    (await request("POST", "/api/auth/refresh", { cookie: session.cookie }))
      .status,
    200,
  );
  assert.equal((await reset(raw)).status, 200);
  assert.equal((await reset(sibling)).status, 404);
});
