import {
  hasShareGrant,
  updateShareRevision,
} from "../../utils/share-grants.js";
import { Prisma, type PrismaClient } from "@prisma/client";
import type { StorageProvider } from "../../services/storage.js";
import type { FastifyInstance } from "fastify";
import crypto from "crypto";
import { hashPassword, verifyPassword } from "../../utils/passwords.js";
import { logger } from "../../utils/logger.js";
import {
  NotFoundError,
  ForbiddenError,
  ConflictError,
} from "../../utils/errors.js";
import {
  assertFileAccess,
  fileAccessRole,
  fileReadWhere,
  type AccessContext,
} from "./file-access.js";
import { fileReadable } from "./file-read-scope.js";
import {
  deliverNotification,
  enqueueNotification,
} from "../notifications/notification-delivery.js";
import { isLegacyFileShareToken } from "@pm/shared";

const NETWORK_ERROR_CODES = new Set([
  "ECONNRESET", "ECONNREFUSED", "EPIPE", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN",
]);

function postCommitDiagnostics(error: unknown) {
  try {
    const errorKind = error instanceof TypeError ? "type_error"
      : error instanceof Error ? "error" : "unknown";
    const descriptor = typeof error === "object" && error !== null
      ? Object.getOwnPropertyDescriptor(error, "code") : undefined;
    const code = descriptor && "value" in descriptor ? descriptor.value : undefined;
    return {
      errorKind,
      ...(typeof code === "string" && NETWORK_ERROR_CODES.has(code) ? { errorCode: code } : {}),
    };
  } catch {
    return { errorKind: "unknown" };
  }
}

// ─── Member Shares ──────────────────────────────────────

export async function createFileShares(
  prisma: PrismaClient,
  workspaceId: string,
  fileIds: string[],
  userIds: string[],
  sharedById: string,
  ctx: AccessContext,
  fastify?: FastifyInstance,
) {
  // Verify access to all files
  for (const fileId of fileIds) {
    await assertFileAccess(prisma, fileId, { ...ctx, workspaceId }, true);
  }

  // Verify recipients are workspace members
  const members = await prisma.workspaceMember.findMany({
    where: { workspaceId, userId: { in: userIds } },
    select: { userId: true },
  });
  const memberSet = new Set(members.map((m) => m.userId));
  for (const uid of userIds) {
    if (!memberSet.has(uid)) {
      throw new ForbiddenError(`User ${uid} is not a workspace member`);
    }
  }

  const data = fileIds.flatMap((fileId) =>
    userIds
      .filter((uid) => uid !== sharedById) // Don't share with yourself
      .map((uid) => ({
        workspaceId,
        fileId,
        sharedById,
        sharedWithId: uid,
      })),
  );

  if (data.length === 0) return { count: 0 };

  // Internal callers without a broadcaster retain the existing pure write.
  if (!fastify) {
    return prisma.fileShare.createMany({ data, skipDuplicates: true });
  }

  const { result, notificationDeliveryId } = await prisma.$transaction(async (tx) => {
    const result = await tx.fileShare.createMany({ data, skipDuplicates: true });
    if (result.count === 0) return { result, notificationDeliveryId: null };

    const sharer = await tx.user.findUnique({
      where: { id: sharedById },
      select: { displayName: true },
    });
    const sharerName = sharer?.displayName ?? "Someone";

    // Build notification title
    let title: string;
    if (fileIds.length === 1) {
      const file = await tx.file.findUnique({
        where: { id: fileIds[0] },
        select: { name: true },
      });
      title = `${sharerName} shared "${file?.name ?? "a file"}" with you`;
    } else {
      title = `${sharerName} shared ${fileIds.length} files with you`;
    }

    const recipients = userIds.filter((uid) => uid !== sharedById);
    const notificationDeliveryId = await enqueueNotification(tx, {
      recipients,
      type: "FILE_SHARED",
      title,
      data: { fileId: fileIds[0], workspaceId },
      excludeUserId: sharedById,
    });
    return { result, notificationDeliveryId };
  });

  if (notificationDeliveryId) {
    void deliverNotification(prisma, fastify, notificationDeliveryId, { log: fastify.log })
      .catch((error) => fastify.log.error(
        { stage: "file_share_notification_delivery", workspaceId, notificationDeliveryId, ...postCommitDiagnostics(error) },
        "Committed file-share notification remains queued for retry",
      ));
  }

  return result;
}

