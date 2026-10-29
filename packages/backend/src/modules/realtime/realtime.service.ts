import type { WebSocket } from "ws";
import type { PrismaClient } from "@prisma/client";
import { verifyAccessToken } from "../../utils/tokens.js";
import { assertProjectAccess } from "../../utils/project-access.js";

interface ConnectionInfo {
  userId: string;
  // The sign-in session (refresh-token family) of the access token that
  // opened the socket. Ending that session closes the socket.
  sessionId: string;
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

// Authentications whose session lookup is in flight. Ending a session marks
// them, so a lookup that read the session just before its revocation
// committed cannot register a socket after the revocation closed the others.
interface PendingAuthentication {
  userId: string;
  sessionId: string;
  ended: boolean;
}
const pendingAuthentications = new Set<PendingAuthentication>();

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

/**
 * Authenticates a socket with an access token whose session is still live.
 *
 * Close codes: 4002 for an invalid or expired token; 4004 for a token that
 * names no session (issued before access tokens carried `sid`), so the client
 * refreshes and reconnects with a session-bound token; 4005 for a token whose
 * session has ended (logout, password change or reset, password login
 * elsewhere, refresh-token reuse, or a deleted account).
 */
export async function authenticate(
  ws: WebSocket,
  token: string,
  prisma: PrismaClient,
): Promise<string | null> {
  let payload: ReturnType<typeof verifyAccessToken>;
  try {
    payload = verifyAccessToken(token);
    if (typeof payload.exp !== "number") throw new Error("Access token has no expiry");
  } catch {
    ws.close(WS_CLOSE.AUTH_FAILED.code, WS_CLOSE.AUTH_FAILED.reason);
    return null;
  }
  const userId = payload.sub;
  const sessionId = payload.sid;
  // A token without a session could never be closed with it.
  if (typeof sessionId !== "string" || sessionId === "") {
    ws.close(WS_CLOSE.SESSION_EXPIRED.code, WS_CLOSE.SESSION_EXPIRED.reason);
    return null;
  }

  const pending: PendingAuthentication = { userId, sessionId, ended: false };
  pendingAuthentications.add(pending);
  try {
    // A live session implies the account exists: families cascade with it.
    const session = await prisma.refreshTokenFamily.findFirst({
      where: { id: sessionId, userId, revokedAt: null },
      select: { id: true },
    });

    // The client may have gone away while the lookup ran; registering it now
    // would leak a connection slot that no close event will ever release.
    if (ws.readyState !== ws.OPEN) return null;

    // `ended` is set by a revocation that committed after the lookup read
    // the session; nothing awaits between this check and registration.
    if (!session || pending.ended) {
      ws.close(WS_CLOSE.SESSION_REVOKED.code, WS_CLOSE.SESSION_REVOKED.reason);
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
      sessionId,
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
  } finally {
    pendingAuthentications.delete(pending);
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

// ─── Session end ───────────────────────────────────────
// Call these after the revocation has committed. They close the affected
// sockets in this process with 4005 before the caller responds, and refuse
// authentications of those sessions whose lookup is still in flight.

/**
 * Closes every socket opened with an access token of one of these sessions
 * (refresh-token family ids). Sockets of the user's other sessions stay open.
 */
export function endSessions(sessionIds: Iterable<string>): void {
  const ended = new Set(sessionIds);
  if (ended.size === 0) return;
  for (const pending of pendingAuthentications) {
    if (ended.has(pending.sessionId)) pending.ended = true;
  }
  for (const [ws, conn] of connections) {
    if (ended.has(conn.sessionId)) terminate(ws, WS_CLOSE.SESSION_REVOKED);
  }
}

/**
 * Closes every socket the user has open in any session. No route calls it
 * today: there is no account deletion or deactivation endpoint, and a deleted
 * account's sessions are deleted with it, so its sockets could not
 * authenticate again.
 */
export function disconnectUserSockets(userId: string): void {
  for (const pending of pendingAuthentications) {
    if (pending.userId === userId) pending.ended = true;
  }
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
