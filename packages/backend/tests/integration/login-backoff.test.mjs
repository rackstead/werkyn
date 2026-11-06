// Failed password sign-in backoff (docs/remediation/r31-login-backoff.md):
// growth, cap, reset, no lockout, identical answers for addresses with and
// without an account, parallel admission, two server processes, and
// password-reset requests answered before any account work.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { createInterface } from "node:readline";
import { after, before, test } from "node:test";
import nodemailer from "nodemailer";

if (!process.env.TEST_DATABASE_URL)
  throw new Error(
    "Set TEST_DATABASE_URL to a migrated, disposable PostgreSQL database",
  );
for (const name of Object.keys(process.env))
  if (name.startsWith("LOGIN_BACKOFF_")) delete process.env[name];
Object.assign(process.env, {
  DATABASE_URL: process.env.TEST_DATABASE_URL,
  NODE_ENV: "test",
  LOG_LEVEL: "error",
  JWT_SECRET: "login-backoff-jwt-secret",
  COOKIE_SECRET: "login-backoff-cookie-secret",
  FRONTEND_URL: "https://werkyn.example.test",
  SMTP_HOST: "127.0.0.1",
  SMTP_PORT: "1",
  SMTP_USER: "",
  SMTP_PASS: "",
  SMTP_SECURE: "false",
  SMTP_FROM: "noreply@werkyn.example.test",
  CORS_ORIGIN: "http://localhost:5173",
});

const { buildApp } = await import("../../src/app.ts");
const { hashPassword } = await import("../../src/utils/passwords.ts");
const { loginSlot, loginThrottle, DEVICE_LANES } = await import(
  "../../src/modules/auth/login-throttle.ts"
);
const { settlePasswordResetRequests } = await import(
  "../../src/modules/auth/auth.service.ts"
);
const { resetTransporter, setPrisma } = await import("../../src/utils/mailer.ts");
const { deviceCookieAfterSignIn } = await import(
  "../../src/modules/auth/login-device.ts"
);

const PASSWORD = "Correct-password-123";
const WRONG = "Wrong-password-123";
const DEFAULT_SLOTS = 65536;
const suffix = crypto.randomBytes(5).toString("hex");
const domain = `backoff-${suffix}.example.test`;
const originalTransport = nodemailer.createTransport;
const mail = [];
let mailGate = Promise.resolve();
let app;
let passwordHash;
let counter = 0;
let address = 0;
const usedSlots = new Set();

nodemailer.createTransport = () => ({
  async sendMail(message) {
    await mailGate;
    mail.push(message);
    return {};
  },
});

before(async () => {
  resetTransporter();
  app = await buildApp();
  await app.ready();
  passwordHash = await hashPassword(PASSWORD);
});

after(async () => {
  try {
    await settlePasswordResetRequests();
    await app.prisma.user.deleteMany({
      where: { email: { endsWith: `@${domain}` } },
    });
    // This run's address slots, and the device lanes its sign-ins used.
    await app.prisma.loginThrottle.deleteMany({
      where: { OR: [{ slot: { in: [...usedSlots] } }, { slot: { gte: DEFAULT_SLOTS } }] },
    });
  } finally {
    nodemailer.createTransport = originalTransport;
    resetTransporter();
    await app?.close();
  }
});

/** A new address whose slot no other address of this run uses and is empty. */
async function freshAddress(kind) {
  for (;;) {
    const email = `${kind}-${++counter}@${domain}`;
    const slot = loginSlot(email, DEFAULT_SLOTS);
    if (usedSlots.has(slot)) continue;
    usedSlots.add(slot);
    if (await app.prisma.loginThrottle.findUnique({ where: { slot } }))
      continue;
    return email;
  }
}

async function account(kind) {
  const email = await freshAddress(kind);
  if (kind !== "unknown")
    await app.prisma.user.create({
      data: {
        email,
        displayName: kind,
        passwordHash: kind === "real" ? passwordHash : null,
        emailVerified: true,
      },
    });
  return email;
}

function nextAddress() {
  address++;
  return `10.88.${(address >> 8) & 255}.${address & 255}`;
}

async function login(email, password) {
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { email, password },
    // Distinct client addresses keep the per-address route limit out of it.
    remoteAddress: nextAddress(),
  });
  return {
    status: response.statusCode,
    retryAfter: response.headers["retry-after"],
    body: response.json(),
  };
}

