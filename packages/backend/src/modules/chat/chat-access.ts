import type { PrismaClient } from "@prisma/client";
import { ForbiddenError, NotFoundError } from "../../utils/errors.js";

export interface ChatAccessContext {
  workspaceId: string;
  userId: string;
}

// Public channels are discoverable by current workspace members. Private channels
// and DMs require explicit channel membership, including for workspace admins.
export async function assertChannelAccess(
  prisma: PrismaClient,
  context: ChatAccessContext,
  channelId: string,
) {
  const channel = await prisma.chatChannel.findFirst({
    where: { id: channelId, workspaceId: context.workspaceId },
    select: {
      id: true,
      type: true,
      members: { where: { userId: context.userId }, select: { id: true } },
    },
  });
  if (!channel) throw new NotFoundError("Channel not found");
  if (channel.type !== "PUBLIC" && channel.members.length === 0) {
    throw new ForbiddenError("Not a member of this channel");
  }
  return channel;
}

export async function assertWorkspaceRecipients(
  prisma: PrismaClient,
  workspaceId: string,
  userIds: string[],
) {
  const uniqueIds = [...new Set(userIds)];
  const count = await prisma.workspaceMember.count({
    where: { workspaceId, userId: { in: uniqueIds } },
  });
  if (count !== uniqueIds.length) {
    throw new ForbiddenError("All recipients must be current workspace members");
  }
}
