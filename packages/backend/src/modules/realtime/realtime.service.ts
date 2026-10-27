import type { WebSocket } from "ws";
import type { PrismaClient } from "@prisma/client";
import { verifyAccessToken } from "../../utils/tokens.js";
import { assertProjectAccess } from "../../utils/project-access.js";

interface ConnectionInfo {
  userId: string;
  projectIds: Set<string>;
  workspaceIds: Set<string>;
  channelIds: Set<string>;
  projectAdmissionVersion: number;
  authenticatedAt: number;
  lastActivity: number;
}

const connections = new Map<WebSocket, ConnectionInfo>();
const userConnectionCounts = new Map<string, number>();

const MAX_CONNECTIONS_PER_USER = 5;
const IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 min
const AUTH_TIMEOUT_MS = 5 * 1000; // 5s

// Close codes
export const WS_CLOSE = {
  AUTH_TIMEOUT: { code: 4001, reason: "Authentication timeout" },
  AUTH_FAILED: { code: 4002, reason: "Authentication failed" },
  MEMBERSHIP_REVOKED: { code: 4003, reason: "Membership revoked" },
  CONNECTION_LIMIT: { code: 4008, reason: "Connection limit exceeded" },
  IDLE_TIMEOUT: { code: 4009, reason: "Idle timeout" },
} as const;

export function authenticate(
  ws: WebSocket,
  token: string,
  prisma: PrismaClient,
): Promise<string | null> {
  return new Promise(async (resolve) => {
    try {
      const payload = verifyAccessToken(token);
      const userId = payload.sub;

      // Check user exists
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { id: true },
      });

      if (!user) {
        ws.close(WS_CLOSE.AUTH_FAILED.code, WS_CLOSE.AUTH_FAILED.reason);
        resolve(null);
        return;
      }

      // Check connection limit
      const currentCount = userConnectionCounts.get(userId) || 0;
      if (currentCount >= MAX_CONNECTIONS_PER_USER) {
        ws.close(WS_CLOSE.CONNECTION_LIMIT.code, WS_CLOSE.CONNECTION_LIMIT.reason);
        resolve(null);
        return;
      }

      // Register connection
      connections.set(ws, {
        userId,
        projectIds: new Set(),
        workspaceIds: new Set(),
        channelIds: new Set(),
        projectAdmissionVersion: 0,
        authenticatedAt: Date.now(),
        lastActivity: Date.now(),
      });
      userConnectionCounts.set(userId, currentCount + 1);

      resolve(userId);
    } catch {
      ws.close(WS_CLOSE.AUTH_FAILED.code, WS_CLOSE.AUTH_FAILED.reason);
      resolve(null);
    }
  });
}

export async function subscribe(
  ws: WebSocket,
  projectId: string,
  prisma: PrismaClient,
): Promise<boolean> {
  const conn = connections.get(ws);
  if (!conn) return false;
  const admissionVersion = conn.projectAdmissionVersion;

  try {
    await assertProjectAccess(prisma, projectId, conn.userId);
  } catch {
    return false;
  }

  // A removal can commit while the database authorization read is in flight.
  // Never restore a revoked subscription from that earlier result.
  if (connections.get(ws) !== conn || conn.projectAdmissionVersion !== admissionVersion) return false;

  conn.projectIds.add(projectId);
  conn.lastActivity = Date.now();
  return true;
}

export function unsubscribe(ws: WebSocket, projectId: string): void {
  const conn = connections.get(ws);
  if (conn) {
    conn.projectIds.delete(projectId);
    conn.lastActivity = Date.now();
  }
}

export function revokeProjectAccess(userId: string, projectId: string): void {
  for (const conn of connections.values()) {
    if (conn.userId === userId) {
      conn.projectAdmissionVersion++;
      conn.projectIds.delete(projectId);
    }
  }
}

export async function subscribeWorkspace(
  ws: WebSocket,
  workspaceId: string,
  prisma: PrismaClient,
): Promise<boolean> {
  const conn = connections.get(ws);
  if (!conn) return false;

  const member = await prisma.workspaceMember.findUnique({
    where: {
      userId_workspaceId: {
        userId: conn.userId,
        workspaceId,
      },
    },
  });
  if (!member) return false;

  conn.workspaceIds.add(workspaceId);
  conn.lastActivity = Date.now();

  // Broadcast presence to workspace
  broadcastToWorkspace(workspaceId, "presence_online", { userId: conn.userId }, conn.userId);

  return true;
}

