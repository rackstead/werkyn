import type { Prisma } from "@prisma/client";
import { ValidationError } from "./errors.js";
import { filterProjectRecipients } from "./project-access.js";

// Foreign keys only prove that a referenced row exists somewhere. These helpers
// resolve every supplied reference inside the task's own project before writing,
// and reject missing, foreign and duplicate IDs with one indistinguishable error.

type Db = Prisma.TransactionClient;

export function assertUniqueIds(ids: readonly string[], kind: string) {
  if (new Set(ids).size !== ids.length) {
    throw new ValidationError(`Duplicate ${kind} IDs are not allowed`);
  }
}

export async function assertProjectStatus(db: Db, projectId: string, statusId: string) {
  const status = await db.statusColumn.findFirst({
    where: { id: statusId, projectId },
    select: { id: true },
  });
  if (!status) throw new ValidationError("Status column not found in this project");
}

export async function assertProjectLabels(db: Db, projectId: string, labelIds: readonly string[]) {
  assertUniqueIds(labelIds, "label");
  if (labelIds.length === 0) return;
  const found = await db.label.count({ where: { projectId, id: { in: [...labelIds] } } });
  if (found !== labelIds.length) throw new ValidationError("Labels must belong to this project");
}

/** Assignees must be current workspace members who can open the project. */
export async function assertProjectAssignees(db: Db, projectId: string, userIds: readonly string[]) {
  assertUniqueIds(userIds, "assignee");
  if (userIds.length === 0) return;
  const allowed = await filterProjectRecipients(db, projectId, [...userIds]);
  if (allowed.length !== userIds.length) {
    throw new ValidationError("Assignees must be workspace members with access to this project");
  }
}

/** Keep stored (possibly stale) references that are still valid, dropping the rest. */
export async function projectLabelIds(db: Db, projectId: string, labelIds: readonly string[]) {
  if (labelIds.length === 0) return [];
  const labels = await db.label.findMany({
    where: { projectId, id: { in: [...new Set(labelIds)] } },
    select: { id: true },
  });
  const valid = new Set(labels.map((l) => l.id));
  return [...new Set(labelIds)].filter((id) => valid.has(id));
}

export async function projectAssigneeIds(db: Db, projectId: string, userIds: readonly string[]) {
  const unique = [...new Set(userIds)];
  const valid = new Set(await filterProjectRecipients(db, projectId, unique));
  return unique.filter((id) => valid.has(id));
}
