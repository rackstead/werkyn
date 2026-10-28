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
  if (typeof serialized.message === "string") serialized.message = redactText(serialized.message);
  if (typeof serialized.stack === "string") serialized.stack = redactText(serialized.stack);
  return serialized;
}

/**
 * Redacts string arguments, such as Fastify's "Route GET:<url> not found".
 * pino uses `err.message` as the message when a call passes only an Error
 * (or `{ err }`), so that case gets an explicit redacted message too.
 */
export const logMethodHook = {
  logMethod(this: pino.Logger, args: unknown[], method: pino.LogFn) {
    const cleaned = args.map((arg) => (typeof arg === "string" ? redactText(arg) : arg));
    const [first, second] = cleaned;
    if (typeof second !== "string" && first && typeof first === "object") {
      const error = first instanceof Error ? first : (first as { err?: unknown }).err;
      const ownMessage = !(first instanceof Error) && "msg" in first;
      if (error instanceof Error && !ownMessage) {
        cleaned.splice(1, 0, redactText(error.message));
      }
    }
    return (method as (...values: unknown[]) => void).apply(this, cleaned);
  },
};
