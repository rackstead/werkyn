import assert from "node:assert/strict";
import crypto from "node:crypto";
import { after, afterEach, before, beforeEach, test } from "node:test";
import nodemailer from "nodemailer";

if (!process.env.TEST_DATABASE_URL)
  throw new Error(
    "Set TEST_DATABASE_URL to a migrated, disposable PostgreSQL database",
  );
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";
process.env.JWT_SECRET = "bootstrap-integration-jwt-secret";
process.env.COOKIE_SECRET = "bootstrap-integration-cookie-secret";
process.env.SMTP_HOST = "127.0.0.1";
process.env.SMTP_PORT = "1";
process.env.SMTP_USER = "";
process.env.SMTP_PASS = "";
process.env.SMTP_SECURE = "false";

const { PrismaClient } = await import("@prisma/client");
const { register, login } =
  await import("../../src/modules/auth/auth.service.js");
const { resolveOidcUser } =
  await import("../../src/modules/auth/oidc/oidc-identity.js");
const { resetTransporter } = await import("../../src/utils/mailer.js");
const prisma = new PrismaClient();
const suffix = crypto.randomUUID();
const domain = `bootstrap-${suffix}.example.test`;
const connectorId = `bootstrap-${suffix}`;
const issuer = "https://bootstrap.example.test/dex";
const password = "fixture-password-with-enough-length";
const sent = [];
const originalTransport = nodemailer.createTransport;
const originalTestAccount = nodemailer.createTestAccount;
let originalConfig;

// No network mail: even a regression falling back to Ethereal fails locally.
nodemailer.createTestAccount = async () => {
  throw new Error("External mail is forbidden in bootstrap fixtures");
};
nodemailer.createTransport = (options) => {
  assert.equal(options.host, "127.0.0.1");
  return {
    async sendMail(message) {
      const user = await prisma.user.findUniqueOrThrow({
        where: { email: message.to },
      });
      assert.equal(
        await prisma.authProvider.count({ where: { userId: user.id } }),
        1,
        "mail runs only after the account and provider commit",
      );
      sent.push(message);
      return {};
    },
  };
};

function local(name, client = prisma) {
  return register(client, {
    email: `${name}@${domain}`,
    displayName: name,
    password,
  });
}

function oidc(name, client = prisma, overrides = {}) {
  return resolveOidcUser(
    client,
    {
      issuer,
      subject: name,
      connectorId,
      email: `${name}@${domain}`,
      emailVerified: true,
      displayName: name,
      ...overrides,
    },
    connectorId,
  );
}

// Real account-creation operations pause immediately before their INSERT,
// after each caller has performed its reads. The bounded barrier proves overlap;
// PostgreSQL, rather than a fake delegate, decides which transaction can commit.
function overlappingClient(participants = 2) {
  let arrivals = 0;
  let release;
  const barrier = new Promise((resolve) => {
    release = resolve;
  });
  const attempts = [];
  const client = prisma.$extends({
    query: {
      user: {
        async create({ args, query }) {
          attempts.push(args.data.email);
          if (++arrivals <= participants) {
            if (arrivals === participants) release();
            let timer;
            try {
              await Promise.race([
                barrier,
                new Promise((_, reject) => {
                  timer = setTimeout(
                    () => reject(new Error("Account creation did not overlap")),
                    3000,
                  );
                }),
              ]);
            } finally {
              clearTimeout(timer);
            }
          }
          return query(args);
        },
      },
    },
  });
  return {
    client,
    attempts,
    get arrivals() {
      return arrivals;
    },
  };
}

async function rows() {
  return prisma.user.findMany({
    where: { email: { endsWith: `@${domain}` } },
    include: {
      authProviders: true,
      refreshTokens: true,
      emailVerificationTokens: true,
    },
  });
}

before(async () => {
  // These tests exercise a new installation. Never delete unrelated accounts.
  assert.equal(
    await prisma.user.count(),
    0,
    "Bootstrap tests require an empty disposable database",
  );
  originalConfig = await prisma.ssoConfig.findUnique({
    where: { id: "singleton" },
  });
  await prisma.ssoConfig.upsert({
    where: { id: "singleton" },
    create: {},
    update: {},
  });
  await prisma.ssoConnector.create({
    data: {
      connectorId,
      name: "Bootstrap fixture",
      type: "oidc",
      config: {},
      enabled: true,
    },
  });
});

