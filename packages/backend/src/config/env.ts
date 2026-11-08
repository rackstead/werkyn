import { z } from "zod";
import { SenderAddressSchema } from "@pm/shared";
import { logger } from "../utils/logger.js";
import {
  THUMBNAIL_WORKER_COUNT_MESSAGE,
  thumbnailWorkerCount,
} from "./thumbnail-worker-count.js";

function wholeNumber(name: string, fallback: number, min: number, max: number) {
  const range = `${name} must be a whole number from ${min} to ${max}`;
  return z.coerce
    .number({ error: range })
    .int(range)
    .min(min, range)
    .max(max, range)
    .default(fallback);
}

const port = (name: string, fallback: number) => wholeNumber(name, fallback, 1, 65535);

function flag(name: string) {
  return z
    .enum(["true", "false"], { error: `${name} must be "true" or "false"` })
    .optional();
}

// zod's default enum message repeats the received value; name the choices
// instead so a secret pasted into the wrong variable is never logged.
function oneOf<const T extends [string, ...string[]]>(name: string, values: T) {
  return z.enum(values, { error: `${name} must be one of: ${values.join(", ")}` });
}

function parseHttpUrl(value: string): URL | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    if (!url.hostname || url.username || url.password) return undefined;
    return url;
  } catch {
    return undefined;
  }
}

