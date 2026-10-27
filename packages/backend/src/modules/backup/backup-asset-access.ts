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

function storagePathFromUrl(url: string): string | null {
  const pathname = url.split(/[?#]/, 1)[0];
  if (!pathname.startsWith("/storage/")) return null;
  try {
    const segments = pathname
      .slice("/storage/".length)
      .split("/")
      .map(decodeURIComponent);
    // Do not normalize aliases into another resource, or decode twice. The path
    // checked against database ownership must be exactly the path read from storage.
    if (
      segments.some(
        (segment) =>
          !segment ||
          segment === "." ||
          segment === ".." ||
          /[\\/%\u0000-\u001f\u007f]/.test(segment),
      )
    )
      return null;
    return segments.join("/");
  } catch {
    return null;
  }
}

/** Resolve current resource authority before opening any embedded storage path. */
export async function resolveBackupAssetPath(
  prisma: PrismaClient,
  ctx: AccessContext,
  url: string,
): Promise<string | null> {
  const storagePath = storagePathFromUrl(url);
  if (!storagePath) return null;

  // File paths survive moves and can be legacy paths outside the current tenant
  // prefix. Find ALL identities first, including foreign/trashed records. A path
  // cannot fall back to a Wiki namespace after a recorded resource denies access.
  const files = await prisma.file.findMany({
    where: { OR: [{ storagePath }, { thumbnailPath: storagePath }] },
    select: { id: true, workspaceId: true, isFolder: true },
  });
  if (files.length > 0) {
    for (const file of files) {
      if (file.workspaceId !== ctx.workspaceId || file.isFolder) return null;
      try {
        await assertFileAccess(prisma, file.id, ctx);
      } catch (error) {
        if (error instanceof ForbiddenError || error instanceof NotFoundError)
          return null;
        throw error;
      }
    }
    return storagePath;
  }

  const segments = storagePath.split("/");
  if (
    segments[0] === ctx.workspaceId &&
    segments[1] === "uploads" &&
    segments[2] === "wiki" &&
    segments.length >= 5
  ) {
    // Restore explicitly writes assets into this workspace-owned namespace.
    if (segments[3] === "imports") return storagePath;
    const space = await prisma.wikiSpace.findFirst({
      where: { id: segments[3], workspaceId: ctx.workspaceId },
      select: { id: true },
    });
    return space ? storagePath : null;
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
    if (user) return storagePath;
  }
  // Unrecorded legacy general uploads/private paths have no provable workspace.
  return null;
}
