import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import nodemailer from "nodemailer";

if (!process.env.TEST_DATABASE_URL)
  throw new Error(
    "Set TEST_DATABASE_URL to a migrated, disposable PostgreSQL database",
  );
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";
process.env.JWT_SECRET = "password-hash-compat-jwt-secret";
process.env.COOKIE_SECRET = "password-hash-compat-cookie-secret";
process.env.FRONTEND_URL = "https://werkyn.example.test";
process.env.SMTP_HOST = "127.0.0.1";
process.env.SMTP_PORT = "1";
process.env.SMTP_USER = "";
process.env.SMTP_PASS = "";
process.env.SMTP_SECURE = "false";

const { buildApp } = await import("../../src/app.ts");
const { signAccessToken } = await import("../../src/utils/tokens.ts");
const { resetTransporter } = await import("../../src/utils/mailer.ts");

// Hashes written by bcrypt 5.1.1, the release used before bcrypt 6.
const recorded = JSON.parse(
  readFileSync(
    new URL("../fixtures/bcrypt-5.1.1-hashes.json", import.meta.url),
    "utf8",
  ),
);
const fixture = (name) => {
  const found = recorded.fixtures.find((f) => f.name === name);
  assert(found, name);
  return found;
};
const wrong = (password) =>
  (password[0] === "Q" ? "R" : "Q") + password.slice(1);

const suffix = crypto.randomBytes(5).toString("hex");
const domain = `hash-${suffix}.example.test`;
const originalTransport = nodemailer.createTransport;
const originalTestAccount = nodemailer.createTestAccount;
let app;
const mail = [];
let counter = 0;
let address = 0;

nodemailer.createTestAccount = async () => {
  throw new Error("External mail is forbidden in password fixtures");
};
nodemailer.createTransport = (options) => {
  assert.equal(options.host, "127.0.0.1");
  return {
    async sendMail(message) {
      mail.push(message);
      return {};
    },
  };
};

before(async () => {
  resetTransporter();
  app = await buildApp();
  await app.ready();
  // Registration here must create an ordinary account, never bootstrap.
  await makeUser();
});

after(async () => {
  try {
    await app.prisma.workspace.deleteMany({
      where: { slug: { contains: suffix } },
    });
    await app.prisma.user.deleteMany({
      where: { email: { endsWith: domain } },
    });
    await app.prisma.loginAttempt.deleteMany({
      where: { email: { endsWith: domain } },
    });
  } finally {
    nodemailer.createTransport = originalTransport;
    nodemailer.createTestAccount = originalTestAccount;
    resetTransporter();
    await app?.close();
  }
});