beforeEach(async () => {
  assert.equal(await prisma.user.count(), 0);
  sent.length = 0;
  resetTransporter();
  await prisma.ssoConfig.update({
    where: { id: "singleton" },
    data: {
      enabled: true,
      passwordLoginEnabled: true,
      autoLinkByEmail: true,
    },
  });
});

afterEach(async () => {
  await prisma.user.deleteMany({
    where: { email: { endsWith: `@${domain}` } },
  });
});

after(async () => {
  nodemailer.createTransport = originalTransport;
  nodemailer.createTestAccount = originalTestAccount;
  resetTransporter();
  await prisma.user.deleteMany({
    where: { email: { endsWith: `@${domain}` } },
  });
  await prisma.ssoConnector.deleteMany({ where: { connectorId } });
  if (originalConfig) {
    const { id, createdAt, updatedAt, ...data } = originalConfig;
    await prisma.ssoConfig.update({ where: { id }, data });
  } else {
    await prisma.ssoConfig.delete({ where: { id: "singleton" } });
  }
  await prisma.$disconnect();
});

for (const [name, first, second, localCount, adminCount] of [
  ["local/local", local, local, 2, 1],
  ["local/OIDC", local, oidc, 1, undefined],
  ["OIDC/OIDC", oidc, oidc, 0, 0],
]) {
  test(`overlapping ${name} account creation preserves bootstrap eligibility`, async () => {
    const overlap = overlappingClient();
    const results = await Promise.allSettled([
      first("first", overlap.client),
      second("second", overlap.client),
    ]);
    for (const result of results) {
      if (result.status === "rejected") throw result.reason;
    }
    const users = await rows();
    assert.equal(overlap.arrivals >= 2, true);
    assert.equal(users.length, 2);
    const admins = users.filter((u) => u.isInstanceAdmin);
    if (adminCount !== undefined) assert.equal(admins.length, adminCount);
    else assert(admins.length <= 1);
    assert(
      admins.every((u) => u.passwordHash),
      "only local accounts are bootstrap eligible",
    );
    assert.equal(
      overlap.attempts.length >= 3,
      true,
      "serialization conflict retries the losing account",
    );
    for (const user of users) {
      assert.equal(user.authProviders.length, 1);
      const isLocal = user.authProviders[0].provider === "password";
      assert.equal(user.emailVerified, !isLocal || user.isInstanceAdmin);
      assert.equal(
        user.emailVerificationTokens.length,
        isLocal && !user.isInstanceAdmin ? 1 : 0,
      );
      assert.equal(user.refreshTokens.length, isLocal ? 1 : 0);
    }
    assert.equal(
      sent.length,
      users.filter((u) => !u.isInstanceAdmin && u.passwordHash).length,
    );
    assert.equal(users.filter((u) => u.passwordHash).length, localCount);
  });
}

test("four overlapping ordinary registrations commit without bootstrap predicate contention", async () => {
  const bootstrap = await local("existing-bootstrap");
  const overlap = overlappingClient(4);
  const results = await Promise.allSettled(
    Array.from({ length: 4 }, (_, i) => local(`ordinary-${i}`, overlap.client)),
  );
  for (const result of results) {
    if (result.status === "rejected") throw result.reason;
  }
  assert.equal(
    overlap.attempts.length,
    4,
    "ordinary inserts need no serialization retries",
  );
  const users = await rows();
  assert.equal(users.length, 5);
  assert.deepEqual(
    users.filter((u) => u.isInstanceAdmin).map((u) => u.id),
    [bootstrap.user.id],
  );
  for (const user of users.filter((u) => u.id !== bootstrap.user.id)) {
    assert.equal(user.emailVerified, false);
    assert.equal(user.authProviders.length, 1);
    assert.equal(user.refreshTokens.length, 1);
    assert.equal(user.emailVerificationTokens.length, 1);
  }
  assert.equal(sent.length, 4);
});

test("OIDC first account stays ordinary; subsequent local account needs verification", async () => {
  const first = await oidc("oidc-first");
  const second = await local("local-next");
  assert.equal(
    (await prisma.user.findUniqueOrThrow({ where: { id: first.id } }))
      .isInstanceAdmin,
    false,
  );
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: second.user.id },
  });
  assert.equal(user.isInstanceAdmin, false);
  assert.equal(user.emailVerified, false);
  assert.equal(sent.length, 1);
});

