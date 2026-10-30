import type { CustomField, PrismaClient, Prisma } from "@prisma/client";
import { assertTaskEdit } from "../../utils/project-access.js";
import {
  checkCustomFieldValue,
  customFieldOptionValues,
  isSelectFieldType,
  type CreateCustomFieldInput,
  type UpdateCustomFieldInput,
  type ReorderCustomFieldsInput,
  type SetCustomFieldValueInput,
} from "@pm/shared";
import { ConflictError, NotFoundError, ValidationError } from "../../utils/errors.js";
import { migrateOptionValue, optionTargets } from "./custom-field-options.js";

// Lock order for custom-field writes, after the Project row (FOR KEY SHARE,
// first as in utils/task-references.ts):
//   - a value write holds its CustomField row FOR SHARE while it checks and
//     stores the value, so concurrent value writes do not wait for each other;
//   - a definition change holds the row FOR NO KEY UPDATE, then the tasks that
//     have a value for the field (FOR KEY SHARE, by id), then rewrites values.
// A value write therefore sees the options committed when it runs, and an
// options edit sees, and migrates, every value committed before it. Locking the
// tasks before reading the values keeps a concurrent task deletion from
// deadlocking with the activity entries the migration writes.

const CHUNK = 1000;

function chunks<T>(items: readonly T[]): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < items.length; i += CHUNK) result.push(items.slice(i, i + CHUNK));
  return result;
}

async function lockProject(tx: Prisma.TransactionClient, projectId: string) {
  await tx.$queryRaw`SELECT id FROM "Project" WHERE id = ${projectId} FOR KEY SHARE`;
}

function isUniqueViolation(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: string }).code === "P2002"
  );
}

export async function listCustomFields(
  prisma: PrismaClient,
  projectId: string,
) {
  return prisma.customField.findMany({
    where: { projectId },
    orderBy: { position: "asc" },
    include: { _count: { select: { values: true } } },
  });
}

export async function createCustomField(
  prisma: PrismaClient,
  projectId: string,
  data: CreateCustomFieldInput,
) {
  // SELECT/MULTI_SELECT must have options
  if (
    (data.type === "SELECT" || data.type === "MULTI_SELECT") &&
    (!data.options || data.options.length === 0)
  ) {
    const message = "SELECT and MULTI_SELECT fields require at least one option";
    throw new ValidationError(message, [{ field: "options", message }]);
  }

  // Compute next position
  const maxPos = await prisma.customField.aggregate({
    where: { projectId },
    _max: { position: true },
  });
  const position = (maxPos._max.position ?? -1) + 1;

  try {
    return await prisma.customField.create({
      data: {
        projectId,
        name: data.name,
        type: data.type,
        options: isSelectFieldType(data.type)
          ? (data.options as Prisma.InputJsonValue)
          : undefined,
        required: data.required,
        position,
      },
    });
  } catch (error: unknown) {
    if (isUniqueViolation(error)) {
      throw new ConflictError("A custom field with this name already exists in the project");
    }
    throw error;
  }
}

export interface CustomFieldUpdateResult {
  field: CustomField;
  /** Stored values moved to a renamed option, or that lost a removed option but kept others. */
  migratedValues: number;
  /** Stored values deleted because none of their options remain. */
  clearedValues: number;
}

