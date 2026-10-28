import type { WebSocket } from "ws";
import type { PrismaClient } from "@prisma/client";
import { verifyAccessToken } from "../../utils/tokens.js";
import { assertProjectAccess } from "../../utils/project-access.js";

interface ConnectionInfo {
  userId: string;
  // Each subscription remembers its workspace so a workspace revocation can
  // drop every dependent subscription without another database read.
  projects: Map<string, string>;
  workspaceIds: Set<string>;
  channels: Map<string, string>;
  // Bumped by every revocation for the user. An authorization read that was in
  // flight when one happened is repeated against the committed state.
  accessVersion: number;
  // The socket lives no longer than the access token that opened it.
  expiresAt: number;
  expiryTimer?: NodeJS.Timeout;
  authenticatedAt: number;
  lastActivity: number;
}

const connections = new Map<WebSocket, ConnectionInfo>();
const userConnectionCounts = new Map<string, number>();

const MAX_CONNECTIONS_PER_USER = 5;
const IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 min
const AUTH_TIMEOUT_MS = 5 * 1000; // 5s
const MAX_TIMER_MS = 2 ** 31 - 1;
const MAX_AUTHORIZATION_ATTEMPTS = 3;

// Close codes
export const WS_CLOSE = {
  AUTH_TIMEOUT: { code: 4001, reason: "Authentication timeout" },
  AUTH_FAILED: { code: 4002, reason: "Authentication failed" },
  MEMBERSHIP_REVOKED: { code: 4003, reason: "Membership revoked" },
  SESSION_EXPIRED: { code: 4004, reason: "Session expired" },
  SESSION_REVOKED: { code: 4005, reason: "Session revoked" },
  CONNECTION_LIMIT: { code: 4008, reason: "Connection limit exceeded" },
  IDLE_TIMEOUT: { code: 4009, reason: "Idle timeout" },
} as const;

type CloseReason = (typeof WS_CLOSE)[keyof typeof WS_CLOSE];

export async function authenticate(
  ws: WebSocket,
  token: string,
  prisma: PrismaClient,
): Promise<string | null> {
  try {
    const payload = verifyAccessToken(token);
    const userId = payload.sub;
    if (typeof payload.exp !== "number") throw new Error("Access token has no expiry");

    // Check user exists
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true },
    });

    // The client may have gone away while the lookup ran; registering it now
    // would leak a connection slot that no close event will ever release.
    if (ws.readyState !== ws.OPEN) return null;

    if (!user) {
      ws.close(WS_CLOSE.AUTH_FAILED.code, WS_CLOSE.AUTH_FAILED.reason);
      return null;
    }

    // Check connection limit
    const currentCount = userConnectionCounts.get(userId) || 0;
    if (currentCount >= MAX_CONNECTIONS_PER_USER) {
      ws.close(WS_CLOSE.CONNECTION_LIMIT.code, WS_CLOSE.CONNECTION_LIMIT.reason);
      return null;
    }

    const conn: ConnectionInfo = {
      userId,
      projects: new Map(),
      workspaceIds: new Set(),
      channels: new Map(),
      accessVersion: 0,
      expiresAt: payload.exp * 1000,
      authenticatedAt: Date.now(),
      lastActivity: Date.now(),
    };
    connections.set(ws, conn);
    userConnectionCounts.set(userId, currentCount + 1);
    scheduleExpiry(ws, conn);

    return userId;
  } catch {
    ws.close(WS_CLOSE.AUTH_FAILED.code, WS_CLOSE.AUTH_FAILED.reason);
    return null;
  }
}

function scheduleExpiry(ws: WebSocket, conn: ConnectionInfo): void {
  const delay = Math.min(Math.max(conn.expiresAt - Date.now(), 0), MAX_TIMER_MS);
  conn.expiryTimer = setTimeout(() => {
    if (connections.get(ws) !== conn) return;
    if (Date.now() >= conn.expiresAt) terminate(ws, WS_CLOSE.SESSION_EXPIRED);
    else scheduleExpiry(ws, conn);
  }, delay);
  conn.expiryTimer.unref?.();
}

// Unregisters first, so nothing more is delivered while the close handshake runs.
function terminate(ws: WebSocket, close: CloseReason): void {
  cleanup(ws);
  if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) {
    ws.close(close.code, close.reason);
  }
}

function deliver(ws: WebSocket, conn: ConnectionInfo, message: string): void {
  // A late expiry timer must not let an expired session receive anything.
  if (Date.now() >= conn.expiresAt) {
    terminate(ws, WS_CLOSE.SESSION_EXPIRED);
    return;
  }
  if (ws.readyState === ws.OPEN) ws.send(message);
}

/**
 * Runs an authorization read for the socket's user and returns the workspace
 * it resolved, unless the socket went away. When a revocation for the user
 * happened while the read was in flight, the read is repeated so an earlier
 * result can never restore access that has since been removed.
 */
async function authorizeCurrent(
  ws: WebSocket,
  check: (userId: string) => Promise<string | null>,
): Promise<{ conn: ConnectionInfo; workspaceId: string } | null> {
  const conn = connections.get(ws);
  if (!conn) return null;
  for (let attempt = 0; attempt < MAX_AUTHORIZATION_ATTEMPTS; attempt++) {
    const version = conn.accessVersion;
    const workspaceId = await check(conn.userId).catch(() => null);
    if (!workspaceId || connections.get(ws) !== conn) return null;
    if (conn.accessVersion === version) return { conn, workspaceId };
  }
  return null;
}