test("overlapping local and OIDC creation after an ordinary account preserves both ordinary identities", async () => {
  await oidc("existing-ordinary");
  const overlap = overlappingClient();
  const results = await Promise.allSettled([
    local("ordinary-local", overlap.client),
    oidc("ordinary-oidc", overlap.client),
  ]);
  for (const result of results) {
    if (result.status === "rejected") throw result.reason;
  }
  const users = await rows();
  assert.equal(users.length, 3);
  assert.equal(users.filter((u) => u.isInstanceAdmin).length, 0);
  for (const user of users) assert.equal(user.authProviders.length, 1);
  assert.equal(users.find((u) => u.passwordHash).emailVerified, false);
  assert.equal(sent.length, 1);
});

for (const winner of ["local", "oidc"]) {
  test(`mixed creation with ${winner} committing first refreshes the losing snapshot`, async () => {
    let announcePaused, release;
    const paused = new Promise((resolve) => {
      announcePaused = resolve;
    });
    const committed = new Promise((resolve) => {
      release = resolve;
    });
    const loser = winner === "local" ? "oidc" : "local";
    let attempts = 0;
    const client = prisma.$extends({
      query: {
        user: {
          async create({ args, query }) {
            if (args.data.email === `${loser}@${domain}`) {
              attempts++;
              announcePaused();
              await committed;
            }
            return query(args);
          },
        },
      },
    });
    const creators = { local, oidc };
    const pending = creators[loser](loser, client);
    // A deadline makes a missing production create call fail without hanging.
    let timer, winnerError;
    try {
      await Promise.race([
        paused,
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("Losing creator did not reach INSERT")),
            3000,
          );
        }),
      ]);
      await creators[winner](winner, client);
    } catch (error) {
      winnerError = error;
    } finally {
      clearTimeout(timer);
      release();
    }
    await pending;
    if (winnerError) throw winnerError;
    const users = await rows();
    const localUser = users.find((u) => u.passwordHash);
    const oidcUser = users.find((u) => !u.passwordHash);
    assert.equal(localUser.isInstanceAdmin, winner === "local");
    assert.equal(oidcUser.isInstanceAdmin, false);
    assert.equal(
      attempts >= 2,
      true,
      "the losing SERIALIZABLE snapshot is retried",
    );
  });
}

test("local first account remains verified and can log in normally", async () => {
  const created = await local("local-first");
  assert.equal(created.user.emailVerified, true);
  assert.equal(sent.length, 0);
  const result = await login(prisma, { email: created.user.email, password });
  assert.equal(result.user.id, created.user.id);
  assert(result.accessToken && result.refreshToken);
  await oidc("oidc-next");
  assert.equal((await rows()).filter((u) => u.isInstanceAdmin).length, 1);
});

test("existing ordinary accounts prevent bootstrap; deliberate administrator promotion remains possible", async () => {
  await prisma.user.create({
    data: {
      email: `existing@${domain}`,
      displayName: "Existing ordinary user",
    },
  });
  const created = await local("later-local");
  await oidc("later-oidc");
  assert.equal((await rows()).filter((u) => u.isInstanceAdmin).length, 0);
  await prisma.user.update({
    where: { id: created.user.id },
    data: { isInstanceAdmin: true },
  });
  const secondAdmin = await local("after-promotion");
  assert.deepEqual(
    (await rows()).filter((u) => u.isInstanceAdmin).map((u) => u.id),
    [created.user.id],
  );
  await prisma.user.update({
    where: { id: secondAdmin.user.id },
    data: { isInstanceAdmin: true },
  });
  assert.equal((await rows()).filter((u) => u.isInstanceAdmin).length, 2);
});

for (const [name, create] of [
  ["local", local],
  ["OIDC", oidc],
]) {
  test(`${name} provider insert failure rolls back the bootstrap account`, async () => {
    const failed = prisma.$extends({
      query: {
        user: {
          create({ args, query }) {
            if (args.data.authProviders?.create)
              args.data.authProviders.create.provider = "x".repeat(51);
            return query(args);
          },
        },
        authProvider: {
          create({ args, query }) {
            args.data.provider = "x".repeat(51);
            return query(args);
          },
        },
      },
    });
    await assert.rejects(
      create("failed-provider", failed),
      (error) => error.code === "P2000",
    );
    assert.equal(
      (await rows()).length,
      0,
      "no account survives a failed provider INSERT",
    );
    assert.equal(sent.length, 0);
    const successful = await local("after-failure");
    assert.equal(
      (
        await prisma.user.findUniqueOrThrow({
          where: { id: successful.user.id },
        })
      ).isInstanceAdmin,
      true,
    );
  });
}

