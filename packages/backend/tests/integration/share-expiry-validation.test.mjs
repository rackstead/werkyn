// What the API does with the expiry of a Drive share link and of a workspace
// invitation: omitted means none (and unchanged on a link update), null on a
// link update is the one way to remove it, and "", malformed values, instants
// not in the future and instants after LATEST_EXPIRY are refused with 400
// without changing anything.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

if (!process.env.TEST_DATABASE_URL)
  throw new Error("Set TEST_DATABASE_URL to migrated disposable PostgreSQL");
Object.assign(process.env, {
  DATABASE_URL: process.env.TEST_DATABASE_URL,
  NODE_ENV: "test",
  LOG_LEVEL: "error",
  JWT_SECRET: "share-expiry-integration-jwt-secret",
  COOKIE_SECRET: "share-expiry-integration-cookie-secret",
});
const storageDir = await mkdtemp(path.join(os.tmpdir(), "werkyn-share-expiry-"));
process.env.STORAGE_DIR = storageDir;
const { buildApp } = await import("../../src/app.ts");
const { signAccessToken } = await import("../../src/utils/tokens.ts");
const { LATEST_EXPIRY } = await import("@pm/shared");

let app, user, token, workspace;
let requests = 0;
const inject = (method, url, payload) =>
  app.inject({
    method,
    url,
    payload,
    headers: { authorization: `Bearer ${token}` },
    remoteAddress: `10.91.0.${(++requests % 250) + 1}`,
  });

const DAY = 86_400_000;
const future = () => new Date(Date.now() + 7 * DAY).toISOString();
// Refused values: none of them may change a link or create anything.
const INVALID = [
  ["an empty string", () => ""],
  ["a date without a time", () => "2027-03-14"],
  ["a local time without Z", () => "2027-03-14T23:59:59"],
  ["an impossible date", () => "2027-02-30T23:59:59.000Z"],
  ["a partial year", () => "0020-03-14T23:59:59.000Z"],
  ["a six-digit year", () => "+020271-03-14T23:59:59.000Z"],
  ["a number", () => Date.now() + DAY],
  ["an instant just past", () => new Date(Date.now() - 1000).toISOString()],
  ["a past year", () => "2025-12-31T23:59:59.000Z"],
  ["just after the latest expiry", () => new Date(LATEST_EXPIRY.getTime() + 1).toISOString()],
  ["year 9999", () => "9999-12-31T23:59:59.000Z"],
];

async function makeFile() {
  return app.prisma.file.create({
    data: {
      workspaceId: workspace.id,
      uploadedById: user.id,
      ownerId: user.id,
      name: `Expiry source ${crypto.randomUUID()}`,
      storagePath: "audit-fixture-content-never-opened.txt",
    },
  });
}
const createLink = async (body) =>
  inject("POST", `/api/workspaces/${workspace.id}/files/share-links`, {
    fileIds: [(await makeFile()).id],
    ...body,
  });
const updateLink = (id, body) =>
  inject("PATCH", `/api/workspaces/${workspace.id}/file-share-links/${id}`, body);
const storedLink = (id) =>
  app.prisma.fileShareLink.findUniqueOrThrow({ where: { id } });
const linkCount = () =>
  app.prisma.fileShareLink.count({ where: { workspaceId: workspace.id } });
const createInvite = (body) =>
  inject("POST", `/api/workspaces/${workspace.id}/invites`, { role: "MEMBER", ...body });
const inviteCount = () =>
  app.prisma.workspaceInvite.count({ where: { workspaceId: workspace.id } });

before(async () => {
  app = await buildApp();
  await app.ready();
  user = await app.prisma.user.create({
    data: {
      email: `share-expiry-${crypto.randomUUID()}@example.test`,
      displayName: "Expiry admin",
      emailVerified: true,
    },
  });
  token = signAccessToken({ sub: user.id, email: user.email });
  workspace = await app.prisma.workspace.create({
    data: {
      name: "Share expiry",
      slug: `share-expiry-${crypto.randomUUID().slice(0, 8)}`,
      members: { create: { userId: user.id, role: "ADMIN" } },
    },
  });
});

after(async () => {
  try {
    if (app) {
      if (workspace) await app.prisma.workspace.delete({ where: { id: workspace.id } });
      if (user) await app.prisma.user.delete({ where: { id: user.id } });
    }
  } finally {
    await app?.close();
    await rm(storageDir, { recursive: true, force: true });
  }
});

