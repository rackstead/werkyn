import fp from "fastify-plugin";
import websocket from "@fastify/websocket";
import type { FastifyInstance } from "fastify";

// Clients only send small control messages (auth token, subscribe, ping). The
// ws default of 100 MiB would let an unauthenticated peer make the server
// buffer that much per message before the auth check runs; oversized frames
// are refused with 1009 as soon as their length is read.
export const WS_MAX_PAYLOAD_BYTES = 64 * 1024;

export default fp(async (fastify: FastifyInstance) => {
  await fastify.register(websocket, {
    options: { maxPayload: WS_MAX_PAYLOAD_BYTES },
  });
});
