import assert from "node:assert/strict";
import crypto from "node:crypto";
import net from "node:net";

// Minimal RFC 6455 client over a plain TCP socket. It runs on every supported
// Node.js release (Node 20 has no global WebSocket client) and lets the tests
// control framing, including fragmented and oversized messages. A distinct
// loopback `localAddress` keeps the per-IP rate limit out of busy tests.
export async function openRawSocket(port, { localAddress } = {}) {
  const socket = net.connect({ port, host: "127.0.0.1", ...(localAddress ? { localAddress } : {}) });
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
      } else if (length === 127) {
        if (buffered.length < 10) return undefined;
        length = Number(buffered.readBigUInt64BE(2));
        offset = 10;
      }
      if (buffered.length < offset + length) return undefined;
      const frame = { opcode: buffered[0] & 0x0f, payload: buffered.subarray(offset, offset + length) };
      buffered = buffered.subarray(offset + length);
      return frame;
    }, timeoutMs);

  const inbox = [];
  let closeFrame;
  // Reads every frame that arrives within timeoutMs into the inbox.
  const drain = async (timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    while (!closeFrame) {
      const frame = await nextFrame(Math.max(0, deadline - Date.now()));
      if (!frame) return;
      if (frame.opcode === 0x8) {
        closeFrame = { code: frame.payload.readUInt16BE(0), reason: frame.payload.subarray(2).toString("utf8") };
      } else if (frame.opcode === 0x1) {
        inbox.push(JSON.parse(frame.payload.toString("utf8")));
      }
    }
  };
  // Resolves the next JSON text message matching predicate.
  const next = async (predicate, timeoutMs = 5000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const index = inbox.findIndex(predicate);
      if (index !== -1) return inbox.splice(index, 1)[0];
      if (closeFrame) throw new Error(`Socket closed with ${closeFrame.code}`);
      const frame = await nextFrame(Math.max(0, deadline - Date.now()));
      if (!frame) throw new Error(`No matching message; received ${JSON.stringify(inbox)}`);
      if (frame.opcode === 0x8) {
        closeFrame = { code: frame.payload.readUInt16BE(0), reason: frame.payload.subarray(2).toString("utf8") };
        throw new Error(`Socket closed with ${closeFrame.code}`);
      }
      if (frame.opcode === 0x1) inbox.push(JSON.parse(frame.payload.toString("utf8")));
    }
  };
  // Reads up to the server's close frame and returns its status and reason.
  const closed = async (timeoutMs = 5000) => {
    if (closeFrame) return closeFrame;
    for (;;) {
      const frame = await nextFrame(timeoutMs);
      if (!frame) return undefined;
      if (frame.opcode === 0x8) {
        closeFrame = { code: frame.payload.readUInt16BE(0), reason: frame.payload.subarray(2).toString("utf8") };
        return closeFrame;
      }
      if (frame.opcode === 0x1) inbox.push(JSON.parse(frame.payload.toString("utf8")));
    }
  };
  const sendJSON = (value) => socket.write(clientFrame(0x1, true, Buffer.from(JSON.stringify(value))));
  const close = (code) => {
    const payload = Buffer.alloc(2);
    payload.writeUInt16BE(code);
    socket.write(clientFrame(0x8, true, payload));
  };
  return { socket, inbox, nextFrame, next, drain, closed, sendJSON, close };
}

// A masked client frame header for a payload of the given length.
export function clientFrameHeader(opcode, fin, length) {
  const first = (fin ? 0x80 : 0) | opcode;
  if (length < 126) return Buffer.from([first, 0x80 | length]);
  if (length < 65536) return Buffer.from([first, 0x80 | 126, length >> 8, length & 0xff]);
  const head = Buffer.alloc(10);
  head[0] = first;
  head[1] = 0x80 | 127;
  head.writeBigUInt64BE(BigInt(length), 2);
  return head;
}

export function clientFrame(opcode, fin, payload) {
  const mask = crypto.randomBytes(4);
  const masked = Buffer.from(payload.map((byte, index) => byte ^ mask[index % 4]));
  return Buffer.concat([clientFrameHeader(opcode, fin, payload.length), mask, masked]);
}
