import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

if (!process.env.TEST_DATABASE_URL)
  throw new Error("Set TEST_DATABASE_URL to a migrated, disposable PostgreSQL database");
Object.assign(process.env, {
  DATABASE_URL: process.env.TEST_DATABASE_URL,
  NODE_ENV: "test",
  LOG_LEVEL: "error",
  JWT_SECRET: "realtime-websocket-test-jwt-secret",
  COOKIE_SECRET: "realtime-websocket-test-cookie-secret",
});
const storageDir = await mkdtemp(path.join(os.tmpdir(), "werkyn-realtime-ws-"));
process.env.STORAGE_DIR = storageDir;
const { buildApp } = await import("../../src/app.js");
const { signAccessToken } = await import("../../src/utils/tokens.js");

let app, port, member, outsider, workspace, foreignWorkspace, token;

before(async () => {
  app = await buildApp();
  await app.listen({ host: "127.0.0.1", port: 0 });
  port = app.server.address().port;
  const suffix = crypto.randomUUID();
  member = await app.prisma.user.create({
    data: { email: `realtime-member-${suffix}@example.test`, displayName: "Member", emailVerified: true },
  });
  outsider = await app.prisma.user.create({
    data: { email: `realtime-outsider-${suffix}@example.test`, displayName: "Outsider", emailVerified: true },
  });
  workspace = await app.prisma.workspace.create({
    data: { name: "Realtime", slug: `rt-${suffix}`, members: { create: { userId: member.id, role: "MEMBER" } } },
  });
  foreignWorkspace = await app.prisma.workspace.create({
    data: { name: "Realtime foreign", slug: `rt-foreign-${suffix}`, members: { create: { userId: outsider.id, role: "ADMIN" } } },
  });
  token = signAccessToken({ sub: member.id, email: member.email });
});

after(async () => {
  try {
    if (app) {
      await app.prisma.workspace.deleteMany({
        where: { id: { in: [workspace?.id, foreignWorkspace?.id].filter(Boolean) } },
      });
      await app.prisma.user.deleteMany({
        where: { id: { in: [member?.id, outsider?.id].filter(Boolean) } },
      });
    }
  } finally {
    await app?.close();
    await rm(storageDir, { recursive: true, force: true });
  }
});