const slotOf = (email) => loginSlot(email, DEFAULT_SLOTS);

/** Moves the slot's last admitted attempt `seconds` into the past. */
async function elapse(email, seconds) {
  await app.prisma.$executeRaw`
    UPDATE "LoginThrottle"
    SET "lastFailureAt" = "lastFailureAt" - ${seconds}::integer * interval '1 second'
    WHERE "slot" = ${slotOf(email)}::integer
  `;
}

const failures = async (email) =>
  (await app.prisma.loginThrottle.findUnique({ where: { slot: slotOf(email) } }))
    ?.failures ?? 0;

const invalid = {
  status: 401,
  retryAfter: undefined,
  body: {
    statusCode: 401,
    error: "Unauthorized",
    message: "Invalid email or password",
  },
};
const waiting = (seconds) => ({
  status: 429,
  retryAfter: String(seconds),
  body: {
    statusCode: 429,
    error: "Too Many Requests",
    message: `Too many sign-in attempts. Try again in ${seconds} seconds.`,
  },
});

test("after five failures every address waits alike: real account, account without a password and unknown address", async () => {
  const transcripts = {};
  for (const kind of ["real", "sso", "unknown"]) {
    const email = await account(kind);
    const seen = [];
    for (let i = 0; i < 5; i++) seen.push(await login(email, WRONG));
    // The correct password waits too: the wait is not a password check.
    seen.push(await login(email, kind === "real" ? PASSWORD : WRONG));
    seen.push(await login(email, WRONG));
    transcripts[kind] = seen;
    assert.equal(await failures(email), 5, kind);
  }
  assert.deepEqual(transcripts.real, [
    ...Array(5).fill(invalid),
    waiting(2),
    waiting(2),
  ]);
  assert.deepEqual(transcripts.sso, transcripts.real);
  assert.deepEqual(transcripts.unknown, transcripts.real);
});

test("the wait doubles per failure up to the cap and never becomes a lock", async () => {
  const email = await account("real");
  for (let i = 0; i < 5; i++) assert.deepEqual(await login(email, WRONG), invalid);
  const waits = [];
  for (let i = 0; i < 8; i++) {
    const refused = await login(email, WRONG);
    assert.equal(refused.status, 429);
    waits.push(Number(refused.retryAfter));
    await elapse(email, Number(refused.retryAfter));
    assert.deepEqual(await login(email, WRONG), invalid);
  }
  assert.deepEqual(waits, [2, 4, 8, 16, 32, 60, 60, 60]);
  assert.equal(await failures(email), 13);

  // Still capped, and once the stated wait passes the password signs in.
  assert.deepEqual(await login(email, PASSWORD), waiting(60));
  await elapse(email, 60);
  const signedIn = await login(email, PASSWORD);
  assert.equal(signedIn.status, 200, JSON.stringify(signedIn.body));
  assert.equal(signedIn.body.data.user.email, email);
  // Success forgets the failures: four more are checked without any wait.
  assert.equal(await failures(email), 0);
  for (let i = 0; i < 4; i++) assert.deepEqual(await login(email, WRONG), invalid);
  assert.equal((await login(email, PASSWORD)).status, 200);
  assert.equal(await failures(email), 0);
});

test("a frontend on another allowed origin can read the wait", async () => {
  const email = await account("unknown");
  for (let i = 0; i < 5; i++) await login(email, WRONG);
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { email, password: WRONG },
    headers: { origin: "http://localhost:5173" },
    remoteAddress: nextAddress(),
  });
  assert.equal(response.statusCode, 429);
  assert.equal(response.headers["retry-after"], "2");
  assert.equal(response.headers["access-control-allow-origin"], "http://localhost:5173");
  assert.match(response.headers["access-control-expose-headers"] ?? "", /retry-after/i);
});

test("refused attempts are not counted and do not lengthen the wait", async () => {
  const email = await account("real");
  for (let i = 0; i < 5; i++) await login(email, WRONG);
  for (let i = 0; i < 12; i++)
    assert.deepEqual(await login(email, i % 2 ? PASSWORD : WRONG), waiting(2));
  assert.equal(await failures(email), 5);
  await elapse(email, 2);
  assert.deepEqual(await login(email, WRONG), invalid);
  assert.deepEqual(await login(email, WRONG), waiting(4));
  assert.equal(await failures(email), 6);
});

