import type { Notification, NotificationType, Prisma, PrismaClient } from "@prisma/client";
import { filterProjectRecipients } from "../../utils/project-access.js";
import { startPeriodicJob, type PeriodicJob } from "../../schedulers/periodic-job.js";
import { createNotifications } from "./notifications.service.js";

// Durable delivery for notifications sent through notify() (task, comment,
// template, file-share and due-date reminder notifications), on the same
// lease/backoff design as the chat delivery outbox:
//
// - notify() writes a NotificationDelivery row, then runs the first attempt.
//   The due-date reminder scheduler writes the row in the same transaction as
//   the reminder's sent marker.
// - An attempt creates the notifications in the same transaction that sets
//   the row's notifiedAt, so they are created at most once however often the
//   row is retried, and all or none of the recipients get one.
// - The attempt that created them pushes each one to its recipient
//   (notification_new, which the client shows as a toast). A retry after they
//   were created only sends a refresh event (notification_created), so a toast
//   is never repeated.
// - Any failure leaves the row with a backoff; the worker started in
//   server.ts retries it. A crashed attempt's lease expires and the row is
//   picked up again. A delivered row is deleted; an exhausted one is kept with
//   its error and no next attempt.

const LEASE_MS = 60_000;
const BASE_RETRY_MS = 5_000;
const MAX_RETRY_MS = 60 * 60_000;
export const MAX_NOTIFICATION_ATTEMPTS = 20;
const DEFAULT_BATCH_SIZE = 50;
const MAX_TITLE_LENGTH = 255;
const MAX_BODY_LENGTH = 1000;

type Db = PrismaClient | Prisma.TransactionClient;

interface DeliveryLogger {
  error(obj: unknown, msg?: string): void;
}

export interface NotificationBroadcaster {
  broadcastToUser(userId: string, event: string, data: unknown): void;
}

export interface NotificationRequest {
  recipients: string[];
  type: NotificationType;
  title: string;
  body?: string;
  data?: Prisma.InputJsonValue;
  excludeUserId?: string;
}

interface DeliveryOptions {
  now?: Date;
  log?: DeliveryLogger;
}

export type NotificationDeliveryResult = "completed" | "pending" | "skipped";

function retryDelay(attempts: number) {
  return Math.min(BASE_RETRY_MS * 2 ** Math.max(attempts - 1, 0), MAX_RETRY_MS);
}

function describeError(err: unknown): string {
  return (err instanceof Error ? `${err.name}: ${err.message}` : String(err)).slice(-2000);
}

/** Cuts to the stored column length, counted in characters as PostgreSQL does. */
function truncate(value: string, max: number) {
  const chars = Array.from(value);
  return chars.length > max ? chars.slice(0, max).join("") : value;
}

function outboxRow(request: NotificationRequest, now: Date) {
  const recipientIds = [...new Set(request.recipients)].filter(
    (id) => id !== request.excludeUserId,
  );
  if (recipientIds.length === 0) return null;
  return {
    type: request.type,
    title: truncate(request.title, MAX_TITLE_LENGTH),
    body: request.body === undefined ? undefined : truncate(request.body, MAX_BODY_LENGTH),
    data: request.data,
    recipientIds,
    nextAttemptAt: now,
  };
}

/**
 * Writes the outbox row for one notification, inside the caller's
 * transaction when given one. Returns null when no one is left to notify.
 */
export async function enqueueNotification(
  db: Db,
  request: NotificationRequest,
  now = new Date(),
): Promise<string | null> {
  const data = outboxRow(request, now);
  if (!data) return null;
  const row = await db.notificationDelivery.create({ data, select: { id: true } });
  return row.id;
}

/** Writes the outbox rows for several notifications in one statement. */
export async function enqueueNotifications(
  db: Db,
  requests: NotificationRequest[],
  now = new Date(),
): Promise<string[]> {
  const data = requests.flatMap((request) => outboxRow(request, now) ?? []);
  if (data.length === 0) return [];
  const rows = await db.notificationDelivery.createManyAndReturn({ data, select: { id: true } });
  return rows.map((row) => row.id);
}

