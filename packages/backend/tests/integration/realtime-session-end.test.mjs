import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";
import { after, before, test } from "node:test";
import jwt from "jsonwebtoken";
import { openRawSocket } from "./support/raw-websocket.mjs";

// Realtime sockets are bound to the sign-in session (refresh-token family) of
// the access token that opened them. Ending a session closes exactly its
// sockets with 4005, in the request that ends it; ending every session of an
// account closes all of them. Real TCP WebSocket clients, real HTTP handlers
// and PostgreSQL throughout.

if (!process.env.TEST_DATABASE_URL)
  throw new Error("Set TEST_DATABASE_URL to a migrated, disposable PostgreSQL database");
const JWT_SECRET = "realtime-session-end-test-jwt-secret";
Object.assign(process.env, {
  DATABASE_URL: process.env.TEST_DATABASE_URL,
  NODE_ENV: "test",
  LOG_LEVEL: "error",
  JWT_SECRET,
  COOKIE_SECRET: "realtime-session-end-test-cookie-secret",
});
const storageDir = await mkdtemp(path.join(os.tmpdir(), "werkyn-realtime-session-end-"));
process.env.STORAGE_DIR = storageDir;
const { buildApp } = await import("../../src/app.js");
const { hashPassword } = await import("../../src/utils/passwords.js");
const { hashToken } = await import("../../src/utils/tokens.js");
const authService = await import("../../src/modules/auth/auth.service.js");
const realtime = await import("../../src/modules/realtime/realtime.service.js");

const REVOKED = { code: 4005, reason: "Session revoked" };
const password = "Session-fixture-password-1";
const suffix = crypto.randomUUID().slice(0, 8);

let app, port, passwordHash;
const userIds = [];
const workspaceIds = [];
const clients = [];

before(async () => {
  app = await buildApp();
  await app.listen({ host: "127.0.0.1", port: 0 });
  port = app.server.address().port;
  passwordHash = await hashPassword(password);
});

after(async () => {
  try {
    for (const client of clients) client.socket.destroy();
    if (app) {
      await app.prisma.workspace.deleteMany({ where: { id: { in: workspaceIds } } });
      await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
    }
  } finally {
    await app?.close();
    await rm(storageDir, { recursive: true, force: true });
  }
});

// Distinct source addresses keep the per-IP rate limits (100/min overall,
// 10/min for login, 5/min for reset) out of the measurements.
let requests = 0;
function http(method, url, { token, cookie, payload } = {}) {
  const n = ++requests;
  return app.inject({
    method,
    url,
    remoteAddress: `10.91.${Math.floor(n / 250) % 250}.${(n % 250) + 1}`,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    ...(cookie ? { cookies: { refresh_token: cookie } } : {}),
    ...(payload === undefined ? {} : { payload }),
  });
}

function cookieOf(response) {
  return response.cookies.find((c) => c.name === "refresh_token" && c.value)?.value;
}

let sockets = 0;
async function rawSocket() {
  const n = ++sockets;
  const client = await openRawSocket(port, {
    localAddress: `127.91.${Math.floor(n / 250) % 250}.${(n % 250) + 1}`,
  });
  clients.push(client);
  return client;
}

async function createFixture() {
  const id = crypto.randomUUID().slice(0, 8);
  const user = async (name) => {
    const created = await app.prisma.user.create({
      data: { email: `rt-session-${name}-${id}-${suffix}@example.test`, displayName: name, emailVerified: true, passwordHash },
    });
    userIds.push(created.id);
    return created;
  };
  const owner = await user("owner");
  const other = await user("other");
  const workspace = await app.prisma.workspace.create({
    data: {
      name: `Sessions ${id}`,
      slug: `rt-session-${id}-${suffix}`,
      members: { create: [{ userId: owner.id, role: "MEMBER" }, { userId: other.id, role: "MEMBER" }] },
    },
  });
  workspaceIds.push(workspace.id);
  return { owner, other, workspace };
}

// A sign-in session as a browser holds it: the refresh cookie of a new family,
// exchanged at /api/auth/refresh for an access token of that session.
async function signIn(user) {
  const first = await authService.createRefreshSession(app.prisma, user.id);
  const response = await http("POST", "/api/auth/refresh", { cookie: first });
  assert.equal(response.statusCode, 200, response.body);
  return { first, cookie: cookieOf(response), token: response.json().data.accessToken };
}

