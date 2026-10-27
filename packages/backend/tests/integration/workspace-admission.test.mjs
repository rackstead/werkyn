import assert from "node:assert/strict";
import crypto from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { after, before, beforeEach, test } from "node:test";
import nodemailer from "nodemailer";

if (!process.env.TEST_DATABASE_URL)
  throw new Error(
    "Set TEST_DATABASE_URL to a migrated, disposable PostgreSQL database",
  );
// At most four admissions/participants wait on PostgreSQL locks at once. Six
// application connections leave room for their non-transactional reads. The
// lock holder and pg_stat_activity observer use a separate two-connection pool
// so blocked actors can never starve the control that must release them.
const REQUIRED_ACTOR_CONNECTIONS = 6;
const actorDatabaseUrl = new URL(process.env.TEST_DATABASE_URL);
const requestedActorLimit =
  actorDatabaseUrl.searchParams.get("connection_limit");
const actorConnections =
  requestedActorLimit === null
    ? REQUIRED_ACTOR_CONNECTIONS
    : Number(requestedActorLimit);
assert(
  actorConnections >= REQUIRED_ACTOR_CONNECTIONS,
  `Workspace admission fixture requires connection_limit>=${REQUIRED_ACTOR_CONNECTIONS}`,
);
actorDatabaseUrl.searchParams.set("connection_limit", String(actorConnections));
const controlDatabaseUrl = new URL(actorDatabaseUrl);
controlDatabaseUrl.searchParams.set("connection_limit", "2");
process.env.DATABASE_URL = actorDatabaseUrl.toString();
console.info("Workspace admission fixture connection budget", {
  requestedActorLimit,
  actorConnections,
  controlConnections: 2,
  totalConnections: actorConnections + 2,
});
process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";
process.env.JWT_SECRET = "workspace-admission-jwt-secret";
process.env.COOKIE_SECRET = "workspace-admission-cookie-secret";
process.env.FRONTEND_URL = "https://werkyn.example.test";
process.env.SMTP_HOST = "127.0.0.1";
process.env.SMTP_PORT = "1";
process.env.SMTP_USER = "";
process.env.SMTP_PASS = "";
process.env.SMTP_SECURE = "false";

const { PrismaClient } = await import("@prisma/client");
const { buildApp } = await import("../../src/app.ts");
const { signAccessToken } = await import("../../src/utils/tokens.ts");
const { resetTransporter } = await import("../../src/utils/mailer.ts");

const suffix = crypto.randomBytes(5).toString("hex");
const baseDomain = `adm-${suffix}.example.test`;
const allowedDomain = `allowed-${suffix}.example.test`;
const otherDomain = `other-${suffix}.example.test`;
const password = "Fixture-password-123";
const sent = [];
const mailHosts = [];
const originalTransport = nodemailer.createTransport;
const originalTestAccount = nodemailer.createTestAccount;
let app, control;
let counter = 0;
let address = 0;

// No network mail: even a regression falling back to Ethereal fails locally.
nodemailer.createTestAccount = async () => {
  throw new Error("External mail is forbidden in admission fixtures");
};
nodemailer.createTransport = (options) => {
  mailHosts.push(options.host);
  assert.equal(options.host, "127.0.0.1");
  return {
    async sendMail(message) {
      sent.push(message);
      return {};
    },
  };
};

before(async () => {
  control = new PrismaClient({
    datasources: { db: { url: controlDatabaseUrl.toString() } },
  });
  await control.$connect();
  app = await buildApp();
  await app.ready();
  // Registration in this file must create ordinary accounts, never bootstrap.
  await makeUser({ name: "existing" });
});

beforeEach(() => {
  sent.length = 0;
  resetTransporter();
});

after(async () => {
  try {
    await control.$executeRawUnsafe(
      `DROP FUNCTION IF EXISTS admission_fail_${suffix}() CASCADE`,
    );
    await app.prisma.workspace.deleteMany({
      where: { slug: { contains: suffix } },
    });
    await app.prisma.user.deleteMany({
      where: { email: { contains: suffix } },
    });
  } finally {
    nodemailer.createTransport = originalTransport;
    nodemailer.createTestAccount = originalTestAccount;
    resetTransporter();
    const closed = await Promise.allSettled([
      app?.close(),
      control?.$disconnect(),
    ]);
    for (const result of closed)
      if (result.status === "rejected") throw result.reason;
  }
  assert(
    mailHosts.every((host) => host === "127.0.0.1"),
    "only the local mail stub may be used",
  );
});

// ─── Fixtures ──────────────────────────────────────────────

function emailFor(name, domain = baseDomain) {
  return `${name}-${++counter}@${domain}`;
}

async function makeUser({
  name = "user",
  domain = baseDomain,
  verified = true,
} = {}) {
  const user = await app.prisma.user.create({
    data: {
      email: emailFor(name, domain),
      displayName: name,
      emailVerified: verified,
    },
  });
  return { ...user, token: signAccessToken({ sub: user.id, email: user.email }) };
}

async function makeWorkspace({ settings, members = [] } = {}) {
  const admin = await makeUser({ name: "admin" });
  const workspace = await app.prisma.workspace.create({
    data: {
      name: `Admission ${counter}`,
      slug: `adm-${suffix}-${++counter}`,
      members: {
        create: [
          { userId: admin.id, role: "ADMIN" },
          ...members.map(([user, role]) => ({ userId: user.id, role })),
        ],
      },
    },
  });
  if (settings)
    await app.prisma.workspaceSettings.create({
      data: { workspaceId: workspace.id, ...settings },
    });
  return { workspace, admin };
}

function makeInvite(workspace, data = {}) {
  return app.prisma.workspaceInvite.create({
    data: {
      workspaceId: workspace.id,
      token: crypto.randomBytes(32).toString("hex"),
      role: "MEMBER",
      ...data,
    },
  });
}

