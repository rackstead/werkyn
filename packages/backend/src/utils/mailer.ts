import nodemailer, { type Transporter, type TransportOptions } from "nodemailer";
import type { PrismaClient } from "@prisma/client";
import { env } from "../config/env.js";
import { logger } from "./logger.js";

/** Where the active transport came from. Ethereal is development-only. */
export type MailTransportSource = "database" | "environment" | "ethereal";
export type MailKind = "verification" | "password-reset";
export type MailDeliveryResult =
  | { status: "sent"; transport: MailTransportSource }
  | { status: "not_configured" }
  | { status: "failed"; transport?: MailTransportSource; code?: string };

class MailNotConfiguredError extends Error {}

let transporter: { transport: Transporter; source: MailTransportSource } | undefined;
let prismaRef: PrismaClient | undefined;

const stats = {
  sent: 0,
  failed: 0,
  notConfigured: 0,
  lastFailureAt: null as string | null,
  lastFailureCode: null as string | null,
};

/** Process-local delivery counters for diagnostics; they reset on restart. */
export function getMailDeliveryStats() {
  return { ...stats };
}

export function setPrisma(prisma: PrismaClient | undefined) {
  prismaRef = prisma;
}

export function resetTransporter() {
  transporter = undefined;
}

async function getTransporter(): Promise<{
  transport: Transporter;
  source: MailTransportSource;
}> {
  if (transporter) return transporter;

  // 1. Try DB config
  if (prismaRef) {
    try {
      const dbConfig = await prismaRef.emailConfig.findUnique({
        where: { id: "singleton" },
      });

      if (dbConfig && dbConfig.host) {
        const options: TransportOptions & {
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

        transporter = { transport: nodemailer.createTransport(options), source: "database" };
        return transporter;
      }
    } catch (error) {
      logger.warn({ err: error }, "Failed to read email config from DB, falling back to env vars");
    }
  }

  // 2. Env var fallback
  if (env.SMTP_HOST) {
    const options: TransportOptions & {
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

    transporter = { transport: nodemailer.createTransport(options), source: "environment" };
    return transporter;
  }

  // 3. Ethereal test inbox: an external public service, development only.
  // Production and test never send account links there.
  if (env.NODE_ENV !== "development") throw new MailNotConfiguredError();

  const testAccount = await nodemailer.createTestAccount();
  transporter = {
    transport: nodemailer.createTransport({
      host: testAccount.smtp.host,
      port: testAccount.smtp.port,
      secure: testAccount.smtp.secure,
      auth: {
        user: testAccount.user,
        pass: testAccount.pass,
      },
    }),
    source: "ethereal",
  };

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

function scrub(text: string, secrets: string[]): string {
  let result = text;
  for (const secret of secrets) {
    if (secret) result = result.split(secret).join("[REDACTED]");
  }
  return result.slice(0, 500);
}

/** Only SMTP diagnostics; never the message, links, recipients or credentials. */
function describeFailure(error: unknown, secrets: string[]) {
  const failure = (error ?? {}) as Record<string, unknown>;
  return {
    code: typeof failure.code === "string" ? failure.code : undefined,
    responseCode: typeof failure.responseCode === "number" ? failure.responseCode : undefined,
    command: typeof failure.command === "string" ? failure.command.split(" ")[0] : undefined,
    message: typeof failure.message === "string" ? scrub(failure.message, secrets) : undefined,
  };
}

/**
 * Sends one account email. Never throws: callers keep their generic responses,
 * while the outcome is returned, counted and logged without tokens or links.
 */
async function deliver(
  kind: MailKind,
  message: { to: string; subject: string; text: string; html: string },
  secrets: string[],
): Promise<MailDeliveryResult> {
  let source: MailTransportSource | undefined;
  try {
    const selected = await getTransporter();
    source = selected.source;
    const from = await getFromAddress();
    const info = await selected.transport.sendMail({ from, ...message });
    stats.sent += 1;

    if (source === "ethereal") {
      const previewUrl = nodemailer.getTestMessageUrl(info);
      if (previewUrl) {
        logger.info({ previewUrl, kind }, "Email preview available");
      }
    }
    return { status: "sent", transport: source };
  } catch (error) {
    if (error instanceof MailNotConfiguredError) {
      stats.notConfigured += 1;
      const text =
        `Email delivery is not configured, so the ${kind} email was not sent. ` +
        "Configure SMTP under Admin > Email or set SMTP_HOST.";
      if (env.NODE_ENV === "production") logger.error({ kind, mail: "not_configured" }, text);
      else logger.warn({ kind, mail: "not_configured" }, text);
      return { status: "not_configured" };
    }

    const failure = describeFailure(error, secrets);
    stats.failed += 1;
    stats.lastFailureAt = new Date().toISOString();
    stats.lastFailureCode = failure.code ?? null;
    logger.error({ kind, transport: source, smtp: failure }, `Failed to send ${kind} email`);
    return { status: "failed", transport: source, code: failure.code };
  }
}

export async function sendVerificationEmail(
  to: string,
  token: string,
  inviteToken?: string,
): Promise<MailDeliveryResult> {
  // An existing invitation token is the only continuation context: the
  // verification page links to that fixed invite route, never an arbitrary URL.
  const verifyUrl = `${env.FRONTEND_URL}/verify-email/${encodeURIComponent(token)}${
    inviteToken ? `?invite=${encodeURIComponent(inviteToken)}` : ""
  }`;

  return deliver(
    "verification",
    {
      to,
      subject: "Verify your email address",
      text: `Please verify your email address by clicking the link below:\n\n${verifyUrl}\n\nThis link will expire in 24 hours.`,
      html: `<p>Please verify your email address by clicking the link below:</p><p><a href="${verifyUrl}">Verify Email</a></p><p>This link will expire in 24 hours.</p>`,
    },
    [token, encodeURIComponent(token), inviteToken ?? "", inviteToken ? encodeURIComponent(inviteToken) : ""],
  );
}

export async function sendPasswordResetEmail(
  to: string,
  token: string,
): Promise<MailDeliveryResult> {
  const resetUrl = `${env.FRONTEND_URL}/reset-password/${token}`;

  return deliver(
    "password-reset",
    {
      to,
      subject: "Reset your password",
      text: `You requested a password reset. Click the link below to reset your password:\n\n${resetUrl}\n\nThis link will expire in 1 hour. If you didn't request this, you can ignore this email.`,
      html: `<p>You requested a password reset. Click the link below to reset your password:</p><p><a href="${resetUrl}">Reset Password</a></p><p>This link will expire in 1 hour. If you didn't request this, you can ignore this email.</p>`,
    },
    [token],
  );
}
