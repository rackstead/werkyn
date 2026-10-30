import http, { type IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import fp from "fastify-plugin";
import type { FastifyInstance, FastifyServerOptions } from "fastify";

/**
 * How long the HTTP server waits for a client (see docs/remediation/p03a.md).
 * Every value is in milliseconds; tests pass shorter ones to buildApp().
 */
export interface RequestLimits {
  /**
   * The request line and every header must arrive within this time of the
   * first byte, or of the connection opening when nothing has been sent.
   */
  headersTimeoutMs: number;
  /**
   * The whole request, body included, must arrive within this time. Routes
   * that stream an upload are exempt and bound it themselves (below).
   */
  requestTimeoutMs: number;
  /**
   * A request or response that moves no bytes in either direction for this
   * long is dropped. Node skips one expiry while a write is still pending, so
   * a client that stops reading a download is dropped after one to two times
   * this value.
   */
  socketIdleTimeoutMs: number;
  /** An idle keep-alive connection is closed after this long. */
  keepAliveTimeoutMs: number;
  /** How often the server checks the header and request deadlines. */
  connectionsCheckingIntervalMs: number;
  /** A streamed upload that receives no bytes for this long gets a 408. */
  uploadIdleTimeoutMs: number;
}

export const REQUEST_LIMITS: Readonly<RequestLimits> = Object.freeze({
  headersTimeoutMs: 30_000,
  requestTimeoutMs: 120_000,
  socketIdleTimeoutMs: 120_000,
  keepAliveTimeoutMs: 72_000,
  connectionsCheckingIntervalMs: 5_000,
  uploadIdleTimeoutMs: 60_000,
});

/**
 * Timeouts a route opts out of, in its `config.timeouts`. Each opt-out is
 * replaced by the route's own bound (see docs/remediation/p03a.md).
 */
export interface RouteTimeouts {
  /**
   * false: the route streams its request body to storage and enforces its
   * own size limit and idle timeout, so the whole-request deadline does not
   * apply. The header deadline and the socket idle timeout still do.
   */
  request?: false;
  /**
   * false: the route may wait its turn or work for minutes before it answers
   * (backup exports, previews and restores), so the socket idle timeout is
   * suspended until its response starts. The backup module bounds those
   * phases itself (60 s transfer idle, 10-minute export deadline).
   */
  idleBeforeResponse?: false;
}

declare module "fastify" {
  interface FastifyContextConfig {
    timeouts?: RouteTimeouts;
  }
  interface FastifyInstance {
    requestLimits: Readonly<RequestLimits>;
  }
}

/**
 * The request each socket is streaming for an exempt route. A whole-request
 * timeout reported while that request is still incomplete is ignored.
 */
const exemptRequests = new WeakMap<Socket, IncomingMessage>();

function isExemptFromRequestTimeout(socket: Socket) {
  const request = exemptRequests.get(socket);
  return request !== undefined && !request.complete;
}

/** The request's TCP socket; injected test requests have none. */
function serverSocket(request: IncomingMessage): Socket | undefined {
  const socket = request.socket as Socket | null | undefined;
  return typeof socket?.setTimeout === "function" ? socket : undefined;
}

/**
 * Fastify's default client error response (fastify.js
 * defaultClientErrorHandler), except that the whole-request timeout of an
 * exempt upload is ignored.
 */
function clientErrorHandler(this: FastifyInstance, error: Error & { code?: string }, socket: Socket) {
  if (error.code === "ECONNRESET" || socket.destroyed) return;
  if (error.code === "ERR_HTTP_REQUEST_TIMEOUT" && isExemptFromRequestTimeout(socket)) {
    // Node has stopped tracking this request's deadline; the route's own idle
    // timeout and size limit bound it from here.
    this.log.debug("Request timeout ignored for a streamed upload");
    return;
  }
  let status: number;
  let message: string;
  let label: string;
  if (error.code === "ERR_HTTP_REQUEST_TIMEOUT") {
    status = 408;
    message = "Client Timeout";
    label = "timeout";
  } else if (error.code === "HPE_HEADER_OVERFLOW") {
    status = 431;
    message = "Exceeded maximum allowed HTTP header size";
    label = "header_overflow";
  } else {
    status = 400;
    message = "Client Error";
    label = "error";
  }
  const reason = http.STATUS_CODES[status];
  const body = JSON.stringify({ error: reason, message, statusCode: status });
  this.log.trace({ err: error }, `client ${label}`);
  if (socket.writable) {
    socket.write(
      `HTTP/1.1 ${status} ${reason}\r\nContent-Length: ${Buffer.byteLength(body)}\r\nContent-Type: application/json\r\n\r\n${body}`,
    );
  }
  socket.destroy(error);
}

/** Fastify server options that apply `limits` to the HTTP server. */
export function requestLimitServerOptions(limits: RequestLimits): FastifyServerOptions {
  return {
    requestTimeout: limits.requestTimeoutMs,
    connectionTimeout: limits.socketIdleTimeoutMs,
    keepAliveTimeout: limits.keepAliveTimeoutMs,
    http: {
      headersTimeout: limits.headersTimeoutMs,
      connectionsCheckingInterval: limits.connectionsCheckingIntervalMs,
    },
    clientErrorHandler,
  } as FastifyServerOptions;
}

/**
 * Applies each route's `config.timeouts` opt-outs, and exposes the limits to
 * handlers.
 */
export default fp<{ limits: Readonly<RequestLimits> }>(async (fastify, { limits }) => {
  fastify.decorate("requestLimits", limits);
  fastify.addHook("onRequest", async (request) => {
    const timeouts = request.routeOptions.config?.timeouts;
    const socket = serverSocket(request.raw);
    if (!timeouts || !socket) return;
    if (timeouts.request === false) exemptRequests.set(socket, request.raw);
    if (timeouts.idleBeforeResponse === false) socket.setTimeout(0);
  });
  // A client that stops reading the response is dropped like any other.
  // Node restores the idle timeout itself when the connection's next request
  // starts.
  fastify.addHook("onSend", async (request, _reply, payload) => {
    if (request.routeOptions.config?.timeouts?.idleBeforeResponse === false) {
      serverSocket(request.raw)?.setTimeout(limits.socketIdleTimeoutMs);
    }
    return payload;
  });
});