function inject(method, url, { token, payload } = {}) {
  address++;
  return app.inject({
    method,
    url,
    payload,
    // Distinct client addresses keep per-route rate limits out of the matrix.
    remoteAddress: `10.${(address >> 16) & 255}.${(address >> 8) & 255}.${address & 255}`,
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

function register(email, inviteToken) {
  return inject("POST", "/api/auth/register", {
    payload: {
      email,
      password,
      displayName: "Applicant",
      ...(inviteToken === undefined ? {} : { inviteToken }),
    },
  });
}

function accept(user, invite) {
  return inject("POST", `/api/invites/${invite.token}/accept`, {
    token: user.token,
  });
}

function requestsPath(workspace) {
  return `/api/workspaces/${workspace.id}/admission-requests`;
}

function approve(actor, workspace, requestId) {
  return inject("POST", `${requestsPath(workspace)}/${requestId}/approve`, {
    token: actor.token,
  });
}

function reject(actor, workspace, requestId) {
  return inject("POST", `${requestsPath(workspace)}/${requestId}/reject`, {
    token: actor.token,
  });
}

function registeredUser(response) {
  const { user, accessToken } = response.json().data;
  return { ...user, token: accessToken };
}

async function state(workspace, invite) {
  const [members, requests, currentInvite] = await Promise.all([
    app.prisma.workspaceMember.findMany({
      where: { workspaceId: workspace.id },
      orderBy: { joinedAt: "asc" },
    }),
    // The model test below fails explicitly if the pending model is absent;
    // this fallback keeps pre-migration failures focused on admission effects.
    app.prisma.workspaceAdmissionRequest?.findMany({
      where: { workspaceId: workspace.id },
      orderBy: { createdAt: "asc" },
    }) ?? [],
    invite
      ? app.prisma.workspaceInvite.findUnique({ where: { id: invite.id } })
      : null,
  ]);
  return { members, requests, invite: currentInvite };
}

function member(snapshot, user) {
  return snapshot.members.find((m) => m.userId === user.id);
}

function verificationUrls() {
  return sent.map((message) => {
    const match = message.text.match(/https:\/\/werkyn\.example\.test\S+/);
    assert(match, "verification mail contains its link");
    return new URL(match[0]);
  });
}

async function assertNoWorkspaceAccess(user, workspace) {
  const read = await inject("GET", `/api/workspaces/${workspace.id}`, {
    token: user.token,
  });
  assert.equal(read.statusCode, 403, read.body);
  const list = await inject("GET", "/api/workspaces", { token: user.token });
  assert.equal(list.statusCode, 200, list.body);
  assert(!list.json().data.some((w) => w.id === workspace.id));
}

async function subscribeWorkspace(user, workspace) {
  const socket = await app.injectWS("/api/ws");
  const messages = [];
  const waiters = [];
  socket.on("message", (raw) => {
    const message = JSON.parse(raw.toString());
    const waiter = waiters.findIndex((w) => w.event === message.event);
    if (waiter >= 0) waiters.splice(waiter, 1)[0].resolve(message);
    else messages.push(message);
  });
  const next = (event) => {
    const index = messages.findIndex((m) => m.event === event);
    if (index >= 0) return Promise.resolve(messages.splice(index, 1)[0]);
    let timer;
    return Promise.race([
      new Promise((resolve) => waiters.push({ event, resolve })),
      new Promise((_, rejectWait) => {
        timer = setTimeout(
          () => rejectWait(new Error(`No ${event} websocket event`)),
          3000,
        );
      }),
    ]).finally(() => clearTimeout(timer));
  };
  try {
    socket.send(JSON.stringify({ type: "auth", token: user.token }));
    await next("authenticated");
    socket.send(
      JSON.stringify({ type: "subscribe_workspace", workspaceId: workspace.id }),
    );
    return (await next("subscribed_workspace")).success;
  } finally {
    socket.terminate();
  }
}

// ─── Real PostgreSQL lock barriers ─────────────────────────

let holderPid = null;

// Counts application backends waiting on PostgreSQL locks. `behindActors`
// requires waiters whose blockers exclude the control holder: they queue behind
// a lock held by another application transaction, not behind the fixture.
async function waitForLockWaiters(expected, { behindActors = 0 } = {}) {
  const deadline = performance.now() + 5000;
  let observed = { total: 0, queued: 0 };
  while (performance.now() < deadline) {
    const [row] = await control.$queryRaw`
      SELECT count(*)::int AS total,
        count(*) FILTER (
          WHERE NOT (${holderPid}::int = ANY (pg_blocking_pids(pid)))
        )::int AS queued
      FROM pg_stat_activity
      WHERE datname = current_database() AND backend_type = 'client backend'
        AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()
        AND pid <> ${holderPid}::int
    `;
    observed = row;
    if (row.total >= expected && row.queued >= behindActors) return row;
    await sleep(10);
  }
  assert.fail(
    `Expected ${expected} real PostgreSQL lock waiters (${behindActors} behind actors), observed ${observed.total} (${observed.queued})`,
  );
}

// The control transaction takes a real lock, starts every actor, observes them
// waiting in PostgreSQL, then commits. Cleanup always releases the holder and
// awaits every actor before the caller inspects state or removes fixtures.
async function whileLocked(lock, startActors, { waiters, beforeRelease } = {}) {
  let unlock, locked;
  const unlocked = new Promise((resolve) => {
    unlock = resolve;
  });
  const ready = new Promise((resolve) => {
    locked = resolve;
  });
  const holder = control.$transaction(
    async (tx) => {
      [{ pid: holderPid }] = await tx.$queryRaw`SELECT pg_backend_pid() AS pid`;
      await lock(tx);
      locked();
      await unlocked;
    },
    { timeout: 10_000, maxWait: 2_000 },
  );
  let running = [];
  try {
    await Promise.race([
      ready,
      holder.then(() => {
        throw new Error("Control transaction ended before its lock was ready");
      }),
    ]);
    running = startActors().map((pending) => Promise.resolve(pending));
    await waitForLockWaiters(waiters ?? running.length);
    if (beforeRelease) await beforeRelease();
  } finally {
    unlock();
    await Promise.allSettled([holder, ...running]);
    holderPid = null;
  }
  await holder;
  return Promise.all(running);
}

function workspaceRowLock(workspace, change) {
  return async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Workspace" WHERE id = ${workspace.id} FOR UPDATE`;
    if (change) await change(tx);
  };
}

// Membership INSERTs wait while reads continue, so an admission pauses after
// all of its authorization reads and immediately before committing a member.
async function memberInsertLock(tx) {
  await tx.$executeRawUnsafe(
    'LOCK TABLE "WorkspaceMember" IN SHARE ROW EXCLUSIVE MODE',
  );
}

async function withMemberInsertFailure(column, value, run) {
  assert.match(value, /^[a-z0-9]+$/);
  const name = `admission_fail_${suffix}`;
  await control.$executeRawUnsafe(
    `CREATE OR REPLACE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced membership insert failure'; END $$`,
  );
  await control.$executeRawUnsafe(
    `CREATE TRIGGER ${name} BEFORE INSERT ON "WorkspaceMember" FOR EACH ROW WHEN (NEW."${column}" = '${value}') EXECUTE FUNCTION ${name}()`,
  );
  try {
    return await run();
  } finally {
    await control.$executeRawUnsafe(
      `DROP TRIGGER IF EXISTS ${name} ON "WorkspaceMember"`,
    );
  }
}

test("the pending admission model is migrated with invite/workspace agreement", async () => {
  const [table] = await control.$queryRaw`
    SELECT to_regclass('"WorkspaceAdmissionRequest"')::text AS name
  `;
  assert.equal(table.name, '"WorkspaceAdmissionRequest"');
  const { workspace } = await makeWorkspace();
  const { workspace: other } = await makeWorkspace();
  const invite = await makeInvite(other);
  const user = await makeUser({ name: "mismatch" });
  // A request can never pair one workspace with another workspace's invite.
  await assert.rejects(
    control.$executeRaw`
      INSERT INTO "WorkspaceAdmissionRequest" (id, "workspaceId", "inviteId", "userId")
      VALUES (${`mismatch-${suffix}`}, ${workspace.id}, ${invite.id}, ${user.id})
    `,
    /foreign key|violates/i,
  );
});

// ─── Registration with an invitation ───────────────────────

for (const role of ["ADMIN", "MEMBER", "VIEWER"]) {
  test(`registration with an unrestricted ${role} invite joins once with the invitation role`, async () => {
    const { workspace } = await makeWorkspace(
      role === "ADMIN" ? {} : { settings: { defaultRole: "ADMIN" } },
    );
    const invite = await makeInvite(workspace, { role, maxUses: 2 });
    const response = await register(emailFor("open"), invite.token);
    assert.equal(response.statusCode, 201, response.body);
    const body = response.json().data;
    assert.equal(body.admission?.status, "joined");
    assert.equal(body.admission.workspace.id, workspace.id);
    assert.equal(body.user.emailVerified, false);
    assert.deepEqual(
      body.workspaces.map((w) => [w.workspaceId, w.role]),
      [[workspace.id, role]],
    );
    const after = await state(workspace, invite);
    assert.equal(member(after, body.user).role, role);
    assert.equal(after.invite.useCount, 1);
    assert.equal(after.requests.length, 0);
    assert.equal(sent.length, 1);
    assert.equal(verificationUrls()[0].searchParams.get("invite"), null);
  });
}

for (const [name, setup, reason] of [
  ["invites disabled after issuance", { settings: { invitesEnabled: false } }, "disabled"],
  ["a different allowed domain", { settings: { allowedEmailDomains: [allowedDomain] } }, "domain_not_allowed"],
  ["an invite for another email", { invite: { email: `someone@${baseDomain}` } }, "email_mismatch"],
  ["a full workspace", { settings: { maxMembers: 1 } }, "member_limit"],
  ["a legacy zero member cap", { settings: { maxMembers: 0 } }, "member_limit"],
  ["an expired invite", { invite: { expiresAt: new Date(Date.now() - 1000) } }, "expired"],
  ["an exhausted invite", { invite: { maxUses: 1, useCount: 1 } }, "exhausted"],
  ["a legacy zero-use invite", { invite: { maxUses: 0 } }, "exhausted"],
  ["an unknown invite", { unknown: true }, "not_found"],
]) {
  test(`registration with ${name} keeps the account but grants nothing`, async () => {
    const { workspace } = await makeWorkspace({ settings: setup.settings });
    const invite = await makeInvite(workspace, setup.invite);
    const token = setup.unknown ? crypto.randomBytes(32).toString("hex") : invite.token;
    const email = emailFor("denied", otherDomain);
    const response = await register(email, token);
    assert.equal(response.statusCode, 201, response.body);
    const after = await state(workspace, invite);
    assert.equal(after.members.length, 1, "denied registration created no membership");
    assert.equal(after.requests.length, 0);
    assert.equal(after.invite.useCount, invite.useCount);
    const body = response.json().data;
    assert.deepEqual(body.workspaces, []);
    assert.equal(body.admission?.status, "denied");
    assert.equal(body.admission.reason, reason);
    assert.equal(typeof body.admission.message, "string");
    const stored = await app.prisma.user.findUniqueOrThrow({
      where: { email },
      include: { authProviders: true, refreshTokens: true },
    });
    assert.equal(stored.authProviders.length, 1);
    assert.equal(stored.refreshTokens.length, 1);
    await assertNoWorkspaceAccess(registeredUser(response), workspace);
    assert.equal(sent.length, 1);
    assert.equal(verificationUrls()[0].searchParams.get("invite"), null);
  });
}

for (const restriction of ["domain", "email"]) {
  test(`registration for an ${restriction}-restricted invite proves mailbox control before joining`, async () => {
    const email = emailFor("restricted", allowedDomain);
    const { workspace } = await makeWorkspace(
      restriction === "domain"
        ? // Legacy rows may contain case, whitespace or a leading @.
          { settings: { allowedEmailDomains: [` @${allowedDomain.toUpperCase()} `] } }
        : {},
    );
    const invite = await makeInvite(workspace, {
      role: "VIEWER",
      maxUses: 1,
      ...(restriction === "email" ? { email: email.toUpperCase() } : {}),
    });
    const response = await register(email, invite.token);
    assert.equal(response.statusCode, 201, response.body);
    const applicant = registeredUser(response);
    let current = await state(workspace, invite);
    assert.equal(current.members.length, 1, "unproven mailbox created no membership");
    assert.equal(current.requests.length, 0);
    assert.equal(current.invite.useCount, 0);
    assert.deepEqual(response.json().data.workspaces, []);
    assert.equal(response.json().data.admission?.status, "verification_required");
    const [firstLink] = verificationUrls();
    assert.equal(firstLink.searchParams.get("invite"), invite.token);
    assert.match(firstLink.pathname, /^\/verify-email\/[0-9a-f]+$/);

    const early = await accept(applicant, invite);
    assert.equal(early.statusCode, 202, early.body);
    assert.equal(early.json().data.status, "verification_required");
    await assertNoWorkspaceAccess(applicant, workspace);

    sent.length = 0;
    const resent = await inject("POST", "/api/auth/resend-verification", {
      token: applicant.token,
      payload: { inviteToken: invite.token },
    });
    assert.equal(resent.statusCode, 200, resent.body);
    const bogus = await inject("POST", "/api/auth/resend-verification", {
      token: applicant.token,
      payload: { inviteToken: "not-a-current-invite" },
    });
    assert.equal(bogus.statusCode, 200, bogus.body);
    const [withInvite, withoutInvite] = verificationUrls();
    assert.equal(withInvite.searchParams.get("invite"), invite.token);
    assert.equal(withoutInvite.searchParams.get("invite"), null);

    const verified = await inject(
      "POST",
      `/api/auth/verify-email/${withoutInvite.pathname.split("/").pop()}`,
    );
    assert.equal(verified.statusCode, 200, verified.body);
    const joined = await accept(applicant, invite);
    assert.equal(joined.statusCode, 200, joined.body);
    assert.equal(joined.json().data.status, "joined");
    assert.equal(joined.json().data.role, "VIEWER");
    assert.equal(joined.json().data.userId, applicant.id);
    const again = await accept(applicant, invite);
    assert.equal(again.statusCode, 200, again.body);
    assert.equal(again.json().data.alreadyMember, true);
    current = await state(workspace, invite);
    assert.equal(member(current, applicant).role, "VIEWER");
    assert.equal(current.invite.useCount, 1);
  });
}

test("registration under required approval creates one pending request that grants nothing", async () => {
  const { workspace, admin } = await makeWorkspace({
    settings: { requireAdminApproval: true },
  });
  const invite = await makeInvite(workspace, { role: "VIEWER", maxUses: 1 });
  const response = await register(emailFor("approval"), invite.token);
  assert.equal(response.statusCode, 201, response.body);
  const applicant = registeredUser(response);
  let current = await state(workspace, invite);
  assert.equal(current.members.length, 1, "approval-required registration created no membership");
  assert.equal(current.invite.useCount, 0);
  const admission = response.json().data.admission;
  assert.equal(admission?.status, "approval_pending");
  assert.deepEqual(
    current.requests.map((r) => [r.id, r.userId, r.inviteId]),
    [[admission.requestId, applicant.id, invite.id]],
  );
  await assertNoWorkspaceAccess(applicant, workspace);
  assert.equal(await subscribeWorkspace(applicant, workspace), false);
  const queue = await inject("GET", requestsPath(workspace), {
    token: applicant.token,
  });
  assert.equal(queue.statusCode, 403, queue.body);

  const approved = await approve(admin, workspace, admission.requestId);
  assert.equal(approved.statusCode, 200, approved.body);
  current = await state(workspace, invite);
  assert.equal(member(current, applicant).role, "VIEWER");
  assert.equal(current.invite.useCount, 1);
  assert.equal(current.requests.length, 0);
  assert.equal(await subscribeWorkspace(applicant, workspace), true);
});

// ─── Authenticated acceptance ──────────────────────────────

test("a verified account joins with the invitation role and receives its own memberships", async () => {
  const { workspace } = await makeWorkspace({
    settings: { defaultRole: "VIEWER" },
  });
  const invite = await makeInvite(workspace, { role: "ADMIN" });
  const user = await makeUser({ name: "joiner" });
  const response = await accept(user, invite);
  assert.equal(response.statusCode, 200, response.body);
  const data = response.json().data;
  assert.equal(data.status, "joined");
  assert.equal(data.alreadyMember, false);
  assert.equal(data.userId, user.id);
  assert.equal(data.workspace.slug, workspace.slug);
  assert.deepEqual(
    data.workspaces.map((w) => [w.workspace.slug, w.role]),
    [[workspace.slug, "ADMIN"]],
  );
  const current = await state(workspace, invite);
  assert.equal(member(current, user).role, "ADMIN");
  assert.equal(current.invite.useCount, 1);
});

test("an unverified account keeps unrestricted open-invite compatibility", async () => {
  const { workspace } = await makeWorkspace();
  const invite = await makeInvite(workspace);
  const user = await makeUser({ name: "unverified", verified: false });
  const response = await accept(user, invite);
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().data.status, "joined");
  assert.equal((await state(workspace, invite)).invite.useCount, 1);
});

test("an existing member's retry never changes the role or consumes a use", async () => {
  const user = await makeUser({ name: "existing-member" });
  const { workspace } = await makeWorkspace({ members: [[user, "VIEWER"]] });
  const invite = await makeInvite(workspace, { role: "ADMIN", maxUses: 1 });
  const response = await accept(user, invite);
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().data.status, "joined");
  assert.equal(response.json().data.alreadyMember, true);
  assert.equal(response.json().data.role, "VIEWER");
  const current = await state(workspace, invite);
  assert.equal(member(current, user).role, "VIEWER");
  assert.equal(current.invite.useCount, 0);
});

