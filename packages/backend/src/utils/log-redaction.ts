import pino from "pino";

export const REDACTED = "[REDACTED]";

// Query parameter names whose values are credentials or one-time grants:
// access tokens, OIDC code/state/nonce, Dex approval HMACs, invites, keys.
const SENSITIVE_QUERY_NAME =
  /token|secret|passw|pwd|key|code|state|nonce|hmac|sig|session|auth|credential|invite|^req$|^pass$/i;

// Path segments that carry a bearer link token (API and SPA routes), either as
// a bare path or inside an absolute URL.
const TOKEN_PATH =
  /((?:^|[\s:"'(=]|\/\/[^/\s"']+)(?:\/api\/auth\/(?:reset-password|verify-email)|\/reset-password|\/verify-email|\/api\/invites|\/invite|\/api\/public\/(?:files|wiki)|\/share\/files|\/share)\/)[^/?#\s"'),]+/g;

const QUERY_PARAMETER = /([?&])([^=&#\s"']+)=([^&#\s"']*)/g;

function decodeName(name: string): string {
  try {
    return decodeURIComponent(name.replace(/\+/g, " "));
  } catch {
    return name;
  }
}

/**
 * Replaces link tokens in known token-bearing paths and the values of
 * credential-like query parameters in any URL or free text.
 */
export function redactText(text: string): string {
  if (typeof text !== "string" || text === "") return text;
  if (!text.includes("/") && !text.includes("=")) return text;
  return text
    .replace(TOKEN_PATH, `$1${REDACTED}`)
    .replace(QUERY_PARAMETER, (match, separator: string, name: string) =>
      SENSITIVE_QUERY_NAME.test(decodeName(name)) ? `${separator}${name}=${REDACTED}` : match,
    );
}

// Known structured URL fields: reply-from logs { source }, mailer logs
// { previewUrl }, and request/error contexts can carry { url }. Pino also
// accepts a structured msg rather than a string argument. Inspect only these
// fields, without walking arbitrary payloads, requests or caller-owned graphs.
const STRUCTURED_TEXT_FIELDS = ["source", "url", "previewUrl", "msg", "message", "stack"] as const;

function redactStructuredText<T extends object>(value: T): T {
  let cleaned = value;
  for (const field of STRUCTURED_TEXT_FIELDS) {
    if (!Object.hasOwn(value, field)) continue;
    const text = (value as Record<string, unknown>)[field];
    if (typeof text !== "string") continue;
    const redacted = redactText(text);
    if (redacted === text) continue;
    if (cleaned === value) cleaned = { ...value };
    (cleaned as Record<string, unknown>)[field] = redacted;
  }
  return cleaned;
}

const SECRET_FIELDS = [
  "password",
  "passwordHash",
  "currentPassword",
  "newPassword",
  "pass",
  "token",
  "accessToken",
  "refreshToken",
  "apiKey",
  "key",
  "secret",
  "clientSecret",
  "codeVerifier",
];

const HEADER_FIELDS = [
  "authorization",
  "cookie",
  '["set-cookie"]',
  '["x-api-key"]',
  '["proxy-authorization"]',
];

/** pino `redact` configuration shared by request and standalone loggers. */
export const redactOptions = {
  paths: [
    ...SECRET_FIELDS,
    ...SECRET_FIELDS.map((field) => `*.${field}`),
    ...HEADER_FIELDS.flatMap((field) => {
      const suffix = field.startsWith("[") ? field : `.${field}`;
      return [`headers${suffix}`, `*.headers${suffix}`];
    }),
    "*.auth.user",
    "*.auth.pass",
  ],
  censor: REDACTED,
};

type RequestLike = {
  method?: string;
  url?: string;
  host?: string;
  ip?: string;
  headers?: Record<string, string | string[] | undefined>;
  socket?: { remotePort?: number };
};

/** Fastify's default request serializer, with credentials removed from the URL. */
export function serializeRequest(request: RequestLike) {
  return {
    method: request.method,
    url: request.url === undefined ? undefined : redactText(request.url),
    version: request.headers?.["accept-version"] as string | undefined,
    host: request.host,
    remoteAddress: request.ip,
    remotePort: request.socket?.remotePort,
  };
}

/** pino's error serializer, with URLs in message and stack redacted. */
export function serializeError(error: Error): pino.SerializedError {
  const serialized = pino.stdSerializers.err(error);
  if (!serialized || typeof serialized !== "object") return serialized;
  return redactStructuredText(serialized);
}

/**
 * Redacts string arguments and known structured URL/message fields, including
 * reply-from's source, without changing the original objects or forwarded URL.
 * pino uses `err.message` as the message when a call passes only an Error
 * (or `{ err }`), so that case gets an explicit redacted message too.
 */
export const logMethodHook = {
  logMethod(this: pino.Logger, args: unknown[], method: pino.LogFn) {
    const cleaned = args.map((arg) => {
      if (typeof arg === "string") return redactText(arg);
      // Preserve Error identity so pino still uses the error serializer.
      if (arg && typeof arg === "object" && !(arg instanceof Error) && !Array.isArray(arg)) {
        return redactStructuredText(arg);
      }
      return arg;
    });
    const [first, second] = cleaned;
    if (typeof second !== "string" && first && typeof first === "object") {
      const error = first instanceof Error ? first : (first as { err?: unknown }).err;
      // Like pino, treat an undefined msg as absent, even when it is an own
      // property. Otherwise pino copies the raw error message into msg.
      const ownMessage = !(first instanceof Error) && (first as { msg?: unknown }).msg !== undefined;
      if (error instanceof Error && !ownMessage) {
        cleaned.splice(1, 0, redactText(error.message));
      }
    }
    return (method as (...values: unknown[]) => void).apply(this, cleaned);
  },
};
