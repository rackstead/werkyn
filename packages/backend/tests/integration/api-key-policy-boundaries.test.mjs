import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import net from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { parseMessage, startSmtpCapture } from "../fixtures/smtp-capture.mjs";
import { clientFrame } from "./support/raw-websocket.mjs";

if (!process.env.TEST_DATABASE_URL)
  throw new Error("Set TEST_DATABASE_URL to migrated disposable PostgreSQL");

test(
  "issued API keys are HTTP-only and survive password reset until explicit revocation",
  { timeout: 45_000 },
  async () => {
    let app,
      smtp,
      socket,
      user,
      origin,
      storage,
      resetTransporter,
      apiKey,
      failure,
      phase = "setup",
      requests = 0;
    const familyIds = new Set();
    const email = "key-policy-" + crypto.randomUUID() + "@example.test";
    function safeFailure(error, step) {
      // Preserve the failing step and safe assertion values without credentials.
      const safe = new Error("Credential policy check failed during " + step);
      safe.name = error?.code === "ERR_ASSERTION" ? "AssertionError" : "Error";
      const primitive = (value) =>
        value === null ||
        typeof value === "number" ||
        typeof value === "boolean" ||
        ["string", "undefined"].includes(value);
      if (primitive(error?.actual)) safe.actual = error.actual;
      if (primitive(error?.expected)) safe.expected = error.expected;
      if (["strictEqual", "ok"].includes(error?.operator))
        safe.operator = error.operator;
      return safe;
    }
    async function request(label, method, pathname, { token, payload } = {}) {
      phase = label;
      requests++;
      assert.ok(requests <= 12);
      const result = await new Promise((resolve, reject) => {
        const body =
          payload === undefined ? undefined : JSON.stringify(payload);
        const req = http.request(
          new URL(pathname, origin),
          {
            method,
            localAddress: "127.76.0." + requests,
            headers: {
              ...(token ? { authorization: "Bearer " + token } : {}),
              ...(body
                ? {
                    "content-type": "application/json",
                    "content-length": Buffer.byteLength(body),
                  }
                : {}),
            },
          },
          (res) => {
            let text = "";
            res.setEncoding("utf8");
            res.on("data", (chunk) => {
              text += chunk;
            });
            res.on("end", () => {
              clearTimeout(timer);
              let json;
              try {
                json = text ? JSON.parse(text) : null;
              } catch {
                reject(new Error(label + ": local HTTP response was not JSON"));
                return;
              }
              resolve({
                status: res.statusCode,
                json,
                setCookie: Boolean(res.headers["set-cookie"]?.length),
              });
            });
          },
        );
        const timer = setTimeout(
          () => req.destroy(new Error(label + ": local HTTP deadline")),
          5000,
        );
        req.on("error", () => {
          clearTimeout(timer);
          reject(new Error(label + ": local HTTP transport failure"));
        });
        req.end(body);
      });
      return result;
    }
    async function keySocket() {
      phase = "valid issued key WebSocket authentication";
      const observed = {
        handshakeStatus: null,
        closeCode: null,
        authenticatedEvent: false,
        timedOut: false,
        transportError: false,
      };
      const result = await new Promise((resolve) => {
        let buffer = Buffer.alloc(0),
          handshake = false,
          settled = false;
        function done() {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          socket?.destroy();
          resolve(observed);
        }
        const timer = setTimeout(() => {
          observed.timedOut = true;
          done();
        }, 2000);
        socket = net.connect({
          host: "127.0.0.1",
          port: app.server.address().port,
          localAddress: "127.76.1.1",
        });
        socket.on("error", () => {
          observed.transportError = true;
          done();
        });
        socket.on("connect", () =>
          socket.write(
            [
              "GET /api/ws HTTP/1.1",
              "Host: 127.0.0.1:" + app.server.address().port,
              "Upgrade: websocket",
              "Connection: Upgrade",
              "Sec-WebSocket-Key: " + crypto.randomBytes(16).toString("base64"),
              "Sec-WebSocket-Version: 13",
              "",
              "",
            ].join("\r\n"),
          ),
        );
        socket.on("data", (chunk) => {
          buffer = Buffer.concat([buffer, chunk]);
          if (!handshake) {
            const end = buffer.indexOf("\r\n\r\n");
            if (end === -1) return;
            const match = /^HTTP\/1\.1 (\d+)/.exec(
              buffer.subarray(0, end).toString("latin1"),
            );
            observed.handshakeStatus = match ? Number(match[1]) : null;
            buffer = buffer.subarray(end + 4);
            handshake = true;
            if (observed.handshakeStatus !== 101) {
              done();
              return;
            }
            socket.write(
              clientFrame(
                1,
                true,
                Buffer.from(JSON.stringify({ type: "auth", token: apiKey })),
              ),
            );
          }
          while (buffer.length >= 2) {
            const opcode = buffer[0] & 15;
            let length = buffer[1] & 127,
              offset = 2;
            if (length === 126) {
              if (buffer.length < 4) return;
              length = buffer.readUInt16BE(2);
              offset = 4;
            } else if (length === 127) {
              observed.transportError = true;
              done();
              return;
            }
            if (buffer.length < offset + length) return;
            const payload = buffer.subarray(offset, offset + length);
            buffer = buffer.subarray(offset + length);
            if (opcode === 8) {
              observed.closeCode =
                payload.length >= 2 ? payload.readUInt16BE(0) : null;
              done();
              return;
            }
            if (opcode === 1) {
              try {
                observed.authenticatedEvent ||=
                  JSON.parse(payload.toString()).event === "authenticated";
              } catch {
                observed.transportError = true;
                done();
                return;
              }
            }
          }
        });
        socket.on("end", done);
      });
      return result;
    }
    try {
      smtp = await startSmtpCapture();
      storage = await mkdtemp(path.join(os.tmpdir(), "werkyn-key-policy-"));
      const password = crypto.randomBytes(24).toString("base64url") + "Aa1!";
      const nextPassword =
        crypto.randomBytes(24).toString("base64url") + "Bb2!";
      Object.assign(process.env, {
        DATABASE_URL: process.env.TEST_DATABASE_URL,
        NODE_ENV: "test",
        LOG_LEVEL: "error",
        JWT_SECRET: crypto.randomBytes(32).toString("base64url"),
        COOKIE_SECRET: crypto.randomBytes(32).toString("base64url"),
        STORAGE_DIR: storage,
        APP_URL: "http://127.0.0.1",
        SMTP_HOST: "127.0.0.1",
        SMTP_PORT: String(smtp.port),
        SMTP_SECURE: "false",
        SMTP_FROM: "fixture@example.test",
        SMTP_USER: "",
        SMTP_PASS: "",
      });
      const [{ buildApp }, { hashPassword }, mailer] = await Promise.all([
        import("../../src/app.js"),
        import("../../src/utils/passwords.js"),
        import("../../src/utils/mailer.js"),
      ]);
      resetTransporter = mailer.resetTransporter;
      resetTransporter();
      app = await buildApp();
      origin = await app.listen({ host: "127.0.0.1", port: 0 });
      assert.equal(app.server.address().address, "127.0.0.1");
      phase = "create owned user";
      user = await app.prisma.user.create({
        data: {
          email,
          displayName: "Key policy fixture",
          emailVerified: true,
          passwordHash: await hashPassword(password),
        },
        select: { id: true },
      });
      const login = await request("initial login", "POST", "/api/auth/login", {
        payload: { email, password },
      });
      assert.equal(login.status, 200);
      const accessToken = login.json?.data?.accessToken;
      assert.equal(typeof accessToken, "string");
      const sid = JSON.parse(
        Buffer.from(accessToken.split(".")[1], "base64url").toString(),
      ).sid;
      familyIds.add(sid);
      const created = await request("issue key", "POST", "/api/api-keys", {
        token: accessToken,
        payload: { name: "Key policy fixture", expiresInDays: null },
      });
      assert.equal(created.status, 201);
      apiKey = created.json?.data?.key;
      const keyId = created.json?.data?.id;
      assert.ok(/^wk_[a-f0-9]{64}$/.test(apiKey));
      const beforeReset = await request(
        "key before reset",
        "GET",
        "/api/users/me",
        { token: apiKey },
      );
      assert.equal(beforeReset.status, 200);
      assert.equal(beforeReset.json?.data?.id, user.id);

      // The socket receives the same issued key that succeeded over HTTP.
      const ws = await keySocket();
      assert.equal(ws.handshakeStatus, 101);
      assert.equal(ws.closeCode, 4002);
      assert.equal(ws.authenticatedEvent, false);
      assert.equal(ws.timedOut, false);
      assert.equal(ws.transportError, false);

      const forgot = await request(
        "forgot password",
        "POST",
        "/api/auth/forgot-password",
        { payload: { email } },
      );
      assert.equal(forgot.status, 200);
      const deadline = Date.now() + 5000;
      while (smtp.messages.length < 1 && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(smtp.messages.length, 1);
      const message = smtp.messages.find((entry) =>
        entry.envelope.to.includes("<" + email + ">"),
      );
      assert.ok(message);
      const textOf = (part) => part.text ?? part.parts.map(textOf).join("\n");
      const link = /https?:\/\/[^\s"<>]*\/reset-password\/([a-f0-9]{64})/.exec(
        textOf(parseMessage(message.data)),
      );
      assert.ok(link, "Reset proof must come from the actual SMTP message");
      const reset = await request(
        "reset password",
        "POST",
        "/api/auth/reset-password/" + link[1],
        { payload: { password: nextPassword } },
      );
      assert.equal(reset.status, 200);
      const family = await app.prisma.refreshTokenFamily.findUnique({
        where: { id: sid },
        select: { revokedAt: true },
      });
      assert.ok(family?.revokedAt);
      const keyAfterReset = await app.prisma.apiKey.findUnique({
        where: { id: keyId },
        select: { revokedAt: true },
      });
      assert.equal(keyAfterReset?.revokedAt, null);
      assert.equal(
        (
          await request("old session", "GET", "/api/users/me", {
            token: accessToken,
          })
        ).status,
        401,
      );
      const afterReset = await request(
        "same key after reset",
        "GET",
        "/api/users/me",
        { token: apiKey },
      );
      assert.equal(afterReset.status, 200);
      assert.equal(afterReset.json?.data?.id, user.id);

      const newer = await request("new login", "POST", "/api/auth/login", {
        payload: { email, password: nextPassword },
      });
      assert.equal(newer.status, 200);
      const newToken = newer.json?.data?.accessToken;
      assert.equal(typeof newToken, "string");
      familyIds.add(
        JSON.parse(Buffer.from(newToken.split(".")[1], "base64url").toString())
          .sid,
      );
      assert.equal(
        (
          await request("revoke key", "DELETE", "/api/api-keys/" + keyId, {
            token: newToken,
          })
        ).status,
        204,
      );
      const revoked = await app.prisma.apiKey.findUnique({
        where: { id: keyId },
        select: { revokedAt: true },
      });
      assert.ok(revoked?.revokedAt);
      assert.equal(
        (
          await request("revoked key", "GET", "/api/users/me", {
            token: apiKey,
          })
        ).status,
        401,
      );
      assert.equal(requests, 10);
    } catch (error) {
      failure = safeFailure(error, phase);
    } finally {
      try {
        socket?.destroy();
        try {
          if (app && user) {
            await app.prisma.rotatedRefreshToken.deleteMany({
              where: { familyId: { in: [...familyIds] } },
            });
            await app.prisma.user.deleteMany({ where: { id: user.id } });
            await app.prisma.loginAttempt.deleteMany({ where: { email } });
          }
        } finally {
          try {
            await app?.close();
          } finally {
            resetTransporter?.();
            try {
              await smtp?.close();
            } finally {
              if (storage) await rm(storage, { recursive: true, force: true });
            }
          }
        }
      } catch (error) {
        failure ??= safeFailure(error, "owned cleanup");
      }
    }
    if (failure) throw failure;
  },
);