test("failures are forgotten after the quiet period", async () => {
  const email = await account("unknown");
  for (let i = 0; i < 5; i++) await login(email, WRONG);
  await elapse(email, 2);
  assert.deepEqual(await login(email, WRONG), invalid);
  assert.equal(await failures(email), 6);
  await elapse(email, 3600);
  // The count starts again at one: five more are checked before any wait.
  for (let i = 0; i < 5; i++) assert.deepEqual(await login(email, WRONG), invalid);
  assert.deepEqual(await login(email, WRONG), waiting(2));
  assert.equal(await failures(email), 5);
});

test("parallel attempts are admitted one at a time: at most five passwords are checked", async () => {
  const email = await account("real");
  const results = await Promise.all(
    Array.from({ length: 20 }, () => login(email, WRONG)),
  );
  const count = (status) => results.filter((r) => r.status === status).length;
  const statuses = JSON.stringify(results.map((r) => r.status));
  // 503: password checks were busy (two native jobs per process); such an
  // attempt was not checked and is uncounted, which can admit another.
  assert.equal(count(401) + count(429) + count(503), 20, statuses);
  assert.ok(count(401) >= 1, statuses);
  assert.ok(count(401) <= 5, statuses);
  assert.ok(count(429) >= 15 - count(503), statuses);
  assert.equal(await failures(email), count(401));
  await elapse(email, 60);
  assert.equal((await login(email, PASSWORD)).status, 200);
});

test("an attempt whose password check was unavailable is not counted", async () => {
  const email = await account("real");
  await login(email, WRONG);
  await login(email, WRONG);
  // Keep both native permits of this process busy until a sign-in finds
  // them taken (each sign-in either is refused 503 or slips between jobs).
  let busy = true;
  const occupy = async () => {
    while (busy)
      await hashPassword("Occupying-password-1").catch(
        // A refused job settles at once; yield so I/O keeps running.
        () => new Promise((resolve) => setImmediate(resolve)),
      );
  };
  const workers = [occupy(), occupy()];
  let refused;
  try {
    for (let i = 0; i < 40 && !refused; i++) {
      const before = await failures(email);
      const result = await login(email, WRONG);
      if (result.status === 503) refused = { before, after: await failures(email), result };
      else {
        assert.deepEqual(result, invalid);
        if (before >= 4) {
          await app.prisma.loginThrottle.update({
            where: { slot: slotOf(email) },
            data: { failures: 2 },
          });
        }
      }
    }
  } finally {
    busy = false;
    await Promise.all(workers);
  }
  assert.ok(refused, "a sign-in met busy password checks");
  assert.equal(refused.result.body.message, "Password checks are temporarily unavailable. Try again.");
  assert.equal(refused.after, refused.before);
});

test("a sign-in clears only the failures admitted up to it, not overlapping later ones", async () => {
  const throttle = loginThrottle();
  const email = await account("unknown");
  const first = await throttle.admit(app.prisma, email);
  const second = await throttle.admit(app.prisma, email);
  const third = await throttle.admit(app.prisma, email);
  assert.ok(first.admitted && second.admitted && third.admitted);
  assert.equal(await failures(email), 3);
  // The second attempt signs in while the third (admitted after it) fails.
  await throttle.succeeded(app.prisma, second.ticket);
  assert.equal(await failures(email), 1);
  // A slower report for an earlier attempt changes nothing it does not own.
  await throttle.succeeded(app.prisma, first.ticket);
  assert.equal(await failures(email), 1);
  await throttle.unchecked(app.prisma, first.ticket);
  assert.equal(await failures(email), 1);
});

test("an undecided attempt reported after a later sign-in does not uncount newer failures", async () => {
  const throttle = loginThrottle();
  const email = await account("unknown");
  const busy = await throttle.admit(app.prisma, email);
  const signedIn = await throttle.admit(app.prisma, email);
  await throttle.succeeded(app.prisma, signedIn.ticket);
  assert.equal(await failures(email), 0);
  const newer = await throttle.admit(app.prisma, email);
  assert.ok(newer.admitted);
  assert.equal(await failures(email), 1);
  // The first attempt's password check failed to run; it was already
  // cleared by the sign-in, so the newer failure keeps its count.
  await throttle.unchecked(app.prisma, busy.ticket);
  assert.equal(await failures(email), 1);
  // Its own undecided outcome still uncounts the newer attempt.
  await throttle.unchecked(app.prisma, newer.ticket);
  assert.equal(await failures(email), 0);
});