for (const [name, setup, status] of [
  ["invites are disabled", { settings: { invitesEnabled: false } }, 403],
  ["the domain is not allowed", { settings: { allowedEmailDomains: [allowedDomain] } }, 403],
  ["the invite names another email", { invite: { email: `someone@${baseDomain}` } }, 403],
  ["the workspace is full", { settings: { maxMembers: 1 } }, 403],
  ["a legacy zero cap is configured", { settings: { maxMembers: 0 } }, 403],
  ["the invite expired", { invite: { expiresAt: new Date(Date.now() - 1000) } }, 410],
  ["the invite expires exactly now", { invite: { expiresAt: new Date() } }, 410],
  ["the invite is exhausted", { invite: { maxUses: 2, useCount: 2 } }, 410],
  ["a legacy zero-use invite", { invite: { maxUses: 0 } }, 410],
  ["the invite was revoked", { revoked: true }, 404],
]) {
  test(`acceptance is denied without side effects when ${name}`, async () => {
    const { workspace } = await makeWorkspace({ settings: setup.settings });
    const invite = await makeInvite(workspace, setup.invite);
    if (setup.revoked)
      await app.prisma.workspaceInvite.delete({ where: { id: invite.id } });
    const user = await makeUser({ name: "denied", domain: otherDomain });
    const response = await accept(user, invite);
    assert.equal(response.statusCode, status, response.body);
    const current = await state(workspace, invite);
    assert.equal(current.members.length, 1);
    assert.equal(current.requests.length, 0);
    if (!setup.revoked) assert.equal(current.invite.useCount, invite.useCount);
    await assertNoWorkspaceAccess(user, workspace);
  });
}

