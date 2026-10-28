import { randomUUID } from "node:crypto";
import { mkdir, open, rename, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stringify } from "yaml";
import type { PrismaClient } from "@prisma/client";
import { DexConnectorTypeMap } from "@pm/shared";
import { env } from "../config/env.js";

interface DexConfig {
  issuer: string;
  storage: Record<string, unknown>;
  web: { http: string };
  oauth2: { skipApprovalScreen: boolean };
  staticClients: Array<{
    id: string;
    name: string;
    redirectURIs: string[];
    secret: string;
  }>;
  connectors: Array<{
    type: string;
    id: string;
    name: string;
    config: Record<string, unknown>;
  }>;
}

// Prisma resolves relative certificate paths in DATABASE_URL against the
// directory holding schema.prisma (packages/backend/prisma), from src or dist.
const PRISMA_SCHEMA_DIR = fileURLToPath(
  new URL("../../prisma/", import.meta.url),
);

interface DexPostgresSsl {
  mode: "disable" | "require" | "verify-ca" | "verify-full";
  caFile?: string;
  certFile?: string;
  keyFile?: string;
}

/**
 * Derives Dex's PostgreSQL TLS settings from the sslmode in DATABASE_URL, so
 * Dex requires TLS whenever Werkyn does. Dex's driver supports only disable,
 * require, verify-ca and verify-full and cannot fall back between plaintext
 * and TLS:
 * - no sslmode, disable, allow or prefer: plaintext, since these let Werkyn
 *   connect without TLS too (the bundled Compose database has none);
 * - require: TLS required (verify-full with Prisma's sslaccept=strict);
 * - verify-ca or verify-full: TLS required with certificate verification.
 * The trusted certificate is sslrootcert or, in Prisma's format, sslcert. A
 * libpq client certificate (sslcert with sslkey) is passed on as well.
 */
export function dexPostgresSsl(params: URLSearchParams): DexPostgresSsl {
  const requested = (params.get("sslmode") ?? "disable").toLowerCase();
  let mode: DexPostgresSsl["mode"];
  switch (requested) {
    case "disable":
    case "allow":
    case "prefer":
      mode = "disable";
      break;
    case "require":
      mode =
        params.get("sslaccept")?.toLowerCase() === "strict"
          ? "verify-full"
          : "require";
      break;
    case "verify-ca":
    case "verify-full":
      mode = requested;
      break;
    default:
      throw new Error(
        `DATABASE_URL sslmode "${requested}" is not supported for Dex; use disable, require, verify-ca or verify-full`,
      );
  }

  const ssl: DexPostgresSsl = { mode };
  if (mode === "disable") return ssl;

  if (params.get("sslidentity")) {
    throw new Error(
      "DATABASE_URL sslidentity (a PKCS12 client certificate) cannot be used by Dex; use sslcert and sslkey PEM files",
    );
  }
  const file = (name: string) => {
    const value = params.get(name);
    return value ? path.resolve(PRISMA_SCHEMA_DIR, value) : undefined;
  };
  const rootCert = file("sslrootcert");
  const cert = file("sslcert");
  const key = file("sslkey");
  // Prisma's sslcert is the certificate to trust; libpq's is the client
  // certificate that goes with sslkey.
  const clientPair = cert !== undefined && key !== undefined;
  const caFile =
    params.get("sslrootcert") === "system"
      ? undefined
      : (rootCert ?? (clientPair ? undefined : cert));
  if (caFile) ssl.caFile = caFile;
  if (clientPair) {
    ssl.certFile = cert;
    ssl.keyFile = key;
  }
  return ssl;
}

function parsePostgresUrl(url: string) {
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : 5432,
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    database: parsed.pathname.replace(/^\//, ""),
    ssl: dexPostgresSsl(parsed.searchParams),
  };
}

// The config holds the Dex client secret and, with PostgreSQL storage, the
// database password. Write it owner-only to a new file and rename it into
// place, so an existing file's wider mode is not kept and Dex never reads a
// partly written config.
async function writePrivateFile(
  filePath: string,
  contents: string,
): Promise<void> {
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${randomUUID()}.tmp`,
  );
  try {
    const handle = await open(tempPath, "wx", 0o600);
    try {
      await handle.writeFile(contents, "utf-8");
      await handle.chmod(0o600);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tempPath, filePath);
  } catch (err) {
    await rm(tempPath, { force: true });
    throw err;
  }
}

export async function generateDexConfig(prisma: PrismaClient): Promise<string> {
  const ssoConfig = await prisma.ssoConfig.findUnique({
    where: { id: "singleton" },
    include: {
      connectors: { where: { enabled: true }, orderBy: { position: "asc" } },
    },
  });

  if (!ssoConfig || !ssoConfig.enabled || ssoConfig.connectors.length === 0) {
    throw new Error("SSO is not enabled or no connectors configured");
  }

  const storage: Record<string, unknown> =
    env.DEX_STORAGE_TYPE === "postgres"
      ? { type: "postgres", config: parsePostgresUrl(env.DATABASE_URL) }
      : {
          type: "sqlite3",
          config: { file: path.join(env.DEX_CONFIG_DIR, "dex.db") },
        };

  const dexConfig: DexConfig = {
    issuer: `${env.FRONTEND_URL}/dex`,
    storage,
    web: { http: `127.0.0.1:${env.DEX_INTERNAL_PORT}` },
    oauth2: { skipApprovalScreen: true },
    staticClients: [
      {
        id: "werkyn",
        name: "Werkyn",
        redirectURIs: [`${env.FRONTEND_URL}/api/auth/oidc/callback`],
        secret: env.DEX_CLIENT_SECRET,
      },
    ],
    connectors: ssoConfig.connectors.map((c) => {
      const dexType = DexConnectorTypeMap[c.type] ?? c.type;
      const config = { ...(c.config as Record<string, unknown>) };

      // OIDC-based connectors need redirectURI so Dex knows where
      // the upstream provider should send the user back to.
      if (dexType === "oidc" && !config.redirectURI) {
        config.redirectURI = `${env.FRONTEND_URL}/dex/callback`;
      }

      return { type: dexType, id: c.connectorId, name: c.name, config };
    }),
  };

  await mkdir(env.DEX_CONFIG_DIR, { recursive: true, mode: 0o700 });
  const configPath = path.join(env.DEX_CONFIG_DIR, "dex-config.yaml");
  await writePrivateFile(configPath, stringify(dexConfig));

  return configPath;
}