test("concurrent duplicate local email returns one account and a conflict", async () => {
  const overlap = overlappingClient();
  const result = await Promise.allSettled([
    local("duplicate", overlap.client),
    local("duplicate", overlap.client),
  ]);
  assert.equal(result.filter((r) => r.status === "fulfilled").length, 1);
  const rejected = result.find((r) => r.status === "rejected");
  assert.equal(rejected.reason.statusCode, 409);
  const users = await rows();
  assert.equal(users.length, 1);
  assert.equal(users[0].isInstanceAdmin, true);
  assert.equal(users[0].authProviders.length, 1);
});

test("concurrent same OIDC identity retains one provider and one bootstrap account", async () => {
  const overlap = overlappingClient();
  const results = await Promise.allSettled([
    oidc("same-subject", overlap.client),
    oidc("same-subject", overlap.client),
  ]);
  for (const result of results) {
    if (result.status === "rejected") throw result.reason;
  }
  const users = results.map((result) => result.value);
  assert.equal(users[0].id, users[1].id);
  const stored = await rows();
  assert.equal(stored.length, 1);
  assert.equal(stored[0].authProviders.length, 1);
  assert.equal(stored[0].isInstanceAdmin, false);
});

test("failed admission claims and SSO-only local denial leave bootstrap available", async () => {
  await assert.rejects(
    oidc("unverified", prisma, { emailVerified: false }),
    (e) => e.statusCode === 401,
  );
  await prisma.ssoConfig.update({
    where: { id: "singleton" },
    data: { passwordLoginEnabled: false },
  });
  await assert.rejects(local("password-disabled"), (e) => e.statusCode === 401);
  assert.equal((await rows()).length, 0);
  assert.equal(sent.length, 0);
  await prisma.ssoConfig.update({
    where: { id: "singleton" },
    data: { passwordLoginEnabled: true },
  });
  const created = await local("allowed");
  assert.equal(
    (await prisma.user.findUniqueOrThrow({ where: { id: created.user.id } }))
      .isInstanceAdmin,
    true,
  );
});

test("local serialization retries are bounded and do not send mail or create accounts", async () => {
  let attempts = 0;
  const failed = new Proxy(prisma, {
    get(target, key) {
      if (key === "$transaction")
        return async () => {
          attempts++;
          throw Object.assign(new Error("fixture conflict"), { code: "P2034" });
        };
      return Reflect.get(target, key);
    },
  });
  await assert.rejects(
    local("conflict-limit", failed),
    (e) => e.statusCode === 409,
  );
  assert.equal(attempts, 3);
  assert.equal((await rows()).length, 0);
  assert.equal(sent.length, 0);
});

for (const ordinary of [false, true]) {
  test(`local retry after written account rollback commits once (${ordinary ? "ordinary" : "bootstrap"})`, async () => {
    if (ordinary) await oidc("existing-oidc");
    let attempts = 0;
    let accountCommitted = false;
    const client = new Proxy(prisma, {
      get(target, key) {
        // Counts account-creation transactions; the later refresh-session
        // transaction passes through.
        if (key === "$transaction" && !accountCommitted)
          return (callback, options) =>
            target.$transaction(async (tx) => {
              const result = await callback(tx);
              if (++attempts === 1)
                throw Object.assign(
                  new Error("fixture serialization rollback"),
                  { code: "P2034" },
                );
              accountCommitted = true;
              return result;
            }, options);
        return Reflect.get(target, key);
      },
    });
    const result = await local("retried", client);
    assert.equal(attempts, 2);
    const stored = (await rows()).find((u) => u.id === result.user.id);
    assert.equal(stored.isInstanceAdmin, !ordinary);
    assert.equal(stored.authProviders.length, 1);
    assert.equal(stored.refreshTokens.length, 1);
    assert.equal(stored.emailVerificationTokens.length, ordinary ? 1 : 0);
    assert.equal(sent.length, ordinary ? 1 : 0);
  });
}
