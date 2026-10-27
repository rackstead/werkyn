import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { before, after, test } from "node:test";
import jwt from "jsonwebtoken";

if (!process.env.TEST_DATABASE_URL)
  throw new Error(
    "Set TEST_DATABASE_URL to a migrated, disposable PostgreSQL database",
  );
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";
process.env.JWT_SECRET = "oidc-security-integration-jwt-secret";
process.env.COOKIE_SECRET = "oidc-security-integration-cookie-secret";
process.env.COOKIE_SECURE = "false";
process.env.COOKIE_SAMESITE = "strict";
process.env.FRONTEND_URL = "http://oidc-integration.example.test";
process.env.DEX_CLIENT_SECRET = "oidc-security-fake-client-secret";
const issuer = `${process.env.FRONTEND_URL}/dex`;
const suffix = crypto.randomUUID();
const domain = `oidc-${suffix}.example.test`;
const connectorId = `audit-${suffix}`;
const secondConnectorId = `other-${suffix}`;
const keys = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const wrongKeys = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const publicJwk = {
  ...keys.publicKey.export({ format: "jwk" }),
  kid: "audit-rsa",
  alg: "RS256",
  use: "sig",
};
const codes = new Map();
let tokenRequests = 0;
const idp = http.createServer(async (request, response) => {
  if (request.url === "/dex/keys") {
    response
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ keys: [publicJwk] }));
    return;
  }
  if (request.url !== "/dex/token" || request.method !== "POST") {
    response.writeHead(404).end();
    return;
  }
  tokenRequests++;
  let body = "";
  for await (const chunk of request) body += chunk;
  const params = new URLSearchParams(body);
  const data = codes.get(params.get("code"));
  codes.delete(params.get("code"));
  if (
    !data ||
    params.get("client_id") !== "werkyn" ||
    params.get("client_secret") !== process.env.DEX_CLIENT_SECRET ||
    params.get("code_verifier") !== data.state.codeVerifier ||
    params.get("redirect_uri") !==
      `${process.env.FRONTEND_URL}/api/auth/oidc/callback`
  ) {
    response
      .writeHead(400, { "content-type": "application/json" })
      .end(JSON.stringify({ error: "invalid_grant" }));
    return;
  }
  const claims = {
    iss: issuer,
    aud: "werkyn",
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 300,
    nonce: data.state.nonce,
    sub: `subject-${crypto.randomUUID()}`,
    email: `new-${crypto.randomUUID()}@${domain}`,
    email_verified: true,
    name: "OIDC User",
    federated_claims: {
      connector_id: data.state.connectorId ?? connectorId,
      user_id: "audit-upstream-user",
    },
    ...data.claims,
  };
  for (const key of data.omit ?? []) delete claims[key];
  const idToken = jwt.sign(
    claims,
    data.wrongSignature ? wrongKeys.privateKey : keys.privateKey,
    { algorithm: "RS256", keyid: "audit-rsa" },
  );
  response.writeHead(200, { "content-type": "application/json" }).end(
    JSON.stringify({
      access_token: "fake-upstream-access-token",
      token_type: "Bearer",
      expires_in: 300,
      id_token: idToken,
    }),
  );
});
idp.listen(0, "127.0.0.1");
await once(idp, "listening");
process.env.DEX_INTERNAL_PORT = String(idp.address().port);
const storageDir = await mkdtemp(
  path.join(os.tmpdir(), "werkyn-oidc-security-"),
);
process.env.STORAGE_DIR = storageDir;
const { buildApp } = await import("../../src/app.js");
const { hashToken } = await import("../../src/utils/tokens.js");
const oidcProviderNamespace = (issuer) =>
  `oidc:${crypto.createHash("sha256").update(issuer).digest("base64url")}`;
let app, originalConfig;
const states = [];
let requestNumber = 0;

function request(url, cookies) {
  return app.inject({
    method: "GET",
    url,
    cookies,
    remoteAddress: `10.41.${Math.floor(++requestNumber / 250)}.${(requestNumber % 250) + 1}`,
  });
}