export function unsubscribeWorkspace(ws: WebSocket, workspaceId: string): void {
  const conn = connections.get(ws);
  if (conn) {
    conn.workspaceIds.delete(workspaceId);
    conn.lastActivity = Date.now();
  }
}

export async function subscribeChannel(
  ws: WebSocket,
  channelId: string,
  prisma: PrismaClient,
): Promise<boolean> {
  const conn = connections.get(ws);
  if (!conn) return false;

  // Verify channel membership
  const member = await prisma.chatChannelMember.findUnique({
    where: {
      channelId_userId: {
        channelId,
        userId: conn.userId,
      },
    },
  });
  if (!member) return false;

  conn.channelIds.add(channelId);
  conn.lastActivity = Date.now();
  return true;
}

export function unsubscribeChannel(ws: WebSocket, channelId: string): void {
  const conn = connections.get(ws);
  if (conn) {
    conn.channelIds.delete(channelId);
    conn.lastActivity = Date.now();
  }
}

export function broadcastToChannel(
  channelId: string,
  event: string,
  data: unknown,
  excludeUserId?: string,
): void {
  const message = JSON.stringify({ event, data, channelId });

  for (const [ws, conn] of connections) {
    if (conn.channelIds.has(channelId) && conn.userId !== excludeUserId) {
      if (ws.readyState === ws.OPEN) {
        ws.send(message);
      }
    }
  }
}

export function broadcast(
  projectId: string,
  event: string,
  data: unknown,
  excludeUserId?: string,
): void {
  const message = JSON.stringify({ event, data, projectId });

  for (const [ws, conn] of connections) {
    if (conn.projectIds.has(projectId) && conn.userId !== excludeUserId) {
      if (ws.readyState === ws.OPEN) {
        ws.send(message);
      }
    }
  }
}

export function broadcastToWorkspace(
  workspaceId: string,
  event: string,
  data: unknown,
  excludeUserId?: string,
): void {
  const message = JSON.stringify({ event, data, workspaceId });

  for (const [ws, conn] of connections) {
    if (conn.workspaceIds.has(workspaceId) && conn.userId !== excludeUserId) {
      if (ws.readyState === ws.OPEN) {
        ws.send(message);
      }
    }
  }
}

export function broadcastToUser(
  userId: string,
  event: string,
  data: unknown,
): void {
  const message = JSON.stringify({ event, data });

  for (const [ws, conn] of connections) {
    if (conn.userId === userId && ws.readyState === ws.OPEN) {
      ws.send(message);
    }
  }
}

export function cleanup(ws: WebSocket): void {
  const conn = connections.get(ws);
  if (conn) {
    const count = userConnectionCounts.get(conn.userId) || 0;
    if (count <= 1) {
      userConnectionCounts.delete(conn.userId);
      // Broadcast offline to all subscribed workspaces
      for (const wid of conn.workspaceIds) {
        broadcastToWorkspace(wid, "presence_offline", { userId: conn.userId }, conn.userId);
      }
    } else {
      userConnectionCounts.set(conn.userId, count - 1);
    }
    connections.delete(ws);
  }
}

export function getAuthTimeout(): number {
  return AUTH_TIMEOUT_MS;
}

export function getIdleTimeout(): number {
  return IDLE_TIMEOUT_MS;
}

export function touchConnection(ws: WebSocket): void {
  const conn = connections.get(ws);
  if (conn) {
    conn.lastActivity = Date.now();
  }
}

export function isIdle(ws: WebSocket): boolean {
  const conn = connections.get(ws);
  if (!conn) return true;
  return Date.now() - conn.lastActivity > IDLE_TIMEOUT_MS;
}

const PRESENCE_AWAY_MS = 5 * 60 * 1000; // 5 minutes

export function getOnlineUsers(
  workspaceId: string,
): Array<{ userId: string; status: "online" | "away" }> {
  const userStatus = new Map<string, "online" | "away">();
  const now = Date.now();

  for (const [, conn] of connections) {
    if (conn.workspaceIds.has(workspaceId)) {
      const isActive = now - conn.lastActivity < PRESENCE_AWAY_MS;
      const current = userStatus.get(conn.userId);
      // If any connection is active, user is online
      if (!current || (isActive && current === "away")) {
        userStatus.set(conn.userId, isActive ? "online" : "away");
      }
    }
  }

  return Array.from(userStatus.entries()).map(([userId, status]) => ({
    userId,
    status,
  }));
}