test("an outcome for a row pruned meanwhile does not touch the row created after it", async () => {
  const throttle = loginThrottle();
  const email = await account("unknown");
  const old = await throttle.admit(app.prisma, email);
  const mark = await throttle.addressMark(app.prisma, email);
  // The row is pruned (quiet past the reset period) and created again by a
  // new failure, reaching the same admission number as the old tickets.
  await app.prisma.loginThrottle.delete({ where: { slot: slotOf(email) } });
  const fresh = await throttle.admit(app.prisma, email);
  assert.equal(fresh.ticket.number, old.ticket.number);
  assert.notEqual(fresh.ticket.generation, old.ticket.generation);
  await throttle.succeeded(app.prisma, old.ticket);
  await throttle.succeeded(app.prisma, mark);
  await throttle.unchecked(app.prisma, old.ticket);
  assert.equal(await failures(email), 1);
});

test("a correct password whose sign-in is refused because the password changed stays a counted failure", async () => {
  const email = await account("real");
  await login(email, WRONG);
  const user = await app.prisma.user.findUniqueOrThrow({ where: { email } });
  const replacement = await hashPassword("Replacement-password-1");
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  let held;
  const holding = new Promise((resolve) => (held = resolve));
  // Holds the account row as a password change does, then changes the hash.
  const change = app.prisma.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${user.id} FOR NO KEY UPDATE`;
      held();
      await gate;
      await tx.user.update({ where: { id: user.id }, data: { passwordHash: replacement } });
    },
    { timeout: 15_000 },
  );
  await holding;
  const pending = login(email, PASSWORD);
  try {
    // The sign-in verified the old password and now waits for the row.
    for (let i = 0; ; i++) {
      const [{ waiting }] = await app.prisma.$queryRaw`
        SELECT count(*)::int AS waiting FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'
      `;
      if (waiting > 0) break;
      assert.ok(i < 500, "the sign-in waits for the account row");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  } finally {
    release();
    await change;
  }
  assert.deepEqual(await pending, invalid);
  assert.equal(await failures(email), 2);
});

/** Sign-in from a browser holding `cookie` (login_device), if any. */
async function browserLogin(email, password, cookie) {
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { email, password },
    headers: cookie ? { cookie: `login_device=${cookie}` } : {},
    remoteAddress: nextAddress(),
  });
  return {
    status: response.statusCode,
    retryAfter: response.headers["retry-after"],
    body: response.json(),
    device: response.cookies.find((c) => c.name === "login_device"),
  };
}

const deviceIds = (cookie) => cookie.split("~").map((token) => token.split(".")[0]);
const deviceSlot = (id) => {
  const slot = DEVICE_LANES + loginSlot(`device ${id}`, DEFAULT_SLOTS);
  usedSlots.add(slot);
  return slot;
};
const holdAtCap = (email) => app.prisma.$executeRaw`
  INSERT INTO "LoginThrottle" ("slot", "failures", "lastFailureAt", "admissions")
  VALUES (${slotOf(email)}::integer, 11, clock_timestamp() AT TIME ZONE 'UTC', 11)
  ON CONFLICT ("slot") DO UPDATE SET "failures" = 11,
    "lastFailureAt" = clock_timestamp() AT TIME ZONE 'UTC', "admissions" = 11, "clearedThrough" = 0
`;

test("a browser that signed in before is not held off by failures others send for the address", async () => {
  const email = await account("real");
  const first = await browserLogin(email, PASSWORD);
  assert.equal(first.status, 200);
  assert.ok(first.device, "a sign-in marks the browser");
  assert.equal(first.device.httpOnly, true);
  assert.equal(first.device.path, "/api/auth/login");
  assert.equal(first.device.sameSite, "Lax");
  assert.equal(first.device.maxAge, 30 * 24 * 60 * 60);
  // Someone else keeps the address at its longest wait.
  for (let i = 0; i < 5; i++) await login(email, WRONG);
  await holdAtCap(email);
  assert.deepEqual(await login(email, PASSWORD), waiting(60));
  // The browser that signed in before is checked at once and signs in.
  const trusted = await browserLogin(email, PASSWORD, first.device.value);
  assert.equal(trusted.status, 200, JSON.stringify(trusted.body));
  // Its token is renewed for the same device.
  assert.deepEqual(deviceIds(trusted.device.value), deviceIds(first.device.value));
  // A completed sign-in clears the address's failures admitted before it.
  assert.equal(await failures(email), 0);
});

test("a trusted browser has its own small budget, separate from the address", async () => {
  const email = await account("real");
  const { device } = await browserLogin(email, PASSWORD);
  const lane = deviceSlot(deviceIds(device.value)[0]);
  const laneFailures = async () =>
    (await app.prisma.loginThrottle.findUnique({ where: { slot: lane } }))?.failures ?? 0;
  for (let i = 0; i < 5; i++)
    assert.deepEqual(
      (({ status, retryAfter, body }) => ({ status, retryAfter, body }))(
        await browserLogin(email, WRONG, device.value),
      ),
      invalid,
    );
  const refused = await browserLogin(email, PASSWORD, device.value);
  assert.equal(refused.status, 429);
  assert.equal(refused.retryAfter, "2");
  assert.equal(refused.device, undefined);
  assert.equal(await laneFailures(), 5);
  // The address itself counted none of them.
  assert.equal(await failures(email), 0);
  // The lane backs off like an address: after its wait, it signs in.
  await app.prisma.$executeRaw`
    UPDATE "LoginThrottle" SET "lastFailureAt" = "lastFailureAt" - interval '2 seconds'
    WHERE "slot" = ${lane}::integer
  `;
  assert.equal((await browserLogin(email, PASSWORD, device.value)).status, 200);
  assert.equal(await laneFailures(), 0);
});

test("a device token counts only for its own address, unexpired and unaltered", async () => {
  const owner = await account("real");
  const other = await account("real");
  const { device } = await browserLogin(owner, PASSWORD);
  await holdAtCap(other);
  // Another address's token, an altered one and an expired one are ignored.
  const minted = deviceCookieAfterSignIn(undefined, other);
  const altered = minted.slice(0, -1) + (minted.endsWith("A") ? "B" : "A");
  const expired = deviceCookieAfterSignIn(
    undefined,
    other,
    Date.now() - 31 * 24 * 60 * 60 * 1000,
  );
  for (const cookie of [device.value, altered, expired, "garbage"]) {
    const result = await browserLogin(other, PASSWORD, cookie);
    assert.equal(result.status, 429, cookie);
    assert.equal(result.retryAfter, "60");
  }
  // A token minted for this address is accepted.
  const accepted = await browserLogin(other, PASSWORD, minted);
  assert.equal(accepted.status, 200);
  // The browser keeps one token per address that signed in from it, five at most.
  let cookie = accepted.device.value;
  const signedIn = [other];
  for (let i = 0; i < 5; i++) {
    const email = await account("real");
    const result = await browserLogin(email, PASSWORD, cookie);
    assert.equal(result.status, 200);
    cookie = result.device.value;
    signedIn.unshift(email);
  }
  assert.equal(cookie.split("~").length, 5);
  // The oldest address's token was dropped; the newest five are kept.
  await holdAtCap(signedIn[0]);
  await holdAtCap(signedIn[5]);
  assert.equal((await browserLogin(signedIn[0], PASSWORD, cookie)).status, 200);
  assert.equal((await browserLogin(signedIn[5], PASSWORD, cookie)).status, 429);
});

test("without a device token, answers do not depend on whether some browser holds one for the address", async () => {
  const trustedSomewhere = await account("real");
  assert.equal((await browserLogin(trustedSomewhere, PASSWORD)).status, 200);
  const transcripts = {};
  for (const [kind, email] of [
    ["trusted elsewhere", trustedSomewhere],
    ["never signed in", await account("real")],
    ["password-less", await account("sso")],
    ["unknown", await account("unknown")],
  ]) {
    const seen = [];
    for (let i = 0; i < 6; i++) {
      const result = await browserLogin(email, WRONG);
      seen.push({ status: result.status, retryAfter: result.retryAfter, body: result.body, device: result.device });
    }
    transcripts[kind] = seen;
  }
  const expected = [
    ...Array(5).fill({ ...invalid, device: undefined }),
    { ...waiting(2), device: undefined },
  ];
  for (const [kind, seen] of Object.entries(transcripts))
    assert.deepEqual(seen, expected, kind);
});

test("the tracking table holds counters only, no addresses", async () => {
  const columns = await app.prisma.$queryRaw`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'LoginThrottle'
    ORDER BY ordinal_position
  `;
  assert.deepEqual(
    columns.map((c) => c.column_name),
    ["slot", "failures", "lastFailureAt", "admissions", "clearedThrough", "generation"],
  );
  const [old] = await app.prisma.$queryRaw`
    SELECT to_regclass('"LoginAttempt"')::text AS name
  `;
  assert.equal(old.name, null);
  assert.equal(loginThrottle().policy.slots, DEFAULT_SLOTS);
});

test("two server processes share one address's backoff", async () => {
  const children = await Promise.all([startChild(), startChild()]);
  try {
    const [a, b] = children;
    const email = await account("real");
    const fetchLogin = async (child, password) => {
      const response = await fetch(`http://127.0.0.1:${child.port}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      return {
        status: response.status,
        retryAfter: response.headers.get("retry-after") ?? undefined,
        body: await response.json(),
      };
    };
    for (let i = 0; i < 3; i++) assert.deepEqual(await fetchLogin(a, WRONG), invalid);
    for (let i = 0; i < 2; i++) assert.deepEqual(await fetchLogin(b, WRONG), invalid);
    assert.deepEqual(await fetchLogin(a, PASSWORD), waiting(2));
    assert.deepEqual(await fetchLogin(b, PASSWORD), waiting(2));
    await elapse(email, 2);
    assert.equal((await fetchLogin(b, PASSWORD)).status, 200);
    // The success in one process cleared the count for the other.
    assert.deepEqual(await fetchLogin(a, WRONG), invalid);
    assert.deepEqual(await fetchLogin(a, WRONG), invalid);
    assert.equal(await failures(email), 2);
  } finally {
    await Promise.all(children.map((child) => child.stop()));
  }
});