test("restricted acceptance distinguishes unverified local accounts from trusted verified profiles", async () => {
  const { workspace } = await makeWorkspace({
    settings: { allowedEmailDomains: [allowedDomain.toUpperCase()] },
  });
  const invite = await makeInvite(workspace, { role: "VIEWER" });
  const unverified = await makeUser({
    name: "Unverified",
    domain: allowedDomain,
    verified: false,
  });
  const pending = await accept(unverified, invite);
  assert.equal(pending.statusCode, 202, pending.body);
  assert.equal(pending.json().data.status, "verification_required");
  assert.equal((await state(workspace, invite)).invite.useCount, 0);
  // An OIDC account has no password and arrives with a verified address.
  const oidc = await makeUser({ name: "oidc", domain: allowedDomain });
  await app.prisma.authProvider.create({
    data: { userId: oidc.id, provider: "oidc", providerSub: `sub-${oidc.id}`, email: oidc.email },
  });
  const joined = await accept(oidc, invite);
  assert.equal(joined.statusCode, 200, joined.body);
  await app.prisma.user.update({
    where: { id: unverified.id },
    data: { emailVerified: true },
  });
  const later = await accept(unverified, invite);
  assert.equal(later.statusCode, 200, later.body);
  const current = await state(workspace, invite);
  assert.equal(current.members.length, 3);
  assert.equal(current.invite.useCount, 2);
});