async function connect(token, workspace) {
  const client = await rawSocket();
  client.sendJSON({ type: "auth", token });
  await client.next((m) => m.event === "authenticated");
  client.sendJSON({ type: "subscribe_workspace", workspaceId: workspace.id });
  const reply = await client.next((m) => m.event === "subscribed_workspace");
  assert.equal(reply.success, true);
  return client;
}

// Lets presence frames from the setup arrive, so the next bytes a socket
// receives belong to the action under test.
async function settle(...all) {
  await Promise.all(all.map((client) => client.drain(100)));
  for (const client of all) client.inbox.length = 0;
}

// Resolves with the time the next bytes reach this client.
function nextArrival(client) {
  return new Promise((resolve) => client.socket.once("data", () => resolve(performance.now())));
}

// Runs a session-ending request and measures when each socket's close frame
// arrives relative to the request start and to its response.
async function measureCloses(t, label, request, closing) {
  const arrivals = closing.map(nextArrival);
  const started = performance.now();
  const response = await request();
  const responded = performance.now();
  const closes = await Promise.all(closing.map((client) => client.closed(2000)));
  for (const close of closes) assert.deepEqual(close, REVOKED, `${label}: socket not closed as revoked`);
  // Every socket received its close frame, so each arrival has resolved.
  const arrived = await Promise.all(arrivals);
  for (const at of arrived) {
    // The sockets are closed before the response is written; allow for the
    // client side of this process to read both.
    assert.ok(at - responded < 1000, `${label}: close arrived ${(at - responded).toFixed(1)} ms after the response`);
  }
  t.diagnostic(
    `${label}: response ${(responded - started).toFixed(1)} ms; close frames at ${arrived
      .map((at) => `${(at - started).toFixed(1)}`)
      .join(", ")} ms after the request (${arrived.map((at) => (at - responded).toFixed(1)).join(", ")} ms after the response)`,
  );
  return response;
}

async function assertStillLive(client, workspace, label) {
  const marker = crypto.randomUUID();
  app.broadcastToWorkspace(workspace.id, "probe_workspace", { marker });
  await client.next((m) => m.event === "probe_workspace" && m.data.marker === marker, 2000).catch((error) => {
    throw new Error(`${label}: ${error.message}`);
  });
  client.sendJSON({ type: "ping" });
  await client.next((m) => m.event === "pong", 2000);
}

async function assertRefused(token, expected, label) {
  const client = await rawSocket();
  client.sendJSON({ type: "auth", token });
  assert.deepEqual(await client.closed(2000), expected, label);
  assert.equal(client.inbox.some((m) => m.event === "authenticated"), false, `${label}: authenticated`);
}

test("logout closes only that session's sockets; the user's other session and other users keep theirs", async (t) => {
  const f = await createFixture();
  const a = await signIn(f.owner);
  const b = await signIn(f.owner);
  const otherSession = await signIn(f.other);
  const a1 = await connect(a.token, f.workspace);
  const a2 = await connect(a.token, f.workspace);
  const b1 = await connect(b.token, f.workspace);
  const o1 = await connect(otherSession.token, f.workspace);
  await settle(a1, a2, b1, o1);

  const response = await measureCloses(
    t,
    "logout",
    () => http("POST", "/api/auth/logout", { token: a.token, cookie: a.cookie }),
    [a1, a2],
  );
  assert.equal(response.statusCode, 204, response.body);

  await assertStillLive(b1, f.workspace, "same user, other session");
  await assertStillLive(o1, f.workspace, "other user");
  // The ended session cannot open a socket again; the other session can.
  await assertRefused(a.token, REVOKED, "logged-out session");
  const b2 = await connect(b.token, f.workspace);
  await assertStillLive(b2, f.workspace, "new socket of the remaining session");
  // The user stays online through session B.
  assert.deepEqual(
    realtime.getOnlineUsers(f.workspace.id).map((u) => u.userId).sort(),
    [f.owner.id, f.other.id].sort(),
  );
});