async function start(options = {}) {
  const query = new URLSearchParams({
    ...(options.connector === null
      ? {}
      : { connector_id: options.connector ?? connectorId }),
    return_url: options.returnUrl ?? "/workspace",
  });
  const response = await request(
    `/api/auth/oidc/login?${query}`,
    options.cookies,
  );
  assert.equal(response.statusCode, 302, response.body);
  const url = new URL(response.headers.location);
  assert.equal(url.pathname, "/dex/auth", response.headers.location);
  const state = url.searchParams.get("state");
  states.push(state);
  const row = await app.prisma.oidcState.findUniqueOrThrow({
    where: { state },
  });
  assert.equal(
    url.searchParams.get("code_challenge"),
    crypto.createHash("sha256").update(row.codeVerifier).digest("base64url"),
  );
  assert.equal(url.searchParams.get("nonce"), row.nonce);
  return { state: row, response };
}

function issue(attempt, claims, options = {}) {
  const code = crypto.randomBytes(16).toString("hex");
  codes.set(code, { state: attempt.state, claims, ...options });
  return code;
}

async function callback(attempt, code, options = {}) {
  const query = new URLSearchParams({
    code,
    state: attempt.state.state,
    ...(options.query ?? {}),
  });
  return request(`/api/auth/oidc/callback?${query}`);
}

function expectFailure(response) {
  assert.equal(response.statusCode, 302, response.body);
  assert.equal(
    new URL(response.headers.location).pathname,
    "/login",
    response.headers.location,
  );
  assert.equal(
    response.cookies.some((c) => c.name === "refresh_token" && c.value),
    false,
  );
}

async function expectSuccess(response) {
  assert.equal(response.statusCode, 302, response.body);
  assert.equal(
    new URL(response.headers.location).pathname,
    "/auth/oidc/complete",
    response.headers.location,
  );
  const cookie = response.cookies.find((c) => c.name === "refresh_token");
  assert(cookie?.value);
  const record = await app.prisma.refreshToken.findUniqueOrThrow({
    where: { token: hashToken(cookie.value) },
    include: { user: true },
  });
  return record.user;
}

async function identityCounts() {
  return Promise.all([
    app.prisma.user.count(),
    app.prisma.authProvider.count(),
    app.prisma.refreshToken.count(),
  ]);
}

function user(email, verified = true) {
  return app.prisma.user.create({
    data: {
      email: `${email}@${domain}`,
      displayName: email,
      emailVerified: verified,
      passwordHash: "unchanged-local-password-hash",
    },
  });
}

before(async () => {
  app = await buildApp();
  await app.ready();
  originalConfig = await app.prisma.ssoConfig.findUnique({
    where: { id: "singleton" },
  });
  await app.prisma.ssoConfig.upsert({
    where: { id: "singleton" },
    create: { enabled: true },
    update: { enabled: true, autoLinkByEmail: true },
  });
  await app.prisma.ssoConnector.createMany({
    data: [connectorId, secondConnectorId].map((connectorId) => ({
      connectorId,
      name: "Audit fake IdP",
      type: "oidc",
      config: {},
      enabled: true,
    })),
  });
});

after(async () => {
  try {
    if (app) {
      await app.prisma.oidcState.deleteMany({
        where: { state: { in: states } },
      });
      await app.prisma.user.deleteMany({
        where: { email: { endsWith: `@${domain}` } },
      });
      await app.prisma.ssoConnector.deleteMany({
        where: { connectorId: { in: [connectorId, secondConnectorId] } },
      });
      if (originalConfig)
        await app.prisma.ssoConfig.update({
          where: { id: "singleton" },
          data: {
            enabled: originalConfig.enabled,
            autoLinkByEmail: originalConfig.autoLinkByEmail,
            passwordLoginEnabled: originalConfig.passwordLoginEnabled,
          },
        });
      else
        await app.prisma.ssoConfig.deleteMany({ where: { id: "singleton" } });
    }
  } finally {
    await app?.close();
    idp.close();
    await once(idp, "close");
    await rm(storageDir, { recursive: true, force: true });
  }
});