test("required approval deduplicates pending requests and a later policy change admits through the same gate", async () => {
  const { workspace, admin } = await makeWorkspace({
    settings: { requireAdminApproval: true },
  });
  const first = await makeInvite(workspace, { role: "VIEWER" });
  const second = await makeInvite(workspace, { role: "MEMBER", maxUses: 1 });
  const user = await makeUser({ name: "requester" });
  const one = await accept(user, first);
  const two = await accept(user, first);
  assert.equal(one.statusCode, 202, one.body);
  assert.equal(one.json().data.status, "approval_pending");
  assert.equal(two.json().data.requestId, one.json().data.requestId);
  let current = await state(workspace, first);
  assert.equal(current.requests.length, 1);
  assert.equal(current.invite.useCount, 0);
  const switched = await accept(user, second);
  assert.equal(switched.json().data.requestId, one.json().data.requestId);
  current = await state(workspace, second);
  assert.deepEqual(
    current.requests.map((r) => r.inviteId),
    [second.id],
  );
  assert.equal(await subscribeWorkspace(user, workspace), false);
  const disabled = await inject("PATCH", `/api/workspaces/${workspace.id}/settings`, {
    token: admin.token,
    payload: { requireAdminApproval: false },
  });
  assert.equal(disabled.statusCode, 200, disabled.body);
  const joined = await accept(user, second);
  assert.equal(joined.statusCode, 200, joined.body);
  current = await state(workspace, second);
  assert.equal(member(current, user).role, "MEMBER");
  assert.equal(current.invite.useCount, 1);
  assert.equal(current.requests.length, 0);
});

test("settings PATCH normalizes allowed domains and rejects blank entries", async () => {
  const { workspace, admin } = await makeWorkspace();
  const path = `/api/workspaces/${workspace.id}/settings`;
  const saved = await inject("PATCH", path, {
    token: admin.token,
    payload: {
      allowedEmailDomains: [` @${allowedDomain.toUpperCase()} `, allowedDomain],
    },
  });
  assert.equal(saved.statusCode, 200, saved.body);
  assert.deepEqual(saved.json().data.allowedEmailDomains, [allowedDomain]);
  const blank = await inject("PATCH", path, {
    token: admin.token,
    payload: { allowedEmailDomains: ["   "] },
  });
  assert.equal(blank.statusCode, 400, blank.body);
  const stored = await app.prisma.workspaceSettings.findUniqueOrThrow({
    where: { workspaceId: workspace.id },
  });
  assert.deepEqual(stored.allowedEmailDomains, [allowedDomain]);
});

// ─── Administrator review queue ────────────────────────────

async function pendingRequest({ settings = {}, invite: inviteData = {}, user: userData = {} } = {}) {
  const fixture = await makeWorkspace({
    settings: { requireAdminApproval: true, ...settings },
  });
  const invite = await makeInvite(fixture.workspace, { role: "VIEWER", ...inviteData });
  const applicant = await makeUser({ name: "applicant", ...userData });
  const response = await accept(applicant, invite);
  assert.equal(response.statusCode, 202, response.body);
  assert.equal(response.json().data.status, "approval_pending");
  return { ...fixture, invite, applicant, requestId: response.json().data.requestId };
}

test("the review queue is scoped to workspace administrators and foreign ids are denied without mutation", async () => {
  const a = await pendingRequest();
  const b = await pendingRequest();
  const peer = await makeUser({ name: "peer" });
  await app.prisma.workspaceMember.create({
    data: { userId: peer.id, workspaceId: a.workspace.id, role: "MEMBER" },
  });
  const list = await inject("GET", requestsPath(a.workspace), { token: a.admin.token });
  assert.equal(list.statusCode, 200, list.body);
  assert.deepEqual(
    list.json().data.map((r) => [r.id, r.user.id, r.user.email, r.invite.id, r.invite.role]),
    [[a.requestId, a.applicant.id, a.applicant.email, a.invite.id, "VIEWER"]],
  );
  for (const actor of [peer, a.applicant, b.admin]) {
    const denied = await inject("GET", requestsPath(a.workspace), { token: actor.token });
    assert.equal(denied.statusCode, 403, denied.body);
  }
  for (const decide of [approve, reject]) {
    const foreign = await decide(b.admin, b.workspace, a.requestId);
    assert.equal(foreign.statusCode, 404, foreign.body);
    const byPeer = await decide(peer, a.workspace, a.requestId);
    assert.equal(byPeer.statusCode, 403, byPeer.body);
  }
  const current = await state(a.workspace, a.invite);
  assert.deepEqual(current.requests.map((r) => r.id), [a.requestId]);
  assert.equal(current.members.length, 2);
  assert.equal(current.invite.useCount, 0);
  const approved = await approve(a.admin, a.workspace, a.requestId);
  assert.equal(approved.statusCode, 200, approved.body);
  assert.equal(approved.json().data.status, "joined");
  const after = await state(a.workspace, a.invite);
  assert.equal(member(after, a.applicant).role, "VIEWER");
  assert.equal(after.invite.useCount, 1);
  const retry = await accept(a.applicant, a.invite);
  assert.equal(retry.statusCode, 200, retry.body);
  assert.equal(retry.json().data.alreadyMember, true);
  assert.equal((await state(a.workspace, a.invite)).invite.useCount, 1);
});