test("a password change closes the sockets of every session of that user, including its own", async (t) => {
  const f = await createFixture();
  const a = await signIn(f.owner);
  const b = await signIn(f.owner);
  const otherSession = await signIn(f.other);
  const a1 = await connect(a.token, f.workspace);
  const b1 = await connect(b.token, f.workspace);
  const o1 = await connect(otherSession.token, f.workspace);
  await settle(a1, b1, o1);

  const response = await measureCloses(
    t,
    "password change",
    () =>
      http("PATCH", `/api/users/${f.owner.id}/password`, {
        token: a.token,
        payload: { currentPassword: password, newPassword: "Session-fixture-password-2" },
      }),
    [a1, b1],
  );
  assert.equal(response.statusCode, 200, response.body);
  await assertStillLive(o1, f.workspace, "other user");
  await assertRefused(a.token, REVOKED, "session A after the change");
  await assertRefused(b.token, REVOKED, "session B after the change");

  // A sign-in after the change is a new, live session.
  const login = await http("POST", "/api/auth/login", {
    payload: { email: f.owner.email, password: "Session-fixture-password-2" },
  });
  assert.equal(login.statusCode, 200, login.body);
  const fresh = await connect(login.json().data.accessToken, f.workspace);
  await assertStillLive(fresh, f.workspace, "session after the change");
});

test("a refused password change leaves every socket open", async () => {
  const f = await createFixture();
  const a = await signIn(f.owner);
  const a1 = await connect(a.token, f.workspace);
  await settle(a1);
  const response = await http("PATCH", `/api/users/${f.owner.id}/password`, {
    token: a.token,
    payload: { currentPassword: "not-the-password", newPassword: "Session-fixture-password-2" },
  });
  assert.equal(response.statusCode, 400, response.body);
  await assertStillLive(a1, f.workspace, "after a refused change");
});

test("a password reset closes the sockets of every session of that user", async (t) => {
  const f = await createFixture();
  const a = await signIn(f.owner);
  const b = await signIn(f.owner);
  const otherSession = await signIn(f.other);
  const a1 = await connect(a.token, f.workspace);
  const b1 = await connect(b.token, f.workspace);
  const o1 = await connect(otherSession.token, f.workspace);
  await settle(a1, b1, o1);
  const resetToken = crypto.randomBytes(32).toString("hex");
  await app.prisma.passwordResetToken.create({
    data: { userId: f.owner.id, token: resetToken, expiresAt: new Date(Date.now() + 60 * 60 * 1000) },
  });

  const response = await measureCloses(
    t,
    "password reset",
    () => http("POST", `/api/auth/reset-password/${resetToken}`, { payload: { password: "Session-fixture-password-3" } }),
    [a1, b1],
  );
  assert.equal(response.statusCode, 200, response.body);
  await assertStillLive(o1, f.workspace, "other user");
  await assertRefused(b.token, REVOKED, "session B after the reset");
});

test("a password login ends the account's other sessions and their sockets, not its own", async (t) => {
  const f = await createFixture();
  const a = await signIn(f.owner);
  const b = await signIn(f.owner);
  const otherSession = await signIn(f.other);
  const a1 = await connect(a.token, f.workspace);
  const b1 = await connect(b.token, f.workspace);
  const o1 = await connect(otherSession.token, f.workspace);
  await settle(a1, b1, o1);

  const login = await measureCloses(
    t,
    "password login elsewhere",
    () => http("POST", "/api/auth/login", { payload: { email: f.owner.email, password } }),
    [a1, b1],
  );
  assert.equal(login.statusCode, 200, login.body);
  const fresh = await connect(login.json().data.accessToken, f.workspace);
  await assertStillLive(fresh, f.workspace, "the new session");
  await assertStillLive(o1, f.workspace, "other user");
});

test("refresh-token reuse ends that session's sockets and leaves the user's other session", async (t) => {
  const f = await createFixture();
  const a = await signIn(f.owner);
  const b = await signIn(f.owner);
  const a1 = await connect(a.token, f.workspace);
  const b1 = await connect(b.token, f.workspace);
  await settle(a1, b1);
  // A's first cookie was rotated by signIn; presented again after the grace
  // window it is reuse of a stolen or replayed token.
  await app.prisma.rotatedRefreshToken.update({
    where: { tokenHash: hashToken(a.first) },
    data: { rotatedAt: new Date(Date.now() - authService.REFRESH_REUSE_GRACE_MS - 1000) },
  });

  const response = await measureCloses(t, "refresh reuse", () => http("POST", "/api/auth/refresh", { cookie: a.first }), [a1]);
  assert.equal(response.statusCode, 401, response.body);
  await assertStillLive(b1, f.workspace, "same user, other session");
  // The family is revoked: its current cookie no longer refreshes either.
  assert.equal((await http("POST", "/api/auth/refresh", { cookie: a.cookie })).statusCode, 401);
});

