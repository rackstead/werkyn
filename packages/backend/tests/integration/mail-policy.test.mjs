import assert from "node:assert/strict";
import crypto from "node:crypto";
import { after, before, test } from "node:test";
import Fastify from "fastify";
import { PrismaClient } from "@prisma/client";
import { startSmtpCapture } from "../fixtures/smtp-capture.mjs";

if (!process.env.TEST_DATABASE_URL) throw new Error("Set TEST_DATABASE_URL to a migrated disposable database");
Object.assign(process.env, { DATABASE_URL: process.env.TEST_DATABASE_URL, NODE_ENV: "test", LOG_LEVEL: "error", JWT_SECRET: "mail-policy-integration-signing-key", COOKIE_SECRET: "mail-policy-integration-cookie-key", SMTP_HOST: "", SMTP_FROM: "" });
const { env } = await import("../../src/config/env.ts");
const { signAccessToken } = await import("../../src/utils/tokens.ts");
const mailer = await import("../../src/utils/mailer.ts");
const { default: emailRoutes } = await import("../../src/modules/email/email.routes.ts");
const { default: errors } = await import("../../src/plugins/errors.ts");
const { sendTestEmailHandler } = await import("../../src/modules/email/email.controller.ts");
const prisma = new PrismaClient();
const suffix = crypto.randomBytes(6).toString("hex");
let app, smtp, admin, member, base;
before(async () => {
  await prisma.$connect();
  admin = await prisma.user.create({ data: { email: `mail-admin-${suffix}@example.test`, displayName: "Mail admin", isInstanceAdmin: true, emailVerified: true } });
  member = await prisma.user.create({ data: { email: `mail-member-${suffix}@example.test`, displayName: "Mail member", emailVerified: true } });
  smtp = await startSmtpCapture({ auth: { user: "fixture-user", pass: "fixture-password" } });
  app = Fastify({ logger: false });
  app.decorate("prisma", prisma);
  await app.register(errors);
  await app.register(emailRoutes, { prefix: "/api/admin/email" });
  await app.listen({ host: "127.0.0.1", port: 0 });
  base = `http://127.0.0.1:${app.server.address().port}/api/admin/email`;
  mailer.setPrisma(prisma);
});
after(async () => {
  await app?.close();
  await smtp?.close();
  await prisma.emailConfig.deleteMany();
  await prisma.user.deleteMany({ where: { id: { in: [admin?.id, member?.id].filter(Boolean) } } });
  mailer.setPrisma(undefined);
  mailer.resetTransporter();
  await prisma.$disconnect();
});
async function request(method, route, payload, actor = admin) {
  const response = await fetch(base + route, { method, headers: { ...(payload === undefined ? {} : { "content-type": "application/json" }), ...(actor ? { authorization: `Bearer ${signAccessToken({ sub: actor.id, email: actor.email })}` } : {}) }, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) });
  return { status: response.status, body: await response.json() };
}
const valid = () => ({ host: "127.0.0.1", port: smtp.port, secure: false, user: "fixture-user", pass: "fixture-password", fromAddress: '"Werkyn, Team" <sender@example.test>' });

test("email configuration and test-send remain instance-admin only", async () => {
  for (const [method, route, payload] of [["GET", "/config"], ["PATCH", "/config", valid()], ["POST", "/test"]]) {
    assert.equal((await request(method, route, payload, null)).status, 401);
    assert.equal((await request(method, route, payload, member)).status, 403);
  }
  assert.equal(smtp.sessions.length, 0);
});

test("PATCH rejects ambiguous senders without mutating stored settings", async () => {
  assert.equal((await request("PATCH", "/config", valid())).status, 200);
  for (const fromAddress of ["sender@example.test\r\nBcc: other@example.test", "sender@example.test, other@example.test", "Team: sender@example.test;", "sender(comment)@example.test"]) {
    const response = await request("PATCH", "/config", { fromAddress });
    assert.equal(response.status, 400);
    assert.match(JSON.stringify(response.body), /single mailbox/);
    assert.equal(JSON.stringify(response.body).includes(fromAddress), false);
    assert.equal((await prisma.emailConfig.findUniqueOrThrow({ where: { id: "singleton" } })).fromAddress, valid().fromAddress);
  }
});

test("valid settings preserve the password mask and deliver an admin test to the signed-in account", async () => {
  const saved = await request("PATCH", "/config", { ...valid(), pass: "••••••••" });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.data.pass, "••••••••");
  assert.equal((await prisma.emailConfig.findUniqueOrThrow({ where: { id: "singleton" } })).pass, "fixture-password");
  assert.equal((await request("GET", "/config")).body.data.pass, "••••••••");
  const response = await request("POST", "/test");
  assert.equal(response.status, 200, JSON.stringify(response));
  assert.deepEqual(smtp.messages.at(-1).envelope, { from: "<sender@example.test>", to: [`<${admin.email}>`] });
});

test("invalid legacy settings block account and admin sends until corrected", async () => {
  const before = smtp.sessions.length;
  await prisma.emailConfig.update({ where: { id: "singleton" }, data: { fromAddress: "sender@example.test\r\nBcc: other@example.test" } });
  mailer.resetTransporter();
  const response = await request("POST", "/test");
  assert.equal(response.status, 400);
  assert.match(response.body.message, /Check From Address/);
  assert.equal((await mailer.sendPasswordResetEmail(admin.email, "synthetic-reset-token")).code, "EADDRESS");
  assert.equal(smtp.sessions.length, before);
  await request("PATCH", "/config", { fromAddress: "sender@example.test" });
  assert.equal((await request("POST", "/test")).status, 200);
});

test("environment transport fallback and account default sender remain intact", async () => {
  Object.assign(env, { SMTP_HOST: "127.0.0.1", SMTP_PORT: smtp.port, SMTP_USER: "fixture-user", SMTP_PASS: "fixture-password", SMTP_FROM: "environment@example.test" });
  await request("PATCH", "/config", { host: "", fromAddress: "" });
  assert.equal((await request("POST", "/test")).status, 200);
  assert.equal(smtp.messages.at(-1).envelope.from, "<environment@example.test>");
  env.SMTP_FROM = "";
  assert.deepEqual(await mailer.sendPasswordResetEmail(admin.email, "synthetic-token"), { status: "sent", transport: "environment" });
  assert.equal(smtp.messages.at(-1).envelope.from, "<noreply@example.com>");
});

test("a real configuration-query failure remains a safe server error", async () => {
  const unavailableSchema = new URL(process.env.TEST_DATABASE_URL);
  unavailableSchema.searchParams.set("schema", `mail_policy_missing_${suffix}`);
  const brokenPrisma = new PrismaClient({ datasourceUrl: unavailableSchema.href });
  const probe = Fastify({ logger: false });
  probe.decorate("prisma", brokenPrisma);
  probe.post("/test", { preHandler: async (request) => { request.user = admin; } }, sendTestEmailHandler);
  await probe.listen({ host: "127.0.0.1", port: 0 });
  try {
    const response = await fetch(`http://127.0.0.1:${probe.server.address().port}/test`, { method: "POST" });
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.match(body.message, /database/);
    assert.equal(JSON.stringify(body).includes(unavailableSchema.href), false);
    assert.equal(JSON.stringify(body).includes("P2021"), false);
  } finally {
    await probe.close();
    await brokenPrisma.$disconnect();
  }
});
