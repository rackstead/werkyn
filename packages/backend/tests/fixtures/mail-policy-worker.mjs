// A separate process captures the real production logger's serialized output.
import Fastify from "fastify";
import nodemailer from "nodemailer";
const fixture = JSON.parse(process.env.MAIL_POLICY_FIXTURE);
const { env } = await import("../../src/config/env.ts");
const mailer = await import("../../src/utils/mailer.ts");
Object.assign(env, fixture.environment);
const prisma = { emailConfig: { findUnique: async () => {
  if (fixture.readFailure) throw fixture.readFailure;
  return fixture.stored ?? null;
} } };
mailer.setPrisma(prisma);
if (fixture.failure !== undefined) nodemailer.createTransport = () => ({ sendMail: async () => { throw fixture.failure; } });
if (fixture.admin) {
  const { sendTestEmailHandler } = await import("../../src/modules/email/email.controller.ts");
  const app = Fastify({ logger: false });
  app.decorate("prisma", prisma);
  app.post("/test", { preHandler: async (request) => { request.user = { email: fixture.to }; } }, sendTestEmailHandler);
  await app.listen({ host: "127.0.0.1", port: 0 });
  try {
    const response = await fetch(`http://127.0.0.1:${app.server.address().port}/test`, { method: "POST" });
    console.log("RESULT " + JSON.stringify({ status: response.status, body: await response.json() }));
  } finally { await app.close(); }
} else {
  const result = await mailer.sendVerificationEmail(fixture.to, fixture.token, fixture.invite);
  console.log("RESULT " + JSON.stringify({ result, stats: mailer.getMailDeliveryStats() }));
}
