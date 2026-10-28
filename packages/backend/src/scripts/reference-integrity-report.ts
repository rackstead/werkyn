/**
 * Read-only report of relationships that cross a project or workspace boundary.
 *
 * Writers validate references since the DAT-005 fix, but rows stored earlier can
 * still link a task to another project's status, labels, fields or tasks, or
 * reference users outside the workspace. Run this before adding database
 * constraints, repair what it finds (see docs/remediation/dat-005.md), and run it
 * again until it is clean. It never writes: every query runs in one READ ONLY
 * transaction. Output contains IDs only, never names, titles or values.
 *
 *   DATABASE_URL=... node dist/scripts/reference-integrity-report.js [--json] [--limit=N]
 *
 * Exit status: 0 when clean, 2 when issues were found, 1 on error.
 */
import { pathToFileURL } from "node:url";
import { Prisma, PrismaClient } from "@prisma/client";

export interface IntegrityIssue {
  key: string;
  description: string;
  repair: string;
  count: number;
  samples: Record<string, string | boolean | null>[];
}

interface Check {
  key: string;
  description: string;
  repair: string;
  /** Must select an `id` column; every other column must be an ID, reason or flag. */
  query: Prisma.Sql;
}

/** Same rule the writers use: current workspace member, and ADMIN or project member. */
const hasProjectAccess = (userId: Prisma.Sql, projectId: Prisma.Sql) => Prisma.sql`
  EXISTS (
    SELECT 1 FROM "Project" ap
    JOIN "WorkspaceMember" awm ON awm."workspaceId" = ap."workspaceId" AND awm."userId" = ${userId}
    WHERE ap.id = ${projectId}
      AND (awm.role = 'ADMIN' OR EXISTS (
        SELECT 1 FROM "ProjectMember" apm WHERE apm."projectId" = ap.id AND apm."userId" = ${userId}
      ))
  )`;

const accessReason = (userId: Prisma.Sql, projectId: Prisma.Sql) => Prisma.sql`
  CASE WHEN EXISTS (
    SELECT 1 FROM "Project" rp
    JOIN "WorkspaceMember" rwm ON rwm."workspaceId" = rp."workspaceId" AND rwm."userId" = ${userId}
    WHERE rp.id = ${projectId}
  ) THEN 'no_project_access' ELSE 'not_workspace_member' END`;

const jsonIds = (column: Prisma.Sql) => Prisma.sql`
  jsonb_array_elements_text(CASE WHEN jsonb_typeof(${column}) = 'array' THEN ${column} ELSE '[]'::jsonb END)`;

