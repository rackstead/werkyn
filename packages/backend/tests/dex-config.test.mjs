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
const { dexPostgresSsl, generateDexConfig } =
  await import("../src/services/dex-config.ts");

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
  // prefer lets Werkyn fall back to plaintext as well, and Dex cannot fall
  // back, so only an explicit requirement makes Dex require TLS.
  for (const query of [
    "sslmode=disable",
    "sslmode=allow",
    "sslmode=prefer",
    "sslmode=prefer&sslaccept=strict&sslcert=ca.pem",
  ]) {
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
    ["sslmode=require&sslaccept=strict", { mode: "verify-full" }],
    [
      "sslmode=verify-ca&sslrootcert=/etc/ssl/db-ca.pem",
      { mode: "verify-ca", caFile: "/etc/ssl/db-ca.pem" },
    ],
    // Prisma's sslcert names the certificate to trust.
    [
      "sslmode=require&sslaccept=strict&sslcert=/etc/ssl/server-ca.pem",
      { mode: "verify-full", caFile: "/etc/ssl/server-ca.pem" },
    ],
    [
      "sslmode=require&sslcert=/etc/ssl/server-ca.pem",
      { mode: "require", caFile: "/etc/ssl/server-ca.pem" },
    ],
    ["sslmode=verify-full&sslrootcert=system", { mode: "verify-full" }],
    // libpq's sslcert and sslkey are a client certificate pair.
    [
      "sslmode=verify-full&sslcert=/etc/ssl/client.pem&sslkey=/etc/ssl/client.key",
      {
        mode: "verify-full",
        certFile: "/etc/ssl/client.pem",
        keyFile: "/etc/ssl/client.key",
      },
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

const sslFor = (query) =>
  dexPostgresSsl(
    new URL(`postgresql://u:p@db.example.net/werkyn?${query}`).searchParams,
  );

test("a repeated TLS parameter is rejected, since Werkyn and Dex could read different values", async () => {
  // Prisma reads the last value and URLSearchParams.get the first, so each of
  // these could leave Dex weaker than Werkyn (or the reverse).
  for (const [query, name] of [
    ["sslmode=disable&sslmode=require", "sslmode"],
    ["sslmode=prefer&sslmode=require", "sslmode"],
    ["sslmode=require&sslmode=disable", "sslmode"],
    ["sslmode=require&sslmode=allow", "sslmode"],
    ["sslmode=require&sslmode=require", "sslmode"],
    ["sslmode=verify-full&sslmode=require", "sslmode"],
    // Percent-encoded names decode to the same parameter for both parsers.
    ["sslmode=disable&ssl%6Dode=require", "sslmode"],
    [
      "sslmode=require&sslaccept=accept_invalid_certs&sslaccept=strict",
      "sslaccept",
    ],
    [
      "sslmode=require&sslaccept=strict&sslaccept=accept_invalid_certs",
      "sslaccept",
    ],
    [
      "sslmode=require&sslaccept=strict&sslcert=/etc/ssl/ca.pem&sslcert=/etc/ssl/other-ca.pem",
      "sslcert",
    ],
    [
      "sslmode=verify-full&sslrootcert=/etc/ssl/ca.pem&sslrootcert=system",
      "sslrootcert",
    ],
    [
      "sslmode=verify-full&sslcert=/etc/ssl/client.pem&sslkey=/etc/ssl/a.key&sslkey=/etc/ssl/b.key",
      "sslkey",
    ],
    ["sslmode=require&sslidentity=a.p12&sslidentity=b.p12", "sslidentity"],
    // Rejected even where Dex would ignore the value today.
    [
      "sslmode=disable&sslcert=/etc/ssl/a.pem&sslcert=/etc/ssl/b.pem",
      "sslcert",
    ],
    ["sslrootcert=/etc/ssl/a.pem&sslrootcert=/etc/ssl/b.pem", "sslrootcert"],
  ]) {
    assert.throws(
      () => sslFor(query),
      (err) =>
        err.message.includes(`"${name}"`) && /more than once/.test(err.message),
      query,
    );
  }

  // The error surfaces when the Dex config is generated, so Dex is not
  // started with either reading.
  env.DATABASE_URL =
    "postgresql://u:p@db.example.net/werkyn?sslmode=disable&sslmode=require";
  await assert.rejects(generateDexConfig(prisma), /"sslmode".*more than once/);
});

test("parameters that are not TLS settings may repeat, and names are case-sensitive as in Prisma", () => {
  assert.deepEqual(
    sslFor(
      "schema=a&schema=b&connection_limit=1&connection_limit=2&sslmode=require",
    ),
    { mode: "require" },
  );
  // Prisma ignores parameter names in another case, so these are not repeats.
  assert.deepEqual(sslFor("SSLMODE=disable&sslmode=require"), {
    mode: "require",
  });
  assert.deepEqual(sslFor("sslmode=require&SslMode=disable"), {
    mode: "require",
  });
});

test("TLS settings Dex cannot honor are rejected instead of silently dropped", async () => {
  env.DATABASE_URL = "postgresql://u:p@db.example.net/werkyn?sslmode=bogus";
  await assert.rejects(generateDexConfig(prisma), /sslmode/);
  env.DATABASE_URL =
    "postgresql://u:p@db.example.net/werkyn?sslmode=require&sslidentity=client.p12&sslpassword=x";
  await assert.rejects(generateDexConfig(prisma), /sslidentity/);
});
