import { z } from "zod";
import { logger } from "../utils/logger.js";

function wholeNumber(name: string, fallback: number, min: number, max: number) {
  const range = `${name} must be a whole number from ${min} to ${max}`;
  return z.coerce
    .number({ invalid_type_error: range })
    .int(range)
    .min(min, range)
    .max(max, range)
    .default(fallback);
}

const port = (name: string, fallback: number) => wholeNumber(name, fallback, 1, 65535);

function flag(name: string) {
  return z
    .enum(["true", "false"], {
      errorMap: () => ({ message: `${name} must be "true" or "false"` }),
    })
    .optional();
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
        code: z.ZodIssueCode.custom,
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
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "CORS_ORIGIN must list at least one origin" });
      return z.NEVER;
    }
    const origins: string[] = [];
    for (const entry of entries) {
      if (entry === "*") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'CORS_ORIGIN="*" is not allowed with credentialed requests; list explicit origins',
        });
        continue;
      }
      const url = parseHttpUrl(entry);
      if (!url || url.pathname !== "/" || url.search || url.hash || /[?#]/.test(entry)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
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

const databaseUrl = z
  .string({ required_error: "DATABASE_URL is required" })
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
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),

  DATABASE_URL: databaseUrl,

  JWT_SECRET: z.string({ required_error: "JWT_SECRET is required" }).min(1, "JWT_SECRET is required"),

  COOKIE_SECRET: z
    .string({ required_error: "COOKIE_SECRET is required" })
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
  COOKIE_SAMESITE: z.enum(["lax", "strict", "none"]).default("lax"),

  CORS_ORIGIN: corsOrigins,

  FRONTEND_URL: frontendUrl,

  SMTP_HOST: z.string().default(""),
  SMTP_PORT: port("SMTP_PORT", 587),
  SMTP_SECURE: flag("SMTP_SECURE"),
  SMTP_USER: z.string().default(""),
  SMTP_PASS: z.string().default(""),
  SMTP_FROM: z.string().default(""),

  STORAGE_DIR: z.string().min(1, "STORAGE_DIR must not be empty").default("./storage"),
  MAX_FILE_SIZE: wholeNumber("MAX_FILE_SIZE", 10737418240, 1, Number.MAX_SAFE_INTEGER), // 10GB

  // Dex (embedded OIDC identity provider)
  DEX_BINARY_PATH: z.string().min(1, "DEX_BINARY_PATH must not be empty").default("/usr/local/bin/dex"),
  DEX_CONFIG_DIR: z.string().min(1, "DEX_CONFIG_DIR must not be empty").default("/app/data/dex"),
  DEX_INTERNAL_PORT: port("DEX_INTERNAL_PORT", 5556),
  DEX_STORAGE_TYPE: z.enum(["sqlite3", "postgres"]).default("sqlite3"),
  DEX_CLIENT_SECRET: z.string().optional(),
}).superRefine((values, ctx) => {
  // Browsers drop SameSite=None cookies that are not Secure, so sign-in
  // would silently fail. Production defaults to Secure when unset.
  const secure =
    values.COOKIE_SECURE === undefined
      ? values.NODE_ENV === "production"
      : values.COOKIE_SECURE === "true";
  if (values.COOKIE_SAMESITE === "none" && !secure) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
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
        code: z.ZodIssueCode.custom,
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
    Object.entries(source).filter(([, value]) => value === undefined || value.trim() !== ""),
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