async function startChild() {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "tests/integration/support/login-server-child.mjs"],
    {
      cwd: new URL("../..", import.meta.url),
      env: { ...process.env },
      stdio: ["pipe", "pipe", "inherit"],
    },
  );
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  for (;;) {
    const { value, done } = await lines.next();
    if (done) throw new Error("server child exited");
    if (value.startsWith("{")) {
      const { port } = JSON.parse(value);
      return {
        port,
        async stop() {
          const exited = new Promise((resolve) => child.once("exit", resolve));
          child.stdin.end("quit\n");
          await exited;
        },
      };
    }
  }
}

test("a password-reset request is answered alike for every address before any account work or mail", async () => {
  const real = await account("real");
  const sso = await account("sso");
  const unknown = await account("unknown");
  let release;
  mailGate = new Promise((resolve) => (release = resolve));
  const sent = mail.length;
  try {
    const answers = [];
    for (const email of [real, sso, unknown]) {
      const response = await app.inject({
        method: "POST",
        url: "/api/auth/forgot-password",
        payload: { email },
        remoteAddress: nextAddress(),
      });
      answers.push({ status: response.statusCode, body: response.json() });
    }
    // Answered while the mail server has not accepted anything.
    assert.equal(mail.length, sent);
    for (const answer of answers)
      assert.deepEqual(answer, {
        status: 200,
        body: { message: "If an account exists, a reset link has been sent." },
      });
  } finally {
    release();
    mailGate = Promise.resolve();
  }
  await settlePasswordResetRequests();
  const delivered = mail.slice(sent).map((message) => message.to);
  assert.deepEqual(delivered.sort(), [real, sso].sort());
  const message = mail.slice(sent).find((m) => m.to === real);
  const token = /reset-password\/([a-f0-9]{64})/.exec(message.text)?.[1];
  assert(token, "the reset link comes from the delivered message");
  const reset = await app.inject({
    method: "POST",
    url: `/api/auth/reset-password/${token}`,
    payload: { password: "Reset-password-456" },
    remoteAddress: nextAddress(),
  });
  assert.equal(reset.statusCode, 200, reset.body);
  assert.equal((await login(real, "Reset-password-456")).status, 200);
});

