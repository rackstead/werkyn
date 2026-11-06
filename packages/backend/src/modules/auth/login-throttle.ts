import { createHmac } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { env } from "../../config/env.js";

/**
 * Failed password sign-in backoff, kept in PostgreSQL so every server process
 * sees the same state (docs/remediation/r31-login-backoff.md).
 *
 * Every submitted address, with or without an account, maps by a keyed hash
 * to one of `slots` address rows (0 to slots - 1), so attacker-chosen
 * addresses cannot grow the table beyond `slots` rows and no address is
 * stored. Addresses that share a slot share its count; the key keeps anyone
 * without the server secret from choosing addresses that collide with a given
 * one. A browser that signed in to the address before (login-device.ts) is
 * counted in its device's own lane instead, one of `slots` device rows
 * (slots to 2 * slots - 1), so the table holds at most 2 * slots rows.
 *
 * An attempt is counted as a failure when it is admitted, before its password
 * is checked, and the count is cleared when it signs in. So parallel attempts
 * cannot all pass the check before any failure is recorded:
 * attempts on one slot are admitted one at a time by the row lock, and once
 * `threshold` are counted, each further attempt must wait
 * `baseSeconds * 2^(failures - threshold)` seconds, at most `maxSeconds`,
 * after the previous admitted one. A refused attempt is answered at once
 * (429 with Retry-After), checks no password and is not counted, so the wait
 * never grows while refused. Admission is first come at the end of a wait,
 * so someone who keeps sending wrong passwords for an address can keep a
 * browser that never signed in to it from getting in first; a trusted
 * device's own lane is not affected by them. Failures are forgotten after
 * `resetSeconds` without an admitted attempt.
 *
 * Each admitted attempt gets the slot's next admission number (its ticket).
 * Its outcome changes only what it owns: a sign-in clears the failures of its
 * own and earlier admissions, keeping those admitted after it (from this or a
 * colliding address); an attempt whose password was never checked uncounts
 * itself only while no later outcome has cleared it. An outcome reported more
 * than half the reset period after its admission changes nothing, since the
 * row may by then have been pruned and started again (both directions keep
 * the count, never lower it wrongly).
 */
export interface LoginBackoffPolicy {
  threshold: number;
  baseSeconds: number;
  maxSeconds: number;
  resetSeconds: number;
  slots: number;
}

export interface AdmissionTicket {
  slot: number;
  /** The slot's admission number of this attempt. */
  number: bigint;
  /** performance.now() when it was admitted. */
  at: number;
}

