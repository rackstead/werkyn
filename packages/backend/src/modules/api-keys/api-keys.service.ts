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

// Accepted keys record last use at most once a minute. The stored time can
// lag the latest use by that long. This is not an authorization cache: the
// key is read on every call, and a missing, revoked, or expired key is
// rejected here without refreshing lastUsedAt.
export const API_KEY_LAST_USED_WRITE_INTERVAL_MS = 60_000;

export async function verifyApiKey(prisma: PrismaClient, token: string) {
  if (!/^wk_[a-f0-9]{64}$/.test(token)) {
    throw new UnauthorizedError("Invalid or expired API key");
  }
  const now = new Date();
  const record = await prisma.apiKey.findUnique({
    where: { tokenHash: hashToken(token) },
    select: {
      id: true,
      userId: true,
      expiresAt: true,
      revokedAt: true,
      lastUsedAt: true,
    },
  });
  if (
    !record ||
    record.revokedAt ||
    (record.expiresAt && record.expiresAt <= now)
  ) {
    throw new UnauthorizedError("Invalid or expired API key");
  }
  if (lastUsedWriteIsDue(record.lastUsedAt, now)) {
    const dueAt = new Date(now.getTime() - API_KEY_LAST_USED_WRITE_INTERVAL_MS);
    // Re-check in SQL so overlapping requests still change the row at most
    // once. A lost race, or a key revoked after this read, does not write.
    // Acceptance still stands from the row just read.
    await prisma.apiKey.updateMany({
      where: {
        id: record.id,
        revokedAt: null,
        OR: [{ lastUsedAt: null }, { lastUsedAt: { lte: dueAt } }],
      },
      data: { lastUsedAt: now },
    });
  }
  return {
    id: record.id,
    userId: record.userId,
    expiresAt: record.expiresAt,
    revokedAt: record.revokedAt,
  };
}

function lastUsedWriteIsDue(lastUsedAt: Date | null, now: Date): boolean {
  return (
    lastUsedAt === null ||
    now.getTime() - lastUsedAt.getTime() >= API_KEY_LAST_USED_WRITE_INTERVAL_MS
  );
}
