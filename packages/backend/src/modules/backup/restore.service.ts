import crypto from "node:crypto";
import path from "node:path";
import type { PrismaClient } from "@prisma/client";
import type { BackupFile, RestoreSummary } from "@pm/shared";
import type { StorageProvider } from "../../services/storage.js";
import { IdMapper, UserMapper } from "./id-mapper.js";
import { planCustomFieldRestore } from "./custom-field-restore.js";
import {
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "../../utils/errors.js";
import { lockWorkspace } from "../../utils/workspace-lock.js";
import { rewriteUrls } from "./backup-assets.js";
import { toCustomFieldType, toPriority, toJsonValue } from "./backup-types.js";
import { sanitizeDescription } from "../../utils/description-html.js";
import { parseBackupJson } from "./backup-json.js";
import type { BackupArchiveAsset } from "./backup-archive.js";

/** Parse and validate a backup JSON buffer within the restore limits. */
function parseBackupFile(buffer: Buffer): BackupFile {
  const backup = parseBackupJson(buffer);
  validateWikiGraph(backup);
  return backup;
}

/**
 * Preview and restore share this check, so an invalid page hierarchy is
 * rejected before any asset or database write. A parent must be another page
 * of the same space and the parent chain must end at a root. A parent that is
 * absent from the whole backup keeps the existing skip-with-warning behavior.
 */
function validateWikiGraph(backup: BackupFile) {
  const spaceOf = new Map<string, number>();
  backup.wikiSpaces.forEach((ws, index) => {
    for (const p of ws.pages) spaceOf.set(p._originalId, index);
  });
  backup.wikiSpaces.forEach((ws, index) => {
    const parents = new Map<string, string | null>();
    for (const p of ws.pages) {
      if (parents.has(p._originalId))
        throw new ValidationError(
          "Invalid backup file: duplicate wiki page id",
        );
      parents.set(p._originalId, p.parentRef ?? null);
    }
    for (const p of ws.pages) {
      if (!p.parentRef) continue;
      if (!parents.has(p.parentRef) && spaceOf.has(p.parentRef))
        throw new ValidationError(
          "Invalid backup file: wiki page parent is in another space",
        );
    }
    // Every chain is walked at most once (`done`), so this is linear.
    const done = new Set<string>();
    for (const start of parents.keys()) {
      const path = new Set<string>();
      let current: string | null | undefined = start;
      while (current && parents.has(current) && !done.has(current)) {
        if (path.has(current))
          throw new ValidationError(
            "Invalid backup file: wiki page hierarchy contains a cycle",
          );
        path.add(current);
        current = parents.get(current);
      }
      for (const id of path) done.add(id);
    }
  });
}

/** Build a UserMapper from backup metadata + workspace members. */
async function buildUserMapper(
  prisma: PrismaClient,
  workspaceId: string,
  adminUserId: string,
  backup: BackupFile,
): Promise<UserMapper> {
  const mapper = new UserMapper(adminUserId);

  const wsMembers = await prisma.workspaceMember.findMany({
    where: { workspaceId },
    include: {
      user: { select: { id: true, email: true, displayName: true } },
    },
  });

  const membersByEmail = new Map(
    wsMembers.map((m) => [m.user.email.toLowerCase(), m.user]),
  );

  for (const ref of backup.metadata.userRefs) {
    const match = membersByEmail.get(ref.email.toLowerCase());
    mapper.addMapping(
      ref.originalId,
      ref.email,
      ref.displayName,
      match?.id ?? null,
      match?.displayName ?? null,
    );
  }

  return mapper;
}

/** Generate a preview summary without modifying the database. */
export async function previewRestore(
  prisma: PrismaClient,
  workspaceId: string,
  adminUserId: string,
  fileBuffer: Buffer,
  assets?: ReadonlyMap<string, BackupArchiveAsset>,
): Promise<RestoreSummary> {
  const backup = parseBackupFile(fileBuffer);
  const userMapper = await buildUserMapper(prisma, workspaceId, adminUserId, backup);

  let statuses = 0;
  let labels = 0;
  let customFields = 0;
  let tasks = 0;
  let subtasks = 0;
  let comments = 0;
  let activityLogs = 0;
  let messages = 0;
  let reactions = 0;
  const customFieldWarnings: string[] = [];

  for (const p of backup.projects) {
    statuses += p.statuses.length;
    labels += p.labels.length;
    customFields += p.customFields.length;
    customFieldWarnings.push(...planCustomFieldRestore(p).warnings);
    tasks += p.tasks.length;
    for (const t of p.tasks) {
      subtasks += t.subtasks.length;
      comments += t.comments.length;
      activityLogs += t.activityLogs.length;
    }
  }

  for (const c of backup.channels) {
    messages += c.messages.length;
    for (const m of c.messages) {
      reactions += m.reactions.length;
    }
  }

  let wikiPages = 0;
  let wikiComments = 0;
  for (const ws of backup.wikiSpaces) {
    wikiPages += ws.pages.length;
    for (const p of ws.pages) {
      wikiComments += p.comments.length;
    }
  }

  return {
    projects: backup.projects.length,
    statuses,
    labels,
    customFields,
    tasks,
    subtasks,
    comments,
    activityLogs,
    channels: backup.channels.length,
    messages,
    reactions,
    wikiSpaces: backup.wikiSpaces.length,
    wikiPages,
    wikiComments,
    images: assets?.size ?? 0,
    userMappings: userMapper.getMappings().map((m) => ({
      originalEmail: m.originalEmail,
      originalName: m.originalName,
      mappedUserId: m.resolvedId,
      mappedName: m.resolvedName,
    })),
    warnings: [...userMapper.getWarnings(), ...customFieldWarnings],
  };
}

/** Restore a backup file into the workspace, creating new entities with new IDs. */
export async function executeRestore(
  prisma: PrismaClient,
  workspaceId: string,
  adminUserId: string,
  fileBuffer: Buffer,
  assets?: ReadonlyMap<string, BackupArchiveAsset>,
  storage?: StorageProvider,
): Promise<RestoreSummary> {
  const backup = parseBackupFile(fileBuffer);
  const userMapper = await buildUserMapper(prisma, workspaceId, adminUserId, backup);
  const idMapper = new IdMapper();

  const counts = {
    projects: 0,
    statuses: 0,
    labels: 0,
    customFields: 0,
    tasks: 0,
    subtasks: 0,
    comments: 0,
    activityLogs: 0,
    channels: 0,
    messages: 0,
    reactions: 0,
    wikiSpaces: 0,
    wikiPages: 0,
    wikiComments: 0,
    images: 0,
  };
  const warnings = [...userMapper.getWarnings()];

  // ─── Re-upload assets and build URL rewrite map ────────

  const assetUrlMap = new Map<string, string>(); // "assets/file.png" → "/storage/new/path"
  const savedAssets: string[] = [];

  if (assets && assets.size > 0 && storage) {
    for (const [assetPath, asset] of assets) {
      if (!assetPath.startsWith("assets/")) continue;

      const filename = path.basename(assetPath);
      const ext = path.extname(filename) || ".bin";
      const fileId = crypto.randomUUID();

      try {
        // Streamed from the staged archive; never held in memory whole.
        const { storagePath } = await storage.saveStream(
          `${workspaceId}/uploads`,
          "wiki/imports",
          fileId,
          ext,
          asset.open(),
        );
        savedAssets.push(storagePath);
        assetUrlMap.set(assetPath, `/storage/${storagePath}`);
        counts.images++;
      } catch {
        warnings.push(`Failed to re-upload asset: ${filename}`);
      }
    }
  }

  // Assets staged above have no rows when the transaction rolls back (for
  // example after the role re-check below), so remove them best-effort.
  const discardStagedAssets = async (error: unknown) => {
    if (storage)
      for (const storagePath of savedAssets)
        await storage.delete(storagePath).catch(() => {});
    throw error;
  };

  await prisma.$transaction(
    async (tx) => {
      // New wiki spaces/pages are appended under the same workspace lock as
      // runtime wiki writers, with the administrator role re-read after it.
      if (!(await lockWorkspace(tx, workspaceId)))
        throw new NotFoundError("Workspace not found");
      const admin = await tx.workspaceMember.findUnique({
        where: { userId_workspaceId: { userId: adminUserId, workspaceId } },
        select: { role: true },
      });
      if (admin?.role !== "ADMIN")
        throw new ForbiddenError("Insufficient permissions");

      // ─── Restore Projects ───────────────────────────────

      for (const pEntry of backup.projects) {
        const newProject = await tx.project.create({
          data: {
            workspaceId,
            name: pEntry.project.name,
            description: pEntry.project.description,
            color: pEntry.project.color,
            icon: pEntry.project.icon,
          },
        });
        counts.projects++;

        // Statuses
        for (const s of pEntry.statuses) {
          const newStatus = await tx.statusColumn.create({
            data: {
              projectId: newProject.id,
              name: s.name,
              color: s.color,
              position: s.position,
              isCompletion: s.isCompletion,
            },
          });
          idMapper.set(s._originalId, newStatus.id);
          counts.statuses++;
        }

        // Labels
        for (const l of pEntry.labels) {
          const newLabel = await tx.label.create({
            data: {
              projectId: newProject.id,
              name: l.name,
              color: l.color,
            },
          });
          idMapper.set(l._originalId, newLabel.id);
          counts.labels++;
        }

        // Custom Fields, with the same option and value checks as the API
        const fieldPlan = planCustomFieldRestore(pEntry);
        warnings.push(...fieldPlan.warnings);
        const restoredFieldIds = new Map<string, string>();
        for (const f of fieldPlan.fields) {
          const newField = await tx.customField.create({
            data: {
              projectId: newProject.id,
              name: f.name,
              type: toCustomFieldType(f.type),
              options: f.options,
              required: f.required,
              position: f.position,
            },
          });
          idMapper.set(f.originalId, newField.id);
          restoredFieldIds.set(f.originalId, newField.id);
          counts.customFields++;
        }

        // Members
        for (const m of pEntry.members) {
          const userId = userMapper.resolveOptional(m.userRef);
          if (!userId) continue;
          // Ensure user is workspace member
          const isMember = await tx.workspaceMember.findUnique({
            where: { userId_workspaceId: { userId, workspaceId } },
          });
          if (!isMember) continue;
          await tx.projectMember.upsert({
            where: { projectId_userId: { projectId: newProject.id, userId } },
            update: {},
            create: { projectId: newProject.id, userId },
          });
        }

        // Tasks
        for (const t of pEntry.tasks) {
          const statusId = idMapper.get(t.statusRef);
          if (!statusId) {
            warnings.push(
              `Skipped task "${t.title}" — status ref ${t.statusRef} not found`,
            );
            continue;
          }

          const newTask = await tx.task.create({
            data: {
              projectId: newProject.id,
              statusId,
              title: t.title,
              description: sanitizeDescription(t.description),
              priority: toPriority(t.priority),
              position: t.position,
              dueDate: t.dueDate,
              startDate: t.startDate,
            },
          });
          idMapper.set(t._originalId, newTask.id);
          counts.tasks++;

          // Assignees
          for (const aRef of t.assignees) {
            const userId = userMapper.resolveOptional(aRef);
            if (!userId) continue;
            await tx.taskAssignee.create({
              data: { taskId: newTask.id, userId },
            }).catch(() => {
              // skip duplicates or FK violations
            });
          }

          // Labels
          for (const lRef of t.labels) {
            const labelId = idMapper.get(lRef);
            if (!labelId) continue;
            await tx.taskLabel.create({
              data: { taskId: newTask.id, labelId },
            }).catch(() => {});
          }

          // Subtasks
          for (const s of t.subtasks) {
            const newSubtask = await tx.subtask.create({
              data: {
                taskId: newTask.id,
                title: s.title,
                completed: s.completed,
                position: s.position,
                assigneeId: userMapper.resolveOptional(s.assigneeRef),
                dueDate: s.dueDate,
              },
            });
            idMapper.set(s._originalId, newSubtask.id);
            counts.subtasks++;
          }

          // Custom field values (checked and de-duplicated by the plan)
          for (const v of fieldPlan.values.get(t) ?? []) {
            const fieldId = restoredFieldIds.get(v.fieldRef);
            if (!fieldId) continue;
            await tx.customFieldValue.create({
              data: {
                taskId: newTask.id,
                fieldId,
                value: v.value,
              },
            });
          }

          // Comments
          for (const c of t.comments) {
            const newComment = await tx.comment.create({
              data: {
                taskId: newTask.id,
                authorId: userMapper.resolveOptional(c.authorRef),
                body: c.body,
                createdAt: new Date(c.createdAt),
              },
            });
            idMapper.set(c._originalId, newComment.id);
            counts.comments++;
          }

          // Activity logs
          for (const a of t.activityLogs) {
            await tx.activityLog.create({
              data: {
                taskId: newTask.id,
                action: a.action,
                details: toJsonValue(a.details),
                actorId: userMapper.resolveOptional(a.actorRef),
                createdAt: new Date(a.createdAt),
              },
            });
            counts.activityLogs++;
          }
        }

        // Task dependencies (second pass — all tasks exist now)
        for (const t of pEntry.tasks) {
          const blockedTaskId = idMapper.get(t._originalId);
          if (!blockedTaskId) continue;
          for (const dep of t.dependencies) {
            const blockingTaskId = idMapper.get(dep.blockingTaskRef);
            if (!blockingTaskId) {
              warnings.push(
                `Skipped dependency for task "${t.title}" — blocking task ref ${dep.blockingTaskRef} not found`,
              );
              continue;
            }
            await tx.taskDependency.create({
              data: { blockedTaskId, blockingTaskId },
            }).catch(() => {});
          }
        }

      }

      // ─── Restore Channels ───────────────────────────────

      for (const cEntry of backup.channels) {
        const newChannel = await tx.chatChannel.create({
          data: {
            workspaceId,
            name: cEntry.channel.name,
            description: cEntry.channel.description,
            type: cEntry.channel.type,
            createdById: adminUserId,
          },
        });
        counts.channels++;

        // Members
        for (const m of cEntry.members) {
          const userId = userMapper.resolveOptional(m.userRef);
          if (!userId) continue;
          const isMember = await tx.workspaceMember.findUnique({
            where: { userId_workspaceId: { userId, workspaceId } },
          });
          if (!isMember) continue;
          await tx.chatChannelMember.upsert({
            where: { channelId_userId: { channelId: newChannel.id, userId } },
            update: {},
            create: { channelId: newChannel.id, userId },
          });
        }

        // Ensure admin is a member
        await tx.chatChannelMember.upsert({
          where: {
            channelId_userId: { channelId: newChannel.id, userId: adminUserId },
          },
          update: {},
          create: { channelId: newChannel.id, userId: adminUserId },
        });

        // Messages (chronological order so parents exist before replies)
        for (const m of cEntry.messages) {
          const parentId = m.parentRef ? idMapper.get(m.parentRef) : null;
          // If parent ref exists but wasn't mapped yet, skip (shouldn't happen with chronological order)
          if (m.parentRef && !parentId) {
            warnings.push(
              `Skipped message parent ref ${m.parentRef} — parent not found`,
            );
          }

          const newMessage = await tx.chatMessage.create({
            data: {
              channelId: newChannel.id,
              userId: userMapper.resolve(m.userRef),
              content: m.content,
              parentId: parentId ?? undefined,
              createdAt: new Date(m.createdAt),
            },
          });
          idMapper.set(m._originalId, newMessage.id);
          counts.messages++;

          // Reactions
          for (const r of m.reactions) {
            const userId = userMapper.resolveOptional(r.userRef);
            if (!userId) continue;
            await tx.chatReaction.create({
              data: {
                messageId: newMessage.id,
                userId,
                emoji: r.emoji,
              },
            }).catch(() => {});
            counts.reactions++;
          }
        }
      }
      // ─── Restore Wiki Spaces ─────────────────────────────

      // Determine starting position for new wiki spaces
      const lastWikiSpace = await tx.wikiSpace.findFirst({
        where: { workspaceId },
        orderBy: { position: "desc" },
        select: { position: true },
      });
      let wikiSpacePosition = (lastWikiSpace?.position ?? -1) + 1;

      for (const wsEntry of backup.wikiSpaces) {
        const slug =
          wsEntry.space.name
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-|-$/g, "")
            .slice(0, 80) +
          "-" +
          Date.now().toString(36);

        const newSpace = await tx.wikiSpace.create({
          data: {
            workspaceId,
            name: wsEntry.space.name,
            slug,
            description: wsEntry.space.description,
            icon: wsEntry.space.icon,
            position: wikiSpacePosition++,
          },
        });
        counts.wikiSpaces++;

        // Parent references resolve only to pages of this space; a global
        // id lookup could match an unrelated restored entity.
        const spacePageIds = new Map<string, string>();

        // First pass: create all pages with parentId = null
        for (const p of wsEntry.pages) {
          // Rewrite asset URLs in page content if we have re-uploaded assets
          const content =
            assetUrlMap.size > 0 && p.content
              ? rewriteUrls(p.content, assetUrlMap)
              : p.content;

          const newPage = await tx.wikiPage.create({
            data: {
              spaceId: newSpace.id,
              title: p.title,
              content: toJsonValue(content),
              icon: p.icon,
              position: p.position,
              parentId: null,
              createdById: userMapper.resolve(p.createdByRef ?? ""),
            },
          });
          idMapper.set(p._originalId, newPage.id);
          spacePageIds.set(p._originalId, newPage.id);
          counts.wikiPages++;

          // Comments
          for (const c of p.comments) {
            await tx.wikiPageComment.create({
              data: {
                pageId: newPage.id,
                authorId: userMapper.resolve(c.authorRef ?? ""),
                body: c.body,
                resolved: c.resolved,
                highlightId: c.highlightId,
                selectionStart: toJsonValue(c.selectionStart),
                selectionEnd: toJsonValue(c.selectionEnd),
                createdAt: new Date(c.createdAt),
              },
            });
            counts.wikiComments++;
          }
        }

        // Second pass: set parentId for pages that have a parentRef
        for (const p of wsEntry.pages) {
          if (!p.parentRef) continue;
          const newPageId = spacePageIds.get(p._originalId);
          const newParentId = spacePageIds.get(p.parentRef);
          if (!newPageId || !newParentId) {
            warnings.push(
              `Skipped parent link for wiki page "${p.title}" — parent ref ${p.parentRef} not found`,
            );
            continue;
          }
          await tx.wikiPage.update({
            where: { id: newPageId },
            data: { parentId: newParentId },
          });
        }
      }
    },
    { timeout: 120_000 },
  ).catch(discardStagedAssets);

  return {
    ...counts,
    userMappings: userMapper.getMappings().map((m) => ({
      originalEmail: m.originalEmail,
      originalName: m.originalName,
      mappedUserId: m.resolvedId,
      mappedName: m.resolvedName,
    })),
    warnings,
  };
}
