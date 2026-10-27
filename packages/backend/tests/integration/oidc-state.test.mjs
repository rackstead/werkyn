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
process.env.JWT_SECRET = "oidc-state-integration-jwt-secret";
process.env.COOKIE_SECRET = "oidc-state-integration-cookie-secret";
process.env.COOKIE_SECURE = "false";
process.env.COOKIE_SAMESITE = "strict";
process.env.FRONTEND_URL = "http://oidc-integration.example.test";
process.env.DEX_CLIENT_SECRET = "oidc-state-fake-client-secret";
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
const storageDir = await mkdtemp(path.join(os.tmpdir(), "werkyn-oidc-state-"));
process.env.STORAGE_DIR = storageDir;
const { buildApp } = await import("../../src/app.js");
const { hashToken } = await import("../../src/utils/tokens.js");
const { oidcProviderNamespace } =
  await import("../../src/modules/auth/oidc/oidc-identity.js");
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
  assert(url.searchParams.get("scope").split(" ").includes("federated:id"));
  const state = url.searchParams.get("state");
  states.push(state);
  const row = await app.prisma.oidcState.findUniqueOrThrow({
    where: { state },
  });
  const cookie = response.cookies.find((c) => c.name === `oidc_state_${state}`);
  assert(cookie?.value, "login sets a signed browser binding cookie");
  assert.equal(
    url.searchParams.get("code_challenge"),
    crypto.createHash("sha256").update(row.codeVerifier).digest("base64url"),
  );
  assert.equal(url.searchParams.get("nonce"), row.nonce);
  return { state: row, cookie, response };
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
  const cookies =
    options.cookies === undefined
      ? { [attempt.cookie.name]: attempt.cookie.value }
      : options.cookies;
  return request(`/api/auth/oidc/callback?${query}`, cookies);
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
  assert.equal(response.headers["cache-control"], "no-store");
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

test("normal signed IdP login enforces PKCE/nonce and sets secure browser binding attributes", async () => {
  const attempt = await start();
  const setCookie =
    attempt.response.headers["set-cookie"].join?.("; ") ??
    attempt.response.headers["set-cookie"];
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Lax/);
  assert.match(setCookie, /Path=\/api\/auth\/oidc/);
  assert.match(setCookie, /Max-Age=600/);
  assert.equal(attempt.response.headers["cache-control"], "no-store");
  const account = await expectSuccess(
    await callback(
      attempt,
      issue(attempt, { sub: "new-subject", email: `new-person@${domain}` }),
    ),
  );
  assert.equal(account.email, `new-person@${domain}`);
  assert.equal(account.emailVerified, true);
  assert.equal(account.passwordHash, null);
  assert.equal(
    new URL(
      (await request("/api/auth/oidc/callback?state=invalid")).headers.location,
    ).pathname,
    "/login",
  );
  const provider = await app.prisma.authProvider.findFirstOrThrow({
    where: { userId: account.id },
  });
  assert.equal(provider.provider, oidcProviderNamespace(issuer));
  assert.equal(provider.providerSub, "new-subject");
  assert.equal(
    await app.prisma.oidcState.count({ where: { state: attempt.state.state } }),
    0,
  );
});

test("missing, forged, mismatched and foreign-browser cookies fail before token exchange and preserve pending state", async () => {
  const a = await start(),
    b = await start();
  const requestsBefore = tokenRequests;
  for (const cookies of [
    {},
    { [a.cookie.name]: a.state.state },
    { [a.cookie.name]: b.cookie.value },
  ]) {
    expectFailure(await callback(a, "unused-code", { cookies }));
    assert.equal(
      await app.prisma.oidcState.count({ where: { state: a.state.state } }),
      1,
    );
  }
  assert.equal(tokenRequests, requestsBefore);
  await expectSuccess(await callback(a, issue(a, {})));
});

test("expired state and replay cannot exchange codes or mint additional sessions", async () => {
  const expired = await start();
  await app.prisma.oidcState.update({
    where: { id: expired.state.id },
    data: { expiresAt: new Date(Date.now() - 1000) },
  });
  const before = tokenRequests;
  expectFailure(await callback(expired, "never-exchanged"));
  assert.equal(tokenRequests, before);
  const a = await start(),
    code = issue(a, {});
  await expectSuccess(await callback(a, code));
  const count = await app.prisma.refreshToken.count();
  expectFailure(await callback(a, code));
  assert.equal(await app.prisma.refreshToken.count(), count);
});

test("concurrent callbacks consume one state atomically and exchange once", async () => {
  const a = await start(),
    code = issue(a, {}),
    before = tokenRequests;
  const results = await Promise.all([callback(a, code), callback(a, code)]);
  const successes = results.filter(
    (r) => new URL(r.headers.location).pathname === "/auth/oidc/complete",
  );
  assert.equal(successes.length, 1);
  expectFailure(results.find((r) => r !== successes[0]));
  await expectSuccess(successes[0]);
  assert.equal(tokenRequests - before, 1);
});