// The rule notify() has always applied: recipients must be able to read every
// project the data names, including the actual project of a named task (a
// task that no longer exists notifies no one). Evaluated when the
// notifications are created, so a delayed retry uses current access.
async function currentRecipients(db: Db, data: Prisma.JsonValue, userIds: string[]) {
  let recipients = userIds;
  const projectIds = new Set<string>();
  if (data && typeof data === "object" && !Array.isArray(data)) {
    if (typeof data.projectId === "string") projectIds.add(data.projectId);
    if (typeof data.taskId === "string") {
      const task = await db.task.findUnique({
        where: { id: data.taskId },
        select: { projectId: true },
      });
      if (!task) return [];
      projectIds.add(task.projectId);
    }
  }
  for (const projectId of projectIds) {
    recipients = await filterProjectRecipients(db, projectId, recipients);
  }
  if (projectIds.size === 0 && recipients.length > 0) {
    // Only workspace members pass the project filter. Without one, skip users
    // deleted since the request instead of failing every retry on the key.
    const users = await db.user.findMany({
      where: { id: { in: recipients } },
      select: { id: true },
    });
    const existing = new Set(users.map((user) => user.id));
    recipients = recipients.filter((id) => existing.has(id));
  }
  return recipients;
}

type Ensured =
  | { created: true; notifications: Notification[] }
  | { created: false; notificationIds: string[] };

