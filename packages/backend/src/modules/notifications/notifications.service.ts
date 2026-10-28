import { Prisma } from "@prisma/client";
import type { Notification, PrismaClient, NotificationType } from "@prisma/client";
import type { NotificationQueryInput, UpdateNotificationPreferenceInput } from "@pm/shared";

const TYPE_TO_PREF_KEY: Record<NotificationType, string> = {
  TASK_ASSIGNED: "taskAssigned",
  TASK_STATUS_CHANGED: "taskStatusChanged",
  TASK_DUE_SOON: "taskDueSoon",
  COMMENT_ADDED: "commentAdded",
  COMMENT_MENTION: "commentMention",
  CHAT_MENTION: "chatMention",
  CHAT_DM_MESSAGE: "chatDmMessage",
  FILE_SHARED: "fileShared",
};

export async function createNotification(
  prisma: PrismaClient,
  data: {
    userId: string;
    type: NotificationType;
    title: string;
    body?: string;
    data?: Prisma.InputJsonValue;
  },
) {
  // Check user preference
  const pref = await prisma.notificationPreference.findUnique({
    where: { userId: data.userId },
  });
  const prefKey = TYPE_TO_PREF_KEY[data.type];
  if (pref && prefKey in pref && !(pref as Record<string, unknown>)[prefKey]) {
    return null;
  }

  return prisma.notification.create({
    data: {
      userId: data.userId,
      type: data.type,
      title: data.title,
      body: data.body,
      data: data.data,
    },
  });
}

export async function createNotifications(
  prisma: PrismaClient,
  notifications: Array<{
    userId: string;
    type: NotificationType;
    title: string;
    body?: string;
    data?: Prisma.InputJsonValue;
  }>,
) {
  if (notifications.length === 0) return [];

  // Fetch preferences for all target users
  const userIds = [...new Set(notifications.map((n) => n.userId))];
  const prefs = await prisma.notificationPreference.findMany({
    where: { userId: { in: userIds } },
  });
  const prefMap = new Map(prefs.map((p) => [p.userId, p]));

  // Filter by preferences
  const filtered = notifications.filter((n) => {
    const pref = prefMap.get(n.userId);
    if (!pref) return true; // Default: all enabled
    const prefKey = TYPE_TO_PREF_KEY[n.type];
    return (pref as Record<string, unknown>)[prefKey] !== false;
  });

  if (filtered.length === 0) return [];

  // Create all notifications (use allSettled so one failure doesn't block all)
  const results = await Promise.allSettled(
    filtered.map((n) =>
      prisma.notification.create({
        data: {
          userId: n.userId,
          type: n.type,
          title: n.title,
          body: n.body,
          data: n.data,
        },
      }),
    ),
  );

  return results
    .filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof prisma.notification.create>>> => r.status === "fulfilled")
    .map((r) => r.value);
}

// Same rule as projectAccessWhere: current workspace membership, plus ADMIN
// role or an explicit project membership.
function projectReadable(projectId: Prisma.Sql, userId: string) {
  return Prisma.sql`EXISTS (
    SELECT 1 FROM "Project" p
    JOIN "WorkspaceMember" wm ON wm."workspaceId" = p."workspaceId" AND wm."userId" = ${userId}
    WHERE p."id" = ${projectId}
      AND (wm."role" = 'ADMIN' OR EXISTS (
        SELECT 1 FROM "ProjectMember" pm WHERE pm."projectId" = p."id" AND pm."userId" = ${userId}
      ))
  )`;
}

