import type { PrismaClient, Prisma } from "@prisma/client";
import type { CreateTemplateInput, UpdateTemplateInput, InstantiateTemplateInput } from "@pm/shared";
import { NotFoundError, ValidationError } from "../../utils/errors.js";
import { logActivity } from "../../utils/activity-log.js";
import { sanitizeDescription } from "../../utils/description-html.js";
import {
  assertProjectAssignees,
  assertProjectLabels,
  assertProjectStatus,
  projectAssigneeIds,
  projectLabelIds,
} from "../../utils/task-references.js";

type TemplateReferences = Pick<UpdateTemplateInput, "statusId" | "assigneeIds" | "labelIds">;

async function assertTemplateReferences(prisma: PrismaClient, projectId: string, data: TemplateReferences) {
  if (data.statusId) await assertProjectStatus(prisma, projectId, data.statusId);
  if (data.assigneeIds) await assertProjectAssignees(prisma, projectId, data.assigneeIds);
  if (data.labelIds) await assertProjectLabels(prisma, projectId, data.labelIds);
}

/** Stored JSON lists predate validation; ignore anything that is not an ID. */
function storedIds(value: Prisma.JsonValue): string[] {
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
}

export async function listTemplates(prisma: PrismaClient, projectId: string) {
  return prisma.taskTemplate.findMany({
    where: { projectId },
    orderBy: { name: "asc" },
  });
}

export async function getTemplate(prisma: PrismaClient, projectId: string, templateId: string) {
  const template = await prisma.taskTemplate.findFirst({
    where: { id: templateId, projectId },
  });
  if (!template) throw new NotFoundError("Template not found");
  return template;
}

export async function createTemplate(
  prisma: PrismaClient,
  projectId: string,
  data: CreateTemplateInput,
) {
  await assertTemplateReferences(prisma, projectId, data);
  return prisma.taskTemplate.create({
    data: {
      projectId,
      name: data.name,
      title: data.title,
      description: sanitizeDescription(data.description),
      priority: data.priority,
      statusId: data.statusId,
      dueOffset: data.dueOffset,
      assigneeIds: data.assigneeIds as Prisma.InputJsonValue,
      labelIds: data.labelIds as Prisma.InputJsonValue,
      subtasks: data.subtasks as Prisma.InputJsonValue,
    },
  });
}

export async function updateTemplate(
  prisma: PrismaClient,
  projectId: string,
  templateId: string,
  data: UpdateTemplateInput,
) {
  const existing = await prisma.taskTemplate.findFirst({ where: { id: templateId, projectId } });
  if (!existing) throw new NotFoundError("Template not found");
  await assertTemplateReferences(prisma, projectId, data);

  const updateData: Prisma.TaskTemplateUpdateInput = {};
  if (data.name !== undefined) updateData.name = data.name;
  if (data.title !== undefined) updateData.title = data.title;
  if (data.description !== undefined) updateData.description = sanitizeDescription(data.description);
  if (data.priority !== undefined) updateData.priority = data.priority;
  if (data.statusId !== undefined) updateData.statusId = data.statusId;
  if (data.dueOffset !== undefined) updateData.dueOffset = data.dueOffset;
  if (data.assigneeIds !== undefined) updateData.assigneeIds = data.assigneeIds as Prisma.InputJsonValue;
  if (data.labelIds !== undefined) updateData.labelIds = data.labelIds as Prisma.InputJsonValue;
  if (data.subtasks !== undefined) updateData.subtasks = data.subtasks as Prisma.InputJsonValue;

  return prisma.taskTemplate.update({
    where: { id: templateId, projectId },
    data: updateData,
  });
}

export async function deleteTemplate(prisma: PrismaClient, projectId: string, templateId: string) {
  const existing = await prisma.taskTemplate.findFirst({ where: { id: templateId, projectId } });
  if (!existing) throw new NotFoundError("Template not found");
  await prisma.taskTemplate.delete({ where: { id: templateId, projectId } });
}