export async function removeFileShare(
  prisma: PrismaClient,
  workspaceId: string,
  fileId: string,
  userId: string,
  ctx: AccessContext,
) {
  await assertFileAccess(prisma, fileId, { ...ctx, workspaceId }, true);

  return prisma.fileShare.deleteMany({
    where: { workspaceId, fileId, sharedWithId: userId },
  });
}

export async function getFileShares(
  prisma: PrismaClient,
  workspaceId: string,
  fileId: string,
  ctx: AccessContext,
) {
  await assertFileAccess(prisma, fileId, { ...ctx, workspaceId }, true);

  return prisma.fileShare.findMany({
    where: { workspaceId, fileId },
    include: {
      sharedWith: {
        select: { id: true, displayName: true, avatarUrl: true, email: true },
      },
      sharedBy: {
        select: { id: true, displayName: true, avatarUrl: true },
      },
    },
    orderBy: { createdAt: "desc" },
  });
}

export async function listSharedWithMe(
  prisma: PrismaClient,
  workspaceId: string,
  ctx: AccessContext,
  cursor?: string,
  limit = 50,
) {
  const readable = await fileReadWhere(prisma, { ...ctx, workspaceId });
  const userId = ctx.userId;
  const where: Prisma.FileShareWhereInput = {
    workspaceId,
    sharedWithId: userId,
    file: { AND: [readable], trashedAt: null },
  };
  // A cursor must be one of the listed shares; any other ID gives an empty
  // page, as it did before the ID tie-breaker.
  if (cursor) {
    const scopedCursor = await prisma.fileShare.findFirst({
      where: { AND: [where, { id: cursor }] },
      select: { id: true },
    });
    if (!scopedCursor) return { data: [], nextCursor: null };
  }
  const shares = await prisma.fileShare.findMany({
    where,
    include: {
      file: {
        include: {
          uploadedBy: {
            select: { id: true, displayName: true, avatarUrl: true },
          },
        },
      },
      sharedBy: {
        select: { id: true, displayName: true, avatarUrl: true },
      },
    },
    // The unique ID breaks createdAt ties, so Prisma applies LIMIT to the page.
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });

  const hasMore = shares.length > limit;
  const data = hasMore ? shares.slice(0, limit) : shares;

  return {
    data,
    nextCursor: hasMore ? data[data.length - 1].id : null,
  };
}

// Link rows are already returned as `link-${FileShareLinkFile.id}`. That
// response id is the cursor and the tie-break, shared with member-share ids.
const SHARED_BY_ME_LINK_PREFIX = "link-";

const shareFileInclude = {
  include: {
    uploadedBy: {
      select: { id: true, displayName: true, avatarUrl: true },
    },
  },
} as const;

// COLLATE "C" is UTF-8 byte order, which matches JavaScript string order for
// well-formed text. The database collation must not decide the tie-break.
function afterResponseId(
  createdAt: Prisma.Sql,
  responseId: Prisma.Sql,
  cursorAt?: Date,
  cursorId?: string,
): Prisma.Sql {
  if (!cursorAt || cursorId === undefined) return Prisma.empty;
  return Prisma.sql`AND (
    ${createdAt} < ${cursorAt}
    OR (
      ${createdAt} = ${cursorAt}
      AND ${responseId} COLLATE "C" < ${cursorId} COLLATE "C"
    )
  )`;
}

function bySharedByMeOrder(
  a: { id: string; createdAt: Date },
  b: { id: string; createdAt: Date },
): number {
  const byTime = b.createdAt.getTime() - a.createdAt.getTime();
  if (byTime !== 0) return byTime;
  if (a.id === b.id) return 0;
  return a.id < b.id ? 1 : -1;
}

