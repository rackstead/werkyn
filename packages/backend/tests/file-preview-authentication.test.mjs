import assert from "node:assert/strict";
import { test } from "node:test";
import { Prisma } from "@prisma/client";
Object.assign(process.env, {
  NODE_ENV: "test",
  JWT_SECRET: "file-preview-authentication-unit-signing-secret",
  COOKIE_SECRET: "file-preview-authentication-unit-cookie-secret",
  DATABASE_URL:
    "postgresql://audit:audit-local-only@127.0.0.1:32768/werkyn_audit_url_credentials_r13?connection_limit=5",
});
const { signFilePreviewGrant } =
  await import("../src/utils/file-preview-tokens.ts");
const { authenticateFilePreview } =
  await import("../src/modules/files/file-preview.ts");
const { authenticate } = await import("../src/middleware/authenticate.ts");
const { signAccessToken } = await import("../src/utils/tokens.ts");
const claims = {
  sub: "unit-user",
  sid: "unit-family",
  exp: Math.floor(Date.now() / 1000) + 600,
};
const marker = "private-query-credential-marker";
const known = (code) =>
  new Prisma.PrismaClientKnownRequestError(marker, {
    code,
    clientVersion: "test",
  });
function fixture(error) {
  const events = [],
    queries = [];
  const grant = signFilePreviewGrant(claims, "unit-workspace", "unit-file");
  return {
    events,
    queries,
    request: {
      method: "GET",
      query: { token: grant.token },
      params: { wid: "unit-workspace", fid: "unit-file" },
      headers: {
        authorization: `Bearer ${signAccessToken({ sub: claims.sub, email: "unit@example.test", sid: claims.sid })}`,
      },
      server: {
        prisma: {
          user: {
            findUnique: async (query) => {
              queries.push(query);
              if (error) throw error;
              return {
                id: claims.sub,
                email: "unit@example.test",
                displayName: "Unit",
                avatarUrl: null,
                emailVerified: true,
              };
            },
          },
        },
      },
      log: { error: (...args) => events.push(args) },
    },
  };
}
test("preview authentication uses the same current account/session predicate as header authentication", async () => {
  const preview = fixture(),
    header = fixture();
  await authenticateFilePreview(preview.request, {});
  await authenticate(header.request, {});
  assert.equal(preview.request.user.id, claims.sub);
  const first = preview.queries[0],
    second = header.queries[0];
  assert.ok(
    first.where.refreshTokenFamilies.some.tokens.some.expiresAt.gt instanceof
      Date,
  );
  delete first.where.refreshTokenFamilies.some.tokens.some.expiresAt;
  delete second.where.refreshTokenFamilies.some.tokens.some.expiresAt;
  assert.deepEqual(first, second);
  assert.equal(first.where.refreshTokenFamilies.some.id, claims.sid);
  assert.equal(first.where.refreshTokenFamilies.some.revokedAt, null);
});
for (const [label, error, status, category] of [
  ["operational", known("P1001"), 503, "database_operation"],
  ["schema", known("P2021"), 500, "schema"],
  ["programming", new TypeError(marker), 500, "programming"],
  [
    "forged operational code",
    { name: "PrismaError", code: "P1001", message: marker },
    500,
    "unknown",
  ],
]) {
  test(`preview ${label} failures retain safe diagnostics and refuse authentication`, async () => {
    const f = fixture(error);
    await assert.rejects(authenticateFilePreview(f.request, {}), (actual) => {
      assert.equal(actual.statusCode, status);
      assert.equal(actual.message.includes(marker), false);
      return true;
    });
    assert.equal(f.request.user, undefined);
    assert.equal(f.events.length, 1);
    assert.equal(f.events[0][0].authentication.stage, "session_account");
    assert.equal(f.events[0][0].authentication.category, category);
    assert.equal(f.events[0][0].authentication.statusCode, status);
    assert.equal(f.events[0][1], "Authentication lookup failed");
    assert.equal(JSON.stringify(f.events).includes(marker), false);
    assert.equal(
      JSON.stringify(f.events).includes(f.request.query.token),
      false,
    );
  });
}
test("invalid preview credentials fail before any account query or diagnostic exception", async () => {
  const f = fixture();
  f.request.query = { token: "invalid" };
  await assert.rejects(authenticateFilePreview(f.request, {}), {
    statusCode: 401,
  });
  assert.equal(f.queries.length, 0);
  assert.equal(f.events.length, 0);
});
