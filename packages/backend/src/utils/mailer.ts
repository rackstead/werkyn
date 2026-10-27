import nodemailer from "nodemailer";
import type { PrismaClient } from "@prisma/client";
import { env } from "../config/env.js";
import { logger } from "./logger.js";

let transporter: nodemailer.Transporter | undefined;
let prismaRef: PrismaClient | undefined;

export function setPrisma(prisma: PrismaClient) {
  prismaRef = prisma;
}

export function resetTransporter() {
  transporter = undefined;
}

async function getTransporter(): Promise<nodemailer.Transporter> {
  if (transporter) return transporter;

  // 1. Try DB config
  if (prismaRef) {
    try {
      const dbConfig = await prismaRef.emailConfig.findUnique({
        where: { id: "singleton" },
      });

      if (dbConfig && dbConfig.host) {
        const options: nodemailer.TransportOptions & {
          host: string;
          port: number;
          secure: boolean;
          auth?: { user: string; pass: string };
        } = {
          host: dbConfig.host,
          port: dbConfig.port,
          secure: dbConfig.secure,
        };

        if (dbConfig.user && dbConfig.pass) {
          options.auth = {
            user: dbConfig.user,
            pass: dbConfig.pass,
          };
        }

        transporter = nodemailer.createTransport(options);
        return transporter;
      }
    } catch (error) {
      logger.warn({ err: error }, "Failed to read email config from DB, falling back to env vars");
    }
  }

  // 2. Env var fallback
  if (env.SMTP_HOST) {
    const options: nodemailer.TransportOptions & {
      host: string;
      port: number;
      secure: boolean;
      auth?: { user: string; pass: string };
    } = {
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_SECURE,
    };

    if (env.SMTP_USER && env.SMTP_PASS) {
      options.auth = {
        user: env.SMTP_USER,
        pass: env.SMTP_PASS,
      };
    }

    transporter = nodemailer.createTransport(options);
    return transporter;
  }

  // 3. Ethereal test account (dev only)
  const testAccount = await nodemailer.createTestAccount();
  transporter = nodemailer.createTransport({
    host: testAccount.smtp.host,
    port: testAccount.smtp.port,
    secure: testAccount.smtp.secure,
    auth: {
      user: testAccount.user,
      pass: testAccount.pass,
    },
  });

  return transporter;
}

async function getFromAddress(): Promise<string> {
  // Try DB config first
  if (prismaRef) {
    try {
      const dbConfig = await prismaRef.emailConfig.findUnique({
        where: { id: "singleton" },
      });
      if (dbConfig?.fromAddress) {
        return dbConfig.fromAddress;
      }
    } catch {
      // fall through
    }
  }

  // Env fallback
  return env.SMTP_FROM || "noreply@example.com";
}

export async function sendVerificationEmail(
  to: string,
  token: string,
  inviteToken?: string,
): Promise<void> {
  try {
    const transport = await getTransporter();
    const from = await getFromAddress();
    // An existing invitation token is the only continuation context: the
    // verification page links to that fixed invite route, never an arbitrary URL.
    const verifyUrl = `${env.FRONTEND_URL}/verify-email/${encodeURIComponent(token)}${
      inviteToken ? `?invite=${encodeURIComponent(inviteToken)}` : ""
    }`;

    const info = await transport.sendMail({
      from,
      to,
      subject: "Verify your email address",
      text: `Please verify your email address by clicking the link below:\n\n${verifyUrl}\n\nThis link will expire in 24 hours.`,
      html: `<p>Please verify your email address by clicking the link below:</p><p><a href="${verifyUrl}">Verify Email</a></p><p>This link will expire in 24 hours.</p>`,
    });

    if (env.NODE_ENV === "development") {
      const previewUrl = nodemailer.getTestMessageUrl(info);
      if (previewUrl) {
        logger.info({ previewUrl }, "Email preview available");
      }
    }
  } catch (error) {
    logger.error({ err: error }, "Failed to send verification email");
  }
}

export async function sendPasswordResetEmail(
  to: string,
  token: string,
): Promise<void> {
  try {
    const transport = await getTransporter();
    const from = await getFromAddress();
    const resetUrl = `${env.FRONTEND_URL}/reset-password/${token}`;

    const info = await transport.sendMail({
      from,
      to,
      subject: "Reset your password",
      text: `You requested a password reset. Click the link below to reset your password:\n\n${resetUrl}\n\nThis link will expire in 1 hour. If you didn't request this, you can ignore this email.`,
      html: `<p>You requested a password reset. Click the link below to reset your password:</p><p><a href="${resetUrl}">Reset Password</a></p><p>This link will expire in 1 hour. If you didn't request this, you can ignore this email.</p>`,
    });

    if (env.NODE_ENV === "development") {
      const previewUrl = nodemailer.getTestMessageUrl(info);
      if (previewUrl) {
        logger.info({ previewUrl }, "Email preview available");
      }
    }
  } catch (error) {
    logger.error({ err: error }, "Failed to send password reset email");
  }
}
