import type { FastifyRequest, FastifyReply } from "fastify";
import nodemailer, { type TransportOptions } from "nodemailer";
import * as emailService from "./email.service.js";
import type { UpdateEmailConfigInput } from "@pm/shared";
import { env } from "../../config/env.js";
import { requireSenderMailbox } from "../../utils/mail-sender.js";
import { describeMailConfigFailure, testMailFailureMessage } from "../../utils/mail-diagnostics.js";
import { logger } from "../../utils/logger.js";

export async function getEmailConfigHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const config = await emailService.getEmailConfig(request.server.prisma);
  return reply.send({ data: config });
}

export async function updateEmailConfigHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const body = request.body as UpdateEmailConfigInput;
  const config = await emailService.updateEmailConfig(
    request.server.prisma,
    body,
  );
  return reply.send({ data: config });
}

export async function sendTestEmailHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  let rawConfig: Awaited<ReturnType<typeof emailService.getRawEmailConfig>>;
  try {
    rawConfig = await emailService.getRawEmailConfig(
      request.server.prisma,
    );
  } catch (error) {
    logger.error({ database: describeMailConfigFailure(error) }, "Failed to read email config for admin test");
    return reply.status(503).send({
      statusCode: 503,
      error: "Service Unavailable",
      message: "Email settings could not be loaded. Check database connectivity and try again.",
    });
  }

  try {
    // Determine SMTP settings: DB config first, then env fallback
    const host = rawConfig?.host || env.SMTP_HOST;
    const port = rawConfig?.host ? rawConfig.port : env.SMTP_PORT;
    const secure = rawConfig?.host ? rawConfig.secure : env.SMTP_SECURE;
    const user = rawConfig?.host ? rawConfig.user : env.SMTP_USER;
    const pass = rawConfig?.host ? rawConfig.pass : env.SMTP_PASS;
    const fromAddress = rawConfig?.host ? rawConfig.fromAddress : env.SMTP_FROM;

    if (!host) {
      return reply.status(400).send({
        statusCode: 400,
        error: "Bad Request",
        message: "No email server configured. Please save SMTP settings first.",
      });
    }

    const options: TransportOptions & {
      host: string;
      port: number;
      secure: boolean;
      auth?: { user: string; pass: string };
    } = { host, port, secure };

    if (user && pass) {
      options.auth = { user, pass };
    }

    const from = requireSenderMailbox(fromAddress || `noreply@${host}`);
    const testTransporter = nodemailer.createTransport(options);
    const userEmail = (request as any).user.email as string;

    await testTransporter.sendMail({
      from,
      to: userEmail,
      subject: "Werkyn - Test Email",
      text: "This is a test email from your Werkyn instance. If you're reading this, your email configuration is working correctly!",
      html: "<p>This is a test email from your Werkyn instance.</p><p>If you're reading this, your email configuration is working correctly!</p>",
    });

    return reply.send({
      data: { message: `Test email sent to ${userEmail}` },
    });
  } catch (error) {
    return reply.status(400).send({
      statusCode: 400,
      error: "Bad Request",
      message: testMailFailureMessage(error),
    });
  }
}