test("rejection removes only the pending request", async () => {
  const fixture = await pendingRequest();
  const rejected = await reject(fixture.admin, fixture.workspace, fixture.requestId);
  assert.equal(rejected.statusCode, 204, rejected.body);
  const again = await reject(fixture.admin, fixture.workspace, fixture.requestId);
  assert.equal(again.statusCode, 404, again.body);
  const approveRejected = await approve(fixture.admin, fixture.workspace, fixture.requestId);
  assert.equal(approveRejected.statusCode, 404, approveRejected.body);
  const current = await state(fixture.workspace, fixture.invite);
  assert.equal(current.requests.length, 0);
  assert.equal(current.members.length, 1);
  assert.equal(current.invite.useCount, 0);
});

for (const [name, change, status] of [
  ["invites were disabled", ({ workspace }) => app.prisma.workspaceSettings.update({ where: { workspaceId: workspace.id }, data: { invitesEnabled: false } }), 403],
  ["the allowed domain changed", ({ workspace }) => app.prisma.workspaceSettings.update({ where: { workspaceId: workspace.id }, data: { allowedEmailDomains: [otherDomain] } }), 403],
  ["the workspace became full", ({ workspace }) => app.prisma.workspaceSettings.update({ where: { workspaceId: workspace.id }, data: { maxMembers: 1 } }), 403],
  ["the invite expired", ({ invite }) => app.prisma.workspaceInvite.update({ where: { id: invite.id }, data: { expiresAt: new Date(Date.now() - 1000) } }), 410],
  ["the invite was used up", ({ invite }) => app.prisma.workspaceInvite.update({ where: { id: invite.id }, data: { maxUses: 1, useCount: 1 } }), 410],
  ["the applicant must still verify a restricted address", ({ workspace, applicant }) => Promise.all([
    app.prisma.workspaceSettings.update({ where: { workspaceId: workspace.id }, data: { allowedEmailDomains: [baseDomain] } }),
    app.prisma.user.update({ where: { id: applicant.id }, data: { emailVerified: false } }),
  ]), 403],
]) {
  test(`approval rechecks live policy: denied without mutation when ${name}`, async () => {
    const fixture = await pendingRequest();
    await change(fixture);
    const before = await state(fixture.workspace, fixture.invite);
    const response = await approve(fixture.admin, fixture.workspace, fixture.requestId);
    assert.equal(response.statusCode, status, response.body);
    const after = await state(fixture.workspace, fixture.invite);
    assert.deepEqual(after.requests, before.requests);
    assert.deepEqual(after.members, before.members);
    assert.equal(after.invite.useCount, before.invite.useCount);
  });
}

test("revoking an invite cancels its pending requests", async () => {
  const fixture = await pendingRequest();
  const revoked = await inject("DELETE", `/api/invites/${fixture.invite.id}`, {
    token: fixture.admin.token,
  });
  assert.equal(revoked.statusCode, 204, revoked.body);
  assert.equal((await state(fixture.workspace)).requests.length, 0);
  const approved = await approve(fixture.admin, fixture.workspace, fixture.requestId);
  assert.equal(approved.statusCode, 404, approved.body);
  assert.equal((await state(fixture.workspace)).members.length, 1);
});

// ─── Forced failure rollback ───────────────────────────────

test("a failed membership insert rolls back the use count and keeps pending state", async () => {
  const open = await makeWorkspace();
  const invite = await makeInvite(open.workspace, { maxUses: 1 });
  const user = await makeUser({ name: "rollback" });
  await withMemberInsertFailure("userId", user.id, async () => {
    const failed = await accept(user, invite);
    assert.equal(failed.statusCode, 500, failed.body);
  });
  let current = await state(open.workspace, invite);
  assert.equal(current.invite.useCount, 0);
  assert.equal(current.members.length, 1);
  assert.equal((await accept(user, invite)).statusCode, 200);
  assert.equal((await state(open.workspace, invite)).invite.useCount, 1);

  const fixture = await pendingRequest({ invite: { maxUses: 1 } });
  await withMemberInsertFailure("userId", fixture.applicant.id, async () => {
    const failed = await approve(fixture.admin, fixture.workspace, fixture.requestId);
    assert.equal(failed.statusCode, 500, failed.body);
  });
  current = await state(fixture.workspace, fixture.invite);
  assert.deepEqual(current.requests.map((r) => r.id), [fixture.requestId]);
  assert.equal(current.invite.useCount, 0);
  assert.equal(current.members.length, 1);
  const approved = await approve(fixture.admin, fixture.workspace, fixture.requestId);
  assert.equal(approved.statusCode, 200, approved.body);

  const signup = await makeWorkspace();
  const signupInvite = await makeInvite(signup.workspace, { maxUses: 1 });
  const email = emailFor("rollback-signup");
  await withMemberInsertFailure("workspaceId", signup.workspace.id, async () => {
    const response = await register(email, signupInvite.token);
    assert.equal(response.statusCode, 201, response.body);
    assert.equal(response.json().data.admission.status, "unavailable");
  });
  current = await state(signup.workspace, signupInvite);
  assert.equal(current.invite.useCount, 0);
  assert.equal(current.members.length, 1);
  assert(await app.prisma.user.findUnique({ where: { email } }));
});

// ─── Concurrent admission on real PostgreSQL connections ───

function statuses(responses) {
  return responses.map((r) => r.statusCode).sort();
}

test("concurrent acceptances of the last invitation use admit exactly one account", async () => {
  const { workspace } = await makeWorkspace();
  const invite = await makeInvite(workspace, { maxUses: 1 });
  const users = [await makeUser({ name: "a" }), await makeUser({ name: "b" })];
  const responses = await whileLocked(memberInsertLock, () =>
    users.map((user) => accept(user, invite)),
  );
  assert.deepEqual(statuses(responses), [200, 410]);
  const current = await state(workspace, invite);
  assert.equal(current.members.length, 2);
  assert.equal(current.invite.useCount, 1);
});

