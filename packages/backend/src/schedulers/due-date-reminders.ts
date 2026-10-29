import type { PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import {
  deliverNotification,
  enqueueNotifications,
} from "../modules/notifications/notification-delivery.js";

const DEFAULT_TIMING = "1_day_before";
const BATCH_SIZE = 100;

/** Map timing preference → number of days before due date */
const TIMING_TO_DAYS: Record<string, number> = {
  on_due_date: 0,
  "1_day_before": 1,
  "3_days_before": 3,
  "1_week_before": 7,
};

function formatDateUTC(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export async function processDueDateReminders(
  prisma: PrismaClient,
  fastify: Pick<FastifyInstance, "broadcastToUser" | "log">,
  options: { now?: Date; signal?: AbortSignal } = {},
) {
  const now = options.now ?? new Date();

  // Build the 4 target dates (UTC): today, +1, +3, +7
  const targetDates = Object.entries(TIMING_TO_DAYS).map(([timing, days]) => {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() + days);
    return { timing, dateStr: formatDateUTC(d) };
  });

  const dateStrings = targetDates.map((t) => t.dateStr);

  // Query tasks with matching due dates that are not archived and not completed
  const tasks = await prisma.task.findMany({
    where: {
      dueDate: { in: dateStrings },
      archived: false,
      status: { isCompletion: false },
    },
    include: {
      assignees: { select: { userId: true } },
      project: { select: { name: true, workspaceId: true } },
    },
  });

  if (tasks.length === 0) {
    fastify.log.info("Due-date reminders: 0 candidates");
    return;
  }

  // Collect all assignee user IDs
  const allUserIds = [...new Set(tasks.flatMap((t) => t.assignees.map((a) => a.userId)))];

  // Batch-fetch notification preferences
  const prefs = await prisma.notificationPreference.findMany({
    where: { userId: { in: allUserIds } },
  });
  const prefMap = new Map(prefs.map((p) => [p.userId, p]));

  // Build timing → dateStr lookup
  const timingToDate = new Map(targetDates.map((t) => [t.timing, t.dateStr]));

  // Determine which (task, user) pairs should receive a reminder
  const candidates: Array<{
    taskId: string;
    userId: string;
    dueDate: string;
    taskTitle: string;
    projectName: string;
    workspaceId: string;
  }> = [];

  for (const task of tasks) {
    for (const assignee of task.assignees) {
      const pref = prefMap.get(assignee.userId);

      // Skip if user disabled taskDueSoon
      if (pref && pref.taskDueSoon === false) continue;

      // Effective timing: task-level reminder > user pref > default
      const effectiveTiming =
        task.reminder || pref?.dueDateReminderTiming || DEFAULT_TIMING;

      // Check if this task's dueDate matches the target date for the effective timing
      const expectedDate = timingToDate.get(effectiveTiming);
      if (task.dueDate !== expectedDate) continue;

      candidates.push({
        taskId: task.id,
        userId: assignee.userId,
        dueDate: task.dueDate,
        taskTitle: task.title,
        projectName: task.project.name,
        workspaceId: task.project.workspaceId,
      });
    }
  }

  if (candidates.length === 0) {
    fastify.log.info("Due-date reminders: 0 candidates after filtering");
    return;
  }

  // Skip reminders already recorded. This read only saves work: the insert
  // below decides which run sends a reminder.
  const alreadySent = await prisma.taskReminderSent.findMany({
    where: {
      OR: candidates.map((c) => ({
        taskId: c.taskId,
        userId: c.userId,
        dueDate: c.dueDate,
      })),
    },
    select: { taskId: true, userId: true, dueDate: true },
  });

  const sentSet = new Set(
    alreadySent.map((s) => `${s.taskId}:${s.userId}:${s.dueDate}`),
  );

  // Sorted, so concurrent runs insert markers in the same order and wait on
  // each other instead of deadlocking.
  const toSend = candidates
    .filter((c) => !sentSet.has(`${c.taskId}:${c.userId}:${c.dueDate}`))
    .sort((a, b) => {
      const x = `${a.taskId}:${a.userId}`;
      const y = `${b.taskId}:${b.userId}`;
      return x < y ? -1 : x > y ? 1 : 0;
    });

  if (toSend.length === 0) {
    fastify.log.info("Due-date reminders: all already sent");
    return;
  }

  // Each batch records its sent markers and queues their notifications in one
  // transaction. Only markers this run inserted (ON CONFLICT DO NOTHING ...
  // RETURNING) get a notification, so concurrent runs send each reminder
  // once, and a failed batch records nothing and is retried on the next run.
  const queued: string[] = [];
  let failedBatches = 0;
  for (let i = 0; i < toSend.length; i += BATCH_SIZE) {
    if (options.signal?.aborted) break;
    const batch = toSend.slice(i, i + BATCH_SIZE);
    const byKey = new Map(batch.map((c) => [`${c.taskId}:${c.userId}:${c.dueDate}`, c]));
    try {
      const ids = await prisma.$transaction(async (tx) => {
        const inserted = await tx.taskReminderSent.createManyAndReturn({
          data: batch.map((c) => ({ taskId: c.taskId, userId: c.userId, dueDate: c.dueDate })),
          skipDuplicates: true,
          select: { taskId: true, userId: true, dueDate: true },
        });
        return enqueueNotifications(
          tx,
          inserted.map((marker) => {
            const c = byKey.get(`${marker.taskId}:${marker.userId}:${marker.dueDate}`)!;
            return {
              recipients: [c.userId],
              type: "TASK_DUE_SOON" as const,
              title: `Task due soon: ${c.taskTitle}`,
              body: `"${c.taskTitle}" in ${c.projectName} is due on ${c.dueDate}`,
              data: {
                taskId: c.taskId,
                workspaceId: c.workspaceId,
                dueDate: c.dueDate,
              },
            };
          }),
          now,
        );
      });
      queued.push(...ids);
    } catch (err) {
      failedBatches++;
      fastify.log.error(err, "Due-date reminders: could not record a batch; it will be retried");
    }
  }

  // First delivery attempt. A failed or interrupted one stays queued for the
  // notification delivery worker.
  const results = { completed: 0, pending: 0, skipped: 0 };
  for (const id of queued) {
    if (options.signal?.aborted) break;
    results[await deliverNotification(prisma, fastify, id, { now, log: fastify.log })] += 1;
  }
  const waiting = queued.length - results.completed;

  fastify.log.info(
    { queued: queued.length, ...results, failedBatches },
    `Due-date reminders: sent ${results.completed} notifications` +
      (waiting > 0 ? `, ${waiting} queued for retry` : "") +
      (failedBatches > 0 ? `, ${failedBatches} batches failed` : ""),
  );
}
