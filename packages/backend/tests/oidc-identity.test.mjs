import assert from "node:assert/strict";
import test from "node:test";
import {
  oidcProviderNamespace,
  readOidcIdentity,
} from "../src/modules/auth/oidc/oidc-identity.ts";

const issuer = "https://werkyn.example/dex";

test("OIDC profile claims are typed and verified email is a strict boolean", () => {
  const claims = {
    iss: issuer,
    sub: "stable-subject",
    email: " Person@Example.COM ",
    email_verified: true,
    name: " Person ",
    federated_claims: {
      connector_id: "test-connector",
      user_id: "upstream-user",
    },
  };
  assert.deepEqual(readOidcIdentity(claims, issuer), {
    issuer,
    subject: "stable-subject",
    connectorId: "test-connector",
    email: "person@example.com",
    emailVerified: true,
    displayName: "Person",
  });
  for (const changes of [
    { iss: "https://other.example/dex" },
    { sub: "" },
    { sub: 42 },
    { sub: "s".repeat(256) },
    { email: 42 },
    { email: "invalid" },
    { email_verified: "true" },
    { name: { toString: "attacker" } },
    { federated_claims: undefined },
    { federated_claims: false },
    { federated_claims: { connector_id: "" } },
    { federated_claims: { connector_id: 42 } },
  ]) {
    assert.throws(
      () => readOidcIdentity({ ...claims, ...changes }, issuer),
      /Invalid OIDC/,
    );
  }
  assert.equal(
    readOidcIdentity(
      {
        iss: issuer,
        sub: "linked-subject",
        federated_claims: { connector_id: "test-connector" },
      },
      issuer,
    ).emailVerified,
    false,
  );
});

test("issuer namespaces fit the existing schema and cannot overlap the legacy provider", () => {
  const key = oidcProviderNamespace(issuer);
  assert.equal(key.length, 48);
  assert.notEqual(key, "oidc");
  assert.equal(key, oidcProviderNamespace(issuer));
  assert.notEqual(key, oidcProviderNamespace("https://other.example/dex"));
});