// Minimal RFC 6455 client over a plain TCP socket. It runs on every supported
// Node.js release (Node 20 has no global WebSocket client) and lets the tests
// control framing, including fragmented messages.
async function rawSocket() {
  const socket = net.connect(port, "127.0.0.1");
  let buffered = Buffer.alloc(0);
  let ended = false;
  const waiters = [];
  const wake = () => {
    while (waiters.length) waiters.shift()();
  };
  socket.on("data", (chunk) => {
    buffered = Buffer.concat([buffered, chunk]);
    wake();
  });
  socket.on("close", () => {
    ended = true;
    wake();
  });
  socket.on("error", () => {});
  const waitFor = async (check, timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const result = check();
      if (result !== undefined) return result;
      const remaining = deadline - Date.now();
      if (ended || remaining <= 0) return undefined;
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, remaining);
        waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  };
  socket.write(
    [
      "GET /api/ws HTTP/1.1",
      `Host: 127.0.0.1:${port}`,
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Key: ${crypto.randomBytes(16).toString("base64")}`,
      "Sec-WebSocket-Version: 13",
      "",
      "",
    ].join("\r\n"),
  );
  const head = await waitFor(() => {
    const end = buffered.indexOf("\r\n\r\n");
    if (end === -1) return undefined;
    const text = buffered.subarray(0, end).toString("latin1");
    buffered = buffered.subarray(end + 4);
    return text;
  }, 5000);
  assert.match(head ?? "", /^HTTP\/1\.1 101 /);

  // Parses the next unmasked server frame once it has fully arrived.
  const nextFrame = (timeoutMs = 5000) =>
    waitFor(() => {
      if (buffered.length < 2) return undefined;
      let length = buffered[1] & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buffered.length < 4) return undefined;
        length = buffered.readUInt16BE(2);
        offset = 4;
      }
      if (buffered.length < offset + length) return undefined;
      const frame = { opcode: buffered[0] & 0x0f, payload: buffered.subarray(offset, offset + length) };
      buffered = buffered.subarray(offset + length);
      return frame;
    }, timeoutMs);

  const inbox = [];
  // Resolves the next JSON text message matching predicate.
  const next = async (predicate, timeoutMs = 5000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const index = inbox.findIndex(predicate);
      if (index !== -1) return inbox.splice(index, 1)[0];
      const frame = await nextFrame(Math.max(0, deadline - Date.now()));
      if (!frame) throw new Error(`No matching message; received ${JSON.stringify(inbox)}`);
      if (frame.opcode === 0x8) throw new Error(`Socket closed with ${frame.payload.readUInt16BE(0)}`);
      if (frame.opcode === 0x1) inbox.push(JSON.parse(frame.payload.toString("utf8")));
    }
  };
  // Reads up to the server's close frame and returns its status and reason.
  const closed = async (timeoutMs = 5000) => {
    for (;;) {
      const frame = await nextFrame(timeoutMs);
      if (!frame) return undefined;
      if (frame.opcode === 0x8) {
        return { code: frame.payload.readUInt16BE(0), reason: frame.payload.subarray(2).toString("utf8") };
      }
    }
  };
  const sendJSON = (value) => socket.write(clientFrame(0x1, true, Buffer.from(JSON.stringify(value))));
  const close = (code) => {
    const payload = Buffer.alloc(2);
    payload.writeUInt16BE(code);
    socket.write(clientFrame(0x8, true, payload));
  };
  return { socket, nextFrame, next, closed, sendJSON, close };
}

function clientFrame(opcode, fin, payload) {
  assert.ok(payload.length < 65536);
  const first = (fin ? 0x80 : 0) | opcode;
  const head =
    payload.length < 126
      ? Buffer.from([first, 0x80 | payload.length])
      : Buffer.from([first, 0x80 | 126, payload.length >> 8, payload.length & 0xff]);
  const mask = crypto.randomBytes(4);
  const masked = Buffer.from(payload.map((byte, index) => byte ^ mask[index % 4]));
  return Buffer.concat([head, mask, masked]);
}

test("an authenticated socket subscribes to its own workspace and receives its events", async () => {
  const client = await rawSocket();
  try {
    client.sendJSON({ type: "auth", token });
    assert.deepEqual(await client.next((m) => m.event === "authenticated"), { event: "authenticated" });

    client.sendJSON({ type: "subscribe_workspace", workspaceId: workspace.id });
    assert.deepEqual(await client.next((m) => m.event === "subscribed_workspace"), {
      event: "subscribed_workspace",
      workspaceId: workspace.id,
      success: true,
    });
    client.sendJSON({ type: "subscribe_workspace", workspaceId: foreignWorkspace.id });
    assert.deepEqual(await client.next((m) => m.event === "subscribed_workspace"), {
      event: "subscribed_workspace",
      workspaceId: foreignWorkspace.id,
      success: false,
    });

    app.broadcastToWorkspace(workspace.id, "fixture_event", { value: 1 });
    app.broadcastToWorkspace(foreignWorkspace.id, "fixture_event", { value: 2 });
    assert.deepEqual(await client.next((m) => m.event === "fixture_event"), {
      event: "fixture_event",
      data: { value: 1 },
      workspaceId: workspace.id,
    });

    client.sendJSON({ type: "ping" });
    assert.deepEqual(await client.next((m) => m.event === "pong"), { event: "pong" });
    await assert.rejects(client.next((m) => m.event === "fixture_event", 200), /No matching message/);

    client.close(1000);
    assert.equal((await client.closed())?.code, 1000);
  } finally {
    client.socket.destroy();
  }
});

test("a socket presenting an invalid token is closed as unauthenticated", async () => {
  const client = await rawSocket();
  try {
    client.sendJSON({ type: "auth", token: `${token}tampered` });
    assert.deepEqual(await client.closed(), { code: 4002, reason: "Authentication failed" });
  } finally {
    client.socket.destroy();
  }
});

test("a legitimately fragmented message is still reassembled", async () => {
  const raw = await rawSocket();
  try {
    const auth = Buffer.from(JSON.stringify({ type: "auth", token }));
    const parts = [];
    for (let offset = 0; offset < auth.length; offset += 100) parts.push(auth.subarray(offset, offset + 100));
    raw.socket.write(
      Buffer.concat(parts.map((part, index) => clientFrame(index === 0 ? 0x1 : 0x0, index === parts.length - 1, part))),
    );
    const frame = await raw.nextFrame();
    assert.equal(frame?.opcode, 0x1);
    assert.deepEqual(JSON.parse(frame.payload.toString("utf8")), { event: "authenticated" });
  } finally {
    raw.socket.destroy();
  }
});

test("an unauthenticated flood of tiny fragments is cut off before the auth timeout", async () => {
  const raw = await rawSocket();
  try {
    const started = Date.now();
    const frames = [clientFrame(0x1, false, Buffer.from("{"))];
    for (let index = 0; index < 20_000; index++) frames.push(clientFrame(0x0, false, Buffer.from(" ")));
    raw.socket.write(Buffer.concat(frames));

    const close = await raw.nextFrame(4000);
    assert.ok(close, "server kept buffering fragments without closing the connection");
    assert.equal(close.opcode, 0x8);
    assert.equal(close.payload.readUInt16BE(0), 1008);
    assert.ok(Date.now() - started < 4000);
  } finally {
    raw.socket.destroy();
  }

  const health = await fetch(`http://127.0.0.1:${port}/api/health`);
  assert.equal(health.status, 200);
});
