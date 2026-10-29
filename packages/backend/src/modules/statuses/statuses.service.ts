import type { PrismaClient } from "@prisma/client";
import type {
  CreateStatusColumnInput,
  UpdateStatusColumnInput,
  ReorderInput,
} from "@pm/shared";
import { ConflictError, NotFoundError } from "../../utils/errors.js";

export async function listStatuses(
  prisma: PrismaClient,
  projectId: string,
) {
  return prisma.statusColumn.findMany({
    where: { projectId },
    orderBy: { position: "asc" },
  });
}

export async function createStatus(
  prisma: PrismaClient,
  projectId: string,
  data: CreateStatusColumnInput,
) {
  return prisma.$transaction(async (tx) => {
    // Get max position
    const maxPos = await tx.statusColumn.aggregate({
      where: { projectId },
      _max: { position: true },
    });
    const position = (maxPos._max.position ?? -1) + 1;

    // If isCompletion, unset existing completion column
    if (data.isCompletion) {
      await tx.statusColumn.updateMany({
        where: { projectId, isCompletion: true },
        data: { isCompletion: false },
      });
    }

    return tx.statusColumn.create({
      data: {
        projectId,
        name: data.name,
        color: data.color,
        position,
        isCompletion: data.isCompletion,
      },
    });
  });
}

export async function updateStatus(
  prisma: PrismaClient,
  projectId: string,
  statusId: string,
  data: UpdateStatusColumnInput,
) {
  const status = await prisma.statusColumn.findFirst({
    where: { id: statusId, projectId },
  });
  if (!status) {
    throw new NotFoundError("Status column not found");
  }

  return prisma.$transaction(async (tx) => {
    // If setting isCompletion to true, unset existing
    if (data.isCompletion === true) {
      await tx.statusColumn.updateMany({
        where: { projectId, isCompletion: true, id: { not: statusId } },
        data: { isCompletion: false },
      });
    }

    return tx.statusColumn.update({
      where: { id: statusId },
      data: {
        name: data.name,
        color: data.color,
        isCompletion: data.isCompletion,
      },
    });
  });
}

export async function deleteStatus(
  prisma: PrismaClient,
  projectId: string,
  statusId: string,
) {
  return prisma.$transaction(async (tx) => {
    // Lock the column before moving its tasks. A task write that already
    // validated this column holds it FOR KEY SHARE (task-references.ts), so the
    // delete waits for it and then moves its task too; a write that starts
    // later waits here and is refused once the column is gone.
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM "StatusColumn" WHERE id = ${statusId} AND "projectId" = ${projectId} FOR UPDATE
    `;
    const status = locked.length
      ? await tx.statusColumn.findUnique({ where: { id: statusId } })
      : null;
    if (!status) {
      throw new NotFoundError("Status column not found");
    }

    // Cannot delete the last column
    const count = await tx.statusColumn.count({ where: { projectId } });
    if (count <= 1) {
      throw new ConflictError("Cannot delete the last status column");
    }

    // Find the lowest-position remaining column to move tasks to
    const targetColumn = await tx.statusColumn.findFirst({
      where: { projectId, id: { not: statusId } },
      orderBy: { position: "asc" },
    });

    // Move this project's tasks to the target column. A legacy task from
    // another project that still points here must be repaired, not relinked.
    await tx.task.updateMany({
      where: { statusId, projectId },
      data: { statusId: targetColumn!.id },
    });
    if (await tx.task.count({ where: { statusId } })) {
      throw new ConflictError(
        "Status column is still referenced by tasks in another project; repair those tasks first",
      );
    }

    // If deleting the completion column, reassign to highest-position remaining
    if (status.isCompletion) {
      const highestRemaining = await tx.statusColumn.findFirst({
        where: { projectId, id: { not: statusId } },
        orderBy: { position: "desc" },
      });
      if (highestRemaining) {
        await tx.statusColumn.update({
          where: { id: highestRemaining.id },
          data: { isCompletion: true },
        });
      }
    }

    await tx.statusColumn.delete({ where: { id: statusId } });
  });
}

export async function reorderStatuses(
  prisma: PrismaClient,
  projectId: string,
  data: ReorderInput,
) {
  return prisma.$transaction(async (tx) => {
    // Validate all IDs belong to this project
    const statuses = await tx.statusColumn.findMany({
      where: { projectId },
      select: { id: true },
    });
    const validIds = new Set(statuses.map((s) => s.id));

    for (const id of data.orderedIds) {
      if (!validIds.has(id)) {
        throw new NotFoundError(`Status column ${id} not found in project`);
      }
    }

    // Update positions
    const updates = data.orderedIds.map((id, index) =>
      tx.statusColumn.update({
        where: { id },
        data: { position: index },
      }),
    );
    await Promise.all(updates);

    return tx.statusColumn.findMany({
      where: { projectId },
      orderBy: { position: "asc" },
    });
  });
}
