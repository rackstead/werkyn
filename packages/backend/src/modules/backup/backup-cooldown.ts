import type { PrismaClient } from "@prisma/client";
import type { FastifyReply, FastifyRequest } from "fastify";
import { env } from "../../config/env.js";
import { closeAfterUnreadBody } from "../../plugins/request-limits.js";
import { TooManyRequestsError } from "../../utils/errors.js";

/**
 * Per-user cooldown on backup preview and restore uploads (the R42
 * follow-up in docs/remediation/r42-backup-limits.md).
 *
 * The minimum upload rate frees a slot from a slow upload once the grace
 * period has passed, but a client that starts a new upload each time could
 * keep slots busy while sending almost nothing. So a user who held a slot
 * below the minimum rate owes a wait before their next preview or restore is
 * admitted:
 *
 * - An upload refused for its rate (the 408) makes its user wait the full
 *   cooldown.
 * - An upload that stops being received any other way (its file is staged,
 *   it is refused for another reason, or the client goes away) adds
 *   cooldown / grace seconds of wait for each second of its shortfall below
 *   the minimum rate since admission (RateWatch.shortfallMs). Holding a slot
 *   for the whole grace period without sending costs about a full cooldown
 *   however the upload ends, so ending it just before the 408 saves nothing.
 *   An upload that keeps to the minimum adds nothing.
 * - Waits add up, count down in real time and never exceed 1.2 times the
 *   cooldown. A fifth of the cooldown is forgiven: a user is refused only
 *   while more than that is left, and only until it is back to that. Small
 *   shortfalls, such as the time it takes to receive a tiny file, never lead
 *   to a refusal, and a 408 leaves exactly the cooldown.
 *
 * The check runs before admission, so a refused request takes no slot. The
 * wait is recorded before the slot is released and before the answer is
 * sent, so the client's next request finds it.
 *
 * The wait is kept in PostgreSQL rather than in each process: the user is
 * refused by every server process (whichever one their next request
 * reaches), and a restart does not clear it. Each check is one primary-key
 * read; only uploads short of the minimum rate write a row. There is at most
 * one row per user, removed with the user, and each write also prunes rows
 * whose wait is over.
 */
export interface BackupUploadCooldownPolicy {
  /** BACKUP_UPLOAD_RATE_COOLDOWN_SECONDS; 0 turns the cooldown off. */
  cooldownSeconds: number;
  /** BACKUP_UPLOAD_RATE_GRACE_SECONDS. */
  graceSeconds: number;
}

/** The `code` of a refusal by the cooldown, for clients. */
export const BACKUP_UPLOAD_COOLDOWN_CODE = "BACKUP_UPLOAD_COOLDOWN";

export class BackupUploadCooldownError extends TooManyRequestsError {
  constructor(retryAfter: number) {
    super(
      `Backup uploads from your account are paused because a recent one was too slow. Try again in ${retryAfter} ${retryAfter === 1 ? "second" : "seconds"}.`,
      retryAfter,
      BACKUP_UPLOAD_COOLDOWN_CODE,
    );
  }
}

/** Rows whose wait is over that one write removes at most. */
const PRUNE_LIMIT = 1000;