const CHECKS: Check[] = [
  {
    key: "task_status_project",
    description: "Task status column belongs to another project",
    repair: "Move the task to the lowest-position status column of its own project, appended after that column's last task.",
    query: Prisma.sql`
      SELECT t.id, t."projectId", t."statusId" AS "referenceId", s."projectId" AS "referenceProjectId"
      FROM "Task" t JOIN "StatusColumn" s ON s.id = t."statusId"
      WHERE s."projectId" <> t."projectId"`,
  },
  {
    key: "task_label_project",
    description: "Task label belongs to another project",
    repair: "Delete the TaskLabel row.",
    query: Prisma.sql`
      SELECT tl.id, tl."taskId", t."projectId", tl."labelId" AS "referenceId", l."projectId" AS "referenceProjectId"
      FROM "TaskLabel" tl JOIN "Task" t ON t.id = tl."taskId" JOIN "Label" l ON l.id = tl."labelId"
      WHERE l."projectId" <> t."projectId"`,
  },
  {
    key: "custom_field_value_project",
    description: "Custom-field value uses another project's field",
    repair: "Delete the CustomFieldValue row; the value has no meaning outside its field's project.",
    query: Prisma.sql`
      SELECT v.id, v."taskId", t."projectId", v."fieldId" AS "referenceId", f."projectId" AS "referenceProjectId"
      FROM "CustomFieldValue" v JOIN "Task" t ON t.id = v."taskId" JOIN "CustomField" f ON f.id = v."fieldId"
      WHERE f."projectId" <> t."projectId"`,
  },
  {
    key: "task_dependency_project",
    description: "Task dependency links tasks in different projects, or a task to itself",
    repair: "Delete the TaskDependency row.",
    query: Prisma.sql`
      SELECT d.id, d."blockedTaskId" AS "taskId", a."projectId", d."blockingTaskId" AS "referenceId", b."projectId" AS "referenceProjectId"
      FROM "TaskDependency" d JOIN "Task" a ON a.id = d."blockedTaskId" JOIN "Task" b ON b.id = d."blockingTaskId"
      WHERE a."projectId" <> b."projectId" OR d."blockedTaskId" = d."blockingTaskId"`,
  },
  {
    key: "task_assignee_access",
    description: "Task assignee cannot access the task's project",
    repair: "not_workspace_member: delete the assignment. no_project_access: add the user to the project if the assignment is intended, otherwise delete it.",
    query: Prisma.sql`
      SELECT ta.id, ta."taskId", t."projectId", ta."userId" AS "referenceId",
        ${accessReason(Prisma.sql`ta."userId"`, Prisma.sql`t."projectId"`)} AS reason
      FROM "TaskAssignee" ta JOIN "Task" t ON t.id = ta."taskId"
      WHERE NOT ${hasProjectAccess(Prisma.sql`ta."userId"`, Prisma.sql`t."projectId"`)}`,
  },
  {
    key: "subtask_assignee_access",
    description: "Subtask assignee cannot access the task's project",
    repair: "Set Subtask.assigneeId to NULL, or add the user to the project if the assignment is intended.",
    query: Prisma.sql`
      SELECT s.id, s."taskId", t."projectId", s."assigneeId" AS "referenceId",
        ${accessReason(Prisma.sql`s."assigneeId"`, Prisma.sql`t."projectId"`)} AS reason
      FROM "Subtask" s JOIN "Task" t ON t.id = s."taskId"
      WHERE s."assigneeId" IS NOT NULL
        AND NOT ${hasProjectAccess(Prisma.sql`s."assigneeId"`, Prisma.sql`t."projectId"`)}`,
  },
  {
    key: "time_entry_workspace",
    description: "Time entry references a task or project in another workspace",
    repair: "Set the foreign taskId/projectId to NULL; the hours stay with the entry's own workspace and user.",
    query: Prisma.sql`
      SELECT e.id, e."workspaceId", e."taskId", e."projectId"
      FROM "TimeEntry" e
      LEFT JOIN "Project" p ON p.id = e."projectId"
      LEFT JOIN "Task" t ON t.id = e."taskId"
      LEFT JOIN "Project" tp ON tp.id = t."projectId"
      WHERE p."workspaceId" <> e."workspaceId" OR tp."workspaceId" <> e."workspaceId"`,
  },
  {
    key: "time_entry_task_project",
    description: "Time entry task and project disagree within the workspace",
    repair: "Set TimeEntry.projectId to the task's projectId.",
    query: Prisma.sql`
      SELECT e.id, e."taskId", e."projectId", t."projectId" AS "taskProjectId"
      FROM "TimeEntry" e
      JOIN "Task" t ON t.id = e."taskId"
      JOIN "Project" tp ON tp.id = t."projectId"
      WHERE tp."workspaceId" = e."workspaceId" AND e."projectId" IS DISTINCT FROM t."projectId"
        AND NOT EXISTS (
          SELECT 1 FROM "Project" p WHERE p.id = e."projectId" AND p."workspaceId" <> e."workspaceId"
        )`,
  },
  {
    key: "user_rate_workspace",
    description: "Rate belongs to a user who is not a current workspace member",
    repair: "hasTimeEntries=false: delete the rate (the user never logged time here). hasTimeEntries=true: keep it for historical reports of a former member.",
    query: Prisma.sql`
      SELECT r.id, r."workspaceId", r."userId" AS "referenceId",
        EXISTS (
          SELECT 1 FROM "TimeEntry" e WHERE e."workspaceId" = r."workspaceId" AND e."userId" = r."userId"
        ) AS "hasTimeEntries"
      FROM "UserRate" r
      WHERE NOT EXISTS (
        SELECT 1 FROM "WorkspaceMember" wm WHERE wm."workspaceId" = r."workspaceId" AND wm."userId" = r."userId"
      )`,
  },
  {
    key: "task_template_reference",
    description: "Task template stores a status, label or assignee that is not valid in its project",
    repair: "Instantiation already ignores these; rewrite statusId/labelIds/assigneeIds to their valid subset so the template editor matches.",
    query: Prisma.sql`
      SELECT tt.id, tt."projectId"
      FROM "TaskTemplate" tt
      WHERE (tt."statusId" IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM "StatusColumn" s WHERE s.id = tt."statusId" AND s."projectId" = tt."projectId"
        ))
        OR EXISTS (
          SELECT 1 FROM ${jsonIds(Prisma.sql`tt."labelIds"`)} AS x(id)
          WHERE NOT EXISTS (SELECT 1 FROM "Label" l WHERE l.id = x.id AND l."projectId" = tt."projectId")
        )
        OR EXISTS (
          SELECT 1 FROM ${jsonIds(Prisma.sql`tt."assigneeIds"`)} AS x(id)
          WHERE NOT ${hasProjectAccess(Prisma.sql`x.id`, Prisma.sql`tt."projectId"`)}
        )`,
  },
  {
    key: "recurring_template_project",
    description: "Recurring configuration uses a template from another project",
    repair: "Delete the RecurringTaskConfig row (or recreate it in the template's project).",
    query: Prisma.sql`
      SELECT rc.id, rc."projectId", rc."templateId" AS "referenceId", tt."projectId" AS "referenceProjectId"
      FROM "RecurringTaskConfig" rc JOIN "TaskTemplate" tt ON tt.id = rc."templateId"
      WHERE tt."projectId" <> rc."projectId"`,
  },
  {
    key: "chat_member_workspace",
    description: "Chat channel member is not a current member of the channel's workspace",
    repair: "Delete the ChatChannelMember row.",
    query: Prisma.sql`
      SELECT cm.id, cm."channelId", c."workspaceId", cm."userId" AS "referenceId"
      FROM "ChatChannelMember" cm JOIN "ChatChannel" c ON c.id = cm."channelId"
      WHERE NOT EXISTS (
        SELECT 1 FROM "WorkspaceMember" wm WHERE wm."workspaceId" = c."workspaceId" AND wm."userId" = cm."userId"
      )`,
  },
];