export async function listSharedByMe(
  prisma: PrismaClient,
  workspaceId: string,
  ctx: AccessContext,
  cursor?: string,
  limit = 50,
) {
  // Not a member: the same error as the other file lists. The page queries
  // below would otherwise just return no rows.
  await fileAccessRole(prisma, { ...ctx, workspaceId });
  const userId = ctx.userId;
  const userSql = Prisma.sql`${userId}`;
  const workspaceSql = Prisma.sql`${workspaceId}`;
  // Same rows as before: member shares and link files the caller can still
  // read. Disabled, password, expired and legacy links stay in the list.
  const memberReadable = fileReadable(
    Prisma.sql`s."fileId"`,
    userSql,
    workspaceSql,
  );
  const linkReadable = fileReadable(
    Prisma.sql`lf."fileId"`,
    userSql,
    workspaceSql,
  );

  // A cursor must be one of the listed rows. Any other id gives an empty
  // page, as shared-with-me does.
  let cursorAt: Date | undefined;
  if (cursor) {
    const found = cursor.startsWith(SHARED_BY_ME_LINK_PREFIX)
      ? await prisma.$queryRaw<{ createdAt: Date }[]>`
          SELECT l."createdAt" AS "createdAt"
          FROM "public"."FileShareLinkFile" lf
          JOIN "public"."FileShareLink" l ON l.id = lf."shareLinkId"
          WHERE lf.id = ${cursor.slice(SHARED_BY_ME_LINK_PREFIX.length)}
            AND l."workspaceId" = ${workspaceId}
            AND l."createdById" = ${userId}
            AND ${linkReadable}
          LIMIT 1`
      : await prisma.$queryRaw<{ createdAt: Date }[]>`
          SELECT s."createdAt" AS "createdAt"
          FROM "public"."FileShare" s
          WHERE s.id = ${cursor}
            AND s."workspaceId" = ${workspaceId}
            AND s."sharedById" = ${userId}
            AND ${memberReadable}
          LIMIT 1`;
    if (found.length === 0) return { data: [], nextCursor: null };
    cursorAt = found[0].createdAt;
  }

  // Each side is ordered by the merged key and limited to limit + 1. The
  // merged top is inside those two slices, so the database applies LIMIT.
  const [memberKeys, linkKeys] = await Promise.all([
    prisma.$queryRaw<{ id: string; createdAt: Date }[]>`SELECT s.id AS id, s."createdAt" AS "createdAt"
      FROM "public"."FileShare" s
      WHERE s."workspaceId" = ${workspaceId}
        AND s."sharedById" = ${userId}
        AND ${memberReadable}
        ${afterResponseId(Prisma.sql`s."createdAt"`, Prisma.sql`s.id`, cursorAt, cursor)}
      ORDER BY s."createdAt" DESC, s.id COLLATE "C" DESC
      LIMIT ${limit + 1}`,
    prisma.$queryRaw<{ id: string; createdAt: Date }[]>`SELECT ('link-' || lf.id) AS id, l."createdAt" AS "createdAt"
      FROM "public"."FileShareLinkFile" lf
      JOIN "public"."FileShareLink" l ON l.id = lf."shareLinkId"
      WHERE l."workspaceId" = ${workspaceId}
        AND l."createdById" = ${userId}
        AND ${linkReadable}
        ${afterResponseId(
          Prisma.sql`l."createdAt"`,
          Prisma.sql`('link-' || lf.id)`,
          cursorAt,
          cursor,
        )}
      ORDER BY l."createdAt" DESC, ('link-' || lf.id) COLLATE "C" DESC
      LIMIT ${limit + 1}`,
  ]);

  const ranked = [...memberKeys, ...linkKeys].sort(bySharedByMeOrder);
  const hasMore = ranked.length > limit;
  const page = hasMore ? ranked.slice(0, limit) : ranked;
  const memberIds = page
    .filter((row) => !row.id.startsWith(SHARED_BY_ME_LINK_PREFIX))
    .map((row) => row.id);
  const linkIds = page
    .filter((row) => row.id.startsWith(SHARED_BY_ME_LINK_PREFIX))
    .map((row) => row.id.slice(SHARED_BY_ME_LINK_PREFIX.length));
  const [memberShares, linkShareFiles] = await Promise.all([
    memberIds.length === 0
      ? []
      : prisma.fileShare.findMany({
          where: { id: { in: memberIds } },
          include: {
            file: shareFileInclude,
            sharedWith: {
              select: {
                id: true,
                displayName: true,
                avatarUrl: true,
                email: true,
              },
            },
          },
        }),
    linkIds.length === 0
      ? []
      : prisma.fileShareLinkFile.findMany({
          where: { id: { in: linkIds } },
          include: {
            file: shareFileInclude,
            shareLink: { select: { createdAt: true } },
          },
        }),
  ]);
  const membersById = new Map(memberShares.map((row) => [row.id, row]));
  const linksById = new Map(linkShareFiles.map((row) => [row.id, row]));
  type ListedShare = {
    id: string;
    file: (typeof memberShares)[number]["file"];
    sharedWith: (typeof memberShares)[number]["sharedWith"] | null;
    shareType: "member" | "link";
    createdAt: Date;
  };
  const data: ListedShare[] = [];
  for (const row of page) {
    if (row.id.startsWith(SHARED_BY_ME_LINK_PREFIX)) {
      const link = linksById.get(row.id.slice(SHARED_BY_ME_LINK_PREFIX.length));
      if (!link) continue;
      data.push({
        id: row.id,
        file: link.file,
        sharedWith: null,
        shareType: "link",
        createdAt: link.shareLink.createdAt,
      });
      continue;
    }
    const share = membersById.get(row.id);
    if (!share) continue;
    data.push({
      id: share.id,
      file: share.file,
      sharedWith: share.sharedWith,
      shareType: "member",
      createdAt: share.createdAt,
    });
  }

  return {
    data,
    nextCursor: hasMore ? page[page.length - 1].id : null,
  };
}

