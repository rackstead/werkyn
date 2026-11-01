import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { env } from "../../../config/env.js";
import {
  AppError,
  ConflictError,
  ForbiddenError,
} from "../../../utils/errors.js";
import { hashToken, signAccessToken } from "../../../utils/tokens.js";
import { getUserWorkspaces } from "../auth.service.js";
import {
  MAX_OIDC_BROWSER_ATTEMPTS,
  OIDC_STATE_COOKIE_PREFIX,
  OIDC_STATE_PATTERN,
} from "./oidc-state.js";

export const OIDC_COMPLETION_TTL_MS = 60_000;
const MAX_ATTEMPT_COOKIE_LENGTH = 1024;
const uuid = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase());
const timestamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const pendingSchema = z
  .object({
    version: z.literal(1),
    purpose: z.literal("oidc-pending"),
    state: z.string().regex(OIDC_STATE_PATTERN),
    attemptId: uuid,
  })
  .strict();
const completedSchema = z
  .object({
    version: z.literal(1),
    purpose: z.literal("oidc-complete"),
    state: z.string().regex(OIDC_STATE_PATTERN),
    attemptId: uuid,
    familyId: uuid,
    issuedAt: timestamp,
    expiresAt: timestamp,
  })
  .strict()
  .refine(
    (value) => value.expiresAt - value.issuedAt === OIDC_COMPLETION_TTL_MS,
  );
type CompletedAttempt = z.infer<typeof completedSchema>;
export type BrowserAttempt =
  | { phase: "legacy"; state: string }
  | ({ phase: "pending" } & z.infer<typeof pendingSchema>)
  | ({ phase: "completed" } & CompletedAttempt);

function stateInName(name: string) {
  if (!name.startsWith(OIDC_STATE_COOKIE_PREFIX)) return null;
  const state = name.slice(OIDC_STATE_COOKIE_PREFIX.length);
  return OIDC_STATE_PATTERN.test(state) ? state : null;
}
function rawCookieNames(request: FastifyRequest) {
  return (request.headers.cookie ?? "").split(";").flatMap((part) => {
    const equals = part.indexOf("=");
    return equals > 0 ? [part.slice(0, equals).trim()] : [];
  });
}
const unavailable = () =>
  new ConflictError("Sign-in completion is unavailable. Start sign-in again.");

/** Bound new-protocol credentials before any signature or JSON parsing. */
export function assertOidcAttemptCookieBudget(request: FastifyRequest) {
  const names = rawCookieNames(request);
  const attempts = names.filter((name) => stateInName(name) !== null);
  if (
    attempts.length > MAX_OIDC_BROWSER_ATTEMPTS ||
    new Set(attempts).size !== attempts.length ||
    names.filter((name) => name === "refresh_token").length > 1
  )
    throw unavailable();
  return attempts.length;
}
export function hasDuplicateAttemptCookie(
  request: FastifyRequest,
  name: string,
) {
  return (
    rawCookieNames(request).filter((candidate) => candidate === name).length > 1
  );
}

/** Ownership and phase decoding; completion expiry is checked separately. */
export function readBrowserAttempt(
  request: FastifyRequest,
  name: string,
  value: string | undefined,
): BrowserAttempt | null {
  const state = stateInName(name);
  if (!state || !value || value.length > MAX_ATTEMPT_COOKIE_LENGTH) return null;
  const unsigned = request.unsignCookie(value);
  if (!unsigned.valid || typeof unsigned.value !== "string") return null;
  if (unsigned.value === state) return { phase: "legacy", state };
  let payload: unknown;
  try {
    payload = JSON.parse(unsigned.value);
  } catch {
    return null;
  }
  const pending = pendingSchema.safeParse(payload);
  if (pending.success && pending.data.state === state)
    return { phase: "pending", ...pending.data };
  const completed = completedSchema.safeParse(payload);
  if (completed.success && completed.data.state === state)
    return { phase: "completed", ...completed.data };
  return null;
}
export function pendingAttemptCookie(state: string, attemptId: string) {
  return JSON.stringify({
    version: 1,
    purpose: "oidc-pending",
    state,
    attemptId,
  });
}
export function completedAttemptCookie(
  state: string,
  attemptId: string,
  familyId: string,
) {
  const issuedAt = Date.now();
  return JSON.stringify({
    version: 1,
    purpose: "oidc-complete",
    state,
    attemptId,
    familyId,
    issuedAt,
    expiresAt: issuedAt + OIDC_COMPLETION_TTL_MS,
  });
}
function usableAt(proof: CompletedAttempt, now: number) {
  return proof.issuedAt <= now && proof.expiresAt > now;
}

export const CompleteOidcSessionSchema = z.object({ attemptId: uuid }).strict();
const trustedOrigins = new Set([
  new URL(env.FRONTEND_URL).origin,
  ...env.CORS_ORIGIN.split(","),
]);
export async function requireOidcCompletionRequest(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  reply.header("Cache-Control", "no-store");
  if (
    typeof request.headers.origin !== "string" ||
    !trustedOrigins.has(request.headers.origin) ||
    request.headers["x-werkyn-oidc-completion"] !== "1"
  ) {
    throw new ForbiddenError(
      "Sign-in completion requires a trusted browser request",
    );
  }
  const type = request.headers["content-type"];
  if (typeof type !== "string" || !/^application\/json(?:\s*;|$)/i.test(type)) {
    throw new AppError(
      415,
      "Unsupported Media Type",
      "Sign-in completion requires JSON",
    );
  }
  assertOidcAttemptCookieBudget(request);
}
export async function completeOidcSessionHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const { attemptId } = request.body as z.infer<
    typeof CompleteOidcSessionSchema
  >;
  const now = Date.now();
  const proofs = Object.entries(request.cookies).flatMap(([name, value]) => {
    const attempt = readBrowserAttempt(request, name, value);
    return attempt?.phase === "completed" &&
      attempt.attemptId === attemptId &&
      usableAt(attempt, now)
      ? [attempt]
      : [];
  });
  const rawToken = request.cookies.refresh_token;
  if (proofs.length !== 1 || !rawToken) throw unavailable();
  const proof = proofs[0]!;
  // Retained rotated proof can revoke a session but can never mint access here.
  // Filter the exact family before selecting any profile or memberships.
  const current = await request.server.prisma.refreshToken.findFirst({
    where: {
      token: hashToken(rawToken),
      expiresAt: { gt: new Date(now) },
      family: { id: proof.familyId, revokedAt: null },
    },
    select: {
      userId: true,
      familyId: true,
      expiresAt: true,
      family: { select: { userId: true } },
      user: {
        select: {
          id: true,
          email: true,
          displayName: true,
          avatarUrl: true,
          jobTitle: true,
          phone: true,
          timezone: true,
          emailVerified: true,
        },
      },
    },
  });
  if (
    !current ||
    current.userId !== current.family.userId ||
    current.userId !== current.user.id
  )
    throw unavailable();
  const workspaces = await getUserWorkspaces(
    request.server.prisma,
    current.userId,
  );
  const finishedAt = Date.now();
  if (!usableAt(proof, finishedAt) || current.expiresAt.getTime() <= finishedAt)
    throw unavailable();
  // No transaction, refresh rotation, cookie mutation or lifetime renewal.
  // Later revocation remains authoritative on ordinary HTTP/WS authentication.
  const accessToken = signAccessToken({
    sub: current.userId,
    email: current.user.email,
    sid: current.familyId,
  });
  return reply.send({ data: { user: current.user, accessToken, workspaces } });
}