const frontendUrl = z
  .string()
  .default("http://localhost:5173")
  .transform((value, ctx) => {
    const url = parseHttpUrl(value.trim());
    if (!url || url.search || url.hash || /[?#]/.test(value)) {
      ctx.addIssue({
        code: "custom",
        message:
          "FRONTEND_URL must be an absolute http(s) URL without credentials, query or fragment",
      });
      return z.NEVER;
    }
    // Callers append paths such as `/dex`, so never keep a trailing slash.
    return url.href.replace(/\/+$/, "");
  });

const corsOrigins = z
  .string()
  .default("http://localhost:5173")
  .transform((value, ctx) => {
    const entries = value.split(",").map((entry) => entry.trim()).filter(Boolean);
    if (entries.length === 0) {
      ctx.addIssue({ code: "custom", message: "CORS_ORIGIN must list at least one origin" });
      return z.NEVER;
    }
    const origins: string[] = [];
    for (const entry of entries) {
      if (entry === "*") {
        ctx.addIssue({
          code: "custom",
          message: 'CORS_ORIGIN="*" is not allowed with credentialed requests; list explicit origins',
        });
        continue;
      }
      const url = parseHttpUrl(entry);
      if (!url || url.pathname !== "/" || url.search || url.hash || /[?#]/.test(entry)) {
        ctx.addIssue({
          code: "custom",
          message:
            "CORS_ORIGIN entries must be comma-separated http(s) origins such as https://app.example.com",
        });
        continue;
      }
      // Browsers send the serialized origin (lowercase host, no default port).
      origins.push(url.origin);
    }
    return origins.join(",");
  });

const DATABASE_PROTOCOLS = new Set(["postgresql:", "postgres:", "prisma:", "prisma+postgres:"]);

const databaseUrl = z.string({ error: "DATABASE_URL is required" })
  .min(1, "DATABASE_URL is required")
  .refine((value) => {
    try {
      // Require the hierarchical form with a host and database name; opaque
      // values such as `postgresql:name` parse as URLs but cannot connect.
      const url = new URL(value);
      return (
        DATABASE_PROTOCOLS.has(url.protocol) &&
        value.slice(url.protocol.length).startsWith("//") &&
        url.hostname !== "" &&
        (url.protocol.startsWith("prisma") || url.pathname.replace(/^\/+/, "") !== "")
      );
    } catch {
      return false;
    }
  }, "DATABASE_URL must be a PostgreSQL connection URL (postgresql://user:password@host:5432/database)");

const DOMAIN_LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const COOKIE_DOMAIN_PATTERN = new RegExp(`^\\.?(?:${DOMAIN_LABEL}\\.)*${DOMAIN_LABEL}$`, "i");

const envSchema = z.object({
  PORT: port("PORT", 3000),
  NODE_ENV: oneOf("NODE_ENV", ["development", "production", "test"]).default("development"),
  LOG_LEVEL: oneOf("LOG_LEVEL", ["debug", "info", "warn", "error"]).default("info"),

  DATABASE_URL: databaseUrl,

  JWT_SECRET: z.string({ error: "JWT_SECRET is required" }).min(1, "JWT_SECRET is required"),

  COOKIE_SECRET: z.string({ error: "COOKIE_SECRET is required" })
    .min(1, "COOKIE_SECRET is required"),
  COOKIE_DOMAIN: z
    .string()
    .trim()
    .default("")
    .refine(
      (value) => value === "" || COOKIE_DOMAIN_PATTERN.test(value),
      "COOKIE_DOMAIN must be a bare domain such as example.com (no scheme, port or path)",
    ),
  COOKIE_SECURE: flag("COOKIE_SECURE"),
  COOKIE_SAMESITE: oneOf("COOKIE_SAMESITE", ["lax", "strict", "none"]).default("lax"),

  CORS_ORIGIN: corsOrigins,

  FRONTEND_URL: frontendUrl,

  SMTP_HOST: z.string().default(""),
  SMTP_PORT: port("SMTP_PORT", 587),
  SMTP_SECURE: flag("SMTP_SECURE"),
  SMTP_USER: z.string().default(""),
  SMTP_PASS: z.string().default(""),
  SMTP_FROM: SenderAddressSchema.default(""),

  STORAGE_DIR: z.string().min(1, "STORAGE_DIR must not be empty").default("./storage"),
  MAX_FILE_SIZE: wholeNumber("MAX_FILE_SIZE", 10737418240, 1, Number.MAX_SAFE_INTEGER), // 10GB

  // Dex (embedded OIDC identity provider)
  DEX_BINARY_PATH: z.string().min(1, "DEX_BINARY_PATH must not be empty").default("/usr/local/bin/dex"),
  DEX_CONFIG_DIR: z.string().min(1, "DEX_CONFIG_DIR must not be empty").default("/app/data/dex"),
  DEX_INTERNAL_PORT: port("DEX_INTERNAL_PORT", 5556),
  DEX_STORAGE_TYPE: oneOf("DEX_STORAGE_TYPE", ["sqlite3", "postgres"]).default("sqlite3"),
  DEX_CLIENT_SECRET: z.string().optional(),

  // Failed password sign-in backoff (docs/remediation/r31-login-backoff.md).
  // After THRESHOLD consecutive failures for one address, each further
  // attempt waits BASE seconds, doubling per failure up to MAX. Failures are
  // forgotten after RESET quiet seconds or a successful sign-in. The tracking
  // table holds at most SLOTS address rows and SLOTS trusted-browser rows.
  LOGIN_BACKOFF_THRESHOLD: wholeNumber("LOGIN_BACKOFF_THRESHOLD", 5, 1, 100),
  LOGIN_BACKOFF_BASE_SECONDS: wholeNumber("LOGIN_BACKOFF_BASE_SECONDS", 2, 1, 900),
  LOGIN_BACKOFF_MAX_SECONDS: wholeNumber("LOGIN_BACKOFF_MAX_SECONDS", 60, 1, 900),
  LOGIN_BACKOFF_RESET_SECONDS: wholeNumber("LOGIN_BACKOFF_RESET_SECONDS", 3600, 60, 604800),
  LOGIN_BACKOFF_SLOTS: wholeNumber("LOGIN_BACKOFF_SLOTS", 65536, 256, 16777216),

  // Password-reset requests (docs/remediation/r31-login-backoff.md). An
  // account gets at most one new link per COOLDOWN seconds; more requests
  // are answered alike and add nothing. The cooldown is read from the newest
  // link, which is kept until it expires after an hour, so it is at most an
  // hour. Each process starts at most REQUESTS_PER_MINUTE requests, a memory
  // guard set far above what the per-client route limit lets a few clients
  // send.
  PASSWORD_RESET_COOLDOWN_SECONDS: wholeNumber("PASSWORD_RESET_COOLDOWN_SECONDS", 60, 0, 3600),
  PASSWORD_RESET_REQUESTS_PER_MINUTE: wholeNumber("PASSWORD_RESET_REQUESTS_PER_MINUTE", 6000, 60, 1000000),

  // Backup preview and restore uploads (docs/remediation/r42-backup-limits.md).
  // From GRACE seconds after an upload is admitted until its file is staged,
  // its body must average at least MIN_BYTES_PER_SECOND over the last WINDOW
  // seconds (or since admission, when shorter). A slower upload is refused
  // with a 408, its partial file removed and its backup slot released.
  BACKUP_UPLOAD_MIN_BYTES_PER_SECOND: wholeNumber("BACKUP_UPLOAD_MIN_BYTES_PER_SECOND", 16384, 1, 1073741824),
  BACKUP_UPLOAD_RATE_WINDOW_SECONDS: wholeNumber("BACKUP_UPLOAD_RATE_WINDOW_SECONDS", 60, 1, 3600),
  BACKUP_UPLOAD_RATE_GRACE_SECONDS: wholeNumber("BACKUP_UPLOAD_RATE_GRACE_SECONDS", 30, 1, 3600),
  // After an upload is refused for its rate, its user's previews and
  // restores are refused with a 429 for COOLDOWN seconds. An upload that ends
  // another way while below the rate adds to that wait in proportion to the
  // slot time it held (modules/backup/backup-cooldown.ts). 0 turns it off.
  BACKUP_UPLOAD_RATE_COOLDOWN_SECONDS: wholeNumber("BACKUP_UPLOAD_RATE_COOLDOWN_SECONDS", 120, 0, 3600),

  // Drive thumbnail decoder processes. Unset keeps one worker on fewer than
  // four CPUs and two otherwise. 1 runs a single worker (a small pod).
  // See the README ("Thumbnail memory").
  THUMBNAIL_WORKERS: z.string().optional().transform((value, ctx) => {
    try {
      return thumbnailWorkerCount(value);
    } catch (error) {
      ctx.addIssue({
        code: "custom",
        message: error instanceof Error ? error.message : THUMBNAIL_WORKER_COUNT_MESSAGE,
      });
      return z.NEVER;
    }
  }),
}).superRefine((values, ctx) => {
  if (values.LOGIN_BACKOFF_BASE_SECONDS > values.LOGIN_BACKOFF_MAX_SECONDS) {
    ctx.addIssue({
      code: "custom",
      path: ["LOGIN_BACKOFF_BASE_SECONDS"],
      message: "LOGIN_BACKOFF_BASE_SECONDS must not exceed LOGIN_BACKOFF_MAX_SECONDS",
    });
  }
  if (values.LOGIN_BACKOFF_MAX_SECONDS > values.LOGIN_BACKOFF_RESET_SECONDS) {
    ctx.addIssue({
      code: "custom",
      path: ["LOGIN_BACKOFF_MAX_SECONDS"],
      message: "LOGIN_BACKOFF_MAX_SECONDS must not exceed LOGIN_BACKOFF_RESET_SECONDS",
    });
  }

  // Browsers drop SameSite=None cookies that are not Secure, so sign-in
  // would silently fail. Production defaults to Secure when unset.
  const secure =
    values.COOKIE_SECURE === undefined
      ? values.NODE_ENV === "production"
      : values.COOKIE_SECURE === "true";
  if (values.COOKIE_SAMESITE === "none" && !secure) {
    ctx.addIssue({
      code: "custom",
      path: ["COOKIE_SAMESITE"],
      message: "COOKIE_SAMESITE=none requires COOKIE_SECURE=true",
    });
  }

  if (values.NODE_ENV !== "production") return;
  for (const name of ["JWT_SECRET", "COOKIE_SECRET"] as const) {
    if (
      values[name].length < 32 ||
      /^(?:change-me|your-secret|your-cookie)/i.test(values[name])
    ) {
      ctx.addIssue({
        code: "custom",
        path: [name],
        message: "Use a unique random secret of at least 32 characters in production",
      });
    }
  }
}).transform((values) => ({
  ...values,
  // Default COOKIE_SECURE to true in production if not explicitly set.
  // docker-compose.yml sets it to false explicitly for local HTTP installs.
  COOKIE_SECURE:
    values.COOKIE_SECURE === undefined
      ? values.NODE_ENV === "production"
      : values.COOKIE_SECURE === "true",
  SMTP_SECURE: values.SMTP_SECURE === "true",
  // Default DEX_CLIENT_SECRET to JWT_SECRET if not explicitly set
  DEX_CLIENT_SECRET: values.DEX_CLIENT_SECRET || values.JWT_SECRET,
}));

export type Env = z.output<typeof envSchema>;

export type EnvParseResult =
  | { success: true; data: Env; warnings: string[] }
  | { success: false; errors: Record<string, string[]> };

/**
 * Validates configuration without side effects. Error messages name the
 * variable and the expected form but never echo the supplied value.
 */
export function parseEnvironment(source: NodeJS.ProcessEnv): EnvParseResult {
  // Treat `NAME=` (common in .env files and Compose `${NAME:-}`) as unset so
  // the documented default applies instead of "" failing or becoming 0/false.
  const present = Object.fromEntries(
    Object.entries(source).filter(([name, value]) => value === undefined || value.trim() !== "" || (name === "SMTP_FROM" && /[\r\n]/.test(value))),
  );
  const parsed = envSchema.safeParse(present);
  if (!parsed.success) {
    const errors: Record<string, string[]> = {};
    for (const [name, messages] of Object.entries(parsed.error.flatten().fieldErrors)) {
      if (messages?.length) errors[name] = messages;
    }
    return { success: false, errors };
  }

  const warnings: string[] = [];
  const data = parsed.data;
  if (
    data.NODE_ENV === "production" &&
    !data.COOKIE_SECURE &&
    data.FRONTEND_URL.startsWith("https:")
  ) {
    warnings.push(
      "FRONTEND_URL uses https but session cookies are not marked Secure; set COOKIE_SECURE=true",
    );
  }
  return { success: true, data, warnings };
}

const result = parseEnvironment(process.env);

if (!result.success) {
  logger.fatal({ errors: result.errors }, "Invalid environment variables");
  process.exit(1);
}

for (const warning of result.warnings) logger.warn(warning);

export const env: Env = result.data;
