import { Prisma } from "@prisma/client";
import { ValidationError } from "./errors.js";

// Foreign keys only prove that a referenced row exists somewhere. These helpers
// resolve every supplied reference inside the task's own project before writing,
// and reject missing, foreign and duplicate IDs with one indistinguishable error.
//
// Inside a transaction they also lock what they resolved until commit, so the
// check still holds when the write commits (the full lock map and the cycles
// that remain are in docs/remediation/dat-005.md):
//   - the Project row FOR KEY SHARE, always first. Project deletion locks it
//     before cascading to columns, labels, members and tasks, so it waits for
//     the write rather than meeting it halfway;
//   - explicitly supplied columns and labels FOR KEY SHARE. A column or label
//     delete locks its own row first, so it either waits for the write (and
//     then moves or detaches the new task) or commits first and the write is
//     refused like any other missing reference;
//   - each assignee's WorkspaceMember, then ProjectMember row FOR SHARE.
//     Project and workspace removal (after the Workspace lock) delete those
//     rows, and a role change updates them, so a revocation either waits for
//     the assignment and then clears it, or commits first and the assignment
//     is refused.
// The column, member and label locks are all shared; writers take them in
// different orders (duplication and template instantiation resolve labels
// before members). That cannot deadlock with the deletes and removals above:
// a column or label delete holds only its own row, and removals take
// WorkspaceMember before ProjectMember as writers do. Workspace deletion is
// the known exception: its cascade deletes WorkspaceMember rows before the
// projects, the reverse of a writer, and PostgreSQL resolves that cycle by
// aborting one side, which the API reports as a retryable 409.
// The recurring-task scheduler (schedulers/recurring-tasks.ts) runs template
// instantiation inside its own transaction: it takes the Project row KEY SHARE,
// then its schedule row FOR UPDATE SKIP LOCKED, then the locks above, so it
// follows the same Project-first order.
// Not locked here: a template's stored column, a duplicated task's column and
// the default first column are plain reads, held only by the insert's own
// foreign-key check, so a column delete racing those still gets the generic
// 409. A lock taken outside a transaction would end with its statement, so
// callers that pass the root client (template editing, listings) get plain
// reads.

type Db = Prisma.TransactionClient;

/** Interactive transaction clients do not expose $transaction. */
function inTransaction(db: Db) {
  return typeof (db as { $transaction?: unknown }).$transaction !== "function";
}

function lockClause(db: Db, clause: Prisma.Sql) {
  return inTransaction(db) ? clause : Prisma.empty;
}

async function lockProject(db: Db, projectId: string) {
  if (!inTransaction(db)) return;
  await db.$queryRaw`SELECT id FROM "Project" WHERE id = ${projectId} FOR KEY SHARE`;
}

export function assertUniqueIds(ids: readonly string[], kind: string) {
  if (new Set(ids).size !== ids.length) {
    throw new ValidationError(`Duplicate ${kind} IDs are not allowed`);
  }
}

/**
 * The given columns that exist in the project, locked FOR KEY SHARE (after the
 * Project row) when called in a transaction. A task move takes its source and
 * destination columns this way before renumbering any task, so a column delete
 * waits for the move instead of meeting its task rows in the opposite order.
 */
export async function lockProjectStatuses(db: Db, projectId: string, statusIds: readonly string[]) {
  const unique = [...new Set(statusIds)];
  if (unique.length === 0) return new Set<string>();
  await lockProject(db, projectId);
  const rows = await db.$queryRaw<{ id: string }[]>`
    SELECT id FROM "StatusColumn"
    WHERE "projectId" = ${projectId} AND id IN (${Prisma.join(unique)})
    ORDER BY id
    ${lockClause(db, Prisma.sql`FOR KEY SHARE`)}
  `;
  return new Set(rows.map((r) => r.id));
}

export async function assertProjectStatus(db: Db, projectId: string, statusId: string) {
  const found = await lockProjectStatuses(db, projectId, [statusId]);
  if (!found.has(statusId)) throw new ValidationError("Status column not found in this project");
}

export async function assertProjectLabels(db: Db, projectId: string, labelIds: readonly string[]) {
  assertUniqueIds(labelIds, "label");
  if (labelIds.length === 0) return;
  const found = await projectLabelIds(db, projectId, labelIds);
  if (found.length !== labelIds.length) throw new ValidationError("Labels must belong to this project");
}

