// Account email over a real SMTP conversation with a local capture server:
// what Werkyn's mailer puts on the wire, how SMTP failures map to delivery
// results and logs, and that header injection through names, subjects and the
// configured sender never produces extra headers or recipients.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import net from "node:net";
import { after, afterEach, beforeEach, test } from "node:test";
import nodemailer from "nodemailer";
import { decodeWords, parseMessage, startSmtpCapture } from "./fixtures/smtp-capture.mjs";

Object.assign(process.env, {
  NODE_ENV: "production",
  LOG_LEVEL: "error",
  DATABASE_URL: "postgresql://unused:unused@127.0.0.1:5432/unused",
  JWT_SECRET: "mailer-smtp-test-jwt-secret-32-characters",
  COOKIE_SECRET: "mailer-smtp-test-cookie-secret-32-characters",
  SMTP_HOST: "",
});
delete process.env.SMTP_USER;
delete process.env.SMTP_PASS;

const { env } = await import("../src/config/env.ts");
const { logger } = await import("../src/utils/logger.ts");
const mailer = await import("../src/utils/mailer.ts");

const FRONTEND = "https://werkyn.example.test";
const FROM = "noreply@werkyn.example.test";
const RECIPIENT = "person@example.test";
const SMTP_USER = "smtp-user@werkyn.example.test";
const SMTP_PASS = "smtp-pass-5d1e-must-not-be-logged";
const token = () => crypto.randomBytes(32).toString("hex");

const originalLog = { error: logger.error, warn: logger.warn, info: logger.info };
let logs;
const servers = [];

async function capture(options) {
  const server = await startSmtpCapture(options);
  servers.push(server);
  return server;
}

function useSmtp(port, overrides = {}) {
  Object.assign(env, {
    SMTP_HOST: "127.0.0.1",
    SMTP_PORT: port,
    SMTP_SECURE: false,
    SMTP_USER: "",
    SMTP_PASS: "",
    SMTP_FROM: FROM,
    ...overrides,
  });
  mailer.resetTransporter();
}

