// Instance setting for privacy-preserving registration. Off keeps immediate
// sign-in and the duplicate-address conflict. On answers new and existing
// addresses alike, withholds a session until verification, and does not
// change an existing account. Mail is captured the same way as password reset.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { after, before, test } from "node:test";
import nodemailer from "nodemailer";

if (!process.env.TEST_DATABASE_URL) {
  throw new Error(
    "Set TEST_DATABASE_URL to a migrated, disposable PostgreSQL database",
  );
}
Object.assign(process.env, {
  DATABASE_URL: process.env.TEST_DATABASE_URL,
  NODE_ENV: "test",
  LOG_LEVEL: "error",
  JWT_SECRET: "registration-privacy-jwt-secret",
  COOKIE_SECRET: "registration-privacy-cookie-secret",
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
const { hashPassword, verifyPassword } = await import("../../src/utils/passwords.ts");
const { signAccessToken } = await import("../../src/utils/tokens.ts");
const { resetTransporter } = await import("../../src/utils/mailer.ts");
const { loginSlot, loginThrottle } = await import(
  "../../src/modules/auth/login-throttle.ts"
);
const {
  REGISTRATION_PRIVACY_MESSAGE,
  settleRegistrationPrivacyWork,
} = await import("../../src/modules/auth/auth.service.ts");
const { forgetSignInFailures } = await import("./support/login-throttle.mjs");

const PASSWORD = "Register-password-1";
const EXISTING_PASSWORD = "Existing-password-1";
const suffix = crypto.randomBytes(5).toString("hex");
const domain = `privacy-${suffix}.example.test`;
const originalTransport = nodemailer.createTransport;
const mail = [];
let mailGate = Promise.resolve();
let app;
let counter = 0;
let address = 0;
const emails = [];

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
  resetTransporter();
  await app.prisma.user.create({
    data: {
      email: `anchor@${domain}`,
      displayName: "Anchor",
      emailVerified: true,
      isInstanceAdmin: true,
      passwordHash: await hashPassword(EXISTING_PASSWORD),
    },
  });
  emails.push(`anchor@${domain}`);
  await setPrivacy(false);
});

after(async () => {
  mailGate = Promise.resolve();
  try {
    await settleRegistrationPrivacyWork();
    if (app) {
      await setPrivacy(false);
      await app.prisma.ssoConfig.update({
        where: { id: "singleton" },
        data: { enabled: false, passwordLoginEnabled: true },
      }).catch(() => {});
      await app.prisma.workspace.deleteMany({
        where: { slug: { contains: suffix } },
      });
      await app.prisma.user.deleteMany({
        where: { email: { endsWith: `@${domain}` } },
      });
      await forgetSignInFailures(app.prisma, emails);
    }
  } finally {
    nodemailer.createTransport = originalTransport;
    resetTransporter();
    await app?.close();
  }
});

function nextEmail(kind) {
  const email = `${kind}-${++counter}@${domain}`;
  emails.push(email);
  return email;
}

function nextAddress() {
  address += 1;
  return `10.17.${(address >> 8) & 255}.${address & 255}`;
}

function cookieHeader(response) {
  const raw = response.headers["set-cookie"];
  return (Array.isArray(raw) ? raw : raw ? [raw] : []).join(";");
}

function answered(response) {
  const cookies = cookieHeader(response);
  return {
    status: response.statusCode,
    body: response.json(),
    refreshCookie: cookies.includes("refresh_token"),
    deviceCookie: cookies.includes("login_device"),
  };
}

function register(email, extra = {}) {
  return app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: {
      email,
      password: extra.password ?? PASSWORD,
      displayName: extra.displayName ?? "Applicant",
      ...(extra.inviteToken ? { inviteToken: extra.inviteToken } : {}),
    },
    remoteAddress: extra.remoteAddress ?? nextAddress(),
  });
}

function login(email, password) {
  return app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { email, password },
    remoteAddress: nextAddress(),
  });
}