test("reset requests from one client address are all delivered, whether or not other addresses exist; repeats add nothing", async () => {
  const forgot = async (email, client) => {
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/forgot-password",
      payload: { email },
      remoteAddress: client,
    });
    assert.equal(response.statusCode, 200, response.body);
  };
  const delivered = async (send) => {
    let release;
    mailGate = new Promise((resolve) => (release = resolve));
    const sent = mail.length;
    try {
      await send();
    } finally {
      release();
      mailGate = Promise.resolve();
    }
    await settlePasswordResetRequests();
    return mail.slice(sent).map((message) => message.to).sort();
  };
  // Everyone behind one proxy shares its address: eight users' resets are
  // all delivered while the mail server holds every message.
  const users = [];
  for (let i = 0; i < 8; i++) users.push(await account("real"));
  assert.deepEqual(
    await delivered(() => Promise.all(users.map((email) => forgot(email, "10.71.0.1")))),
    [...users].sort(),
  );
  // The reviewer's probe: whether a third address exists must not change
  // whether the prober's own (fourth) link arrives.
  for (const kind of ["real", "unknown"]) {
    const [k1, k2, y] = [await account("real"), await account("real"), await account("real")];
    const x = await account(kind);
    const client = kind === "real" ? "10.71.1.1" : "10.71.1.2";
    const got = await delivered(async () => {
      await Promise.all([k1, k2, x].map((email) => forgot(email, client)));
      await forgot(y, client);
    });
    assert.deepEqual(got, [k1, k2, y, ...(kind === "real" ? [x] : [])].sort(), kind);
  }
  // A repeat for an address whose request is still running adds nothing.
  const repeated = await account("real");
  assert.deepEqual(
    await delivered(async () => {
      await forgot(repeated, "10.71.2.1");
      await forgot(repeated, "10.71.2.2");
    }),
    [repeated],
  );
});