async function closedPort() {
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

const logged = () =>
  JSON.stringify(logs, (_key, value) => (value instanceof Error ? { message: value.message, stack: value.stack } : value));

function onlyHeaders(message, allowed) {
  const names = message.headers.map((header) => header.name.toLowerCase());
  for (const name of names) assert.ok(allowed.includes(name), `unexpected header ${name}: ${message.headerLines.join(" | ")}`);
}

beforeEach(() => {
  logs = [];
  for (const level of ["error", "warn", "info"]) logger[level] = (...args) => logs.push({ level, args });
  env.NODE_ENV = "production";
  env.FRONTEND_URL = FRONTEND;
  mailer.setPrisma(undefined);
  mailer.resetTransporter();
});

afterEach(() => {
  Object.assign(logger, originalLog);
  env.SMTP_HOST = "";
  mailer.resetTransporter();
});

after(async () => {
  await Promise.all(servers.map((server) => server.close()));
});

const ACCOUNT_HEADERS = ["from", "to", "subject", "message-id", "date", "mime-version", "content-type"];

function assertAlternative(message, textIncludes, htmlIncludes) {
  assert.match(message.contentType, /^multipart\/alternative;/);
  assert.equal(message.parts.length, 2);
  const [plain, html] = message.parts;
  assert.match(plain.contentType, /^text\/plain; charset=utf-8$/i);
  assert.match(html.contentType, /^text\/html; charset=utf-8$/i);
  for (const fragment of textIncludes) assert.ok(plain.text.includes(fragment), `text part lacks ${fragment}: ${plain.text}`);
  for (const fragment of htmlIncludes) assert.ok(html.text.includes(fragment), `html part lacks ${fragment}: ${html.text}`);
}

test("verification email with an invitation arrives with intact headers and link", async () => {
  const server = await capture();
  useSmtp(server.port);
  const verification = token();
  const invite = token();

  const result = await mailer.sendVerificationEmail(RECIPIENT, verification, invite);
  assert.deepEqual(result, { status: "sent", transport: "environment" });

  assert.equal(server.messages.length, 1);
  const [{ envelope, data }] = server.messages;
  assert.deepEqual(envelope, { from: `<${FROM}>`, to: [`<${RECIPIENT}>`] });
  const message = parseMessage(data);
  onlyHeaders(message, ACCOUNT_HEADERS);
  assert.equal(message.get("From"), FROM);
  assert.equal(message.get("To"), RECIPIENT);
  assert.equal(message.get("Subject"), "Verify your email address");
  assert.equal(message.get("MIME-Version"), "1.0");
  assert.match(message.get("Message-ID"), /^<[^<>\s]+@werkyn\.example\.test>$/);

  const link = `${FRONTEND}/verify-email/${verification}?invite=${invite}`;
  assertAlternative(message, [link, "This link will expire in 24 hours."], [`<a href="${link}">Verify Email</a>`]);
});

test("verification email without an invitation links only to the verify page", async () => {
  const server = await capture();
  useSmtp(server.port);
  const verification = token();

  assert.deepEqual(await mailer.sendVerificationEmail(RECIPIENT, verification), { status: "sent", transport: "environment" });
  const message = parseMessage(server.messages[0].data);
  const link = `${FRONTEND}/verify-email/${verification}`;
  assertAlternative(message, [link], [`<a href="${link}">`]);
  assert.ok(message.parts[0].text.split(/\r?\n/).includes(link), "the link is a line of its own");
  assert.equal(server.messages[0].data.includes("invite="), false);
});

test("password reset email arrives with intact headers and link", async () => {
  const server = await capture();
  useSmtp(server.port);
  const reset = token();

  assert.deepEqual(await mailer.sendPasswordResetEmail(RECIPIENT, reset), { status: "sent", transport: "environment" });
  const [{ envelope, data }] = server.messages;
  assert.deepEqual(envelope, { from: `<${FROM}>`, to: [`<${RECIPIENT}>`] });
  const message = parseMessage(data);
  onlyHeaders(message, ACCOUNT_HEADERS);
  assert.equal(message.get("Subject"), "Reset your password");
  const link = `${FRONTEND}/reset-password/${reset}`;
  assertAlternative(message, [link, "This link will expire in 1 hour."], [`<a href="${link}">Reset Password</a>`]);
});

test("SMTP AUTH sends the configured credentials", async () => {
  const server = await capture({ auth: { user: SMTP_USER, pass: SMTP_PASS } });
  useSmtp(server.port, { SMTP_USER, SMTP_PASS });

  assert.deepEqual(await mailer.sendPasswordResetEmail(RECIPIENT, token()), { status: "sent", transport: "environment" });
  assert.deepEqual(server.sessions[0].auth, { user: SMTP_USER, pass: SMTP_PASS });
  assert.equal(server.messages.length, 1);
});

test("a refused SMTP login is a failed result logged without secrets", async () => {
  const server = await capture({ rejectAuth: true });
  useSmtp(server.port, { SMTP_USER, SMTP_PASS });
  const reset = token();
  const before = mailer.getMailDeliveryStats();

  const result = await mailer.sendPasswordResetEmail(RECIPIENT, reset);
  assert.deepEqual(result, { status: "failed", transport: "environment", code: "EAUTH" });
  assert.equal(server.messages.length, 0);
  assert.equal(mailer.getMailDeliveryStats().failed, before.failed + 1);
  assert.equal(mailer.getMailDeliveryStats().lastFailureCode, "EAUTH");

  const errors = logs.filter((entry) => entry.level === "error");
  assert.equal(errors.length, 1, logged());
  const [context, text] = errors[0].args;
  assert.equal(text, "Failed to send password-reset email");
  assert.equal(context.smtp.code, "EAUTH");
  assert.equal(context.smtp.responseCode, 535);
  assert.equal(context.smtp.command, "AUTH");
  for (const secret of [reset, SMTP_PASS, SMTP_USER, RECIPIENT]) {
    assert.equal(logged().includes(secret), false, `log contains ${secret}: ${logged()}`);
  }
});

test("a refused connection is a failed result", async () => {
  useSmtp(await closedPort());
  const reset = token();

  const result = await mailer.sendPasswordResetEmail(RECIPIENT, reset);
  assert.deepEqual(result, { status: "failed", transport: "environment", code: "ESOCKET" });
  const [context] = logs.find((entry) => entry.level === "error").args;
  assert.equal(context.smtp.code, "ESOCKET");
  assert.equal(context.smtp.command, "CONN");
  assert.match(context.smtp.message, /ECONNREFUSED/);
  assert.equal(logged().includes(reset), false);
});

test("a server that requires TLS before MAIL is a failed result", async () => {
  const server = await capture({ requireTls: true });
  useSmtp(server.port);
  const verification = token();

  const result = await mailer.sendVerificationEmail(RECIPIENT, verification);
  assert.deepEqual(result, { status: "failed", transport: "environment", code: "EENVELOPE" });
  assert.equal(server.messages.length, 0);
  const [context] = logs.find((entry) => entry.level === "error").args;
  assert.equal(context.smtp.responseCode, 530);
  assert.equal(context.smtp.command, "MAIL");
  for (const secret of [verification, RECIPIENT]) assert.equal(logged().includes(secret), false, logged());
});

test("implicit TLS against a plaintext server fails before any mail command", async () => {
  const server = await capture();
  useSmtp(server.port, { SMTP_SECURE: true });

  const result = await mailer.sendPasswordResetEmail(RECIPIENT, token());
  assert.equal(result.status, "failed");
  assert.equal(result.transport, "environment");
  assert.equal(result.code, "ESOCKET");
  assert.equal(server.messages.length, 0);
  assert.equal(server.sessions.flatMap((session) => session.commands).some((line) => /^(MAIL|RCPT|DATA)/i.test(line)), false);
});

test("a configured sender carrying CRLF never adds headers or recipients", async () => {
  const server = await capture();
  useSmtp(server.port);
  for (const fromAddress of [
    `${FROM}\r\nBcc: injected@evil.example`,
    `"Werkyn\r\nBcc: injected@evil.example" <${FROM}>`,
    `Werkyn <${FROM}>\nX-Injected: yes`,
  ]) {
    mailer.resetTransporter();
    mailer.setPrisma({
      emailConfig: { findUnique: async () => ({ host: "127.0.0.1", port: server.port, secure: false, user: "", pass: "", fromAddress }) },
    });
    const result = await mailer.sendPasswordResetEmail(RECIPIENT, token());
    assert.equal(result.status, "sent");
  }
  assert.equal(server.messages.length, 3);
  for (const { envelope, data } of server.messages) {
    assert.deepEqual(envelope.to, [`<${RECIPIENT}>`]);
    const message = parseMessage(data);
    onlyHeaders(message, ACCOUNT_HEADERS);
    for (const line of message.headerLines) assert.doesNotMatch(line, /^(bcc|x-injected):/i);
  }
});

test("CRLF in display names and subjects is encoded, never a new header or recipient", async () => {
  const server = await capture();
  const transport = nodemailer.createTransport({ host: "127.0.0.1", port: server.port, secure: false });
  const subject = "Hello\r\nBcc: injected@evil.example\r\nX-Injected: yes";
  await transport.sendMail({
    from: { name: "Werkyn\r\nBcc: injected@evil.example", address: FROM },
    to: { name: "Person\r\nX-Injected: yes", address: RECIPIENT },
    subject,
    text: "body",
  });
  const [{ envelope, data }] = server.messages;
  assert.deepEqual(envelope, { from: `<${FROM}>`, to: [`<${RECIPIENT}>`] });
  const message = parseMessage(data);
  onlyHeaders(message, ["from", "to", "subject", "message-id", "date", "mime-version", "content-type", "content-transfer-encoding"]);
  for (const line of message.headerLines) assert.doesNotMatch(line, /^(bcc|x-injected):/i);
  // The text survives only as encoded or flattened content of its own header.
  const flat = (value) => decodeWords(value).replace(/\s+/g, " ");
  assert.equal(flat(message.get("Subject")), "Hello Bcc: injected@evil.example X-Injected: yes");
  assert.equal(flat(message.get("From")), `Werkyn Bcc: injected@evil.example <${FROM}>`);
  assert.equal(flat(message.get("To")), `Person X-Injected: yes <${RECIPIENT}>`);
});