export async function createTaskFromTemplate(
  prisma: PrismaClient,
  projectId: string,
  templateId: string,
  actorId: string | null,
  actorRole: string,
  overrides?: InstantiateTemplateInput,
) {
  const template = await prisma.taskTemplate.findFirst({
    where: { id: templateId, projectId },
  });
  if (!template) throw new NotFoundError("Template not found");

  // Check project is not archived
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { archived: true },
  });
  if (project?.archived) {
    throw new ValidationError("Cannot create tasks in an archived project");
  }

  return prisma.$transaction(async (tx) => {
    // Explicit overrides are validated like any other write. Stored template
    // values may be stale (deleted columns, departed members) or predate
    // validation, so only the ones still valid in this project are copied.
    if (overrides?.statusId) await assertProjectStatus(tx, projectId, overrides.statusId);
    let assigneeIds: string[];
    if (overrides?.assigneeIds) {
      await assertProjectAssignees(tx, projectId, overrides.assigneeIds);
      assigneeIds = overrides.assigneeIds;
    } else {
      assigneeIds = await projectAssigneeIds(tx, projectId, storedIds(template.assigneeIds));
    }

    // Auto-include actor for MEMBER role
    if (actorId && actorRole === "MEMBER" && !assigneeIds.includes(actorId)) {
      assigneeIds = [actorId, ...assigneeIds];
    }

    const labelIds = await projectLabelIds(tx, projectId, storedIds(template.labelIds));

    // Resolve statusId: override > template > first column
    let statusId = overrides?.statusId ?? template.statusId;
    if (statusId && !overrides?.statusId) {
      const status = await tx.statusColumn.findFirst({
        where: { id: statusId, projectId },
      });
      if (!status) statusId = null;
    }
    if (!statusId) {
      const firstColumn = await tx.statusColumn.findFirst({
        where: { projectId },
        orderBy: { position: "asc" },
      });
      if (!firstColumn) throw new ValidationError("Project has no status columns");
      statusId = firstColumn.id;
    }

    // Calculate dueDate from dueOffset
    let dueDate = overrides?.dueDate;
    if (!dueDate && template.dueOffset !== null) {
      const d = new Date();
      d.setUTCDate(d.getUTCDate() + template.dueOffset);
      const y = d.getUTCFullYear();
      const m = String(d.getUTCMonth() + 1).padStart(2, "0");
      const day = String(d.getUTCDate()).padStart(2, "0");
      dueDate = `${y}-${m}-${day}`;
    }

    // Calculate position
    const maxPos = await tx.task.aggregate({
      where: { statusId, projectId },
      _max: { position: true },
    });
    const position = (maxPos._max.position ?? -1) + 1;

    const title = overrides?.title ?? template.title;

    const task = await tx.task.create({
      data: {
        projectId,
        statusId,
        title,
        // Sanitize again on copy: templates stored before sanitizing was added
        // may still hold unfiltered HTML.
        description: sanitizeDescription(template.description),
        priority: template.priority,
        position,
        dueDate,
        assignees: assigneeIds.length
          ? { createMany: { data: assigneeIds.map((userId) => ({ userId })) } }
          : undefined,
        labels: labelIds.length
          ? { createMany: { data: labelIds.map((labelId) => ({ labelId })) } }
          : undefined,
      },
      include: {
        assignees: {
          include: {
            user: {
              select: { id: true, displayName: true, avatarUrl: true },
            },
          },
        },
        labels: { include: { label: true } },
        status: true,
      },
    });

    // Create subtasks from template
    const subtasks = template.subtasks as Array<{ title: string }>;
    if (subtasks.length > 0) {
      await tx.subtask.createMany({
        data: subtasks.map((s, i) => ({
          taskId: task.id,
          title: s.title,
          position: i,
        })),
      });
    }

    if (actorId) {
      await logActivity(tx, {
        taskId: task.id,
        actorId,
        action: "created",
        details: { fromTemplate: templateId },
      });
    }

    return task;
  });
}
