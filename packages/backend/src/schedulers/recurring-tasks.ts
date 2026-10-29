import type { PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { createTaskFromTemplate } from "../modules/templates/templates.service.js";
import {
  advanceNextRunDate,
  calculateNextRunDate,
  todayUTC,
} from "../modules/recurring/recurring.service.js";

// Generates the tasks of recurring schedules whose next run date has arrived.
//
// Each occurrence is one transaction: lock the project (key share) and then
// the schedule row, record the date in RecurringTaskOccurrence, create the
// task, advance nextRunDate. The three writes commit together or not at all,
// so:
//
// - a failure (or a crash) at any point leaves the schedule on the same date,
//   and a later run generates it; an occurrence is never lost;
// - a date is generated at most once: workers skip a schedule another worker
//   holds (SKIP LOCKED) and re-read it under the lock, and the occurrence key
//   rejects a date generated before, for example after an edit or a resume
//   moved nextRunDate back to it.
//
// Catch-up policy: an active schedule generates every date it missed (the
// scheduler was down, or generation kept failing), oldest first, each with its
// own due date (the template's dueOffset counts from the occurrence date). At
// most MAX_OCCURRENCES_PER_RUN dates per schedule are generated per run; a
// longer backlog continues on the next run. Dates up to endDate are generated
// even when endDate has passed; then the schedule is deactivated. Dates that
// pass while a schedule is paused are skipped when it is resumed (see
// updateRecurringConfig), and dates that pass while its project is archived
// are skipped here: an archived project gets no tasks.
//
// A run stops between occurrences when its signal is aborted (shutdown); the
// rest is picked up by the next run.

export const MAX_OCCURRENCES_PER_RUN = 31;
const PAGE_SIZE = 100;
const REPAIR_PAGE_SIZE = 500;

interface DueConfig {
  id: string;
  projectId: string;
  templateId: string;
  frequency: string;
  dayOfWeek: number | null;
  dayOfMonth: number | null;
  endDate: string | null;
  nextRunDate: string;
  archived: boolean;
}

type Outcome =
  /** Not due, inactive, or held by another worker. */
  | { kind: "none" }
  /** Past its end date: deactivated. */
  | { kind: "ended" }
  /** Project archived: dates up to today skipped. */
  | { kind: "skipped" }
  | { kind: "generated"; projectId: string; taskId: string; more: boolean }
  /** The date was generated before: only advanced. */
  | { kind: "existing"; more: boolean };

export interface RecurringRunSummary {
  generated: number;
  alreadyGenerated: number;
  skipped: number;
  ended: number;
  failed: number;
  repaired: number;
}

async function runNextOccurrence(
  prisma: PrismaClient,
  configId: string,
  today: string,
): Promise<Outcome> {
  return prisma.$transaction(
    async (tx): Promise<Outcome> => {
      // Lock order: the Project row (key share), then the schedule row, then
      // the status, member and label rows and the task rows that task
      // creation touches. Project and workspace deletion lock the Project row
      // before cascading to the schedule; taking the schedule first could
      // deadlock with them. A key-share lock does not block project updates
      // such as archiving; task creation then strengthens it to the project's
      // order lock (utils/task-order.ts) until this transaction commits.
      await tx.$queryRaw`
        SELECT p."id" FROM "Project" p
        JOIN "RecurringTaskConfig" c ON c."projectId" = p."id"
        WHERE c."id" = ${configId}
        FOR KEY SHARE OF p`;
      const [config] = await tx.$queryRaw<DueConfig[]>`
        SELECT c."id", c."projectId", c."templateId", c."frequency"::text AS "frequency",
               c."dayOfWeek", c."dayOfMonth", c."endDate", c."nextRunDate", p."archived"
        FROM "RecurringTaskConfig" c
        JOIN "Project" p ON p."id" = c."projectId"
        WHERE c."id" = ${configId} AND c."isActive" AND c."nextRunDate" <= ${today}
        FOR UPDATE OF c SKIP LOCKED`;
      if (!config) return { kind: "none" };

      const advance = (date: string) =>
        advanceNextRunDate(config.frequency, date, config.dayOfWeek, config.dayOfMonth);
      const pastEnd = (date: string) => config.endDate !== null && date > config.endDate;
      const save = (nextRunDate: string) =>
        tx.recurringTaskConfig.update({
          where: { id: config.id },
          data: {
            nextRunDate,
            lastRunDate: today,
            ...(pastEnd(nextRunDate) ? { isActive: false } : {}),
          },
        });

      if (pastEnd(config.nextRunDate)) {
        await tx.recurringTaskConfig.update({
          where: { id: config.id },
          data: { isActive: false, lastRunDate: today },
        });
        return { kind: "ended" };
      }

      if (config.archived) {
        let next = config.nextRunDate;
        while (next <= today) next = advance(next);
        await save(next);
        return { kind: "skipped" };
      }

      const date = config.nextRunDate;
      const generatedBefore = await tx.recurringTaskOccurrence.findUnique({
        where: { configId_occurrenceDate: { configId: config.id, occurrenceDate: date } },
        select: { configId: true },
      });
      let taskId: string | null = null;
      if (!generatedBefore) {
        const task = await createTaskFromTemplate(
          tx,
          config.projectId,
          config.templateId,
          null, // system-generated, no actor
          "ADMIN", // system acts as admin
          undefined,
          date,
        );
        // The primary key is the last guard: a concurrent insert of the same
        // date fails this transaction, task included.
        await tx.recurringTaskOccurrence.create({
          data: { configId: config.id, occurrenceDate: date, taskId: task.id },
        });
        taskId = task.id;
      }

      const next = advance(date);
      await save(next);
      const more = !pastEnd(next) && next <= today;
      return taskId
        ? { kind: "generated", projectId: config.projectId, taskId, more }
        : { kind: "existing", more };
    },
    { maxWait: 10_000, timeout: 30_000 },
  );
}

/**
 * Rows written by the old monthly arithmetic can hold a first run one month
 * late (docs/remediation/dat-007.md). When an active MONTHLY schedule's next
 * run is later than the first occurrence on or after today, the stored date
 * skips that occurrence: move it back. An occurrence in the future cannot
 * have been generated yet. One due today counts as missing only if no
 * scheduler run advanced the row today (lastRunDate): a run that generated
 * today's date, or skipped it for an archived project, did. Edits do not
 * write lastRunDate. Rows written by the current code never match, because
 * their next run always is the first occurrence after the last generated or
 * skipped date.
 */
async function repairLateMonthlySchedules(
  prisma: PrismaClient,
  today: string,
  signal?: AbortSignal,
) {
  let repaired = 0;
  let cursor: string | undefined;
  // Paged by id, and stops between rows when the run is stopped; each repair
  // is one compare-and-set, so a stopped scan resumes on the next run.
  while (!signal?.aborted) {
    const rows = await prisma.recurringTaskConfig.findMany({
      where: {
        isActive: true,
        frequency: "MONTHLY",
        nextRunDate: { gt: today },
        ...(cursor ? { id: { gt: cursor } } : {}),
      },
      orderBy: { id: "asc" },
      take: REPAIR_PAGE_SIZE,
      select: {
        id: true,
        startDate: true,
        dayOfMonth: true,
        nextRunDate: true,
        lastRunDate: true,
        updatedAt: true,
      },
    });
    if (rows.length === 0) break;
    cursor = rows[rows.length - 1].id;
    for (const row of rows) {
      if (signal?.aborted) break;
      const expected = calculateNextRunDate("MONTHLY", row.startDate, null, row.dayOfMonth, today);
      if (expected < today || expected >= row.nextRunDate) continue;
      // Only a run on this exact day counts (a later date left by a clock
      // that ran ahead proves nothing about today). Moving back onto a date a
      // run did generate is harmless anyway: its occurrence row stops a
      // second task.
      if (expected === today && row.lastRunDate === today) continue;
      // Only if the row is unchanged since it was read: an edit in between
      // (even one that kept nextRunDate) keeps its own result.
      const { count } = await prisma.recurringTaskConfig.updateMany({
        where: {
          id: row.id,
          isActive: true,
          frequency: "MONTHLY",
          startDate: row.startDate,
          dayOfMonth: row.dayOfMonth,
          nextRunDate: row.nextRunDate,
          lastRunDate: row.lastRunDate,
          updatedAt: row.updatedAt,
        },
        data: { nextRunDate: expected },
      });
      repaired += count;
    }
  }
  return repaired;
}

export async function processRecurringTasks(
  prisma: PrismaClient,
  fastify: Pick<FastifyInstance, "broadcast" | "log">,
  options: { now?: Date; signal?: AbortSignal } = {},
): Promise<RecurringRunSummary> {
  const today = todayUTC(options.now);
  const signal = options.signal;
  const summary: RecurringRunSummary = {
    generated: 0,
    alreadyGenerated: 0,
    skipped: 0,
    ended: 0,
    failed: 0,
    repaired: 0,
  };
  try {
    summary.repaired = await repairLateMonthlySchedules(prisma, today, signal);
  } catch (err) {
    fastify.log.error(err, "Recurring tasks: could not check monthly schedules for a late next run");
  }

  // Pages by id, so each due schedule is visited once per run even when it
  // stays due (a failure, or a backlog longer than one run's share).
  let cursor: string | undefined;
  pages: while (!signal?.aborted) {
    const due = await prisma.recurringTaskConfig.findMany({
      where: {
        isActive: true,
        nextRunDate: { lte: today },
        ...(cursor ? { id: { gt: cursor } } : {}),
      },
      orderBy: { id: "asc" },
      take: PAGE_SIZE,
      select: { id: true },
    });
    if (due.length === 0) break;
    cursor = due[due.length - 1].id;

    for (const { id } of due) {
      for (let n = 0; n < MAX_OCCURRENCES_PER_RUN; n++) {
        if (signal?.aborted) break pages;
        let outcome: Outcome;
        try {
          outcome = await runNextOccurrence(prisma, id, today);
        } catch (err) {
          // Nothing was written; the same date is retried on the next run.
          fastify.log.error(err, `Recurring task failed for config ${id}; it will be retried`);
          summary.failed++;
          break;
        }
        if (outcome.kind === "generated") {
          summary.generated++;
          try {
            fastify.broadcast(outcome.projectId, "task_created", { taskId: outcome.taskId });
          } catch (err) {
            fastify.log.error(err, `Could not announce recurring task ${outcome.taskId}`);
          }
        } else if (outcome.kind === "existing") {
          summary.alreadyGenerated++;
        } else if (outcome.kind === "skipped") {
          summary.skipped++;
        } else if (outcome.kind === "ended") {
          summary.ended++;
        }
        if (!("more" in outcome) || !outcome.more) break;
      }
    }
  }

  fastify.log.info(
    { ...summary, stopped: signal?.aborted ?? false },
    `Recurring tasks: created ${summary.generated} tasks${summary.failed > 0 ? `, ${summary.failed} failed` : ""}`,
  );
  return summary;
}