test("signed IdP login preserves PKCE/nonce and creates an issuer-scoped verified identity", async () => {
  const attempt = await start();
  assert(
    new URL(attempt.response.headers.location).searchParams
      .get("scope")
      .split(" ")
      .includes("federated:id"),
  );
  const account = await expectSuccess(
    await callback(
      attempt,
      issue(attempt, { sub: "new-subject", email: `new-person@${domain}` }),
    ),
  );
  assert.equal(account.email, `new-person@${domain}`);
  assert.equal(account.emailVerified, true);
  assert.equal(account.passwordHash, null);
  const provider = await app.prisma.authProvider.findFirstOrThrow({
    where: { userId: account.id },
  });
  assert.equal(provider.provider, oidcProviderNamespace(issuer));
  assert.equal(provider.providerSub, "new-subject");
  assert.equal(provider.connectorId, connectorId);
});

test("disabled auto-link refuses verified email collisions without new provider or password changes", async () => {
  const existing = await user("disabled-link");
  await app.prisma.ssoConfig.update({
    where: { id: "singleton" },
    data: { autoLinkByEmail: false },
  });
  const a = await start();
  const response = await callback(a, issue(a, { email: existing.email }));
  expectFailure(response);
  assert.match(
    decodeURIComponent(response.headers.location),
    /linking is disabled/,
  );
  assert.equal(
    await app.prisma.authProvider.count({ where: { userId: existing.id } }),
    0,
  );
  assert.deepEqual(
    await app.prisma.user.findUnique({ where: { id: existing.id } }),
    existing,
  );
  await app.prisma.ssoConfig.update({
    where: { id: "singleton" },
    data: { autoLinkByEmail: true },
  });
});

test("auto-link permits only verified email matching an already-verified local account", async () => {
  const existing = await user("verified-link");
  const a = await start();
  const linked = await expectSuccess(
    await callback(
      a,
      issue(a, {
        email: existing.email.toUpperCase(),
        sub: "verified-link-subject",
      }),
    ),
  );
  assert.equal(linked.id, existing.id);
  assert.equal(linked.passwordHash, existing.passwordHash);
  assert.equal(
    await app.prisma.authProvider.count({ where: { userId: existing.id } }),
    1,
  );
  const unverified = await user("pre-registered", false);
  const b = await start();
  expectFailure(await callback(b, issue(b, { email: unverified.email })));
  assert.deepEqual(
    await app.prisma.user.findUnique({ where: { id: unverified.id } }),
    unverified,
  );
  assert.equal(
    await app.prisma.authProvider.count({ where: { userId: unverified.id } }),
    0,
  );
});

test("unverified, missing or malformed claims cannot create or link accounts", async () => {
  const initial = await identityCounts();
  for (const [claims, omit] of [
    [{ email_verified: false }, []],
    [{}, ["email_verified"]],
    [{ email_verified: "true" }, []],
    [{ email: 42 }, []],
    [{ email: "invalid" }, []],
    [{}, ["email"]],
    [{ name: { attacker: true } }, []],
  ]) {
    const a = await start();
    expectFailure(await callback(a, issue(a, claims, { omit })));
  }
  assert.deepEqual(await identityCounts(), initial);
});