// Creates the row's notifications unless an earlier attempt already did. The
// row lock serializes attempts, so two attempts can never both create them.
async function ensureNotifications(prisma: PrismaClient, id: string): Promise<Ensured | null> {
  return prisma.$transaction(async (tx) => {
    const [locked] = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "NotificationDelivery" WHERE "id" = ${id} FOR UPDATE`;
    if (!locked) return null;
    const row = await tx.notificationDelivery.findUniqueOrThrow({ where: { id } });
    if (row.notifiedAt) return { created: false, notificationIds: row.notificationIds };

    const recipients = await currentRecipients(tx, row.data, row.recipientIds);
    const notifications = await createNotifications(
      tx,
      recipients.map((userId) => ({
        userId,
        type: row.type,
        title: row.title,
        body: row.body ?? undefined,
        data: (row.data ?? undefined) as Prisma.InputJsonValue | undefined,
      })),
    );
    await tx.notificationDelivery.update({
      where: { id },
      data: { notifiedAt: new Date(), notificationIds: notifications.map((n) => n.id) },
    });
    return { created: true, notifications };
  });
}

async function runDelivery(
  prisma: PrismaClient,
  broadcaster: NotificationBroadcaster,
  id: string,
) {
  const ensured = await ensureNotifications(prisma, id);
  if (!ensured) return;
  if (ensured.created) {
    for (const notification of ensured.notifications) {
      broadcaster.broadcastToUser(notification.userId, "notification_new", notification);
    }
    return;
  }
  if (ensured.notificationIds.length === 0) return;
  // An earlier attempt created these and may already have pushed them: only
  // ask the recipients' clients to refresh, without content or a toast.
  const stored = await prisma.notification.findMany({
    where: { id: { in: ensured.notificationIds } },
    select: { id: true, userId: true },
  });
  for (const { id: notificationId, userId } of stored) {
    broadcaster.broadcastToUser(userId, "notification_created", { id: notificationId });
  }
}

/**
 * Leases a due delivery for one attempt. The attempt number identifies the
 * claim: each claim increments it, so a later claim (after this lease
 * expired) makes this attempt's completion and failure writes no-ops.
 */
export async function claimNotificationDelivery(
  prisma: PrismaClient,
  id: string,
  now: Date,
): Promise<number | null> {
  const row = await prisma.notificationDelivery.findUnique({
    where: { id },
    select: { attempts: true },
  });
  if (!row) return null;
  const attempt = row.attempts + 1;
  const claimed = await prisma.notificationDelivery.updateMany({
    where: {
      id,
      attempts: { equals: row.attempts, lt: MAX_NOTIFICATION_ATTEMPTS },
      nextAttemptAt: { lte: now },
      OR: [{ lockedUntil: null }, { lockedUntil: { lte: now } }],
    },
    data: { lockedUntil: new Date(now.getTime() + LEASE_MS), attempts: attempt },
  });
  return claimed.count === 1 ? attempt : null;
}

/**
 * Runs one delivery attempt for an outbox row if it is due and not leased by
 * another attempt. It never throws: a failure is recorded on the row for a
 * later retry.
 */
export async function deliverNotification(
  prisma: PrismaClient,
  broadcaster: NotificationBroadcaster,
  id: string,
  options: DeliveryOptions = {},
): Promise<NotificationDeliveryResult> {
  const now = options.now ?? new Date();
  let attempt: number | null;
  try {
    attempt = await claimNotificationDelivery(prisma, id, now);
  } catch (err) {
    options.log?.error({ err, notificationDeliveryId: id }, "Could not claim notification delivery");
    return "pending";
  }
  if (attempt === null) return "skipped";

  try {
    await runDelivery(prisma, broadcaster, id);
    await prisma.notificationDelivery.deleteMany({ where: { id, attempts: attempt } });
    return "completed";
  } catch (err) {
    const finalAttempt = attempt >= MAX_NOTIFICATION_ATTEMPTS;
    try {
      await prisma.notificationDelivery.updateMany({
        where: { id, attempts: attempt },
        data: {
          lockedUntil: null,
          lastError: describeError(err),
          nextAttemptAt: finalAttempt ? null : new Date(now.getTime() + retryDelay(attempt)),
        },
      });
      options.log?.error(
        { err, notificationDeliveryId: id, attempt, finalAttempt },
        finalAttempt
          ? "Notification delivery failed for the last time"
          : "Notification delivery failed; it will be retried",
      );
    } catch (recordErr) {
      // The lease expires and the row is retried anyway.
      options.log?.error(
        { err, recordErr, notificationDeliveryId: id },
        "Could not record notification delivery failure",
      );
    }
    return "pending";
  }
}

/** Retries due, unleased deliveries, checking the stop signal between rows. */
export async function processDueNotificationDeliveries(
  prisma: PrismaClient,
  broadcaster: NotificationBroadcaster,
  options: DeliveryOptions & { limit?: number; signal?: AbortSignal } = {},
) {
  const now = options.now ?? new Date();
  const due = await prisma.notificationDelivery.findMany({
    where: {
      attempts: { lt: MAX_NOTIFICATION_ATTEMPTS },
      nextAttemptAt: { lte: now },
      OR: [{ lockedUntil: null }, { lockedUntil: { lte: now } }],
    },
    orderBy: { nextAttemptAt: "asc" },
    take: options.limit ?? DEFAULT_BATCH_SIZE,
    select: { id: true },
  });
  const results = { completed: 0, pending: 0, skipped: 0 };
  for (const { id } of due) {
    if (options.signal?.aborted) break;
    results[await deliverNotification(prisma, broadcaster, id, { ...options, now })] += 1;
  }
  return results;
}

/** Retries failed notification deliveries every intervalMs. */
export function startNotificationDeliveryWorker(
  app: NotificationBroadcaster & { prisma: PrismaClient; log: DeliveryLogger },
  options: { intervalMs?: number } = {},
): PeriodicJob {
  const { intervalMs = 30_000 } = options;
  return startPeriodicJob({
    name: "notification deliveries",
    intervalMs,
    log: app.log,
    run: (signal) =>
      processDueNotificationDeliveries(app.prisma, app, { log: app.log, signal }),
  });
}