// ─── Public Share Links ─────────────────────────────────

// New links get 32 CSPRNG bytes (256 bits) as 43 URL-safe characters.
// An 8-character token is not a credential: public reads miss before the
// query, the same way an unknown token does. The row itself is kept.
const SHARE_LINK_TOKEN_BYTES = 32;
const SHARE_LINK_CREATE_ATTEMPTS = 3;

function newShareLinkToken(): string {
  return crypto.randomBytes(SHARE_LINK_TOKEN_BYTES).toString("base64url");
}

/** Only a duplicate FileShareLink.token earns a fresh draw. */
function isShareLinkTokenCollision(error: unknown): boolean {
  if (
    !(error instanceof Prisma.PrismaClientKnownRequestError) ||
    error.code !== "P2002" ||
    error.meta?.modelName !== "FileShareLink"
  )
    return false;
  const target = error.meta?.target;
  return Array.isArray(target)
    ? target.length === 1 && target[0] === "token"
    : target === "FileShareLink_token_key";
}

export async function createFileShareLink(
  prisma: PrismaClient,
  workspaceId: string,
  fileIds: string[],
  createdById: string,
  ctx: AccessContext,
  password?: string,
  expiresAt?: string,
) {
  for (const fileId of fileIds) {
    await assertFileAccess(prisma, fileId, { ...ctx, workspaceId }, true);
  }

  // Hashed once: a token retry must not repeat the password KDF.
  const passwordHash = password ? await hashPassword(password) : undefined;

  const readable = await fileReadWhere(prisma, { ...ctx, workspaceId });

  for (let attempt = 1; ; attempt++) {
    try {
      // One nested write: the link and its file rows commit or roll back
      // together, so a failed attempt leaves nothing behind.
      return await prisma.fileShareLink.create({
        data: {
          workspaceId,
          token: newShareLinkToken(),
          passwordHash,
          expiresAt: expiresAt ? new Date(expiresAt) : undefined,
          createdById,
          files: {
            create: fileIds.map((fileId) => ({ fileId })),
          },
        },
        include: {
          files: {
            where: { file: { AND: [readable], trashedAt: null } },
            include: {
              file: {
                select: { id: true, name: true, mimeType: true, size: true },
              },
            },
          },
          createdBy: {
            select: { id: true, displayName: true, avatarUrl: true },
          },
        },
      });
    } catch (error) {
      if (!isShareLinkTokenCollision(error)) throw error;
      if (attempt >= SHARE_LINK_CREATE_ATTEMPTS) {
        // Repeated 256-bit collisions mean the random source is broken.
        logger.error(
          { event: "file_share_link_token_exhausted", attempts: attempt },
          "Share link token collided on every attempt",
        );
        throw new ConflictError(
          "Could not create a unique share link; please try again",
        );
      }
    }
  }
}