test("tokens without a live session cannot open a socket; tokens without a session claim still work over HTTP", async () => {
  const f = await createFixture();
  // Issued before access tokens named their session: realtime asks the client
  // to refresh (4004); HTTP accepts it until it expires, as before.
  const legacy = jwt.sign({ sub: f.owner.id, email: f.owner.email }, JWT_SECRET, { expiresIn: "15m" });
  await assertRefused(legacy, { code: 4004, reason: "Session expired" }, "token without sid");
  assert.equal((await http("GET", "/api/users/me", { token: legacy })).statusCode, 200);

  const sign = (sid) => jwt.sign({ sub: f.owner.id, email: f.owner.email, sid }, JWT_SECRET, { expiresIn: "15m" });
  await assertRefused(sign(crypto.randomUUID()), REVOKED, "unknown session");
  const foreign = await authService.startRefreshSession(app.prisma, f.other.id);
  await assertRefused(sign(foreign.familyId), REVOKED, "another user's session");
  await assertRefused(sign(""), { code: 4004, reason: "Session expired" }, "empty sid");

  // Deleting an account deletes its sessions, so its tokens open nothing.
  const own = await authService.startRefreshSession(app.prisma, f.owner.id);
  await app.prisma.user.delete({ where: { id: f.owner.id } });
  await assertRefused(sign(own.familyId), REVOKED, "deleted account");
});

test("an authentication whose session lookup raced a logout is refused", async () => {
  const f = await createFixture();
  const a = await signIn(f.owner);
  const stub = {
    OPEN: 1,
    CONNECTING: 0,
    readyState: 1,
    sent: [],
    closedWith: null,
    send(message) {
      this.sent.push(JSON.parse(message));
    },
    close(code, reason) {
      this.closedWith = { code, reason };
      this.readyState = 3;
    },
  };
  // The session lookup completes before the logout commits and is held until
  // the logout has responded; everything else uses the real client.
  let release;
  const held = new Promise((resolve) => (release = resolve));
  let lookedUp;
  const lookup = new Promise((resolve) => (lookedUp = resolve));
  const gated = new Proxy(app.prisma, {
    get(target, property) {
      if (property !== "refreshTokenFamily") return Reflect.get(target, property);
      return {
        findFirst: async (args) => {
          const result = await target.refreshTokenFamily.findFirst(args);
          lookedUp(result);
          await held;
          return result;
        },
      };
    },
  });
  const pending = realtime.authenticate(stub, a.token, gated);
  try {
    const NO_LOOKUP = Symbol("no session lookup");
    const seen = await Promise.race([lookup, sleep(2000).then(() => NO_LOOKUP)]);
    assert.notEqual(seen, NO_LOOKUP, "authentication never looked the session up");
    assert.ok(seen?.id, "the lookup saw the live session");

    const out = await http("POST", "/api/auth/logout", { token: a.token, cookie: a.cookie });
    assert.equal(out.statusCode, 204, out.body);
    release();

    assert.equal(await pending, null, "a socket was registered on the ended session");
    assert.deepEqual(stub.closedWith, REVOKED);
    app.broadcastToUser(f.owner.id, "probe_user", { content: "after logout" });
    assert.deepEqual(stub.sent, []);
  } finally {
    release();
    await pending;
    realtime.cleanup(stub);
  }
});

test("logouts racing socket authentications never leave a live socket on the ended session", async (t) => {
  const f = await createFixture();
  const observer = await connect((await signIn(f.other)).token, f.workspace);
  const outcomes = { closedAfterAuthentication: 0, refusedAtAuthentication: 0 };
  const ITERATIONS = 30;
  for (let i = 0; i < ITERATIONS; i++) {
    const session = await signIn(f.owner);
    const client = await rawSocket();
    // The logout starts first; the auth frame follows after 0–14 ms, so the
    // session lookup lands before, during and after the revocation commits.
    const logout = http("POST", "/api/auth/logout", { token: session.token, cookie: session.cookie });
    await sleep(i % 15);
    client.sendJSON({ type: "auth", token: session.token });
    assert.equal((await logout).statusCode, 204);

    const closed = await client.closed(2000);
    assert.deepEqual(closed, REVOKED, `iteration ${i}: socket left open on the ended session`);
    if (client.inbox.some((m) => m.event === "authenticated")) outcomes.closedAfterAuthentication++;
    else outcomes.refusedAtAuthentication++;
  }
  // The other user's socket kept working throughout.
  await assertStillLive(observer, f.workspace, "other user");
  t.diagnostic(`outcomes over ${ITERATIONS} races: ${JSON.stringify(outcomes)}`);
});