export function createBackupUploadCooldown(policy: BackupUploadCooldownPolicy) {
  const cooldownMs = policy.cooldownSeconds * 1000;
  const enabled = cooldownMs > 0;
  /** Milliseconds of wait owed per millisecond of shortfall. */
  const waitPerShortfall = policy.cooldownSeconds / policy.graceSeconds;
  /** Wait that is forgiven. */
  const allowanceMs = cooldownMs / 5;
  /** The most a user can owe, which a 408 sets. */
  const capMs = cooldownMs + allowanceMs;

  /**
   * Whole seconds until `userId` may start a backup upload again, or 0 when
   * they may now.
   */
  async function retryAfter(prisma: PrismaClient, userId: string): Promise<number> {
    if (!enabled) return 0;
    const [row] = await prisma.$queryRaw<Array<{ seconds: number }>>`
      SELECT CEIL(
        EXTRACT(EPOCH FROM ("clearsAt" - (statement_timestamp() AT TIME ZONE 'UTC')))
          - ${allowanceMs / 1000}::float8
      )::integer AS "seconds"
      FROM "BackupUploadCooldown"
      WHERE "userId" = ${userId}
        AND "clearsAt" > (statement_timestamp() AT TIME ZONE 'UTC')
          + ${allowanceMs}::float8 * interval '1 millisecond'
    `;
    return row ? Math.max(1, Number(row.seconds)) : 0;
  }

  /**
   * Add `waitMs` to what `userId` owes, up to the cap, and prune rows whose
   * wait is over (skipping rows another write holds). One statement, so
   * concurrent charges for a user add up: a charge that waits for another's
   * row lock reads the clock once it has the row (clock_timestamp(), not the
   * statement's start), so it never caps the wait below what the other
   * charge stored. Returns whole seconds the user is now refused for (0 when
   * none).
   */
  async function owe(prisma: PrismaClient, userId: string, waitMs: number): Promise<number> {
    const [row] = await prisma.$queryRaw<Array<{ seconds: number }>>`
      WITH pruned AS (
        DELETE FROM "BackupUploadCooldown"
        WHERE "userId" IN (
          SELECT "userId" FROM "BackupUploadCooldown"
          WHERE "clearsAt" <= (statement_timestamp() AT TIME ZONE 'UTC')
            AND "userId" <> ${userId}
          ORDER BY "clearsAt"
          LIMIT ${PRUNE_LIMIT}
          FOR UPDATE SKIP LOCKED
        )
      )
      INSERT INTO "BackupUploadCooldown" AS c ("userId", "clearsAt")
      VALUES (
        ${userId},
        (clock_timestamp() AT TIME ZONE 'UTC') + ${waitMs}::float8 * interval '1 millisecond'
      )
      ON CONFLICT ("userId") DO UPDATE SET "clearsAt" = LEAST(
        GREATEST(c."clearsAt", clock_timestamp() AT TIME ZONE 'UTC')
          + ${waitMs}::float8 * interval '1 millisecond',
        (clock_timestamp() AT TIME ZONE 'UTC') + ${capMs}::float8 * interval '1 millisecond'
      )
      RETURNING GREATEST(0, CEIL(
        EXTRACT(EPOCH FROM (c."clearsAt" - (clock_timestamp() AT TIME ZONE 'UTC')))
          - ${allowanceMs / 1000}::float8
      ))::integer AS "seconds"
    `;
    return Number(row?.seconds ?? 0);
  }

  /**
   * Charge the request's user for an upload that has stopped being received:
   * `"refused"` when it was refused for its rate, otherwise its shortfall in
   * milliseconds. Never throws: a failed write is logged and the request's
   * own answer is unchanged.
   */
  async function charge(request: FastifyRequest, outcome: "refused" | number) {
    if (!enabled) return;
    const waitMs =
      outcome === "refused" ? capMs : Math.min(capMs, Math.max(0, outcome) * waitPerShortfall);
    if (!(waitMs > 0)) return;
    try {
      const seconds = await owe(request.server.prisma, request.user!.id, waitMs);
      if (seconds > 0) {
        request.log.info(
          { retryAfter: seconds, shortfallMs: outcome === "refused" ? undefined : Math.round(outcome) },
          "Paused a user's backup uploads after one below the minimum rate",
        );
      }
    } catch (error) {
      request.log.error({ err: error }, "Could not record a backup upload cooldown");
    }
  }

  return { policy, enabled, retryAfter, charge };
}

export type BackupUploadCooldown = ReturnType<typeof createBackupUploadCooldown>;

/** The cooldown configured by the BACKUP_UPLOAD_* settings. */
export const backupUploadCooldown = createBackupUploadCooldown({
  cooldownSeconds: env.BACKUP_UPLOAD_RATE_COOLDOWN_SECONDS,
  graceSeconds: env.BACKUP_UPLOAD_RATE_GRACE_SECONDS,
});

type Handler = (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;

/**
 * Refuse the request with a 429 and Retry-After while its user owes a wait,
 * before `handler` (and so before admission) runs. A refused request's body
 * is never read, so its connection is closed shortly after the answer, also
 * when the check itself fails.
 */
export function refuseDuringUploadCooldown(
  handler: Handler,
  cooldown: BackupUploadCooldown = backupUploadCooldown,
): Handler {
  return async (request, reply) => {
    // Any answer sent before the body has arrived (this refusal, a failed
    // check, or a refusal by the admission) closes the connection shortly
    // after; handleUpload registers the same for the admitted request.
    closeAfterUnreadBody(request, reply);
    const seconds = await cooldown.retryAfter(request.server.prisma, request.user!.id);
    if (seconds > 0) {
      request.log.warn({ retryAfter: seconds }, "Refused a backup upload during its user's cooldown");
      throw new BackupUploadCooldownError(seconds);
    }
    return handler(request, reply);
  };
}