function inject(method, url, { payload, token } = {}) {
  address++;
  return app.inject({
    method,
    url,
    payload,
    // Distinct client addresses keep per-route rate limits out of the matrix.
    remoteAddress: `10.77.${(address >> 8) & 255}.${address & 255}`,
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

async function makeUser(passwordHash) {
  const user = await app.prisma.user.create({
    data: {
      email: `user-${++counter}@${domain}`,
      displayName: "Password fixture",
      emailVerified: true,
      ...(passwordHash ? { passwordHash } : {}),
    },
  });
  return {
    ...user,
    token: signAccessToken({ sub: user.id, email: user.email }),
  };
}

function login(email, password) {
  return inject("POST", "/api/auth/login", { payload: { email, password } });
}

async function assertSignsIn(email, password) {
  const response = await login(email, password);
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(typeof response.json().data.accessToken, "string");
}

async function assertRejected(email, password) {
  const response = await login(email, password);
  assert.equal(response.statusCode, 401, response.body);
}

async function storedHash(id) {
  return (await app.prisma.user.findUniqueOrThrow({ where: { id } }))
    .passwordHash;
}

test("accounts whose hashes were written by bcrypt 5.1.1 still sign in", async () => {
  for (const name of [
    "account password at the application cost (12)",
    "$2a$ prefix at cost 12",
    "100 bytes (over the 72-byte bcrypt input limit)",
    "mixed Unicode",
    "minimum cost (4)",
  ]) {
    const { password, hash } = fixture(name);
    const user = await makeUser(hash);
    await assertRejected(user.email, wrong(password));
    await assertSignsIn(user.email, password);
    // Signing in never rewrites the stored hash.
    assert.equal(await storedHash(user.id), hash, name);
  }
});

test("changing a password verifies the old hash and stores a $2b$12$ hash", async () => {
  const old = fixture("$2a$ prefix at cost 12");
  const user = await makeUser(old.hash);
  const path = `/api/users/${user.id}/password`;
  const newPassword = "Werkyn-changed-password-1";
  const refused = await inject("PATCH", path, {
    token: user.token,
    payload: { currentPassword: wrong(old.password), newPassword },
  });
  assert.equal(refused.statusCode, 400, refused.body);
  assert.equal(await storedHash(user.id), old.hash);
  const changed = await inject("PATCH", path, {
    token: user.token,
    payload: { currentPassword: old.password, newPassword },
  });
  assert.equal(changed.statusCode, 200, changed.body);
  assert.match(await storedHash(user.id), /^\$2b\$12\$[./A-Za-z0-9]{53}$/);
  await assertSignsIn(user.email, newPassword);
  await assertRejected(user.email, old.password);
});

test("resetting a password replaces a bcrypt 5.1.1 hash", async () => {
  const old = fixture("100 bytes (over the 72-byte bcrypt input limit)");
  const user = await makeUser(old.hash);
  const requested = await inject("POST", "/api/auth/forgot-password", {
    payload: { email: user.email },
  });
  assert.equal(requested.statusCode, 200, requested.body);
  const message = mail.findLast((message) => message.to === user.email);
  const token = /reset-password\/([a-f0-9]{64})/.exec(message.text)?.[1];
  assert(token, "the reset bearer comes from the outgoing link");
  const newPassword = "Werkyn-reset-password-1";
  const reset = await inject("POST", `/api/auth/reset-password/${token}`, {
    payload: { password: newPassword },
  });
  assert.equal(reset.statusCode, 200, reset.body);
  assert.match(await storedHash(user.id), /^\$2b\$12\$[./A-Za-z0-9]{53}$/);
  await assertSignsIn(user.email, newPassword);
  await assertRejected(user.email, old.password);
});

test("registration stores a $2b$12$ hash that signs in", async () => {
  const email = `registered-${++counter}@${domain}`;
  const password = "Werkyn-registered-password-1";
  const registered = await inject("POST", "/api/auth/register", {
    payload: { email, password, displayName: "Registered" },
  });
  assert.equal(registered.statusCode, 201, registered.body);
  const user = await app.prisma.user.findUniqueOrThrow({ where: { email } });
  assert.equal(user.isInstanceAdmin, false);
  assert.match(user.passwordHash, /^\$2b\$12\$[./A-Za-z0-9]{53}$/);
  await assertSignsIn(email, password);
  await assertRejected(email, wrong(password));
});

test("share links protected by bcrypt 5.1.1 hashes still validate", async () => {
  const { password, hash } = fixture(
    "share-link password at the share cost (10)",
  );
  const owner = await makeUser();
  const workspace = await app.prisma.workspace.create({
    data: {
      name: "Password fixture",
      slug: `hash-${suffix}`,
      members: { create: { userId: owner.id, role: "ADMIN" } },
    },
  });
  const space = await app.prisma.wikiSpace.create({
    data: {
      workspaceId: workspace.id,
      name: "Fixture space",
      slug: `hash-space-${suffix}`,
    },
  });
  const page = await app.prisma.wikiPage.create({
    data: {
      spaceId: space.id,
      title: "Fixture page",
      content: {},
      createdById: owner.id,
    },
  });
  const file = await app.prisma.file.create({
    data: {
      workspaceId: workspace.id,
      name: "fixture.txt",
      mimeType: "text/plain",
      storagePath: `files/${workspace.id}/fixture.txt`,
      size: 1,
      uploadedById: owner.id,
      ownerId: owner.id,
    },
  });
  const shares = {
    wiki: await app.prisma.wikiPageShare.create({
      data: {
        token: crypto.randomBytes(32).toString("base64url"),
        pageId: page.id,
        createdById: owner.id,
        passwordHash: hash,
      },
    }),
    files: await app.prisma.fileShareLink.create({
      data: {
        token: crypto.randomBytes(32).toString("base64url"),
        workspaceId: workspace.id,
        createdById: owner.id,
        passwordHash: hash,
        files: { create: { fileId: file.id } },
      },
    }),
  };
  for (const [kind, share] of Object.entries(shares)) {
    const path = `/api/public/${kind}/${share.token}/validate`;
    const refused = await inject("POST", path, {
      payload: { password: wrong(password) },
    });
    assert.equal(refused.statusCode, 403, `${kind}: ${refused.body}`);
    const accepted = await inject("POST", path, { payload: { password } });
    assert.equal(accepted.statusCode, 200, `${kind}: ${accepted.body}`);
    assert.equal(accepted.json().data.valid, true);
  }
});