test("legacy linked subjects migrate and keep logging in when auto-link is disabled or email changes", async () => {
  const owner = await user("legacy-owner"),
    another = await user("changed-email-owner");
  const legacy = await app.prisma.authProvider.create({
    data: {
      userId: owner.id,
      provider: "oidc",
      providerSub: "legacy-stable-subject",
      connectorId,
      email: owner.email,
    },
  });
  await app.prisma.ssoConfig.update({
    where: { id: "singleton" },
    data: { autoLinkByEmail: false },
  });
  const a = await start();
  const signedIn = await expectSuccess(
    await callback(
      a,
      issue(a, {
        sub: "legacy-stable-subject",
        email: another.email,
        email_verified: false,
      }),
    ),
  );
  assert.equal(signedIn.id, owner.id);
  assert.equal(signedIn.email, owner.email);
  const migrated = await app.prisma.authProvider.findUniqueOrThrow({
    where: { id: legacy.id },
  });
  assert.equal(migrated.provider, oidcProviderNamespace(issuer));
  assert.equal(migrated.userId, owner.id);
  assert.equal(
    await app.prisma.authProvider.count({ where: { userId: another.id } }),
    0,
  );
  const b = await start();
  assert.equal(
    (
      await expectSuccess(
        await callback(
          b,
          issue(
            b,
            { sub: "legacy-stable-subject" },
            { omit: ["email", "email_verified"] },
          ),
        ),
      )
    ).id,
    owner.id,
  );
  await app.prisma.ssoConfig.update({
    where: { id: "singleton" },
    data: { autoLinkByEmail: true },
  });
});

test("connector mismatch rejects existing bindings and disabled connectors cannot initiate or complete", async () => {
  const owner = await user("connector-owner");
  await app.prisma.authProvider.create({
    data: {
      userId: owner.id,
      provider: "oidc",
      providerSub: "connector-subject",
      connectorId,
    },
  });
  const wrong = await start({ connector: secondConnectorId });
  expectFailure(
    await callback(
      wrong,
      issue(wrong, { sub: "connector-subject", email: owner.email }),
    ),
  );
  assert.equal(
    (await app.prisma.authProvider.findFirst({ where: { userId: owner.id } }))
      .provider,
    "oidc",
  );
  const pending = await start();
  await app.prisma.ssoConnector.update({
    where: { connectorId },
    data: { enabled: false },
  });
  expectFailure(
    await request(`/api/auth/oidc/login?connector_id=${connectorId}`),
  );
  const before = tokenRequests;
  expectFailure(await callback(pending, issue(pending, {})));
  assert.equal(tokenRequests, before);
  await app.prisma.ssoConnector.update({
    where: { connectorId },
    data: { enabled: true },
  });
});

test("SSO disable is checked at initiation and callback", async () => {
  const pending = await start();
  await app.prisma.ssoConfig.update({
    where: { id: "singleton" },
    data: { enabled: false },
  });
  expectFailure(
    await request(`/api/auth/oidc/login?connector_id=${connectorId}`),
  );
  expectFailure(await callback(pending, issue(pending, {})));
  await app.prisma.ssoConfig.update({
    where: { id: "singleton" },
    data: { enabled: true },
  });
});

test("signed actual connector binds unhinted sign-ins and rejects missing or mismatched federated claims", async () => {
  const unhinted = await start({ connector: null });
  const account = await expectSuccess(
    await callback(unhinted, issue(unhinted, {})),
  );
  assert.equal(
    (
      await app.prisma.authProvider.findFirstOrThrow({
        where: { userId: account.id },
      })
    ).connectorId,
    connectorId,
  );
  for (const [claims, options] of [
    [
      {
        federated_claims: {
          connector_id: secondConnectorId,
          user_id: "other-user",
        },
      },
      {},
    ],
    [{ federated_claims: false }, {}],
    [{ federated_claims: { connector_id: 42 } }, {}],
    [{}, { omit: ["federated_claims"] }],
  ]) {
    const attempt = await start();
    expectFailure(await callback(attempt, issue(attempt, claims, options)));
  }
});