test("parallel tabs retain independent signed states, and only the latest five cookies are retained", async () => {
  const jar = {};
  const first = await start();
  jar[first.cookie.name] = first.cookie.value;
  const second = await start({ cookies: jar });
  jar[second.cookie.name] = second.cookie.value;
  await expectSuccess(
    await callback(second, issue(second, {}), { cookies: jar }),
  );
  await expectSuccess(
    await callback(first, issue(first, {}), { cookies: jar }),
  );
  const attempts = [];
  for (let i = 0; i < 6; i++) {
    const a = await start({ cookies: jar });
    attempts.push(a);
    for (const cookie of a.response.cookies) {
      if (cookie.value) jar[cookie.name] = cookie.value;
      else delete jar[cookie.name];
    }
  }
  assert.equal(Object.keys(jar).length, 5);
  assert.equal(jar[attempts[0].cookie.name], undefined);
  expectFailure(await callback(attempts[0], "discarded", { cookies: jar }));
  await expectSuccess(
    await callback(attempts.at(-1), issue(attempts.at(-1), {}), {
      cookies: jar,
    }),
  );
});

test("authorization response issuer mismatch is rejected before token exchange", async () => {
  const attempt = await start();
  const before = tokenRequests;
  expectFailure(
    await callback(attempt, issue(attempt, {}), {
      query: { iss: "https://foreign-issuer.example" },
    }),
  );
  assert.equal(tokenRequests, before);
});

test("provider errors consume browser-bound state without reflecting upstream descriptions", async () => {
  const a = await start();
  const response = await callback(a, "unused", {
    query: {
      error: "access_denied",
      error_description: "private-upstream-secret",
    },
  });
  expectFailure(response);
  assert(!response.headers.location.includes("private-upstream-secret"));
  assert.equal(
    await app.prisma.oidcState.count({ where: { state: a.state.state } }),
    0,
  );
  expectFailure(await callback(a, issue(a, {})));
});

test("return URL stays local for malformed, protocol-relative and encoded paths", async () => {
  for (const returnUrl of [
    "//attacker.example",
    "/%2f%2fattacker.example",
    "/%zz",
    "/%5cattacker.example",
  ]) {
    const a = await start({ returnUrl });
    const response = await callback(a, issue(a, {}));
    await expectSuccess(response);
    assert.equal(
      new URL(response.headers.location).searchParams.get("return_url"),
      "/",
    );
  }
});

test("two real PostgreSQL state reads elect exactly one conditional claimant", async () => {
  const attempt = await start();
  const { consumeOidcState } =
    await import("../../src/modules/auth/oidc/oidc-state.js");
  let reads = 0;
  let releaseReads;
  const bothRead = new Promise((resolve) => {
    releaseReads = resolve;
  });
  // Gate delivery of real PostgreSQL results so both consumers see the pending
  // row. The conditional deletes below are actual competing database writes.
  const database = {
    oidcState: {
      findUnique: async (args) => {
        const row = await app.prisma.oidcState.findUnique(args);
        if (++reads === 2) releaseReads();
        await bothRead;
        return row;
      },
      deleteMany: (args) => app.prisma.oidcState.deleteMany(args),
    },
  };
  const before = tokenRequests;
  const results = await Promise.allSettled([
    consumeOidcState(database, attempt.state.state, attempt.state.state),
    consumeOidcState(database, attempt.state.state, attempt.state.state),
  ]);
  assert.equal(reads, 2);
  assert.deepEqual(results.map((result) => result.status).sort(), [
    "fulfilled",
    "rejected",
  ]);
  assert.match(
    results.find((result) => result.status === "rejected").reason.message,
    /already used/,
  );
  assert.equal(
    await app.prisma.oidcState.count({ where: { id: attempt.state.id } }),
    0,
  );
  assert.equal(tokenRequests, before);
});