export async function updateCustomField(
  prisma: PrismaClient,
  projectId: string,
  fieldId: string,
  data: UpdateCustomFieldInput,
  actorId: string,
): Promise<CustomFieldUpdateResult> {
  try {
    return await prisma.$transaction(
      async (tx) => {
        await lockProject(tx, projectId);
        const locked = await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM "CustomField" WHERE id = ${fieldId} AND "projectId" = ${projectId} FOR NO KEY UPDATE`;
        if (locked.length === 0) {
          throw new NotFoundError("Custom field not found");
        }
        const field = await tx.customField.findUniqueOrThrow({ where: { id: fieldId } });

        if (data.type !== undefined && data.type !== field.type) {
          const message = "The type of a custom field cannot be changed; create a new field instead";
          throw new ValidationError(message, [{ field: "type", message }]);
        }
        if (data.options !== undefined && !isSelectFieldType(field.type)) {
          const message = "Only SELECT and MULTI_SELECT fields have options";
          throw new ValidationError(message, [{ field: "options", message }]);
        }
        const currentOptions = customFieldOptionValues(field.options);
        const currentOptionSet = new Set(currentOptions);
        data.renameOptions?.forEach((rename, index) => {
          if (!currentOptionSet.has(rename.from)) {
            const message = "A renamed option must be one of the field's current options";
            throw new ValidationError(message, [{ field: `renameOptions.${index}.from`, message }]);
          }
        });

        // Check name uniqueness if name is being changed
        if (data.name && data.name !== field.name) {
          const existing = await tx.customField.findUnique({
            where: { projectId_name: { projectId, name: data.name } },
          });
          if (existing) {
            throw new ConflictError("A custom field with this name already exists in the project");
          }
        }

        const updated = await tx.customField.update({
          where: { id: fieldId },
          data: {
            name: data.name,
            options: data.options as Prisma.InputJsonValue | undefined,
            required: data.required,
          },
        });
        if (data.options === undefined) {
          return { field: updated, migratedValues: 0, clearedValues: 0 };
        }

        // Value writes for this field wait for the field lock; lock the tasks
        // that hold values before reading them (see the lock order above).
        await tx.$queryRaw`
          SELECT t.id FROM "Task" t
          WHERE t.id IN (SELECT v."taskId" FROM "CustomFieldValue" v WHERE v."fieldId" = ${fieldId})
          ORDER BY t.id
          FOR KEY SHARE`;
        const rows = await tx.customFieldValue.findMany({
          where: { fieldId },
          select: { id: true, taskId: true, value: true },
          orderBy: { id: "asc" },
        });

        // Only values naming an option this edit renamed or removed change.
        const targets = optionTargets(currentOptions, data.options, data.renameOptions);
        const cleared: string[] = [];
        const updates = new Map<string, { value: Prisma.InputJsonValue; ids: string[] }>();
        const activity: Prisma.ActivityLogCreateManyInput[] = [];
        for (const row of rows) {
          const change = migrateOptionValue(field.type, row.value, targets);
          if (change.action === "keep") continue;
          if (change.action === "clear") {
            cleared.push(row.id);
          } else {
            const key = JSON.stringify(change.value);
            const value = change.value as Prisma.InputJsonValue;
            const group = updates.get(key) ?? { value, ids: [] };
            group.ids.push(row.id);
            updates.set(key, group);
          }
          activity.push({
            taskId: row.taskId,
            actorId,
            action: "custom_field_changed",
            // The previous value keeps a rename or removal recoverable.
            details: {
              fieldId,
              value: change.action === "clear" ? null : (change.value as Prisma.InputJsonValue),
              previousValue: row.value as Prisma.InputJsonValue,
              reason: change.reason,
            },
          });
        }

        for (const ids of chunks(cleared)) {
          await tx.customFieldValue.deleteMany({ where: { id: { in: ids } } });
        }
        let migratedValues = 0;
        for (const group of updates.values()) {
          for (const ids of chunks(group.ids)) {
            await tx.customFieldValue.updateMany({
              where: { id: { in: ids } },
              data: { value: group.value },
            });
          }
          migratedValues += group.ids.length;
        }
        for (const entries of chunks(activity)) {
          await tx.activityLog.createMany({ data: entries });
        }

        return { field: updated, migratedValues, clearedValues: cleared.length };
      },
      // A large field rewrites many values; value writes waiting on it give up
      // with a retryable 409 at their own, shorter timeout.
      { timeout: 60_000 },
    );
  } catch (error: unknown) {
    if (isUniqueViolation(error)) {
      throw new ConflictError("A custom field with this name already exists in the project");
    }
    throw error;
  }
}

export async function deleteCustomField(
  prisma: PrismaClient,
  projectId: string,
  fieldId: string,
) {
  const field = await prisma.customField.findFirst({
    where: { id: fieldId, projectId },
  });
  if (!field) {
    throw new NotFoundError("Custom field not found");
  }

  await prisma.customField.delete({ where: { id: fieldId } });
}

export async function reorderCustomFields(
  prisma: PrismaClient,
  projectId: string,
  data: ReorderCustomFieldsInput,
) {
  return prisma.$transaction(async (tx) => {
    const fields = await tx.customField.findMany({
      where: { projectId },
      select: { id: true },
    });
    const validIds = new Set(fields.map((f) => f.id));

    for (const id of data.orderedIds) {
      if (!validIds.has(id)) {
        throw new NotFoundError(`Custom field ${id} not found in project`);
      }
    }

    const updates = data.orderedIds.map((id, index) =>
      tx.customField.update({
        where: { id },
        data: { position: index },
      }),
    );
    await Promise.all(updates);

    return tx.customField.findMany({
      where: { projectId },
      orderBy: { position: "asc" },
    });
  });
}

export async function setFieldValue(
  prisma: PrismaClient,
  projectId: string,
  taskId: string,
  fieldId: string,
  data: SetCustomFieldValueInput,
  actorId: string,
) {
  // Bind both resources to the project authorized by the route. Independent
  // foreign keys alone do not prevent cross-project or cross-workspace writes.
  const [task, field] = await Promise.all([
    prisma.task.findFirst({
      where: { id: taskId, projectId },
      select: { id: true },
    }),
    prisma.customField.findFirst({
      where: { id: fieldId, projectId },
      select: { id: true },
    }),
  ]);
  if (!task) {
    throw new NotFoundError("Task not found in this project");
  }
  if (!field) {
    throw new NotFoundError("Custom field not found in this project");
  }

  await assertTaskEdit(prisma, taskId, actorId);

  return prisma.$transaction(async (tx) => {
    // Check the value against the definition as committed now, and keep it
    // until this write commits (see the lock order above).
    await lockProject(tx, projectId);
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM "CustomField" WHERE id = ${fieldId} AND "projectId" = ${projectId} FOR SHARE`;
    if (locked.length === 0) {
      throw new NotFoundError("Custom field not found in this project");
    }
    const definition = await tx.customField.findUniqueOrThrow({ where: { id: fieldId } });

    const checked = checkCustomFieldValue(definition, data.value);
    if (!checked.ok) {
      throw new ValidationError(checked.message, [{ field: "value", message: checked.message }]);
    }

    // Empty values are not stored: null, blank text and [] delete the record.
    if (checked.value === null) {
      await tx.customFieldValue.deleteMany({
        where: { taskId, fieldId },
      });
      return null;
    }

    return tx.customFieldValue.upsert({
      where: { taskId_fieldId: { taskId, fieldId } },
      create: {
        taskId,
        fieldId,
        value: checked.value,
      },
      update: {
        value: checked.value,
      },
      include: { field: true },
    });
  });
}