test("a new share link without expiresAt never expires; a future expiry is stored as sent", async () => {
  const none = await createLink({});
  assert.equal(none.statusCode, 201, none.body);
  assert.equal(none.json().data.expiresAt, null);
  assert.equal((await storedLink(none.json().data.id)).expiresAt, null);

  // The end of 2027-03-14 in New York (the daylight saving day), as the
  // dialog sends it, and the latest expiry accepted.
  for (const expiresAt of ["2027-03-15T03:59:59.000Z", future(), LATEST_EXPIRY.toISOString()]) {
    const created = await createLink({ expiresAt });
    assert.equal(created.statusCode, 201, created.body);
    assert.equal(created.json().data.expiresAt, expiresAt);
    assert.equal((await storedLink(created.json().data.id)).expiresAt.toISOString(), expiresAt);
  }
});

test("creating a share link refuses null and every invalid, past or too distant expiry", async () => {
  const before = await linkCount();
  for (const [label, value] of [["null", () => null], ...INVALID]) {
    const response = await createLink({ expiresAt: value() });
    assert.equal(response.statusCode, 400, `${label}: ${response.body}`);
    assert.equal(response.json().message, "Validation failed", label);
  }
  assert.equal(await linkCount(), before, "no link was created");
});

test("the refusal names the rule that failed", async () => {
  const past = await createLink({ expiresAt: new Date(Date.now() - DAY).toISOString() });
  assert.match(past.body, /Expiration must be in the future/);
  const distant = await createLink({ expiresAt: "9999-12-31T23:59:59.000Z" });
  assert.match(distant.body, /Expiration must be no later than 3000-01-02T00:00:00.000Z/);
  const malformed = await createLink({ expiresAt: "" });
  assert.match(malformed.body, /Invalid datetime/);
  assert.doesNotMatch(malformed.body, /in the future/);
});

test("updating a link keeps its expiry unless expiresAt is a valid future instant or an explicit null", async () => {
  const original = future();
  const created = await createLink({ expiresAt: original });
  const id = created.json().data.id;

  // Omitted: unchanged, also alongside other changes.
  for (const body of [{}, { enabled: false }, { enabled: true }]) {
    const response = await updateLink(id, body);
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().data.expiresAt, original);
  }

  // Refused: nothing changes, not even the fields sent with it.
  for (const [label, value] of INVALID) {
    const before = await storedLink(id);
    const response = await updateLink(id, { enabled: false, expiresAt: value() });
    assert.equal(response.statusCode, 400, `${label}: ${response.body}`);
    assert.deepEqual(await storedLink(id), before, label);
  }

  const changed = future();
  const set = await updateLink(id, { expiresAt: changed });
  assert.equal(set.statusCode, 200, set.body);
  assert.equal(set.json().data.expiresAt, changed);

  // Deliberate removal.
  const removed = await updateLink(id, { expiresAt: null });
  assert.equal(removed.statusCode, 200, removed.body);
  assert.equal(removed.json().data.expiresAt, null);
  assert.equal((await storedLink(id)).expiresAt, null);
});

test("a link whose expiry passed still reports it, and can get a new one or none", async () => {
  const created = await createLink({ expiresAt: future() });
  const id = created.json().data.id;
  await app.prisma.fileShareLink.update({
    where: { id },
    data: { expiresAt: new Date(Date.now() - 1000) },
  });
  const renewed = await updateLink(id, { expiresAt: future() });
  assert.equal(renewed.statusCode, 200, renewed.body);
  assert.ok(Date.parse(renewed.json().data.expiresAt) > Date.now());
  const removed = await updateLink(id, { expiresAt: null });
  assert.equal(removed.json().data.expiresAt, null);
});

test("a new invitation without expiresAt never expires; null, invalid, past and too distant expiries are refused", async () => {
  const none = await createInvite({});
  assert.equal(none.statusCode, 201, none.body);
  assert.equal(none.json().data.expiresAt, null);

  const expiresAt = future();
  const dated = await createInvite({ expiresAt });
  assert.equal(dated.statusCode, 201, dated.body);
  assert.equal(new Date(dated.json().data.expiresAt).toISOString(), expiresAt);

  const before = await inviteCount();
  for (const [label, value] of [["null", () => null], ...INVALID]) {
    const response = await createInvite({ expiresAt: value() });
    assert.equal(response.statusCode, 400, `${label}: ${response.body}`);
  }
  assert.equal(await inviteCount(), before, "no invitation was created");
});
