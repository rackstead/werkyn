import { Prisma } from "@prisma/client";
import { ValidationError } from "./errors.js";

// Foreign keys only prove that a referenced row exists somewhere. These helpers
// resolve every supplied reference inside the task's own project before writing,
// and reject missing, foreign and duplicate IDs with one indistinguishable error.
//
// Inside a writer's transaction they also lock what they resolved until commit,
// so the check holds for the write:
//   - status and label rows FOR KEY SHARE: a column or label delete waits for
//     the write (and then moves or detaches its task), or commits first and the
//     write sees the row gone and is refused;
//   - each assignee's WorkspaceMember and ProjectMember rows FOR SHARE: project
//     removal and workspace removal delete those rows and a role change updates
//     them, so a revocation either waits for the assignment (and then removes
//     it) or commits first and the assignment is refused.
// Each helper first takes the Project row FOR KEY SHARE (the lock the task
// insert takes anyway). A project deletion locks that row before cascading to
// its columns, labels and members, so it either waits for the write or
// finishes before the write has locked anything else; without this the two
// could deadlock.
// Writers validate before their first write and take only these row locks,
// never the Workspace lock: Project, then its column, member and label rows,
// then their own task rows. Membership changes take the Workspace lock first
// and then member rows; column and label deletes lock their own row first.
// No path takes these locks in the opposite order.
// A lock taken outside a transaction would end with its statement, so callers
// that pass the root client (template editing, listings) get plain reads.

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

export async function assertProjectStatus(db: Db, projectId: string, statusId: string) {
  await lockProject(db, projectId);
  const rows = await db.$queryRaw<{ id: string }[]>`
    SELECT id FROM "StatusColumn"
    WHERE id = ${statusId} AND "projectId" = ${projectId}
    ${lockClause(db, Prisma.sql`FOR KEY SHARE`)}
  `;
  if (rows.length === 0) throw new ValidationError("Status column not found in this project");
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