/** Assignees must be current workspace members who can open the project. */
export async function assertProjectAssignees(db: Db, projectId: string, userIds: readonly string[]) {
  assertUniqueIds(userIds, "assignee");
  if (userIds.length === 0) return;
  const allowed = await projectAssigneeIds(db, projectId, userIds);
  if (allowed.length !== userIds.length) {
    throw new ValidationError("Assignees must be workspace members with access to this project");
  }
}

/** Keep stored (possibly stale) references that are still valid, dropping the rest. */
export async function projectLabelIds(db: Db, projectId: string, labelIds: readonly string[]) {
  const unique = [...new Set(labelIds)];
  if (unique.length === 0) return [];
  await lockProject(db, projectId);
  const labels = await db.$queryRaw<{ id: string }[]>`
    SELECT id FROM "Label"
    WHERE "projectId" = ${projectId} AND id IN (${Prisma.join(unique)})
    ORDER BY id
    ${lockClause(db, Prisma.sql`FOR KEY SHARE`)}
  `;
  const valid = new Set(labels.map((l) => l.id));
  return unique.filter((id) => valid.has(id));
}

/**
 * The users among `userIds` who can open the project: current workspace
 * members who are workspace ADMINs or project members, the same rule as
 * filterProjectRecipients. In a transaction their membership rows stay locked
 * FOR SHARE until commit (see the note at the top of this file).
 */
export async function projectAssigneeIds(db: Db, projectId: string, userIds: readonly string[]) {
  const unique = [...new Set(userIds)];
  if (unique.length === 0) return [];
  await lockProject(db, projectId);
  const workspaceMembers = await db.$queryRaw<{ userId: string; role: string }[]>`
    SELECT wm."userId", wm.role::text AS role
    FROM "WorkspaceMember" wm
    JOIN "Project" p ON p."workspaceId" = wm."workspaceId"
    WHERE p.id = ${projectId} AND wm."userId" IN (${Prisma.join(unique)})
    ORDER BY wm."userId"
    ${lockClause(db, Prisma.sql`FOR SHARE OF wm`)}
  `;
  if (workspaceMembers.length === 0) return [];
  const projectMembers = await db.$queryRaw<{ userId: string }[]>`
    SELECT "userId" FROM "ProjectMember"
    WHERE "projectId" = ${projectId}
      AND "userId" IN (${Prisma.join(workspaceMembers.map((m) => m.userId))})
    ORDER BY "userId"
    ${lockClause(db, Prisma.sql`FOR SHARE`)}
  `;
  const joined = new Set(projectMembers.map((m) => m.userId));
  const valid = new Set(
    workspaceMembers.filter((m) => m.role === "ADMIN" || joined.has(m.userId)).map((m) => m.userId),
  );
  return unique.filter((id) => valid.has(id));
}

/**
 * Clears a user's task and subtask assignments in one project or in every
 * project of a workspace, for a removal that has already deleted the user's
 * membership rows (so no new assignment can start). The rows are locked in
 * task id and subtask id order first (byte order, as JavaScript sorts): bulk
 * updates rewrite assignees task by task and subtask reordering updates
 * subtasks in that same order, so a removal and such a writer queue behind
 * each other instead of deadlocking.
 */
export async function clearAssignments(
  tx: Db,
  userId: string,
  scope: { projectId: string } | { workspaceId: string },
) {
  const inScope =
    "projectId" in scope
      ? Prisma.sql`t."projectId" = ${scope.projectId}`
      : Prisma.sql`t."projectId" IN (SELECT id FROM "Project" WHERE "workspaceId" = ${scope.workspaceId})`;
  const task: Prisma.TaskWhereInput =
    "projectId" in scope ? { projectId: scope.projectId } : { project: { workspaceId: scope.workspaceId } };

  await tx.$queryRaw`
    SELECT ta.id FROM "TaskAssignee" ta JOIN "Task" t ON t.id = ta."taskId"
    WHERE ta."userId" = ${userId} AND ${inScope}
    ORDER BY ta."taskId" COLLATE "C"
    FOR UPDATE OF ta
  `;
  await tx.taskAssignee.deleteMany({ where: { userId, task } });

  await tx.$queryRaw`
    SELECT s.id FROM "Subtask" s JOIN "Task" t ON t.id = s."taskId"
    WHERE s."assigneeId" = ${userId} AND ${inScope}
    ORDER BY s.id COLLATE "C"
    FOR UPDATE OF s
  `;
  await tx.subtask.updateMany({ where: { assigneeId: userId, task }, data: { assigneeId: null } });
}
