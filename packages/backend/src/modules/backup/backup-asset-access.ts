import type { PrismaClient } from "@prisma/client";
import { assertFileAccess, type AccessContext } from "../files/file-access.js";
import { ForbiddenError, NotFoundError } from "../../utils/errors.js";

/** A service caller's supplied role is never export authority. */
export async function assertBackupExportAccess(
  prisma: PrismaClient,
  workspaceId: string,
  userId: string,
): Promise<AccessContext> {
  if (typeof userId !== "string" || !userId) {
    throw new ForbiddenError("Workspace administrator access is required");
  }
  const member = await prisma.workspaceMember.findUnique({
    where: { userId_workspaceId: { userId, workspaceId } },
    select: { role: true },
  });
  if (member?.role !== "ADMIN") {
    throw new ForbiddenError("Workspace administrator access is required");
  }
  return { workspaceId, userId, workspaceRole: member.role };
}

function storagePathsFromUrl(url: string): string[] {
  if (!url.startsWith("/storage/")) return [];
  const raw = url.slice("/storage/".length);
  const pathname = raw.split(/[?#]/, 1)[0];
  const candidates = new Set<string>();
  const add = (segments: string[]) => {
    if (
      segments.every(
        (segment) =>
          segment &&
          segment !== "." &&
          segment !== ".." &&
          !/[\\/\u0000-\u001f\u007f]/.test(segment),
      )
    ) {
      candidates.add(segments.join("/"));
    }
  };
  // Current upload responses contain literal extensions, including '%2f', '?'
  // and '#'. Resolve their FULL exact storage identity before interpreting any
  // URL syntax. These characters are filename data when storage reads the path.
  add(raw.split("/"));
  const uriSegments = pathname.split("/");
  const decoded = uriSegments.map((segment) => {
    try {
      return decodeURIComponent(segment.replace(/%(?![\da-f]{2})/gi, "%25"));
    } catch {
      // A literal percent-bearing filename need not form a UTF-8 escape sequence.
      return segment;
    }
  });
  // Reject only an unsafe interpretation, not a separately valid raw filename.
  // Never decode a resulting storage candidate again; residual percent text is
  // literal data, not a second chance to introduce separators or parent paths.
  add(decoded);
  add(uriSegments);
  return [...candidates];
}

/** Resolve current resource authority before opening any embedded storage path. */
export async function resolveBackupAssetPaths(
  prisma: PrismaClient,
  ctx: AccessContext,
  url: string,
): Promise<string[]> {
  const storagePaths = storagePathsFromUrl(url);
  if (storagePaths.length === 0) return [];

  // File paths survive moves and can be legacy paths outside the current tenant
  // prefix. Find ALL identities first, including foreign/trashed records. A path
  // cannot fall back to a Wiki namespace after a recorded resource denies access.
  const files = await prisma.file.findMany({
    where: {
      OR: storagePaths.flatMap((storagePath) => [
        { storagePath },
        { thumbnailPath: storagePath },
      ]),
    },
    select: {
      id: true,
      workspaceId: true,
      isFolder: true,
      storagePath: true,
      thumbnailPath: true,
    },
  });
  for (const file of files) {
    if (file.workspaceId !== ctx.workspaceId || file.isFolder) return [];
    try {
      await assertFileAccess(prisma, file.id, ctx);
    } catch (error) {
      if (error instanceof ForbiddenError || error instanceof NotFoundError)
        return [];
      throw error;
    }
  }
  const authorized = [];
  for (const storagePath of storagePaths) {
    if (
      files.some(
        (file) =>
          file.storagePath === storagePath ||
          file.thumbnailPath === storagePath,
      ) ||
      (await isOwnedUploadPath(prisma, ctx, storagePath))
    )
      authorized.push(storagePath);
  }
  return authorized;
}

async function isOwnedUploadPath(
  prisma: PrismaClient,
  ctx: AccessContext,
  storagePath: string,
): Promise<boolean> {
  const segments = storagePath.split("/");
  if (
    segments[0] === ctx.workspaceId &&
    segments[1] === "uploads" &&
    segments[2] === "wiki" &&
    segments.length >= 5
  ) {
    // Restore explicitly writes assets into this workspace-owned namespace.
    if (segments[3] === "imports") return true;
    const space = await prisma.wikiSpace.findFirst({
      where: { id: segments[3], workspaceId: ctx.workspaceId },
      select: { id: true },
    });
    return !!space;
  }

  // Public avatars have a separate explicit identity: namespace owner, matching
  // current profile URL, and current membership in the exported workspace. A
  // mutable avatarUrl alone must never authorize an arbitrary legacy upload.
  const avatarUserId =
    segments[0] === "avatars" && segments.length >= 3
      ? segments[1]
      : segments[0] === ctx.workspaceId &&
          segments[1] === "uploads" &&
          segments[2] === "avatars" &&
          segments.length >= 5
        ? segments[3]
        : null;
  if (avatarUserId) {
    const user = await prisma.user.findFirst({
      where: {
        id: avatarUserId,
        avatarUrl: `/storage/${storagePath}`,
        workspaces: { some: { workspaceId: ctx.workspaceId } },
      },
      select: { id: true },
    });
    if (user) return true;
  }
  // Unrecorded legacy general uploads/private paths have no provable workspace.
  return false;
}
