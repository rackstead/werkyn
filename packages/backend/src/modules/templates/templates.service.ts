import type { PrismaClient, Prisma, TaskTemplate } from "@prisma/client";
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
import { nextTaskPosition, withProjectOrder } from "../../utils/task-order.js";

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

/**
 * Stored references can go stale (deleted columns or labels, departed members)
 * or predate validation. Those are no longer part of the template: responses and
 * instantiation only carry references valid in the project today, so an editor
 * round trip never resubmits an ID that writes now reject.
 */
async function scopeTemplateReferences(
  prisma: Prisma.TransactionClient,
  projectId: string,
  templates: TaskTemplate[],
): Promise<TaskTemplate[]> {
  if (templates.length === 0) return templates;
  const statusIds = [...new Set(templates.flatMap((t) => (t.statusId ? [t.statusId] : [])))];
  const [statuses, labelIds, assigneeIds] = await Promise.all([
    statusIds.length
      ? prisma.statusColumn.findMany({ where: { projectId, id: { in: statusIds } }, select: { id: true } })
      : [],
    projectLabelIds(prisma, projectId, templates.flatMap((t) => storedIds(t.labelIds))),
    projectAssigneeIds(prisma, projectId, templates.flatMap((t) => storedIds(t.assigneeIds))),
  ]);
  const validStatuses = new Set(statuses.map((s) => s.id));
  const validLabels = new Set(labelIds);
  const validAssignees = new Set(assigneeIds);
  return templates.map((t) => ({
    ...t,
    statusId: t.statusId && validStatuses.has(t.statusId) ? t.statusId : null,
    labelIds: [...new Set(storedIds(t.labelIds))].filter((id) => validLabels.has(id)),
    assigneeIds: [...new Set(storedIds(t.assigneeIds))].filter((id) => validAssignees.has(id)),
  }));
}

async function scopeTemplate(prisma: Prisma.TransactionClient, projectId: string, template: TaskTemplate) {
  const [scoped] = await scopeTemplateReferences(prisma, projectId, [template]);
  return scoped;
}

export async function listTemplates(prisma: PrismaClient, projectId: string) {
  const templates = await prisma.taskTemplate.findMany({
    where: { projectId },
    orderBy: { name: "asc" },
  });
  return scopeTemplateReferences(prisma, projectId, templates);
}

export async function getTemplate(prisma: PrismaClient, projectId: string, templateId: string) {
  const template = await prisma.taskTemplate.findFirst({
    where: { id: templateId, projectId },
  });
  if (!template) throw new NotFoundError("Template not found");
  return scopeTemplate(prisma, projectId, template);
}

export async function createTemplate(
  prisma: PrismaClient,
  projectId: string,
  data: CreateTemplateInput,
) {
  await assertTemplateReferences(prisma, projectId, data);
  const template = await prisma.taskTemplate.create({
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
  return scopeTemplate(prisma, projectId, template);
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

  const template = await prisma.taskTemplate.update({
    where: { id: templateId, projectId },
    data: updateData,
  });
  return scopeTemplate(prisma, projectId, template);
}

export async function deleteTemplate(prisma: PrismaClient, projectId: string, templateId: string) {
  const existing = await prisma.taskTemplate.findFirst({ where: { id: templateId, projectId } });
  if (!existing) throw new NotFoundError("Template not found");
  await prisma.taskTemplate.delete({ where: { id: templateId, projectId } });
}

/**
 * The date `days` after a calendar date (YYYY-MM-DD), or after today (UTC)
 * when no date is given.
 */
function addDaysUTC(date: string | undefined, days: number): string {
  let d = new Date();
  if (date) {
    const [y, m, day] = date.split("-").map(Number);
    d = new Date(Date.UTC(y, m - 1, day));
  }
  d.setUTCDate(d.getUTCDate() + days);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Creates a task from a template. Pass a transaction client to create it
 * inside the caller's transaction (the recurring scheduler does, so the task
 * and its occurrence record commit together). `dueOffsetFrom` is the date the
 * template's dueOffset counts from, defaulting to today; a recurring schedule
 * passes the occurrence date, so a late-generated occurrence keeps its own due
 * date.
 */
export async function createTaskFromTemplate(
  prisma: PrismaClient | Prisma.TransactionClient,
  projectId: string,
  templateId: string,
  actorId: string | null,
  actorRole: string,
  overrides?: InstantiateTemplateInput,
  dueOffsetFrom?: string,
) {
  const template = await prisma.taskTemplate.findFirst({
    where: { id: templateId, projectId },
  });
  if (!template) throw new NotFoundError("Template not found");

  // Under the project's order lock, taken in a new transaction or in the
  // caller's, so the position chosen below stays last in its column until the
  // task commits (utils/task-order.ts).
  return withProjectOrder(prisma, projectId, async (tx, project) => {
    if (project.archived) {
      throw new ValidationError("Cannot create tasks in an archived project");
    }

    // Explicit overrides are validated like any other write; stored values are
    // copied only while still valid in this project.
    const stored = await scopeTemplate(tx, projectId, template);
    if (overrides?.statusId) await assertProjectStatus(tx, projectId, overrides.statusId);
    if (overrides?.assigneeIds) await assertProjectAssignees(tx, projectId, overrides.assigneeIds);
    let assigneeIds = overrides?.assigneeIds ?? (stored.assigneeIds as string[]);

    // Auto-include actor for MEMBER role, checked and locked like any other
    // assignee so a concurrent removal cannot leave them assigned without access
    if (actorId && actorRole === "MEMBER" && !assigneeIds.includes(actorId)) {
      await assertProjectAssignees(tx, projectId, [actorId]);
      assigneeIds = [actorId, ...assigneeIds];
    }

    const labelIds = stored.labelIds as string[];

    // Resolve statusId: override > template > first column
    let statusId = overrides?.statusId ?? stored.statusId;
    if (!statusId) {
      const firstColumn = await tx.statusColumn.findFirst({
        where: { projectId },
        orderBy: [{ position: "asc" }, { id: "asc" }],
      });
      if (!firstColumn) throw new ValidationError("Project has no status columns");
      statusId = firstColumn.id;
    }

    // Calculate dueDate from dueOffset
    let dueDate = overrides?.dueDate;
    if (!dueDate && template.dueOffset !== null) {
      dueDate = addDaysUTC(dueOffsetFrom, template.dueOffset);
    }

    const position = await nextTaskPosition(tx, projectId, statusId);

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
