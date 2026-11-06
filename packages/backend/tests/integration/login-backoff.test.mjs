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
});

const { buildApp } = await import("../../src/app.ts");
const { hashPassword } = await import("../../src/utils/passwords.ts");
const { loginSlot, loginThrottle } = await import(
  "../../src/modules/auth/login-throttle.ts"
);
const { settlePasswordResetRequests } = await import(
  "../../src/modules/auth/auth.service.ts"
);
const { resetTransporter } = await import("../../src/utils/mailer.ts");

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
    await app.prisma.loginThrottle.deleteMany({
      where: { slot: { in: [...usedSlots] } },
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

test("the tracking table holds counters only, no addresses", async () => {
  const columns = await app.prisma.$queryRaw`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'LoginThrottle'
    ORDER BY ordinal_position
  `;
  assert.deepEqual(
    columns.map((c) => c.column_name),
    ["slot", "failures", "lastFailureAt"],
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