export type LoginAdmission =
  | { admitted: true; ticket: AdmissionTicket }
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

  /** Counts an attempt for `email` in its address slot (see admitSlot). */
  function admit(prisma: PrismaClient, email: string) {
    return admitSlot(prisma, loginSlot(email, slots));
  }

  /** Counts an attempt from a trusted device in that device's own lane. */
  function admitDevice(prisma: PrismaClient, deviceId: string) {
    return admitSlot(prisma, slots + loginSlot(`device ${deviceId}`, slots));
  }

  /**
   * The address slot's admissions so far, as a ticket: a sign-in from a
   * trusted device clears the address's failures up to this point (and keeps
   * those admitted while it was checked). Null when the slot has no row.
   */
  async function addressMark(
    prisma: PrismaClient,
    email: string,
  ): Promise<AdmissionTicket | null> {
    const slot = loginSlot(email, slots);
    const [row] = await prisma.$queryRaw<Array<{ admissions: bigint }>>`
      SELECT "admissions" FROM "LoginThrottle" WHERE "slot" = ${slot}::integer
    `;
    return row
      ? { slot, number: BigInt(row.admissions), at: performance.now() }
      : null;
  }

  /**
   * Counts an attempt in `slot` and admits it, or refuses it with the whole
   * seconds until the next attempt is admitted. One statement, so concurrent
   * attempts on a slot (from any process) are decided in turn.
   */
  async function admitSlot(
    prisma: PrismaClient,
    slot: number,
  ): Promise<LoginAdmission> {
    // The delay owed after the row's current count; the proposed row's time
    // (EXCLUDED) is the one clock reading of this statement.
    const admitted = await prisma.$queryRaw<Array<{ admissions: bigint }>>`
      INSERT INTO "LoginThrottle" AS t
        ("slot", "failures", "lastFailureAt", "admissions", "clearedThrough")
      VALUES (${slot}::integer, 1, clock_timestamp() AT TIME ZONE 'UTC', 1, 0)
      ON CONFLICT ("slot") DO UPDATE SET
        "failures" = CASE
          WHEN t."lastFailureAt" <= EXCLUDED."lastFailureAt" - ${resetSeconds}::integer * interval '1 second'
            THEN 1
          ELSE LEAST(t."failures", ${MAX_FAILURES}::integer) + 1
        END,
        "clearedThrough" = CASE
          WHEN t."lastFailureAt" <= EXCLUDED."lastFailureAt" - ${resetSeconds}::integer * interval '1 second'
            THEN t."admissions"
          ELSE t."clearedThrough"
        END,
        "admissions" = t."admissions" + 1,
        "lastFailureAt" = EXCLUDED."lastFailureAt"
      WHERE t."failures" < ${threshold}::integer
        OR t."lastFailureAt"
          + LEAST(
              ${baseSeconds}::float8 * power(2::float8, LEAST(t."failures" - ${threshold}::integer, 30)),
              ${maxSeconds}::float8
            ) * interval '1 second'
          <= EXCLUDED."lastFailureAt"
      RETURNING t."admissions"
    `;
    if (admitted.length > 0)
      return {
        admitted: true,
        ticket: { slot, number: BigInt(admitted[0]!.admissions), at: performance.now() },
      };

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

  // Within half the reset period of its admission the row cannot have been
  // pruned or restarted (both need resetSeconds without an admission).
  const current = (ticket: AdmissionTicket) =>
    performance.now() - ticket.at < (resetSeconds * 1000) / 2;

  /**
   * The attempt signed in: failures admitted up to and including it no
   * longer count. At most the number admitted after it remain (fewer if
   * some of those were uncounted already).
   */
  async function succeeded(prisma: PrismaClient, ticket: AdmissionTicket) {
    if (!current(ticket)) return;
    await prisma.$executeRaw`
      UPDATE "LoginThrottle" SET
        "failures" = LEAST("failures", "admissions" - ${ticket.number}::bigint),
        "clearedThrough" = ${ticket.number}::bigint
      WHERE "slot" = ${ticket.slot}::integer
        AND "admissions" >= ${ticket.number}::bigint
        AND "clearedThrough" < ${ticket.number}::bigint
    `;
  }

  /**
   * Uncounts an admitted attempt whose outcome was not decided (its password
   * could not be checked, or its sign-in could not be completed), unless a
   * later outcome already cleared it. Its time stays, which can only delay
   * the next attempt, never admit one early.
   */
  async function unchecked(prisma: PrismaClient, ticket: AdmissionTicket) {
    if (!current(ticket)) return;
    await prisma.$executeRaw`
      UPDATE "LoginThrottle" SET "failures" = "failures" - 1
      WHERE "slot" = ${ticket.slot}::integer
        AND "admissions" >= ${ticket.number}::bigint
        AND "clearedThrough" < ${ticket.number}::bigint
        AND "failures" > 0
    `;
  }

  /** Removes rows whose failures are forgotten or outside the slot ranges. */
  async function prune(prisma: PrismaClient) {
    await prisma.$executeRaw`
      DELETE FROM "LoginThrottle"
      WHERE "lastFailureAt" <= (clock_timestamp() AT TIME ZONE 'UTC') - ${resetSeconds}::integer * interval '1 second'
        OR "slot" >= ${2 * slots}::integer
    `;
  }

  return {
    policy,
    admit,
    admitDevice,
    addressMark,
    succeeded,
    unchecked,
    prune,
  };
}

export type LoginThrottle = ReturnType<typeof createLoginThrottle>;

let defaultThrottle: LoginThrottle | undefined;

/** The throttle configured by the LOGIN_BACKOFF_* settings. */
export function loginThrottle(): LoginThrottle {
  defaultThrottle ??= createLoginThrottle(policyFromEnv());
  return defaultThrottle;
}
