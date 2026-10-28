import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const tmp = mkdtempSync(path.join(os.tmpdir(), "werkyn-dex-config-"));
const configDir = path.join(tmp, "dex");

Object.assign(process.env, {
  NODE_ENV: "test",
  LOG_LEVEL: "error",
  DATABASE_URL: "postgresql://werkyn:db-secret@postgres:5432/projectapp",
  JWT_SECRET: "unit-dex-config-jwt-secret",
  COOKIE_SECRET: "unit-dex-config-cookie-secret",
  DEX_CLIENT_SECRET: "unit-dex-client-secret",
  DEX_CONFIG_DIR: configDir,
  DEX_STORAGE_TYPE: "postgres",
});
const { env } = await import("../src/config/env.ts");
const { generateDexConfig } = await import("../src/services/dex-config.ts");

const prisma = {
  ssoConfig: {
    findUnique: async () => ({
      enabled: true,
      connectors: [
        {
          type: "ldap",
          connectorId: "ldap",
          name: "LDAP",
          config: {},
          enabled: true,
          position: 0,
        },
      ],
    }),
  },
};

const originalDatabaseUrl = env.DATABASE_URL;
afterEach(() => {
  env.DATABASE_URL = originalDatabaseUrl;
});
after(() => rmSync(tmp, { recursive: true, force: true }));

const mode = (file) => statSync(file).mode & 0o777;

async function storageFor(databaseUrl) {
  env.DATABASE_URL = databaseUrl;
  const file = await generateDexConfig(prisma);
  return parse(readFileSync(file, "utf8")).storage.config;
}

test("the generated Dex config holding credentials is readable only by its owner", async () => {
  const previousUmask = process.umask(0);
  try {
    const file = await generateDexConfig(prisma);
    assert.equal(mode(file), 0o600);
    const text = readFileSync(file, "utf8");
    assert.match(text, /unit-dex-client-secret/);
    assert.match(text, /db-secret/);
  } finally {
    process.umask(previousUmask);
  }
});

test("a pre-existing world-readable Dex config is replaced with an owner-only file", async () => {
  const file = path.join(configDir, "dex-config.yaml");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(file, "stale: true\n");
  chmodSync(file, 0o644);
  assert.equal(mode(file), 0o644);

  const previousUmask = process.umask(0);
  try {
    assert.equal(await generateDexConfig(prisma), file);
  } finally {
    process.umask(previousUmask);
  }
  assert.equal(mode(file), 0o600);
  assert.doesNotMatch(readFileSync(file, "utf8"), /stale/);
  // No temporary files are left beside it.
  assert.deepEqual(readdirSync(configDir), ["dex-config.yaml"]);
});

test("Dex keeps plaintext PostgreSQL for a URL without sslmode (local Compose)", async () => {
  const storage = await storageFor(
    "postgresql://werkyn:db-secret@postgres:5432/projectapp",
  );
  assert.deepEqual(storage, {
    host: "postgres",
    port: 5432,
    user: "werkyn",
    password: "db-secret",
    database: "projectapp",
    ssl: { mode: "disable" },
  });
  for (const query of ["sslmode=disable", "sslmode=allow"]) {
    assert.deepEqual(
      (await storageFor(`postgresql://u:p@127.0.0.1:5432/db?${query}`)).ssl,
      { mode: "disable" },
      query,
    );
  }
});

test("Dex requires TLS whenever DATABASE_URL requires it", async () => {
  for (const [query, ssl] of [
    ["sslmode=require", { mode: "require" }],
    ["sslmode=REQUIRE", { mode: "require" }],
    // Dex cannot fall back to plaintext, so a stated preference for TLS is
    // enforced rather than dropped.
    ["sslmode=prefer", { mode: "require" }],
    ["sslmode=require&sslaccept=strict", { mode: "verify-full" }],
    [
      "sslmode=verify-ca&sslrootcert=/etc/ssl/db-ca.pem",
      { mode: "verify-ca", caFile: "/etc/ssl/db-ca.pem" },
    ],
    [
      "sslmode=verify-full&sslrootcert=/etc/ssl/ca.pem&sslcert=/etc/ssl/client.pem&sslkey=/etc/ssl/client.key",
      {
        mode: "verify-full",
        caFile: "/etc/ssl/ca.pem",
        certFile: "/etc/ssl/client.pem",
        keyFile: "/etc/ssl/client.key",
      },
    ],
  ]) {
    const storage = await storageFor(
      `postgresql://werkyn:db-secret@db.example.net:6543/werkyn?schema=public&${query}`,
    );
    assert.deepEqual(storage.ssl, ssl, query);
    assert.equal(storage.host, "db.example.net");
    assert.equal(storage.port, 6543);
  }
});

test("relative certificate paths resolve against the Prisma schema directory, as Prisma does", async () => {
  const prismaDir = fileURLToPath(new URL("../prisma/", import.meta.url));
  const storage = await storageFor(
    "postgresql://u:p@db.example.net/werkyn?sslmode=verify-full&sslrootcert=certs/ca.pem",
  );
  assert.deepEqual(storage.ssl, {
    mode: "verify-full",
    caFile: path.join(prismaDir, "certs/ca.pem"),
  });
});

test("an sslmode Dex cannot honor is rejected instead of silently downgraded", async () => {
  env.DATABASE_URL = "postgresql://u:p@db.example.net/werkyn?sslmode=bogus";
  await assert.rejects(generateDexConfig(prisma), /sslmode/);
});