export async function getFileShareLinks(
  prisma: PrismaClient,
  workspaceId: string,
  fileId: string,
  ctx: AccessContext,
) {
  await assertFileAccess(prisma, fileId, { ...ctx, workspaceId }, true);

  const role = await fileAccessRole(prisma, { ...ctx, workspaceId });
  const readable = await fileReadWhere(prisma, { ...ctx, workspaceId });

  return prisma.fileShareLink.findMany({
    where: {
      workspaceId,
      ...(role === "ADMIN" ? {} : { createdById: ctx.userId }),
      files: { some: { fileId } },
    },
    include: {
      files: {
        where: { file: { AND: [readable], trashedAt: null } },
        include: {
          file: {
            select: { id: true, name: true, mimeType: true, size: true },
          },
        },
      },
      createdBy: {
        select: { id: true, displayName: true, avatarUrl: true },
      },
    },
    orderBy: { createdAt: "desc" },
  });
}

async function assertShareLinkManager(
  prisma: PrismaClient,
  linkId: string,
  ctx: AccessContext,
) {
  const link = await prisma.fileShareLink.findFirst({
    where: { id: linkId, workspaceId: ctx.workspaceId },
  });
  if (!link) throw new NotFoundError("Share link not found");
  const role = await fileAccessRole(prisma, ctx);
  if (
    role === "VIEWER" ||
    (role !== "ADMIN" && link.createdById !== ctx.userId)
  )
    throw new ForbiddenError(
      "Only the share creator or workspace administrator can manage this link",
    );
  return link;
}

export async function updateFileShareLink(
  prisma: PrismaClient,
  linkId: string,
  data: {
    enabled?: boolean;
    password?: string | null;
    expiresAt?: string | null;
  },
  ctx: AccessContext,
) {
  await assertShareLinkManager(prisma, linkId, ctx);

  const updateData: Record<string, unknown> = {};
  if (data.enabled !== undefined) updateData.enabled = data.enabled;
  if (data.expiresAt !== undefined) {
    updateData.expiresAt = data.expiresAt ? new Date(data.expiresAt) : null;
  }
  if (data.password !== undefined) {
    updateData.passwordHash = data.password
      ? await hashPassword(data.password)
      : null;
  }

  const readable = await fileReadWhere(prisma, ctx);

  return updateShareRevision(
    () =>
      prisma.fileShareLink.findUnique({
        where: { id: linkId, workspaceId: ctx.workspaceId },
      }),
    (existing, updatedAt) =>
      prisma.fileShareLink.update({
        where: {
          id: linkId,
          workspaceId: ctx.workspaceId,
          updatedAt: existing.updatedAt,
        },
        data: { ...updateData, updatedAt },
        include: {
          files: {
            where: { file: { AND: [readable], trashedAt: null } },
            include: {
              file: {
                select: { id: true, name: true, mimeType: true, size: true },
              },
            },
          },
          createdBy: {
            select: { id: true, displayName: true, avatarUrl: true },
          },
        },
      }),
    () => new NotFoundError("Share link not found"),
  );
}

export async function deleteFileShareLink(
  prisma: PrismaClient,
  linkId: string,
  ctx: AccessContext,
) {
  await assertShareLinkManager(prisma, linkId, ctx);
  await prisma.fileShareLink.delete({
    where: { id: linkId, workspaceId: ctx.workspaceId },
  });
}

// ─── Public Access (no auth) ────────────────────────────

// One gate for every public read of a presented token. The app Prisma client
// misses the same shape on direct reads and on share-link relation filters.
async function findPresentedFileShareLink<T>(
  token: string,
  load: (token: string) => Promise<T | null>,
): Promise<T | null> {
  if (isLegacyFileShareToken(token)) return null;
  return load(token);
}