test("concurrent acceptances of distinct invitations cannot exceed the last seat", async () => {
  const { workspace } = await makeWorkspace({ settings: { maxMembers: 2 } });
  const invites = [await makeInvite(workspace), await makeInvite(workspace)];
  const users = [await makeUser({ name: "a" }), await makeUser({ name: "b" })];
  const responses = await whileLocked(memberInsertLock, () =>
    users.map((user, i) => accept(user, invites[i])),
  );
  assert.deepEqual(statuses(responses), [200, 403]);
  const current = await state(workspace);
  assert.equal(current.members.length, 2);
  const counts = await app.prisma.workspaceInvite.findMany({
    where: { workspaceId: workspace.id },
  });
  assert.equal(counts.reduce((sum, i) => sum + i.useCount, 0), 1);
});

for (const [name, kinds] of [
  ["registration and acceptance", ["register", "accept"]],
  ["two registrations", ["register", "register"]],
]) {
  test(`concurrent ${name} for the last use admit one and keep every account usable`, async () => {
    const { workspace } = await makeWorkspace();
    const invite = await makeInvite(workspace, { maxUses: 1 });
    const existing = await makeUser({ name: "existing-applicant" });
    const emails = kinds.map(() => emailFor("racer"));
    const responses = await whileLocked(memberInsertLock, () =>
      kinds.map((kind, i) =>
        kind === "register" ? register(emails[i], invite.token) : accept(existing, invite),
      ),
    );
    const current = await state(workspace, invite);
    assert.equal(current.members.length, 2, "exactly one racer became a member");
    assert.equal(current.invite.useCount, 1);
    let joined = 0;
    for (const [i, response] of responses.entries()) {
      if (kinds[i] === "register") {
        assert.equal(response.statusCode, 201, response.body);
        const status = response.json().data.admission?.status;
        if (status === "joined") joined++;
        else assert.equal(response.json().data.admission.reason, "exhausted");
        const login = await inject("POST", "/api/auth/login", {
          payload: { email: emails[i], password },
        });
        assert.equal(login.statusCode, 200, login.body);
      } else if (response.statusCode === 200) joined++;
      else assert.equal(response.statusCode, 410, response.body);
    }
    assert.equal(joined, 1);
  });
}

test("parallel acceptances by one account create one membership and consume one use", async () => {
  const { workspace } = await makeWorkspace();
  const invite = await makeInvite(workspace);
  const user = await makeUser({ name: "same" });
  const responses = await whileLocked(memberInsertLock, () => [
    accept(user, invite),
    accept(user, invite),
  ]);
  assert.deepEqual(statuses(responses), [200, 200]);
  assert.deepEqual(
    responses.map((r) => r.json().data.alreadyMember).sort(),
    [false, true],
  );
  const current = await state(workspace, invite);
  assert.equal(current.members.length, 2);
  assert.equal(current.invite.useCount, 1);
});

test("concurrent approvals of one request have one effect", async () => {
  const fixture = await pendingRequest();
  const second = await makeUser({ name: "second-admin" });
  await app.prisma.workspaceMember.create({
    data: { userId: second.id, workspaceId: fixture.workspace.id, role: "ADMIN" },
  });
  const responses = await whileLocked(workspaceRowLock(fixture.workspace), () => [
    approve(fixture.admin, fixture.workspace, fixture.requestId),
    approve(second, fixture.workspace, fixture.requestId),
  ]);
  assert.deepEqual(statuses(responses), [200, 404]);
  const current = await state(fixture.workspace, fixture.invite);
  assert.equal(current.members.length, 3);
  assert.equal(current.invite.useCount, 1);
  assert.equal(current.requests.length, 0);
});

test("concurrent approval and rejection resolve the request exactly once", async () => {
  const fixture = await pendingRequest();
  const responses = await whileLocked(workspaceRowLock(fixture.workspace), () => [
    approve(fixture.admin, fixture.workspace, fixture.requestId),
    reject(fixture.admin, fixture.workspace, fixture.requestId),
  ]);
  const codes = responses.map((r) => r.statusCode);
  assert.equal(codes.filter((c) => c === 404).length, 1, codes.join());
  const approved = codes[0] === 200;
  assert(approved || codes[1] === 204, codes.join());
  const current = await state(fixture.workspace, fixture.invite);
  assert.equal(current.requests.length, 0);
  assert.equal(current.members.length, approved ? 2 : 1);
  assert.equal(current.invite.useCount, approved ? 1 : 0);
});

for (const [name, setup] of [
  ["the last invitation use", { invite: { maxUses: 1 }, shared: true, status: 410 }],
  ["the last seat across invitations", { settings: { maxMembers: 2 }, shared: false, status: 403 }],
]) {
  test(`concurrent approvals of two applicants cannot exceed ${name}`, async () => {
    const fixture = await makeWorkspace({
      settings: { requireAdminApproval: true, ...setup.settings },
    });
    const invites = [await makeInvite(fixture.workspace, setup.invite)];
    invites.push(setup.shared ? invites[0] : await makeInvite(fixture.workspace));
    const requestIds = [];
    for (const invite of invites) {
      const response = await accept(await makeUser({ name: "queued" }), invite);
      assert.equal(response.statusCode, 202, response.body);
      requestIds.push(response.json().data.requestId);
    }
    const responses = await whileLocked(workspaceRowLock(fixture.workspace), () =>
      requestIds.map((id) => approve(fixture.admin, fixture.workspace, id)),
    );
    assert.deepEqual(statuses(responses), [200, setup.status]);
    const current = await state(fixture.workspace);
    assert.equal(current.members.length, 2);
    assert.equal(current.requests.length, 1);
    const used = await app.prisma.workspaceInvite.findMany({
      where: { workspaceId: fixture.workspace.id },
    });
    assert.equal(used.reduce((sum, i) => sum + i.useCount, 0), 1);
  });
}

// ─── Policy changes committed while an admission waits ─────

