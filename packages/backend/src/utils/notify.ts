import type { PrismaClient, NotificationType, Prisma } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { createNotifications } from "../modules/notifications/notifications.service.js";
import { filterProjectRecipients } from "./project-access.js";

interface NotifyOptions {
  recipients: string[];
  type: NotificationType;
  title: string;
  body?: string;
  data?: Prisma.InputJsonValue;
  excludeUserId?: string;
}

export async function notify(
  prisma: PrismaClient,
  fastify: FastifyInstance,
  options: NotifyOptions,
) {
  const { recipients, type, title, body, data, excludeUserId } = options;

  // Filter out the actor
  let targetUserIds = excludeUserId
    ? recipients.filter((id) => id !== excludeUserId)
    : recipients;

  if (data && typeof data === "object" && !Array.isArray(data)) {
    const projectIds = new Set<string>();
    if ("projectId" in data && typeof data.projectId === "string") projectIds.add(data.projectId);
    // Reminders and legacy callers may supply only a task ID. Resolve the
    // actual parent rather than relying on an optional project metadata hint.
    if ("taskId" in data && typeof data.taskId === "string") {
      const task = await prisma.task.findUnique({ where: { id: data.taskId }, select: { projectId: true } });
      if (!task) return;
      projectIds.add(task.projectId);
    }
    for (const projectId of projectIds) {
      targetUserIds = await filterProjectRecipients(prisma, projectId, targetUserIds);
    }
  }

  if (targetUserIds.length === 0) return;

  const notifications = targetUserIds.map((userId) => ({
    userId,
    type,
    title,
    body,
    data,
  }));

  const created = await createNotifications(prisma, notifications);

  // Push real-time notification to each recipient
  for (const notification of created) {
    fastify.broadcastToUser(notification.userId, "notification_new", notification);
  }
}
