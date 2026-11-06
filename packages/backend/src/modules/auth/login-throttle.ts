import { createHmac } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { env } from "../../config/env.js";

/**
 * Failed password sign-in backoff, kept in PostgreSQL so every server process
 * sees the same state (docs/remediation/r31-login-backoff.md).
 *
 * Every submitted address, with or without an account, maps by a keyed hash
 * to one of `slots` rows, so attacker-chosen addresses cannot grow the table
 * beyond `slots` rows and no address is stored. Addresses that share a slot
 * share its count; the key keeps anyone without the server secret from
 * choosing addresses that collide with a given one.
 *
 * An attempt is counted as a failure when it is admitted, before its password
 * is checked, and the count is cleared when the password proves correct. So
 * parallel attempts cannot all pass the check before any failure is recorded:
 * attempts on one slot are admitted one at a time by the row lock, and once
 * `threshold` are counted, each further attempt must wait
 * `baseSeconds * 2^(failures - threshold)` seconds, at most `maxSeconds`,
 * after the previous admitted one. A refused attempt is answered at once
 * (429 with Retry-After), checks no password and is not counted, so the wait
 * never grows while refused and the account is never locked: after the
 * stated wait the correct password signs in. Failures are forgotten after
 * `resetSeconds` without an admitted attempt.
 */
export interface LoginBackoffPolicy {
  threshold: number;
  baseSeconds: number;
  maxSeconds: number;
  resetSeconds: number;
  slots: number;
}

export type LoginAdmission =
  | { admitted: true; slot: number }
  | { admitted: false; retryAfter: number };

// Counts stop growing here; the delay reaches its cap long before.
const MAX_FAILURES = 1_000_000;

export function policyFromEnv(): LoginBackoffPolicy {
  return {
    threshold: env.LOGIN_BACKOFF_THRESHOLD,
    baseSeconds: env.LOGIN_BACKOFF_BASE_SECONDS,
    maxSeconds: env.LOGIN_BACKOFF_MAX_SECONDS,
    resetSeconds: env.LOGIN_BACKOFF_RESET_SECONDS,
    slots: env.LOGIN_BACKOFF_SLOTS,
  };
}

let slotKey: Buffer | undefined;

/** The slot of a normalized (lowercase) address. */
export function loginSlot(email: string, slots: number): number {
  slotKey ??= createHmac("sha256", env.JWT_SECRET)
    .update("werkyn login backoff slot v1")
    .digest();
  const digest = createHmac("sha256", slotKey).update(email, "utf8").digest();
  return Number(digest.readBigUInt64BE(0) % BigInt(slots));
}

export function createLoginThrottle(policy: LoginBackoffPolicy) {
  const { threshold, baseSeconds, maxSeconds, resetSeconds, slots } = policy;

  /**
   * Counts an attempt for `email` and admits it, or refuses it with the
   * whole seconds until the next attempt is admitted. One statement, so
   * concurrent attempts on a slot (from any process) are decided in turn.
   */
  async function admit(
    prisma: PrismaClient,
    email: string,
  ): Promise<LoginAdmission> {
    const slot = loginSlot(email, slots);
    // The delay owed after the row's current count; the proposed row's time
    // (EXCLUDED) is the one clock reading of this statement.
    const admitted = await prisma.$queryRaw<Array<{ failures: number }>>`
      INSERT INTO "LoginThrottle" AS t ("slot", "failures", "lastFailureAt")
      VALUES (${slot}::integer, 1, clock_timestamp() AT TIME ZONE 'UTC')
      ON CONFLICT ("slot") DO UPDATE SET
        "failures" = CASE
          WHEN t."lastFailureAt" <= EXCLUDED."lastFailureAt" - ${resetSeconds}::integer * interval '1 second'
            THEN 1
          ELSE LEAST(t."failures", ${MAX_FAILURES}::integer) + 1
        END,
        "lastFailureAt" = EXCLUDED."lastFailureAt"
      WHERE t."failures" < ${threshold}::integer
        OR t."lastFailureAt"
          + LEAST(
              ${baseSeconds}::float8 * power(2::float8, LEAST(t."failures" - ${threshold}::integer, 30)),
              ${maxSeconds}::float8
            ) * interval '1 second'
          <= EXCLUDED."lastFailureAt"
      RETURNING t."failures"
    `;
    if (admitted.length > 0) return { admitted: true, slot };

    const [waiting] = await prisma.$queryRaw<Array<{ seconds: number | null }>>`
      SELECT CEIL(EXTRACT(EPOCH FROM (
        t."lastFailureAt"
          + LEAST(
              ${baseSeconds}::float8 * power(2::float8, LEAST(t."failures" - ${threshold}::integer, 30)),
              ${maxSeconds}::float8
            ) * interval '1 second'
          - (clock_timestamp() AT TIME ZONE 'UTC')
      )))::integer AS "seconds"
      FROM "LoginThrottle" t
      WHERE t."slot" = ${slot}::integer
    `;
    // The row may have been cleared or its wait ended since the refusal.
    const seconds = Number(waiting?.seconds ?? 1);
    return {
      admitted: false,
      retryAfter: Math.min(Math.max(seconds, 1), maxSeconds),
    };
  }

  /** A correct password ends the slot's failures. */
  async function succeeded(prisma: PrismaClient, slot: number) {
    await prisma.$executeRaw`
      DELETE FROM "LoginThrottle" WHERE "slot" = ${slot}::integer
    `;
  }

  /**
   * Uncounts an admitted attempt whose password was never checked (the
   * check was unavailable). Its time stays, which can only delay the next
   * attempt, never admit one early.
   */
  async function unchecked(prisma: PrismaClient, slot: number) {
    await prisma.$executeRaw`
      UPDATE "LoginThrottle" SET "failures" = "failures" - 1
      WHERE "slot" = ${slot}::integer AND "failures" > 0
    `;
  }

  /** Removes rows whose failures are forgotten or outside the slot range. */
  async function prune(prisma: PrismaClient) {
    await prisma.$executeRaw`
      DELETE FROM "LoginThrottle"
      WHERE "lastFailureAt" <= (clock_timestamp() AT TIME ZONE 'UTC') - ${resetSeconds}::integer * interval '1 second'
        OR "slot" >= ${slots}::integer
    `;
  }

  return { policy, admit, succeeded, unchecked, prune };
}

export type LoginThrottle = ReturnType<typeof createLoginThrottle>;

let defaultThrottle: LoginThrottle | undefined;

/** The throttle configured by the LOGIN_BACKOFF_* settings. */
export function loginThrottle(): LoginThrottle {
  defaultThrottle ??= createLoginThrottle(policyFromEnv());
  return defaultThrottle;
}
