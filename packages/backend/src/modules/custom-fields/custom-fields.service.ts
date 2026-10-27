import type { PrismaClient, Prisma } from "@prisma/client";
import type {
  CreateCustomFieldInput,
  UpdateCustomFieldInput,
  ReorderCustomFieldsInput,
  SetCustomFieldValueInput,
} from "@pm/shared";
import { ConflictError, NotFoundError, ValidationError } from "../../utils/errors.js";

type PrismaTransactionClient = Omit<
  PrismaClient,
  "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends"
>;

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
    throw new ValidationError("SELECT and MULTI_SELECT fields require at least one option");
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
        options: data.options as Prisma.InputJsonValue | undefined,
        required: data.required,
        position,
      },
    });
  } catch (error: unknown) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code: string }).code === "P2002"
    ) {
      throw new ConflictError("A custom field with this name already exists in the project");
    }
    throw error;
  }
}

export async function updateCustomField(
  prisma: PrismaClient,
  projectId: string,
  fieldId: string,
  data: UpdateCustomFieldInput,
) {
  const field = await prisma.customField.findFirst({
    where: { id: fieldId, projectId },
  });
  if (!field) {
    throw new NotFoundError("Custom field not found");
  }

  // Check name uniqueness if name is being changed
  if (data.name && data.name !== field.name) {
    const existing = await prisma.customField.findUnique({
      where: { projectId_name: { projectId, name: data.name } },
    });
    if (existing) {
      throw new ConflictError("A custom field with this name already exists in the project");
    }
  }

  return prisma.customField.update({
    where: { id: fieldId },
    data: {
      name: data.name,
      options: data.options as Prisma.InputJsonValue | undefined,
      required: data.required,
    },
  });
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
    }),
  ]);
  if (!task) {
    throw new NotFoundError("Task not found in this project");
  }
  if (!field) {
    throw new NotFoundError("Custom field not found in this project");
  }

  // Validate value type matches field type
  if (data.value !== null) {
    validateValueType(field.type, data.value);
  }

  // If value is null, delete the record
  if (data.value === null) {
    await prisma.customFieldValue.deleteMany({
      where: { taskId, fieldId },
    });
    return null;
  }

  // Upsert the value
  return prisma.customFieldValue.upsert({
    where: { taskId_fieldId: { taskId, fieldId } },
    create: {
      taskId,
      fieldId,
      value: data.value as Prisma.InputJsonValue,
    },
    update: {
      value: data.value as Prisma.InputJsonValue,
    },
    include: { field: true },
  });
}

function validateValueType(
  fieldType: string,
  value: string | number | boolean | string[],
) {
  switch (fieldType) {
    case "TEXT":
    case "URL":
    case "DATE":
      if (typeof value !== "string") {
        throw new ValidationError(`${fieldType} field expects a string value`);
      }
      break;
    case "NUMBER":
      if (typeof value !== "number") {
        throw new ValidationError("NUMBER field expects a numeric value");
      }
      break;
    case "CHECKBOX":
      if (typeof value !== "boolean") {
        throw new ValidationError("CHECKBOX field expects a boolean value");
      }
      break;
    case "SELECT":
      if (typeof value !== "string") {
        throw new ValidationError("SELECT field expects a string value");
      }
      break;
    case "MULTI_SELECT":
      if (!Array.isArray(value)) {
        throw new ValidationError("MULTI_SELECT field expects an array of strings");
      }
      break;
  }
}
