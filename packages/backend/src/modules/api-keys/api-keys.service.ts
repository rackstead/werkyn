import crypto from "node:crypto";
import type { PrismaClient, Prisma } from "@prisma/client";
import type { CreateApiKeyInput } from "@pm/shared";
import { hashToken } from "../../utils/tokens.js";
import { NotFoundError, UnauthorizedError } from "../../utils/errors.js";

const metadata = {
  id: true,
  name: true,
  prefix: true,
  createdAt: true,
  expiresAt: true,
  lastUsedAt: true,
  revokedAt: true,
} satisfies Prisma.ApiKeySelect;

export function listApiKeys(prisma: PrismaClient, userId: string) {
  return prisma.apiKey.findMany({
    where: { userId },
    select: metadata,
    orderBy: { createdAt: "desc" },
  });
}

export async function createApiKey(
  prisma: PrismaClient,
  userId: string,
  input: CreateApiKeyInput,
) {
  const key = `wk_${crypto.randomBytes(32).toString("hex")}`;
  const record = await prisma.apiKey.create({
    data: {
      userId,
      name: input.name,
      prefix: key.slice(0, 11),
      tokenHash: hashToken(key),
      expiresAt:
        input.expiresInDays === null
          ? null
          : new Date(Date.now() + input.expiresInDays * 24 * 60 * 60 * 1000),
    },
    select: metadata,
  });
  return { ...record, key };
}

export async function revokeApiKey(
  prisma: PrismaClient,
  userId: string,
  id: string,
) {
  const result = await prisma.apiKey.updateMany({
    where: { id, userId },
    data: { revokedAt: new Date() },
  });
  if (result.count === 0) throw new NotFoundError("API key not found");
}

export async function verifyApiKey(prisma: PrismaClient, token: string) {
  if (!/^wk_[a-f0-9]{64}$/.test(token)) {
    throw new UnauthorizedError("Invalid or expired API key");
  }
  const record = await prisma.apiKey.findUnique({
    where: { tokenHash: hashToken(token) },
    select: { id: true, userId: true, expiresAt: true, revokedAt: true },
  });
  if (
    !record ||
    record.revokedAt ||
    (record.expiresAt && record.expiresAt <= new Date())
  ) {
    throw new UnauthorizedError("Invalid or expired API key");
  }
  await prisma.apiKey.update({
    where: { id: record.id },
    data: { lastUsedAt: new Date() },
  });
  return record;
}