for (const [name, setup, change, expected] of [
  ["invites are disabled", {}, (tx, f) => tx.workspaceSettings.update({ where: { workspaceId: f.workspace.id }, data: { invitesEnabled: false } }), [403]],
  ["the allowed domain changes", {}, (tx, f) => tx.workspaceSettings.update({ where: { workspaceId: f.workspace.id }, data: { allowedEmailDomains: [otherDomain] } }), [403]],
  ["the member cap is lowered", {}, (tx, f) => tx.workspaceSettings.update({ where: { workspaceId: f.workspace.id }, data: { maxMembers: 1 } }), [403]],
  ["approval becomes required", {}, (tx, f) => tx.workspaceSettings.update({ where: { workspaceId: f.workspace.id }, data: { requireAdminApproval: true } }), [202, "approval_pending"]],
  ["the invite is revoked", {}, (tx, f) => tx.workspaceInvite.delete({ where: { id: f.invite.id } }), [404]],
  ["a member removal frees the last seat", { maxMembers: 2, peer: true }, (tx, f) => tx.workspaceMember.delete({ where: { userId_workspaceId: { userId: f.peer.id, workspaceId: f.workspace.id } } }), [200, "joined"]],
]) {
  test(`an admission queued behind the workspace lock sees committed policy when ${name}`, async () => {
    const peer = setup.peer ? await makeUser({ name: "peer" }) : undefined;
    const fixture = await makeWorkspace({
      settings: { maxMembers: setup.maxMembers ?? null },
      members: peer ? [[peer, "MEMBER"]] : [],
    });
    const invite = await makeInvite(fixture.workspace);
    const user = await makeUser({ name: "waiting" });
    const f = { ...fixture, invite, peer };
    const [response] = await whileLocked(
      workspaceRowLock(fixture.workspace, (tx) => change(tx, f)),
      () => [accept(user, invite)],
    );
    assert.equal(response.statusCode, expected[0], response.body);
    if (expected[1]) assert.equal(response.json().data.status, expected[1]);
    const current = await state(fixture.workspace);
    assert.equal(Boolean(member(current, user)), expected[0] === 200);
    const stored = await app.prisma.workspaceInvite.findUnique({ where: { id: invite.id } });
    if (stored) assert.equal(stored.useCount, expected[0] === 200 ? 1 : 0);
  });
}

test("an invitation that expires while admission waits is rejected after the lock", async () => {
  const { workspace } = await makeWorkspace();
  const invite = await makeInvite(workspace, {
    expiresAt: new Date(Date.now() + 1500),
  });
  const user = await makeUser({ name: "late" });
  const [response] = await whileLocked(workspaceRowLock(workspace), () => [accept(user, invite)], {
    beforeRelease: async () => {
      const remaining = invite.expiresAt.getTime() - Date.now();
      if (remaining >= 0) await sleep(remaining + 50);
    },
  });
  assert.equal(response.statusCode, 410, response.body);
  const current = await state(workspace, invite);
  assert.equal(current.members.length, 1);
  assert.equal(current.invite.useCount, 0);
});

test("an approver demoted while approval waits cannot admit", async () => {
  const fixture = await pendingRequest();
  const approver = await makeUser({ name: "approver" });
  const membership = await app.prisma.workspaceMember.create({
    data: { userId: approver.id, workspaceId: fixture.workspace.id, role: "ADMIN" },
  });
  const [response] = await whileLocked(
    workspaceRowLock(fixture.workspace, (tx) =>
      tx.workspaceMember.update({ where: { id: membership.id }, data: { role: "MEMBER" } }),
    ),
    () => [approve(approver, fixture.workspace, fixture.requestId)],
  );
  assert.equal(response.statusCode, 403, response.body);
  const current = await state(fixture.workspace, fixture.invite);
  assert.deepEqual(current.requests.map((r) => r.id), [fixture.requestId]);
  assert.equal(current.invite.useCount, 0);
  assert.equal(member(current, fixture.applicant), undefined);
});

// ─── Writers that wait behind an in-flight admission ───────

for (const [name, participant, verify] of [
  [
    "a settings change",
    (f) => inject("PATCH", `/api/workspaces/${f.workspace.id}/settings`, { token: f.admin.token, payload: { invitesEnabled: false } }),
    async (f, response) => {
      assert.equal(response.statusCode, 200, response.body);
      assert.equal((await app.prisma.workspaceSettings.findUnique({ where: { workspaceId: f.workspace.id } })).invitesEnabled, false);
    },
  ],
  [
    "invite creation",
    (f) => inject("POST", `/api/workspaces/${f.workspace.id}/invites`, { token: f.admin.token, payload: { role: "VIEWER" } }),
    async (f, response) => {
      assert.equal(response.statusCode, 201, response.body);
      assert.equal(await app.prisma.workspaceInvite.count({ where: { workspaceId: f.workspace.id } }), 2);
    },
  ],
  [
    "invite revocation",
    (f) => inject("DELETE", `/api/invites/${f.invite.id}`, { token: f.admin.token }),
    async (f, response) => {
      assert.equal(response.statusCode, 204, response.body);
      assert.equal(await app.prisma.workspaceInvite.count({ where: { workspaceId: f.workspace.id } }), 0);
    },
  ],
  [
    "a role change",
    (f) => inject("PATCH", `/api/workspaces/${f.workspace.id}/members/${f.peer.id}`, { token: f.admin.token, payload: { role: "VIEWER" } }),
    async (f, response) => {
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(member(await state(f.workspace), f.peer).role, "VIEWER");
    },
  ],
  [
    "a member removal",
    (f) => inject("DELETE", `/api/workspaces/${f.workspace.id}/members/${f.peer.id}`, { token: f.admin.token }),
    async (f, response) => {
      assert.equal(response.statusCode, 204, response.body);
      assert.equal(member(await state(f.workspace), f.peer), undefined);
    },
  ],
]) {
  test(`${name} waits for an in-flight admission and commits after it`, async () => {
    const peer = await makeUser({ name: "peer" });
    const fixture = await makeWorkspace({ members: [[peer, "MEMBER"]] });
    const invite = await makeInvite(fixture.workspace);
    const user = await makeUser({ name: "joining" });
    const f = { ...fixture, invite, peer };
    // The admission pauses at its membership INSERT while holding the
    // workspace lock; the participant must then wait on that lock (two waiters).
    let participantPending, responses;
    try {
      responses = await whileLocked(
        memberInsertLock,
        () => [accept(user, invite)],
        {
          waiters: 1,
          beforeRelease: async () => {
            participantPending = Promise.resolve(participant(f));
            await waitForLockWaiters(2, { behindActors: 1 });
          },
        },
      );
    } finally {
      await Promise.allSettled([participantPending]);
    }
    assert.equal(responses[0].statusCode, 200, responses[0].body);
    await verify(f, await participantPending);
    assert(member(await state(fixture.workspace), user));
  });
}
