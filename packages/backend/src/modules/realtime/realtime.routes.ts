import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import { z } from "zod";
import * as realtimeService from "./realtime.service.js";

const WsMessageSchema = z.object({
  type: z.enum(["subscribe", "unsubscribe", "subscribe_workspace", "unsubscribe_workspace", "subscribe_channel", "unsubscribe_channel", "ping"]),
  projectId: z.string().optional(),
  workspaceId: z.string().optional(),
  channelId: z.string().optional(),
});

export default async function realtimeRoutes(fastify: FastifyInstance) {
  fastify.route({
    method: "GET",
    url: "/ws",
    handler: (_request, reply) => {
      reply.status(400).send({ error: "WebSocket upgrade required" });
    },
    wsHandler: (socket: WebSocket) => {
      let authenticated = false;
      let authenticating = false;

      // Auth timeout: close if not authenticated within 5s
      const authTimer = setTimeout(() => {
        if (!authenticated) {
          socket.close(
            realtimeService.WS_CLOSE.AUTH_TIMEOUT.code,
            realtimeService.WS_CLOSE.AUTH_TIMEOUT.reason,
          );
        }
      }, realtimeService.getAuthTimeout());

      // Idle check interval
      const idleTimer = setInterval(() => {
        if (realtimeService.isIdle(socket)) {
          socket.close(
            realtimeService.WS_CLOSE.IDLE_TIMEOUT.code,
            realtimeService.WS_CLOSE.IDLE_TIMEOUT.reason,
          );
        }
      }, 60_000);

      socket.on("message", async (raw: Buffer | ArrayBuffer | Buffer[]) => {
        try {
          const text = typeof raw === "string" ? raw : raw.toString();
          const msg = JSON.parse(text);

          // First message must be auth. Anything sent while it is being
          // checked is ignored, so one socket can never register twice.
          if (!authenticated) {
            if (!authenticating && msg.type === "auth" && typeof msg.token === "string") {
              authenticating = true;
              const userId = await realtimeService.authenticate(
                socket,
                msg.token,
                fastify.prisma,
              );
              authenticating = false;
              if (userId) {
                authenticated = true;
                clearTimeout(authTimer);
                socket.send(JSON.stringify({ event: "authenticated" }));
              }
            }
            return;
          }

          // Validate message
          const result = WsMessageSchema.safeParse(msg);
          if (!result.success) return;

          const { type, projectId, workspaceId, channelId } = result.data;

          switch (type) {
            case "subscribe":
              if (projectId) {
                const ok = await realtimeService.subscribe(
                  socket,
                  projectId,
                  fastify.prisma,
                );
                socket.send(
                  JSON.stringify({
                    event: "subscribed",
                    projectId,
                    success: ok,
                  }),
                );
              }
              break;

            case "unsubscribe":
              if (projectId) {
                realtimeService.unsubscribe(socket, projectId);
                socket.send(
                  JSON.stringify({ event: "unsubscribed", projectId }),
                );
              }
              break;

            case "subscribe_workspace":
              if (workspaceId) {
                const ok = await realtimeService.subscribeWorkspace(
                  socket,
                  workspaceId,
                  fastify.prisma,
                );
                socket.send(
                  JSON.stringify({
                    event: "subscribed_workspace",
                    workspaceId,
                    success: ok,
                  }),
                );
              }
              break;

            case "unsubscribe_workspace":
              if (workspaceId) {
                realtimeService.unsubscribeWorkspace(socket, workspaceId);
                socket.send(
                  JSON.stringify({ event: "unsubscribed_workspace", workspaceId }),
                );
              }
              break;

            case "subscribe_channel":
              if (channelId) {
                const ok = await realtimeService.subscribeChannel(
                  socket,
                  channelId,
                  fastify.prisma,
                );
                socket.send(
                  JSON.stringify({
                    event: "subscribed_channel",
                    channelId,
                    success: ok,
                  }),
                );
              }
              break;

            case "unsubscribe_channel":
              if (channelId) {
                realtimeService.unsubscribeChannel(socket, channelId);
                socket.send(
                  JSON.stringify({ event: "unsubscribed_channel", channelId }),
                );
              }
              break;

            case "ping":
              realtimeService.touchConnection(socket);
              socket.send(JSON.stringify({ event: "pong" }));
              break;
          }
        } catch {
          // Ignore malformed messages
        }
      });

      socket.on("close", () => {
        clearTimeout(authTimer);
        clearInterval(idleTimer);
        realtimeService.cleanup(socket);
      });

      socket.on("error", () => {
        clearTimeout(authTimer);
        clearInterval(idleTimer);
        realtimeService.cleanup(socket);
      });
    },
  });
}