export async function findReferenceIntegrityIssues(
  prisma: PrismaClient,
  options: { sampleLimit?: number } = {},
): Promise<{ readOnly: true; issues: IntegrityIssue[] }> {
  const sampleLimit = Math.max(1, Math.floor(options.sampleLimit ?? 50));
  const issues = await prisma.$transaction(
    async (tx) => {
      // Any accidental write in this transaction fails instead of committing.
      await tx.$executeRaw`SET TRANSACTION READ ONLY`;
      const found: IntegrityIssue[] = [];
      for (const check of CHECKS) {
        const rows = await tx.$queryRaw<(Record<string, string | boolean | null> & { total: number })[]>`
          SELECT q.*, (count(*) OVER ())::int AS total
          FROM (${check.query}) q
          ORDER BY q.id
          LIMIT ${sampleLimit}`;
        found.push({
          key: check.key,
          description: check.description,
          repair: check.repair,
          count: rows[0]?.total ?? 0,
          samples: rows.map(({ total: _total, ...sample }) => sample),
        });
      }
      return found;
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 10 * 60_000, maxWait: 60_000 },
  );
  return { readOnly: true, issues };
}

async function main() {
  const args = process.argv.slice(2);
  const limitArg = args.find((arg) => arg.startsWith("--limit="));
  const sampleLimit = limitArg ? Number(limitArg.slice("--limit=".length)) : 50;
  if (!Number.isFinite(sampleLimit) || sampleLimit < 1) throw new Error("--limit must be a positive number");
  const prisma = new PrismaClient();
  try {
    const report = await findReferenceIntegrityIssues(prisma, { sampleLimit });
    if (args.includes("--json")) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      for (const issue of report.issues) {
        console.log(`${issue.count === 0 ? "ok  " : "FAIL"} ${issue.key}: ${issue.count} (${issue.description})`);
        if (issue.count > 0) {
          console.log(`     repair: ${issue.repair}`);
          for (const sample of issue.samples) console.log(`     ${JSON.stringify(sample)}`);
          if (issue.count > issue.samples.length) console.log(`     ... ${issue.count - issue.samples.length} more`);
        }
      }
    }
    process.exitCode = report.issues.some((issue) => issue.count > 0) ? 2 : 0;
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