test("closing the server waits for reset work in progress, and logs work it abandons at the deadline", async (t) => {
  const { logger } = await import("../../src/utils/logger.ts");
  const { setPasswordResetDrainDeadline } = await import(
    "../../src/modules/auth/auth.service.ts"
  );
  const warnings = [];
  t.mock.method(logger, "warn", (...args) => warnings.push(args));
  const closing = async (deadlineMs, releaseAfterMs) => {
    const other = await buildApp();
    await other.ready();
    const email = await account("real");
    let release;
    mailGate = new Promise((resolve) => (release = resolve));
    const sent = mail.length;
    const response = await other.inject({
      method: "POST",
      url: "/api/auth/forgot-password",
      payload: { email },
      remoteAddress: nextAddress(),
    });
    assert.equal(response.statusCode, 200);
    setPasswordResetDrainDeadline(Date.now() + deadlineMs);
    const timer = setTimeout(release, releaseAfterMs);
    const started = Date.now();
    await other.close();
    const tookMs = Date.now() - started;
    const deliveredAtClose = mail.length - sent;
    clearTimeout(timer);
    release();
    mailGate = Promise.resolve();
    await settlePasswordResetRequests();
    // The mailer follows the most recently built app; give it back.
    setPrisma(app.prisma);
    await other.prisma.$disconnect();
    return { tookMs, deliveredAtClose };
  };
  // Mail that takes longer than the old fixed 2 s budget is still delivered
  // before close returns (and before the database connection closes).
  const slow = await closing(10_000, 2_500);
  assert.ok(slow.tookMs >= 2_400, `${slow.tookMs}`);
  assert.equal(slow.deliveredAtClose, 1);
  const abandoned = () =>
    warnings.filter(([fields]) => fields?.event === "password_reset_requests_abandoned");
  assert.deepEqual(abandoned(), []);
  // Past the deadline the work is abandoned and logged with its count.
  const stuck = await closing(200, 5_000);
  assert.ok(stuck.tookMs < 2_000, `${stuck.tookMs}`);
  assert.equal(stuck.deliveredAtClose, 0);
  assert.deepEqual(
    abandoned().map(([fields]) => fields),
    [{ event: "password_reset_requests_abandoned", abandoned: 1 }],
  );
  setPasswordResetDrainDeadline(Date.now() + 5_000);
});
