import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import nodemailer from "nodemailer";

Object.assign(process.env, {
  NODE_ENV: "production",
  LOG_LEVEL: "error",
  DATABASE_URL: "postgresql://unused:unused@127.0.0.1:5432/unused",
  JWT_SECRET: "mailer-delivery-test-jwt-secret-32-chars",
  COOKIE_SECRET: "mailer-delivery-test-cookie-secret-32-chars",
  SMTP_HOST: "",
});
delete process.env.SMTP_USER;
delete process.env.SMTP_PASS;

const { env } = await import("../src/config/env.ts");
const { logger } = await import("../src/utils/logger.ts");
const mailer = await import("../src/utils/mailer.ts");

const TOKEN = "reset-token-7f3a9c-must-not-be-logged";
const original = {
  createTransport: nodemailer.createTransport,
  createTestAccount: nodemailer.createTestAccount,
  logError: logger.error,
  logWarn: logger.warn,
  logInfo: logger.info,
};
let calls, logs, sendMail;

beforeEach(() => {
  calls = { testAccount: 0, transports: [] };
  logs = [];
  sendMail = async () => ({ messageId: "<fixture@local>" });
  nodemailer.createTestAccount = async () => {
    calls.testAccount += 1;
    return { user: "u", pass: "p", smtp: { host: "ethereal.invalid", port: 587, secure: false } };
  };
  nodemailer.createTransport = (options) => {
    calls.transports.push(options);
    return { sendMail: (message) => sendMail(message) };
  };
  for (const level of ["error", "warn", "info"]) {
    logger[level] = (...args) => logs.push({ level, args });
  }
  env.NODE_ENV = "production";
  env.SMTP_HOST = "";
  mailer.setPrisma(undefined);
  mailer.resetTransporter();
});

afterEach(() => {
  nodemailer.createTransport = original.createTransport;
  nodemailer.createTestAccount = original.createTestAccount;
  logger.error = original.logError;
  logger.warn = original.logWarn;
  logger.info = original.logInfo;
});

const logged = () => JSON.stringify(logs, (_key, value) => (value instanceof Error ? { message: value.message, stack: value.stack } : value));

test("production without SMTP never calls the public test mail service", async () => {
  await mailer.sendPasswordResetEmail("person@example.test", TOKEN);
  await mailer.sendVerificationEmail("person@example.test", TOKEN);
  assert.equal(calls.testAccount, 0, "Ethereal account must not be created outside development");
  assert.equal(calls.transports.length, 0);
});

test("unconfigured production mail is reported, counted and logged without tokens", async () => {
  const before = mailer.getMailDeliveryStats();
  const reset = await mailer.sendPasswordResetEmail("person@example.test", TOKEN);
  const verify = await mailer.sendVerificationEmail("person@example.test", TOKEN);
  assert.equal(calls.testAccount, 0);
  assert.deepEqual(reset, { status: "not_configured" });
  assert.deepEqual(verify, { status: "not_configured" });
  assert.equal(mailer.getMailDeliveryStats().notConfigured, before.notConfigured + 2);

  const errors = logs.filter((entry) => entry.level === "error");
  assert.equal(errors.length, 2, logged());
  assert.match(logged(), /not configured/);
  assert.match(logged(), /SMTP_HOST|Admin/);
  assert.equal(logged().includes(TOKEN), false);
});

test("test mode does not reach external mail either", async () => {
  env.NODE_ENV = "test";
  const result = await mailer.sendPasswordResetEmail("person@example.test", TOKEN);
  assert.deepEqual(result, { status: "not_configured" });
  assert.equal(calls.testAccount, 0);
});

test("development keeps the Ethereal preview inbox", async () => {
  env.NODE_ENV = "development";
  const result = await mailer.sendPasswordResetEmail("person@example.test", TOKEN);
  assert.equal(calls.testAccount, 1);
  assert.equal(calls.transports[0].host, "ethereal.invalid");
  assert.deepEqual(result, { status: "sent", transport: "ethereal" });
});

test("database SMTP settings take precedence over environment SMTP", async () => {
  env.SMTP_HOST = "env-smtp.example.test";
  mailer.setPrisma({
    emailConfig: {
      findUnique: async () => ({ host: "db-smtp.example.test", port: 2525, secure: false, user: "", pass: "", fromAddress: "werkyn@example.test" }),
    },
  });
  const messages = [];
  sendMail = async (message) => { messages.push(message); return {}; };
  const result = await mailer.sendVerificationEmail("person@example.test", TOKEN);
  assert.deepEqual(result, { status: "sent", transport: "database" });
  assert.equal(calls.transports[0].host, "db-smtp.example.test");
  assert.equal(messages[0].from, "werkyn@example.test");
  assert.match(messages[0].text, new RegExp(TOKEN));
});

test("environment SMTP is used when no database settings exist", async () => {
  env.SMTP_HOST = "env-smtp.example.test";
  const result = await mailer.sendPasswordResetEmail("person@example.test", TOKEN);
  assert.deepEqual(result, { status: "sent", transport: "environment" });
  assert.equal(calls.transports[0].host, "env-smtp.example.test");
  assert.equal(calls.testAccount, 0);
});

test("SMTP failures are counted and logged with the SMTP code but without tokens or credentials", async () => {
  env.SMTP_HOST = "env-smtp.example.test";
  sendMail = async (message) => {
    const error = new Error(`Message failed: 554 rejected content ${message.text}`);
    Object.assign(error, { code: "EMESSAGE", responseCode: 554, command: "DATA", response: `554 ${message.html}` });
    throw error;
  };
  const before = mailer.getMailDeliveryStats();
  const result = await mailer.sendPasswordResetEmail("person@example.test", TOKEN);
  assert.deepEqual(result, { status: "failed", transport: "environment", code: "EMESSAGE" });
  const stats = mailer.getMailDeliveryStats();
  assert.equal(stats.failed, before.failed + 1);
  assert.equal(stats.lastFailureCode, "EMESSAGE");
  assert.ok(stats.lastFailureAt);

  const errors = logs.filter((entry) => entry.level === "error");
  assert.equal(errors.length, 1, logged());
  assert.match(logged(), /password-reset/);
  assert.match(logged(), /EMESSAGE/);
  assert.match(logged(), /554/);
  assert.equal(logged().includes(TOKEN), false, logged());
});

test("a transport that cannot be created is a counted failure, not a silent success", async () => {
  env.SMTP_HOST = "env-smtp.example.test";
  nodemailer.createTransport = () => { throw Object.assign(new Error("bad options"), { code: "EOPTIONS" }); };
  const result = await mailer.sendVerificationEmail("person@example.test", TOKEN);
  assert.equal(result.status, "failed");
  assert.equal(logs.filter((entry) => entry.level === "error").length, 1);
});