// Stored notifications carry titles and snippets from the scope they were
// created in. They stay readable only while the recipient can still read
// every scope named in their data, mirroring the recipient filter applied
// when they were sent, so a removed member keeps no copy of later or earlier
// project, channel or workspace content in the list or unread count.
function visibleNotification(userId: string) {
  return Prisma.sql`
    (n."data"->>'projectId' IS NULL OR ${projectReadable(Prisma.sql`n."data"->>'projectId'`, userId)})
    AND (n."data"->>'taskId' IS NULL OR EXISTS (
      SELECT 1 FROM "Task" t
      WHERE t."id" = n."data"->>'taskId' AND ${projectReadable(Prisma.sql`t."projectId"`, userId)}
    ))
    AND (n."data"->>'channelId' IS NULL OR EXISTS (
      SELECT 1 FROM "ChatChannel" c
      JOIN "WorkspaceMember" wm ON wm."workspaceId" = c."workspaceId" AND wm."userId" = ${userId}
      WHERE c."id" = n."data"->>'channelId'
        AND (c."type" = 'PUBLIC' OR EXISTS (
          SELECT 1 FROM "ChatChannelMember" cm WHERE cm."channelId" = c."id" AND cm."userId" = ${userId}
        ))
    ))
    AND (n."data"->>'workspaceId' IS NULL OR EXISTS (
      SELECT 1 FROM "WorkspaceMember" wm
      WHERE wm."workspaceId" = n."data"->>'workspaceId' AND wm."userId" = ${userId}
    ))`;
}

export async function listNotifications(
  prisma: PrismaClient,
  userId: string,
  query: NotificationQueryInput,
) {
  const take = query.limit + 1;
  const types = query.type ? query.type.split(",") : null;

  // An unknown or foreign cursor starts from the first page.
  const cursor = query.cursor
    ? await prisma.notification.findFirst({
        where: { id: query.cursor, userId },
        select: { id: true },
      })
    : null;

  const notifications = await prisma.$queryRaw<Notification[]>`
    SELECT n."id", n."userId", n."type"::text AS "type", n."title", n."body",
           n."read", n."data", n."createdAt"
    FROM "Notification" n
    WHERE n."userId" = ${userId}
      ${query.unreadOnly ? Prisma.sql`AND n."read" = false` : Prisma.empty}
      ${types ? Prisma.sql`AND n."type"::text IN (${Prisma.join(types)})` : Prisma.empty}
      ${
        cursor
          ? Prisma.sql`AND (n."createdAt", n."id") < (
              SELECT c."createdAt", c."id" FROM "Notification" c WHERE c."id" = ${cursor.id}
            )`
          : Prisma.empty
      }
      AND ${visibleNotification(userId)}
    ORDER BY n."createdAt" DESC, n."id" DESC
    LIMIT ${take}`;

  const hasMore = notifications.length > query.limit;
  const data = hasMore ? notifications.slice(0, query.limit) : notifications;
  const nextCursor = hasMore ? data[data.length - 1].id : undefined;

  return { data, nextCursor };
}

export async function getUnreadCount(
  prisma: PrismaClient,
  userId: string,
) {
  const [row] = await prisma.$queryRaw<Array<{ count: number }>>`
    SELECT COUNT(*)::int AS "count"
    FROM "Notification" n
    WHERE n."userId" = ${userId} AND n."read" = false AND ${visibleNotification(userId)}`;
  return row?.count ?? 0;
}

export async function markNotificationsRead(
  prisma: PrismaClient,
  userId: string,
  notificationIds: string[],
) {
  await prisma.notification.updateMany({
    where: { id: { in: notificationIds }, userId },
    data: { read: true },
  });
}

export async function markAllRead(
  prisma: PrismaClient,
  userId: string,
) {
  await prisma.notification.updateMany({
    where: { userId, read: false },
    data: { read: true },
  });
}

export async function getNotificationPreference(
  prisma: PrismaClient,
  userId: string,
) {
  return prisma.notificationPreference.upsert({
    where: { userId },
    create: { userId },
    update: {},
  });
}

export async function updateNotificationPreference(
  prisma: PrismaClient,
  userId: string,
  data: UpdateNotificationPreferenceInput,
) {
  return prisma.notificationPreference.upsert({
    where: { userId },
    create: { userId, ...data },
    update: data,
  });
}
