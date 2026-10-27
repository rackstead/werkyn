import type { PrismaClient } from "@prisma/client";
import type { BackupExportRequest, BackupFile } from "@pm/shared";
import type { StorageProvider } from "../../services/storage.js";
import archiver from "archiver";
import path from "node:path";
import { extractStorageUrls, rewriteStorageUrls } from "./backup-assets.js";
import {
  assertBackupExportAccess,
  resolveBackupAssetPath,
} from "./backup-asset-access.js";

export interface BackupExportResult {
  zipBuffer: Buffer;
  filename: string;
}

export async function exportBackup(
  prisma: PrismaClient,
  workspaceId: string,
  request: BackupExportRequest,
  storage: StorageProvider,
  actorId: string,
): Promise<BackupExportResult> {
  await assertBackupExportAccess(prisma, workspaceId, actorId);
  const workspace = await prisma.workspace.findUniqueOrThrow({
    where: { id: workspaceId },
    select: { name: true, slug: true },
  });

  // Collect all user IDs referenced across the backup
  const userIdSet = new Set<string>();

  // ─── Export Projects ──────────────────────────────────

  const projectEntries: BackupFile["projects"] = [];

  for (const opt of request.projects) {
    const project = await prisma.project.findUnique({
      where: { id: opt.projectId, workspaceId },
      select: {
        name: true,
        description: true,
        color: true,
        icon: true,
      },
    });
    if (!project) continue;

    const statuses = opt.includeStatuses
      ? await prisma.statusColumn.findMany({
          where: { projectId: opt.projectId },
          orderBy: { position: "asc" },
        })
      : [];

    const labels = opt.includeLabels
      ? await prisma.label.findMany({
          where: { projectId: opt.projectId },
        })
      : [];

    const customFields = opt.includeCustomFields
      ? await prisma.customField.findMany({
          where: { projectId: opt.projectId },
          orderBy: { position: "asc" },
        })
      : [];

    const members = opt.includeMembers
      ? await prisma.projectMember.findMany({
          where: { projectId: opt.projectId },
          select: { userId: true },
        })
      : [];

    for (const m of members) userIdSet.add(m.userId);

    // Tasks
    let tasks: BackupFile["projects"][number]["tasks"] = [];
    if (opt.includeTasks) {
      const dbTasks = await prisma.task.findMany({
        where: { projectId: opt.projectId },
        include: {
          assignees: { select: { userId: true } },
          labels: { select: { labelId: true } },
          subtasks: { orderBy: { position: "asc" } },
          customFieldValues: true,
          blockedBy: { select: { blockingTaskId: true } },
          comments: opt.includeComments
            ? { orderBy: { createdAt: "asc" } }
            : false,
          activities: opt.includeActivityLogs
            ? { orderBy: { createdAt: "asc" } }
            : false,
        },
        orderBy: { createdAt: "asc" },
      });

      tasks = dbTasks.map((t) => {
        for (const a of t.assignees) userIdSet.add(a.userId);
        for (const s of t.subtasks) {
          if (s.assigneeId) userIdSet.add(s.assigneeId);
        }

        const comments = t.comments
          ? t.comments.map((c) => {
              if (c.authorId) userIdSet.add(c.authorId);
              return {
                _originalId: c.id,
                body: c.body,
                authorRef: c.authorId,
                createdAt: c.createdAt.toISOString(),
              };
            })
          : [];

        const activityLogs = t.activities
          ? t.activities.map((a) => {
              if (a.actorId) userIdSet.add(a.actorId);
              return {
                _originalId: a.id,
                action: a.action,
                details: a.details,
                actorRef: a.actorId,
                createdAt: a.createdAt.toISOString(),
              };
            })
          : [];

        return {
          _originalId: t.id,
          title: t.title,
          description: t.description,
          priority: t.priority,
          position: t.position,
          dueDate: t.dueDate,
          startDate: t.startDate,
          statusRef: t.statusId,
          createdByRef: null as string | null,
          assignees: t.assignees.map((a) => a.userId),
          labels: t.labels.map((l) => l.labelId),
          subtasks: t.subtasks.map((s) => ({
            _originalId: s.id,
            title: s.title,
            completed: s.completed,
            position: s.position,
            assigneeRef: s.assigneeId,
            dueDate: s.dueDate,
          })),
          customFieldValues: t.customFieldValues.map((v) => ({
            fieldRef: v.fieldId,
            value: v.value,
          })),
          dependencies: t.blockedBy.map((d) => ({
            blockingTaskRef: d.blockingTaskId,
            type: "blocks",
          })),
          comments,
          activityLogs,
        };
      });
    }

    projectEntries.push({
      project: {
        name: project.name,
        description: project.description,
        color: project.color,
        icon: project.icon,
      },
      statuses: statuses.map((s) => ({
        _originalId: s.id,
        name: s.name,
        color: s.color,
        position: s.position,
        isCompletion: s.isCompletion,
      })),
      labels: labels.map((l) => ({
        _originalId: l.id,
        name: l.name,
        color: l.color,
      })),
      customFields: customFields.map((f) => ({
        _originalId: f.id,
        name: f.name,
        type: f.type,
        options: f.options,
        required: f.required,
        position: f.position,
      })),
      members: members.map((m) => ({ userRef: m.userId })),
      tasks,
      attachments: [],
    });
  }

  // ─── Export Channels ──────────────────────────────────

  const channelEntries: BackupFile["channels"] = [];

  for (const opt of request.channels) {
    const channel = await prisma.chatChannel.findUnique({
      where: { id: opt.channelId, workspaceId },
      select: {
        name: true,
        description: true,
        type: true,
        createdById: true,
      },
    });
    if (!channel || channel.type === "DM") continue;

    const members = opt.includeMembers
      ? await prisma.chatChannelMember.findMany({
          where: { channelId: opt.channelId },
          select: { userId: true },
        })
      : [];

    for (const m of members) userIdSet.add(m.userId);
    userIdSet.add(channel.createdById);

    let messages: BackupFile["channels"][number]["messages"] = [];
    if (opt.includeMessages) {
      const dbMessages = await prisma.chatMessage.findMany({
        where: { channelId: opt.channelId, deletedAt: null },
        include: opt.includeReactions
          ? { reactions: { select: { userId: true, emoji: true } } }
          : undefined,
        orderBy: { createdAt: "asc" },
      });

      messages = dbMessages.map((m) => {
        userIdSet.add(m.userId);
        const mWithReactions = m as typeof m & { reactions?: Array<{ userId: string; emoji: string }> };
        const reactions = mWithReactions.reactions
          ? mWithReactions.reactions.map((r) => {
              userIdSet.add(r.userId);
              return { userRef: r.userId, emoji: r.emoji };
            })
          : [];

        return {
          _originalId: m.id,
          content: m.content,
          userRef: m.userId,
          parentRef: m.parentId,
          createdAt: m.createdAt.toISOString(),
          reactions,
        };
      });
    }

    channelEntries.push({
      channel: {
        name: channel.name,
        description: channel.description,
        type: channel.type as "PUBLIC" | "PRIVATE",
      },
      members: members.map((m) => ({ userRef: m.userId })),
      messages,
    });
  }

  // ─── Export Wiki Spaces ──────────────────────────────

  const wikiSpaceEntries: BackupFile["wikiSpaces"] = [];

  for (const opt of request.wikiSpaces) {
    const space = await prisma.wikiSpace.findUnique({
      where: { id: opt.spaceId, workspaceId },
      select: { name: true, description: true, icon: true },
    });
    if (!space) continue;

    const dbPages = await prisma.wikiPage.findMany({
      where: { spaceId: opt.spaceId },
      include: opt.includeComments
        ? { comments: { orderBy: { createdAt: "asc" } } }
        : undefined,
      orderBy: { createdAt: "asc" },
    });

    const pages = dbPages.map((p) => {
      if (p.createdById) userIdSet.add(p.createdById);

      type WikiComment = {
        id: string;
        body: string;
        authorId: string;
        resolved: boolean;
        highlightId: string;
        selectionStart: unknown;
        selectionEnd: unknown;
        createdAt: Date;
      };
      const pWithComments = p as typeof p & { comments?: WikiComment[] };
      const comments = pWithComments.comments
        ? pWithComments.comments.map((c) => {
            if (c.authorId) userIdSet.add(c.authorId);
            return {
              _originalId: c.id,
              body: c.body,
              authorRef: c.authorId,
              resolved: c.resolved,
              highlightId: c.highlightId,
              selectionStart: c.selectionStart,
              selectionEnd: c.selectionEnd,
              createdAt: c.createdAt.toISOString(),
            };
          })
        : [];

      return {
        _originalId: p.id,
        title: p.title,
        content: p.content,
        icon: p.icon,
        position: p.position,
        parentRef: p.parentId,
        createdByRef: p.createdById,
        comments,
      };
    });

    wikiSpaceEntries.push({
      space: {
        name: space.name,
        description: space.description,
        icon: space.icon,
      },
      pages,
    });
  }

  // ─── Resolve User References ──────────────────────────

  const userRefs = await prisma.user.findMany({
    where: { id: { in: Array.from(userIdSet) } },
    select: { id: true, email: true, displayName: true },
  });

  // ─── Collect Files (wiki images) ─────

  const assetBuffers = new Map<string, Buffer>();
  const urlRewriteMap = new Map<string, string>();

  if (request.includeFiles) {
    // Collect & rewrite storage URLs in wiki content
    const allStorageUrls = new Set<string>();
    for (const ws of wikiSpaceEntries) {
      for (const page of ws.pages) {
        if (page.content) {
          for (const url of extractStorageUrls(page.content)) {
            allStorageUrls.add(url);
          }
        }
      }
    }

    for (const url of allStorageUrls) {
      const ctx = await assertBackupExportAccess(prisma, workspaceId, actorId);
      const storagePath = await resolveBackupAssetPath(prisma, ctx, url);
      if (!storagePath) continue;
      const filename = path.basename(storagePath);
      const assetPath = `assets/${filename}`;

      try {
        const buffer = await storage.read(storagePath);
        assetBuffers.set(assetPath, buffer);
        urlRewriteMap.set(url, assetPath);
      } catch {
        // File not found on disk — skip, leave original URL in JSON
      }
    }

    // Rewrite URLs in wiki page content
    if (urlRewriteMap.size > 0) {
      for (const ws of wikiSpaceEntries) {
        for (const page of ws.pages) {
          if (page.content) {
            page.content = rewriteStorageUrls(page.content, urlRewriteMap);
          }
        }
      }
    }

  }

  // ─── Build Backup JSON ────────────────────────────────

  const backupJson: BackupFile = {
    metadata: {
      version: "1.1",
      exportedAt: new Date().toISOString(),
      sourceWorkspace: { name: workspace.name, slug: workspace.slug },
      userRefs: userRefs.map((u) => ({
        originalId: u.id,
        email: u.email,
        displayName: u.displayName,
      })),
    },
    projects: projectEntries,
    channels: channelEntries,
    wikiSpaces: wikiSpaceEntries,
  };

  // ─── Package as ZIP ───────────────────────────────────

  const zipBuffer = await new Promise<Buffer>((resolve, reject) => {
    const archive = archiver("zip", { zlib: { level: 6 } });
    const chunks: Buffer[] = [];

    archive.on("data", (chunk: Buffer) => chunks.push(chunk));
    archive.on("end", () => resolve(Buffer.concat(chunks)));
    archive.on("error", reject);

    // Add backup.json
    archive.append(JSON.stringify(backupJson, null, 2), {
      name: "backup.json",
    });

    // Add asset files
    for (const [assetPath, buffer] of assetBuffers) {
      archive.append(buffer, { name: assetPath });
    }

    archive.finalize();
  });

  const filename = `backup-${workspace.slug}-${new Date().toISOString().slice(0, 10)}.zip`;

  return { zipBuffer, filename };
}