test(
  "a state expiring while its PostgreSQL claim waits cannot complete consumption",
  { timeout: 10000 },
  async () => {
    const attempt = await start();
    const { consumeOidcState } =
      await import("../../src/modules/auth/oidc/oidc-state.js");
    const expiresAt = new Date(Date.now() + 1000);
    await app.prisma.oidcState.update({
      where: { id: attempt.state.id },
      data: { expiresAt },
    });
    let unlock, locked, requested;
    const unlockGate = new Promise((resolve) => {
      unlock = resolve;
    });
    const lockReady = new Promise((resolve) => {
      locked = resolve;
    });
    const deletionRequested = new Promise((resolve) => {
      requested = resolve;
    });
    const lock = app.prisma.$transaction(
      async (tx) => {
        await tx.$queryRawUnsafe(
          'SELECT id FROM "OidcState" WHERE id = $1 FOR UPDATE',
          attempt.state.id,
        );
        locked();
        await unlockGate;
      },
      { timeout: 5000 },
    );
    try {
      await lockReady;
      const database = {
        oidcState: {
          findUnique: (args) => app.prisma.oidcState.findUnique(args),
          deleteMany: (args) => {
            requested();
            return app.prisma.oidcState.deleteMany(args);
          },
        },
      };
      const claim = consumeOidcState(
        database,
        attempt.state.state,
        attempt.state.state,
      );
      await Promise.race([
        deletionRequested,
        claim.then(
          () => {
            throw new Error(
              "Claim completed before the database lock released",
            );
          },
          (error) => {
            throw error;
          },
        ),
      ]);
      await new Promise((resolve) =>
        setTimeout(resolve, Math.max(0, expiresAt.getTime() - Date.now() + 30)),
      );
      unlock();
      await lock;
      await assert.rejects(claim, /expired/);
      assert.equal(
        await app.prisma.oidcState.count({ where: { id: attempt.state.id } }),
        0,
      );
    } finally {
      unlock();
      await lock;
    }
  },
);

test("malformed callback query values neither consume pending state nor create identity/session records", async () => {
  const attempt = await start();
  const before = await Promise.all([
    app.prisma.user.count(),
    app.prisma.authProvider.count(),
    app.prisma.refreshToken.count(),
  ]);
  const requestsBefore = tokenRequests;
  for (const query of [
    "state=invalid&code=unused",
    `state=${attempt.state.state}&state=${attempt.state.state}&code=unused`,
    `state=${attempt.state.state}&code=${"c".repeat(4097)}`,
  ]) {
    expectFailure(
      await request(`/api/auth/oidc/callback?${query}`, {
        [attempt.cookie.name]: attempt.cookie.value,
      }),
    );
    assert.equal(
      await app.prisma.oidcState.count({ where: { id: attempt.state.id } }),
      1,
    );
    assert.deepEqual(
      await Promise.all([
        app.prisma.user.count(),
        app.prisma.authProvider.count(),
        app.prisma.refreshToken.count(),
      ]),
      before,
    );
  }
  assert.equal(tokenRequests, requestsBefore);
  await expectSuccess(await callback(attempt, issue(attempt, {})));
});

test("configured secure browser bindings stay host-only and provider errors need the matching binding", async () => {
  const { env } = await import("../../src/config/env.js");
  const originalSecure = env.COOKIE_SECURE;
  const originalDomain = env.COOKIE_DOMAIN;
  try {
    env.COOKIE_SECURE = true;
    env.COOKIE_DOMAIN = ".example.test";
    const attempt = await start();
    const header = []
      .concat(attempt.response.headers["set-cookie"])
      .find((value) => value.startsWith(attempt.cookie.name + "="));
    assert.match(header, /; Secure(?:;|$)/);
    assert.match(header, /; HttpOnly(?:;|$)/);
    assert.match(header, /; SameSite=Lax(?:;|$)/);
    assert.doesNotMatch(header, /; Domain=/i);
    const before = tokenRequests;
    const response = await callback(attempt, "unused", {
      cookies: {},
      query: {
        error: "access_denied",
        error_description: "private-provider-description",
      },
    });
    expectFailure(response);
    assert(!response.headers.location.includes("private-provider-description"));
    assert.equal(
      await app.prisma.oidcState.count({ where: { id: attempt.state.id } }),
      1,
    );
    assert.equal(tokenRequests, before);
    await expectSuccess(await callback(attempt, issue(attempt, {})));
  } finally {
    env.COOKIE_SECURE = originalSecure;
    env.COOKIE_DOMAIN = originalDomain;
  }
});

test("callback rate limit bounds repeated invalid requests before state or identity work", async () => {
  const before = await Promise.all([
    app.prisma.oidcState.count(),
    app.prisma.user.count(),
    app.prisma.authProvider.count(),
    app.prisma.refreshToken.count(),
  ]);
  const requestsBefore = tokenRequests;
  for (let index = 0; index < 31; index++) {
    const response = await app.inject({
      method: "GET",
      url: "/api/auth/oidc/callback?state=invalid&code=unused",
      remoteAddress: "10.88.0.1",
    });
    assert.equal(response.statusCode, index < 30 ? 302 : 429, response.body);
  }
  assert.deepEqual(
    await Promise.all([
      app.prisma.oidcState.count(),
      app.prisma.user.count(),
      app.prisma.authProvider.count(),
      app.prisma.refreshToken.count(),
    ]),
    before,
  );
  assert.equal(tokenRequests, requestsBefore);
});