export async function subscribe(
  ws: WebSocket,
  projectId: string,
  prisma: PrismaClient,
): Promise<boolean> {
  const admitted = await authorizeCurrent(
    ws,
    async (userId) => (await assertProjectAccess(prisma, projectId, userId)).workspaceId,
  );
  if (!admitted) return false;

  admitted.conn.projects.set(projectId, admitted.workspaceId);
  admitted.conn.lastActivity = Date.now();
  return true;
}

export function unsubscribe(ws: WebSocket, projectId: string): void {
  const conn = connections.get(ws);
  if (conn) {
    conn.projects.delete(projectId);
    conn.lastActivity = Date.now();
  }
}

export async function subscribeWorkspace(
  ws: WebSocket,
  workspaceId: string,
  prisma: PrismaClient,
): Promise<boolean> {
  const admitted = await authorizeCurrent(ws, async (userId) => {
    const member = await prisma.workspaceMember.findUnique({
      where: { userId_workspaceId: { userId, workspaceId } },
      select: { workspaceId: true },
    });
    return member?.workspaceId ?? null;
  });
  if (!admitted) return false;

  admitted.conn.workspaceIds.add(workspaceId);
  admitted.conn.lastActivity = Date.now();

  // Broadcast presence to workspace
  broadcastToWorkspace(workspaceId, "presence_online", { userId: admitted.conn.userId }, admitted.conn.userId);

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
  // A channel membership row only counts while its workspace membership does.
  const admitted = await authorizeCurrent(ws, async (userId) => {
    const channel = await prisma.chatChannel.findFirst({
      where: {
        id: channelId,
        members: { some: { userId } },
        workspace: { members: { some: { userId } } },
      },
      select: { workspaceId: true },
    });
    return channel?.workspaceId ?? null;
  });
  if (!admitted) return false;

  admitted.conn.channels.set(channelId, admitted.workspaceId);
  admitted.conn.lastActivity = Date.now();
  return true;
}

export function unsubscribeChannel(ws: WebSocket, channelId: string): void {
  const conn = connections.get(ws);
  if (conn) {
    conn.channels.delete(channelId);
    conn.lastActivity = Date.now();
  }
}

// ─── Revocation ────────────────────────────────────────
// Call these after the membership change has committed. They take effect
// synchronously on every socket the user has open in this process.

function revoke(userId: string, drop: (conn: ConnectionInfo) => void): void {
  for (const conn of connections.values()) {
    if (conn.userId === userId) {
      conn.accessVersion++;
      drop(conn);
    }
  }
}

export function revokeProjectAccess(userId: string, projectId: string): void {
  revoke(userId, (conn) => conn.projects.delete(projectId));
}

export function revokeChannelAccess(userId: string, channelId: string): void {
  revoke(userId, (conn) => conn.channels.delete(channelId));
}

/** Drops project subscriptions in a workspace except the ones still allowed. */
export function revokeWorkspaceProjects(
  userId: string,
  workspaceId: string,
  retainedProjectIds: ReadonlySet<string>,
): void {
  revoke(userId, (conn) => {
    for (const [projectId, projectWorkspaceId] of conn.projects) {
      if (projectWorkspaceId === workspaceId && !retainedProjectIds.has(projectId)) {
        conn.projects.delete(projectId);
      }
    }
  });
}

/** Drops the workspace and every project and channel subscription inside it. */
export function revokeWorkspaceAccess(userId: string, workspaceId: string): void {
  let wasPresent = false;
  revoke(userId, (conn) => {
    if (conn.workspaceIds.delete(workspaceId)) wasPresent = true;
    for (const [projectId, projectWorkspaceId] of conn.projects) {
      if (projectWorkspaceId === workspaceId) conn.projects.delete(projectId);
    }
    for (const [channelId, channelWorkspaceId] of conn.channels) {
      if (channelWorkspaceId === workspaceId) conn.channels.delete(channelId);
    }
  });
  if (wasPresent) {
    broadcastToWorkspace(workspaceId, "presence_offline", { userId }, userId);
  }
}

/**
 * Closes every socket the user has open, for session-wide revocation such as
 * a password change or reset. Clients must authenticate again to reconnect.
 */
export function disconnectUserSockets(userId: string): void {
  for (const [ws, conn] of connections) {
    if (conn.userId === userId) terminate(ws, WS_CLOSE.SESSION_REVOKED);
  }
}

// ─── Delivery ──────────────────────────────────────────

export function broadcastToChannel(
  channelId: string,
  event: string,
  data: unknown,
  excludeUserId?: string,
  // When given, only subscribers among these users receive the event.
  onlyUserIds?: ReadonlySet<string>,
): void {
  const message = JSON.stringify({ event, data, channelId });

  for (const [ws, conn] of connections) {
    if (
      conn.channels.has(channelId) &&
      conn.userId !== excludeUserId &&
      (!onlyUserIds || onlyUserIds.has(conn.userId))
    ) {
      deliver(ws, conn, message);
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
    if (conn.projects.has(projectId) && conn.userId !== excludeUserId) {
      deliver(ws, conn, message);
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
      deliver(ws, conn, message);
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
    if (conn.userId === userId) {
      deliver(ws, conn, message);
    }
  }
}

export function cleanup(ws: WebSocket): void {
  const conn = connections.get(ws);
  if (conn) {
    clearTimeout(conn.expiryTimer);
    connections.delete(ws);
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