export async function getPublicShareLink(
  prisma: PrismaClient,
  token: string,
  grant?: string,
) {
  const link = await findPresentedFileShareLink(token, (presented) =>
    prisma.fileShareLink.findUnique({
      where: { token: presented },
    }),
  );

  if (!link || !link.enabled) throw new NotFoundError("Shared files not found");

  if (link.expiresAt && link.expiresAt <= new Date()) {
    throw new NotFoundError("This share link has expired");
  }

  if (link.passwordHash && !hasShareGrant(grant, "files", link)) {
    return {
      files: [],
      createdBy: null,
      hasPassword: true,
      authorized: false as const,
      createdAt: null,
    };
  }

  const authorizedLink = await prisma.fileShareLink.findUnique({
    where: { id: link.id, updatedAt: link.updatedAt, enabled: true },
    select: {
      files: {
        where: { file: { workspaceId: link.workspaceId, trashedAt: null } },
        include: {
          file: {
            select: { id: true, name: true, mimeType: true, size: true },
          },
        },
      },
      createdBy: { select: { id: true, displayName: true, avatarUrl: true } },
    },
  });
  if (!authorizedLink) throw new NotFoundError("Shared files not found");

  return {
    files: authorizedLink.files,
    createdBy: authorizedLink.createdBy,
    hasPassword: !!link.passwordHash,
    authorized: true as const,
    createdAt: link.createdAt,
  };
}

export async function validateShareLinkAccess(
  prisma: PrismaClient,
  token: string,
  password: string,
) {
  const link = await findPresentedFileShareLink(token, (presented) =>
    prisma.fileShareLink.findUnique({ where: { token: presented } }),
  );
  if (!link || !link.enabled) throw new NotFoundError("Shared files not found");

  if (link.expiresAt && link.expiresAt <= new Date()) {
    throw new NotFoundError("This share link has expired");
  }

  if (!link.passwordHash) return link;

  const valid = await verifyPassword(password, link.passwordHash);
  if (!valid) throw new ForbiddenError("Invalid password");
  const current = await prisma.fileShareLink.findUnique({
    where: { id: link.id, updatedAt: link.updatedAt, enabled: true },
  });
  if (!current)
    throw new ConflictError("Share changed; please verify its password again");
  if (current.expiresAt && current.expiresAt <= new Date()) {
    throw new NotFoundError("This share link has expired");
  }
  return current;
}

export async function downloadPublicFile(
  prisma: PrismaClient,
  storage: Pick<StorageProvider, "openReadStream">,
  token: string,
  fileId: string,
  grant?: string,
) {
  const link = await findPresentedFileShareLink(token, (presented) =>
    prisma.fileShareLink.findUnique({
      where: { token: presented },
      include: {
        files: { where: { fileId }, include: { file: true } },
      },
    }),
  );

  if (!link || !link.enabled) throw new NotFoundError("Shared files not found");

  if (link.expiresAt && link.expiresAt <= new Date()) {
    throw new NotFoundError("This share link has expired");
  }

  if (link.passwordHash && !hasShareGrant(grant, "files", link)) {
    throw new ForbiddenError("Share password verification required");
  }

  if (link.files.length === 0) {
    throw new NotFoundError("File not found in share link");
  }

  const file = link.files[0].file;
  if (
    !file.storagePath ||
    file.isFolder ||
    file.workspaceId !== link.workspaceId ||
    file.trashedAt
  ) {
    throw new NotFoundError("File content not available");
  }

  const stream = await storage.openReadStream(file.storagePath);
  return { stream, file };
}

// ─── Share Status (for indicators) ──────────────────────

export async function getFileShareStatus(
  prisma: PrismaClient,
  workspaceId: string,
  fileIds: string[],
  ctx: AccessContext,
) {
  const readable = await fileReadWhere(prisma, { ...ctx, workspaceId });
  const [shares, linkFiles] = await Promise.all([
    prisma.fileShare.findMany({
      where: {
        workspaceId,
        fileId: { in: fileIds },
        file: { AND: [readable], trashedAt: null },
      },
      select: { fileId: true },
      distinct: ["fileId"],
    }),
    prisma.fileShareLinkFile.findMany({
      where: {
        fileId: { in: fileIds },
        shareLink: { workspaceId },
        file: { AND: [readable], trashedAt: null },
      },
      select: { fileId: true },
      distinct: ["fileId"],
    }),
  ]);

  const sharedIds = new Set<string>();
  for (const s of shares) sharedIds.add(s.fileId);
  for (const l of linkFiles) sharedIds.add(l.fileId);

  return Array.from(sharedIds);
}