test("unhinted callbacks cannot bypass a disabled connector on legacy or current linked identities", async () => {
  for (const [name, provider] of [
    ["legacy-disabled", "oidc"],
    ["current-disabled", oidcProviderNamespace(issuer)],
  ]) {
    const owner = await user(name);
    await app.prisma.authProvider.create({
      data: {
        userId: owner.id,
        provider,
        providerSub: `${name}-subject`,
        connectorId,
      },
    });
    const attempt = await start({ connector: null });
    await app.prisma.ssoConnector.update({
      where: { connectorId },
      data: { enabled: false },
    });
    try {
      expectFailure(
        await callback(
          attempt,
          issue(attempt, { sub: `${name}-subject`, email: owner.email }),
        ),
      );
      assert.equal(
        await app.prisma.refreshToken.count({ where: { userId: owner.id } }),
        0,
      );
      assert.equal(
        (
          await app.prisma.authProvider.findFirstOrThrow({
            where: { userId: owner.id },
          })
        ).provider,
        provider,
      );
    } finally {
      await app.prisma.ssoConnector.update({
        where: { connectorId },
        data: { enabled: true },
      });
    }
  }
});

test("wrong signature, issuer, audience, nonce and expired ID tokens preserve accounts and sessions", async () => {
  const before = await identityCounts();
  for (const [claims, options] of [
    [{}, { wrongSignature: true }],
    [{ iss: "https://foreign-issuer.example" }, {}],
    [{ aud: "different-client" }, {}],
    [{ nonce: "not-the-login-nonce" }, {}],
    [{ exp: Math.floor(Date.now() / 1000) - 120 }, {}],
  ]) {
    const a = await start();
    expectFailure(await callback(a, issue(a, claims, options)));
  }
  assert.deepEqual(await identityCounts(), before);
});

test("concurrent first SSO logins for the same subject create one account and provider", async () => {
  const a = await start(),
    b = await start();
  const email = `concurrent-person@${domain}`;
  const claims = { sub: "concurrent-subject", email };
  const results = await Promise.all([
    callback(a, issue(a, claims)),
    callback(b, issue(b, claims)),
  ]);
  const users = await Promise.all(results.map(expectSuccess));
  assert.equal(users[0].id, users[1].id);
  assert.equal(await app.prisma.user.count({ where: { email } }), 1);
  assert.equal(
    await app.prisma.authProvider.count({ where: { userId: users[0].id } }),
    1,
  );
});

test("legacy links without a recorded connector upgrade using the actual signed connector", async () => {
  const owner = await user("legacy-no-connector");
  const legacy = await app.prisma.authProvider.create({
    data: {
      userId: owner.id,
      provider: "oidc",
      providerSub: "legacy-no-connector-subject",
    },
  });
  const attempt = await start({ connector: null });
  const signedIn = await expectSuccess(
    await callback(
      attempt,
      issue(
        attempt,
        { sub: legacy.providerSub },
        { omit: ["email", "email_verified"] },
      ),
    ),
  );
  assert.equal(signedIn.id, owner.id);
  const migrated = await app.prisma.authProvider.findUniqueOrThrow({
    where: { id: legacy.id },
  });
  assert.equal(migrated.connectorId, connectorId);
  assert.equal(migrated.provider, oidcProviderNamespace(issuer));
});

test("an identity from this issuer does not adopt another issuer's existing subject binding", async () => {
  const owner = await user("other-issuer-owner");
  const otherProvider = await app.prisma.authProvider.create({
    data: {
      userId: owner.id,
      provider: oidcProviderNamespace("https://previous-idp.example.test/dex"),
      providerSub: "shared-raw-subject",
      connectorId,
    },
  });
  const attempt = await start();
  const signedIn = await expectSuccess(
    await callback(
      attempt,
      issue(attempt, {
        sub: otherProvider.providerSub,
        email: `issuer-isolated@${domain}`,
      }),
    ),
  );
  assert.notEqual(signedIn.id, owner.id);
  assert.deepEqual(
    await app.prisma.authProvider.findUniqueOrThrow({
      where: { id: otherProvider.id },
    }),
    otherProvider,
  );
  assert.equal(
    (
      await app.prisma.authProvider.findFirstOrThrow({
        where: { userId: signedIn.id },
      })
    ).provider,
    oidcProviderNamespace(issuer),
  );
});