async function setPrivacy(on) {
  await app.prisma.registrationConfig.upsert({
    where: { id: "singleton" },
    create: { id: "singleton", privacyPreserving: on },
    update: { privacyPreserving: on },
  });
}

async function sessionsOf(email) {
  const user = await app.prisma.user.findUnique({
    where: { email },
    select: { id: true },
  });
  if (!user) return 0;
  return app.prisma.refreshTokenFamily.count({ where: { userId: user.id } });
}

async function withTimeout(pending, label) {
  let timer;
  try {
    return await Promise.race([
      pending,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), 8000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const invalidPassword = {
  statusCode: 401,
  error: "Unauthorized",
  message: "Invalid email or password",
};

test("default registration still signs a new account in and names a duplicate address", async () => {
  await setPrivacy(false);
  const email = nextEmail("ordinary");
  const sent = mail.length;
  const created = await register(email);
  assert.equal(created.statusCode, 201, created.body);
  assert.equal(created.json().data.user.emailVerified, false);
  assert.equal(typeof created.json().data.accessToken, "string");
  assert.equal(cookieHeader(created).includes("refresh_token"), true);
  assert.equal(await sessionsOf(email), 1);
  assert.equal(mail.length, sent + 1);
  assert.equal(mail.at(-1).to, email);
  const again = await register(email);
  assert.deepEqual(answered(again), {
    status: 409,
    body: {
      statusCode: 409,
      error: "Conflict",
      message: "Email already in use",
    },
    refreshCookie: false,
    deviceCookie: false,
  });
  assert.equal(await sessionsOf(email), 1);
});

test("only an instance administrator can read or change the setting", async () => {
  const admin = await app.prisma.user.create({
    data: {
      email: nextEmail("admin"),
      displayName: "Instance admin",
      emailVerified: true,
      isInstanceAdmin: true,
      passwordHash: await hashPassword(EXISTING_PASSWORD),
    },
  });
  const member = await app.prisma.user.create({
    data: {
      email: nextEmail("member"),
      displayName: "Member",
      emailVerified: true,
      passwordHash: await hashPassword(EXISTING_PASSWORD),
    },
  });
  const call = (method, token, payload) =>
    app.inject({
      method,
      url: "/api/admin/registration/config",
      payload,
      headers: token ? { authorization: `Bearer ${token}` } : {},
      remoteAddress: nextAddress(),
    });
  const adminToken = signAccessToken({ sub: admin.id, email: admin.email });
  const memberToken = signAccessToken({ sub: member.id, email: member.email });
  assert.equal((await call("GET", null)).statusCode, 401);
  assert.equal((await call("PATCH", null, { privacyPreserving: true })).statusCode, 401);
  assert.equal((await call("GET", memberToken)).statusCode, 403);
  assert.equal((await call("PATCH", memberToken, { privacyPreserving: true })).statusCode, 403);
  await setPrivacy(false);
  const read = await call("GET", adminToken);
  assert.equal(read.statusCode, 200, read.body);
  assert.equal(read.json().data.privacyPreserving, false);
  const invalid = await call("PATCH", adminToken, { privacyPreserving: "yes" });
  assert.equal(invalid.statusCode, 400, invalid.body);
  assert.equal(
    (await app.prisma.registrationConfig.findUnique({ where: { id: "singleton" } }))
      .privacyPreserving,
    false,
  );
  const updated = await call("PATCH", adminToken, { privacyPreserving: true });
  assert.equal(updated.statusCode, 200, updated.body);
  assert.equal(updated.json().data.privacyPreserving, true);
  assert.equal((await call("GET", adminToken)).json().data.privacyPreserving, true);
  assert.equal((await call("PATCH", memberToken, { privacyPreserving: false })).statusCode, 403);
  assert.equal(
    (await app.prisma.registrationConfig.findUnique({ where: { id: "singleton" } }))
      .privacyPreserving,
    true,
  );
  await setPrivacy(false);
});

test("enabled registration gives new and existing addresses the same response and requires verification", async () => {
  await setPrivacy(true);
  const owner = await app.prisma.user.create({
    data: {
      email: nextEmail("owner"),
      displayName: "Owner",
      emailVerified: true,
      passwordHash: await hashPassword(EXISTING_PASSWORD),
    },
  });
  const workspace = await app.prisma.workspace.create({
    data: { name: "Privacy", slug: `privacy-${suffix}-${counter}` },
  });
  await app.prisma.workspaceMember.create({
    data: { userId: owner.id, workspaceId: workspace.id, role: "ADMIN" },
  });
  const invite = await app.prisma.workspaceInvite.create({
    data: {
      workspaceId: workspace.id,
      token: crypto.randomBytes(32).toString("hex"),
      role: "MEMBER",
    },
  });
  const existing = await app.prisma.user.create({
    data: {
      email: nextEmail("existing"),
      displayName: "Existing",
      emailVerified: true,
      passwordHash: await hashPassword(EXISTING_PASSWORD),
    },
  });
  const beforeHash = existing.passwordHash;
  const fresh = nextEmail("fresh");
  let release;
  mailGate = new Promise((resolve) => {
    release = resolve;
  });
  const sent = mail.length;
  try {
    const [created, duplicate] = await Promise.all([
      withTimeout(
        register(fresh, { inviteToken: invite.token, displayName: "Fresh" }),
        "new address",
      ),
      withTimeout(
        register(existing.email, {
          inviteToken: invite.token,
          displayName: "Taken over",
          password: PASSWORD,
        }),
        "existing address",
      ),
    ]);
    assert.equal(mail.length, sent, "answered before mail was accepted");
    const expected = {
      status: 200,
      body: { message: REGISTRATION_PRIVACY_MESSAGE },
      refreshCookie: false,
      deviceCookie: false,
    };
    assert.deepEqual(answered(created), expected);
    assert.deepEqual(answered(duplicate), expected);
    assert.equal(JSON.stringify(answered(created)).includes(fresh), false);
    assert.equal(JSON.stringify(answered(duplicate)).includes("already"), false);
  } finally {
    release();
    mailGate = Promise.resolve();
  }
  await settleRegistrationPrivacyWork();

  const createdUser = await app.prisma.user.findUniqueOrThrow({ where: { email: fresh } });
  assert.equal(createdUser.emailVerified, false);
  assert.equal(createdUser.displayName, "Fresh");
  assert.equal(await sessionsOf(fresh), 0);
  assert.equal(
    await app.prisma.workspaceMember.count({
      where: { workspaceId: workspace.id, userId: createdUser.id },
    }),
    1,
  );
  const unchanged = await app.prisma.user.findUniqueOrThrow({ where: { id: existing.id } });
  assert.equal(unchanged.passwordHash, beforeHash);
  assert.equal(unchanged.displayName, "Existing");
  assert.equal(await verifyPassword(EXISTING_PASSWORD, unchanged.passwordHash), true);
  assert.equal(await verifyPassword(PASSWORD, unchanged.passwordHash), false);
  assert.equal(await sessionsOf(existing.email), 0);
  assert.equal(
    await app.prisma.workspaceMember.count({
      where: { workspaceId: workspace.id, userId: existing.id },
    }),
    0,
  );
  const delivered = mail.slice(sent);
  assert.deepEqual(delivered.map((message) => message.to), [fresh]);
  const token = /verify-email\/([a-f0-9]{64})/.exec(delivered[0].text)?.[1];
  assert.ok(token, "verification link is in the captured message");
  assert.equal(delivered[0].text.includes(invite.token), true);

  const unknown = nextEmail("unknown");
  const wrong = answered(await login(fresh, "Wrong-password-1"));
  const early = answered(await login(fresh, PASSWORD));
  const missing = answered(await login(unknown, PASSWORD));
  assert.deepEqual(wrong, { status: 401, body: invalidPassword, refreshCookie: false, deviceCookie: false });
  assert.deepEqual(early, wrong);
  assert.deepEqual(missing, wrong);
  await settleRegistrationPrivacyWork();
  assert.equal(mail.length, sent + 1, "a fresh verification token suppresses another message");
  assert.equal(await sessionsOf(fresh), 0);

  const verified = await app.inject({
    method: "POST",
    url: `/api/auth/verify-email/${token}`,
    remoteAddress: nextAddress(),
  });
  assert.equal(verified.statusCode, 200, verified.body);
  assert.equal(
    (await app.prisma.user.findUnique({ where: { email: fresh } })).emailVerified,
    true,
  );
  assert.equal(await sessionsOf(fresh), 0);
  const signedIn = await login(fresh, PASSWORD);
  assert.equal(signedIn.statusCode, 200, signedIn.body);
  assert.equal(cookieHeader(signedIn).includes("refresh_token"), true);
  assert.equal(await sessionsOf(fresh), 1);
  const stillThere = await app.prisma.user.findUniqueOrThrow({ where: { id: existing.id } });
  assert.equal(stillThere.passwordHash, beforeHash);

  const repeat = await register(existing.email, { password: PASSWORD, displayName: "Again" });
  await settleRegistrationPrivacyWork();
  assert.deepEqual(answered(repeat), {
    status: 200,
    body: { message: REGISTRATION_PRIVACY_MESSAGE },
    refreshCookie: false,
    deviceCookie: false,
  });
  assert.equal(
    (await app.prisma.user.findUnique({ where: { id: existing.id } })).passwordHash,
    beforeHash,
  );
  await setPrivacy(false);
});

test("sign-in of an unverified account is refused only while the setting is on, without clearing backoff", async () => {
  const email = nextEmail("unverified");
  const passwordHash = await hashPassword(EXISTING_PASSWORD);
  await app.prisma.user.create({
    data: {
      email,
      displayName: "Unverified",
      emailVerified: false,
      passwordHash,
    },
  });
  await setPrivacy(false);
  const open = await login(email, EXISTING_PASSWORD);
  assert.equal(open.statusCode, 200, open.body);
  assert.equal(cookieHeader(open).includes("refresh_token"), true);
  const kept = await app.inject({
    method: "GET",
    url: "/api/users/me",
    headers: { authorization: `Bearer ${open.json().data.accessToken}` },
    remoteAddress: nextAddress(),
  });
  await setPrivacy(true);
  const still = await app.inject({
    method: "GET",
    url: "/api/users/me",
    headers: { authorization: `Bearer ${open.json().data.accessToken}` },
    remoteAddress: nextAddress(),
  });
  assert.equal(kept.statusCode, 200, kept.body);
  assert.equal(still.statusCode, 200, still.body);

  const locked = nextEmail("locked");
  await app.prisma.user.create({
    data: {
      email: locked,
      displayName: "Locked",
      emailVerified: false,
      passwordHash,
    },
  });
  const slot = loginSlot(locked, loginThrottle().policy.slots);
  assert.equal((await login(locked, "Wrong-password-1")).statusCode, 401);
  const afterWrong = await app.prisma.loginThrottle.findUniqueOrThrow({ where: { slot } });
  const sent = mail.filter((message) => message.to === locked).length;
  const refused = await login(locked, EXISTING_PASSWORD);
  assert.deepEqual(answered(refused), {
    status: 401,
    body: invalidPassword,
    refreshCookie: false,
    deviceCookie: false,
  });
  assert.equal(await sessionsOf(locked), 0);
  const afterCorrect = await app.prisma.loginThrottle.findUniqueOrThrow({ where: { slot } });
  assert.equal(afterCorrect.failures, afterWrong.failures + 1);
  await settleRegistrationPrivacyWork();
  assert.equal(mail.filter((message) => message.to === locked).length, sent + 1);
  assert.equal(
    (await app.prisma.user.findUnique({ where: { email: locked } })).passwordHash,
    passwordHash,
  );
  await setPrivacy(false);
});

test("a repeat while registration is still running adds one account and one message", async () => {
  await setPrivacy(true);
  const email = nextEmail("once");
  let release;
  mailGate = new Promise((resolve) => {
    release = resolve;
  });
  const sent = mail.length;
  try {
    const [first, second] = await Promise.all([
      withTimeout(register(email), "first"),
      withTimeout(register(email), "second"),
    ]);
    assert.equal(mail.length, sent);
    assert.deepEqual(answered(first), answered(second));
    assert.equal(first.statusCode, 200);
  } finally {
    release();
    mailGate = Promise.resolve();
  }
  await settleRegistrationPrivacyWork();
  assert.equal(await app.prisma.user.count({ where: { email } }), 1);
  assert.equal(mail.slice(sent).filter((message) => message.to === email).length, 1);
  assert.equal(await sessionsOf(email), 0);
  await setPrivacy(false);
});

test("the setting cannot be turned on until email delivery is configured", async () => {
  const { env } = await import("../../src/config/env.ts");
  const previousHost = env.SMTP_HOST;
  const stored = await app.prisma.emailConfig.findUnique({
    where: { id: "singleton" },
  });
  const admin = await app.prisma.user.create({
    data: {
      email: nextEmail("mail-admin"),
      displayName: "Mail admin",
      emailVerified: true,
      isInstanceAdmin: true,
      passwordHash: await hashPassword(EXISTING_PASSWORD),
    },
  });
  env.SMTP_HOST = "";
  if (stored?.host) {
    await app.prisma.emailConfig.update({
      where: { id: "singleton" },
      data: { host: "" },
    });
  }
  try {
    await setPrivacy(false);
    const token = signAccessToken({ sub: admin.id, email: admin.email });
    const refused = await app.inject({
      method: "PATCH",
      url: "/api/admin/registration/config",
      payload: { privacyPreserving: true },
      headers: { authorization: `Bearer ${token}` },
      remoteAddress: nextAddress(),
    });
    assert.equal(refused.statusCode, 400, refused.body);
    assert.match(refused.json().message, /Admin > Email or set SMTP_HOST/);
    assert.equal(
      (await app.prisma.registrationConfig.findUnique({ where: { id: "singleton" } }))
        .privacyPreserving,
      false,
    );
    await setPrivacy(true);
    const disabled = await app.inject({
      method: "PATCH",
      url: "/api/admin/registration/config",
      payload: { privacyPreserving: false },
      headers: { authorization: `Bearer ${token}` },
      remoteAddress: nextAddress(),
    });
    assert.equal(disabled.statusCode, 200, disabled.body);
    assert.equal(disabled.json().data.privacyPreserving, false);
  } finally {
    env.SMTP_HOST = previousHost;
    if (stored) {
      await app.prisma.emailConfig.update({
        where: { id: "singleton" },
        data: { host: stored.host },
      });
    }
    await setPrivacy(false);
  }
});

test("SSO-only registration stays the same refusal for every address when privacy is on", async () => {
  await setPrivacy(true);
  await app.prisma.ssoConfig.upsert({
    where: { id: "singleton" },
    create: { id: "singleton", enabled: true, passwordLoginEnabled: false },
    update: { enabled: true, passwordLoginEnabled: false },
  });
  try {
    const existing = await app.prisma.user.create({
      data: {
        email: nextEmail("sso-existing"),
        displayName: "SSO existing",
        emailVerified: true,
        passwordHash: await hashPassword(EXISTING_PASSWORD),
      },
    });
    const fresh = nextEmail("sso-fresh");
    const [known, unknown] = await Promise.all([
      register(existing.email),
      register(fresh),
    ]);
    const expected = {
      status: 401,
      body: {
        statusCode: 401,
        error: "Unauthorized",
        message: "Password registration is disabled. Please use SSO to sign in.",
      },
      refreshCookie: false,
      deviceCookie: false,
    };
    assert.deepEqual(answered(known), expected);
    assert.deepEqual(answered(unknown), expected);
    assert.equal(await app.prisma.user.findUnique({ where: { email: fresh } }), null);
    assert.equal(
      (await app.prisma.user.findUnique({ where: { id: existing.id } })).passwordHash,
      existing.passwordHash,
    );
  } finally {
    await app.prisma.ssoConfig.update({
      where: { id: "singleton" },
      data: { enabled: false, passwordLoginEnabled: true },
    });
    await setPrivacy(false);
  }
});
