import { Prisma, type PrismaClient } from "@prisma/client";
import { currencyFractionDigits } from "./report-money.js";
import { FINITE_FLOAT } from "./user-rates.service.js";

type ReportDb = PrismaClient | Prisma.TransactionClient;

export interface ReportTotalQuery {
  startDate: string;
  endDate: string;
  userIds?: string;
  projectIds?: string;
  billable?: "true" | "false" | "all";
  groupBy?: "user" | "project" | "date";
}

export interface ReportAggregateRow {
  kind: number;
  groupKey: string | null;
  entryCount: number;
  totalHours: number;
  billableHours: number;
  nonBillableHours: number;
  unratedHours: number;
  currency: string | null;
  units: bigint;
  fractionDigits: number | null;
}

export interface ReportPageRow {
  id: string;
  userId: string;
  projectId: string | null;
  taskId: string | null;
  date: string;
  hours: number;
  billable: boolean;
  description: string | null;
  groupKey: string;
}

function groupKeySql(groupBy: ReportTotalQuery["groupBy"]): Prisma.Sql {
  if (groupBy === "project")
    return Prisma.sql`COALESCE(e."projectId", 'no-project')`;
  if (groupBy === "date") return Prisma.sql`e.date`;
  return Prisma.sql`e."userId"`;
}

function projectVisible(
  projectId: Prisma.Sql,
  workspaceId: string,
  userId: string,
): Prisma.Sql {
  return Prisma.sql`EXISTS (
    SELECT 1 FROM "Project" p
    WHERE p.id = ${projectId}
      AND p."workspaceId" = ${workspaceId}
      AND EXISTS (
        SELECT 1 FROM "WorkspaceMember" wm
        WHERE wm."workspaceId" = p."workspaceId" AND wm."userId" = ${userId}
      )
      AND (
        EXISTS (
          SELECT 1 FROM "WorkspaceMember" wm
          WHERE wm."workspaceId" = p."workspaceId" AND wm."userId" = ${userId} AND wm.role = 'ADMIN'
        )
        OR EXISTS (
          SELECT 1 FROM "ProjectMember" pm
          WHERE pm."projectId" = p.id AND pm."userId" = ${userId}
        )
      )
  )`;
}

function reportFilter(
  workspaceId: string,
  userId: string,
  query: ReportTotalQuery,
): Prisma.Sql {
  const userFilter = query.userIds
    ? Prisma.sql`AND e."userId" IN (${Prisma.join(query.userIds.split(","))})`
    : Prisma.empty;
  const projectFilter = query.projectIds
    ? Prisma.sql`AND e."projectId" IN (${Prisma.join(query.projectIds.split(","))})`
    : Prisma.empty;
  const billableFilter =
    query.billable === "true"
      ? Prisma.sql`AND e.billable`
      : query.billable === "false"
        ? Prisma.sql`AND NOT e.billable`
        : Prisma.empty;
  return Prisma.sql`
    e."workspaceId" = ${workspaceId}
    AND e.date >= ${query.startDate}
    AND e.date <= ${query.endDate}
    AND e.hours >= ${FINITE_FLOAT.gte}
    AND e.hours <= ${FINITE_FLOAT.lte}
    ${userFilter}
    ${projectFilter}
    ${billableFilter}
    AND (e."projectId" IS NULL OR ${projectVisible(Prisma.sql`e."projectId"`, workspaceId, userId)})
    AND (
      e."taskId" IS NULL OR EXISTS (
        SELECT 1 FROM "Task" t
        WHERE t.id = e."taskId"
          AND ${projectVisible(Prisma.sql`t."projectId"`, workspaceId, userId)}
      )
    )
  `;
}

function upperCurrency(column: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`translate(${column}, 'abcdefghijklmnopqrstuvwxyz', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ')`;
}

async function currencyDigits(
  db: ReportDb,
  workspaceId: string,
): Promise<Prisma.Sql> {
  const rows = await db.$queryRaw<{ currency: string }[]>`
    SELECT DISTINCT translate(currency, 'abcdefghijklmnopqrstuvwxyz', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') AS currency
    FROM "UserRate"
    WHERE "workspaceId" = ${workspaceId}
  `;
  if (rows.length === 0) {
    return Prisma.sql`LEFT JOIN (
      SELECT NULL::text AS currency, NULL::int AS places WHERE FALSE
    ) AS digits ON FALSE`;
  }
  const values = rows.map(
    (row) =>
      Prisma.sql`(${row.currency}, ${currencyFractionDigits(row.currency)}::int)`,
  );
  return Prisma.sql`LEFT JOIN (VALUES ${Prisma.join(values)}) AS digits(currency, places)
    ON digits.currency = ${upperCurrency(Prisma.sql`rate.currency`)}`;
}

function asNumber(value: unknown): number {
  if (value == null) return 0;
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number))
    throw new Error("Report hour total was not a finite number");
  return number;
}

function asUnits(value: unknown): bigint {
  if (value == null) return 0n;
  const text = String(value);
  if (!/^-?\d+$/.test(text))
    throw new Error("Report cost units were not an integer");
  return BigInt(text);
}

interface AggregateSqlRow {
  kind: number;
  group_key: string | null;
  entry_count: number | null;
  total_hours: number | null;
  billable_hours: number | null;
  non_billable_hours: number | null;
  unrated_hours: number | null;
  currency: string | null;
  units: string | null;
  places: number | null;
}

/** Group and summary totals. One result row per group, one summary row, and one row per group currency. */
export async function queryReportAggregate(
  db: ReportDb,
  workspaceId: string,
  userId: string,
  query: ReportTotalQuery,
): Promise<ReportAggregateRow[]> {
  const digits = await currencyDigits(db, workspaceId);
  const key = groupKeySql(query.groupBy);
  const rows = await db.$queryRaw<AggregateSqlRow[]>`
    /* report-totals */
    WITH priced AS MATERIALIZED (
      SELECT
        ${key} AS group_key,
        e.hours,
        e.billable,
        e.date AS entry_date,
        e."createdAt" AS created_at,
        e.id,
        ${upperCurrency(Prisma.sql`rate.currency`)} AS currency,
        digits.places,
        CASE
          WHEN e.billable
            AND rate.rate IS NOT NULL
            AND rate.rate >= ${FINITE_FLOAT.gte}
            AND rate.rate <= ${FINITE_FLOAT.lte}
            AND digits.places IS NOT NULL
          THEN trunc(round(
            public.js_float_decimal(e.hours) * public.js_float_decimal(rate.rate),
            digits.places
          ) * power(10::numeric, digits.places))
          ELSE NULL
        END AS units
      FROM "TimeEntry" e
      LEFT JOIN LATERAL (
        SELECT r.rate, r.currency
        FROM "UserRate" r
        WHERE r."workspaceId" = e."workspaceId"
          AND r."userId" = e."userId"
          AND r."effectiveFrom" <= e.date
        ORDER BY r."effectiveFrom" DESC
        LIMIT 1
      ) rate ON TRUE
      ${digits}
      WHERE ${reportFilter(workspaceId, userId, query)}
    )
    SELECT kind, group_key, entry_count, total_hours, billable_hours, non_billable_hours,
           unrated_hours, first_date, first_created_at, first_id, currency, units, places
    FROM (
      SELECT
        0 AS kind,
        group_key,
        count(*)::int AS entry_count,
        sum(hours ORDER BY entry_date, created_at, id) AS total_hours,
        sum(hours ORDER BY entry_date, created_at, id) FILTER (WHERE billable) AS billable_hours,
        sum(hours ORDER BY entry_date, created_at, id) FILTER (WHERE NOT billable) AS non_billable_hours,
        sum(hours ORDER BY entry_date, created_at, id) FILTER (WHERE billable AND units IS NULL) AS unrated_hours,
        (array_agg(entry_date ORDER BY entry_date, created_at, id))[1] AS first_date,
        (array_agg(created_at ORDER BY entry_date, created_at, id))[1] AS first_created_at,
        (array_agg(id ORDER BY entry_date, created_at, id))[1] AS first_id,
        NULL::text AS currency,
        NULL::text AS units,
        NULL::int AS places
      FROM priced
      GROUP BY group_key
      UNION ALL
      SELECT
        1,
        NULL::text,
        count(*)::int,
        sum(hours ORDER BY entry_date, created_at, id),
        sum(hours ORDER BY entry_date, created_at, id) FILTER (WHERE billable),
        sum(hours ORDER BY entry_date, created_at, id) FILTER (WHERE NOT billable),
        sum(hours ORDER BY entry_date, created_at, id) FILTER (WHERE billable AND units IS NULL),
        NULL::text,
        NULL::timestamp(3),
        NULL::text,
        NULL::text,
        NULL::text,
        NULL::int
      FROM priced
      UNION ALL
      SELECT
        2,
        group_key,
        NULL::int,
        NULL::float8,
        NULL::float8,
        NULL::float8,
        NULL::float8,
        NULL::text,
        NULL::timestamp(3),
        NULL::text,
        currency,
        trim_scale(sum(units))::text,
        max(places)::int
      FROM priced
      WHERE units IS NOT NULL AND currency IS NOT NULL
      GROUP BY group_key, currency
    ) totals
    ORDER BY kind, first_date, first_created_at, first_id, group_key, currency
  `;
  return rows.map((row) => ({
    kind: Number(row.kind),
    groupKey: row.group_key,
    entryCount: Number(row.entry_count ?? 0),
    totalHours: asNumber(row.total_hours),
    billableHours: asNumber(row.billable_hours),
    nonBillableHours: asNumber(row.non_billable_hours),
    unratedHours: asNumber(row.unrated_hours),
    currency: row.currency,
    units: asUnits(row.units),
    fractionDigits: row.places == null ? null : Number(row.places),
  }));
}

/** The entries a report lists, already limited per group. */
export async function queryReportPage(
  db: ReportDb,
  workspaceId: string,
  userId: string,
  query: ReportTotalQuery,
  limits: readonly { key: string; take: number }[],
): Promise<ReportPageRow[]> {
  if (limits.length === 0) return [];
  const key = groupKeySql(query.groupBy);
  const values = limits.map(
    (limit, index) =>
      Prisma.sql`(${limit.key}, ${limit.take}::int, ${index}::int)`,
  );
  const rows = await db.$queryRaw<ReportPageRow[]>`
    /* report-entries */
    SELECT
      e.id,
      e."userId",
      e."projectId",
      e."taskId",
      e.date,
      e.hours,
      e.billable,
      e.description,
      limits.group_key AS "groupKey"
    FROM (VALUES ${Prisma.join(values)}) AS limits(group_key, row_limit, ord)
    JOIN LATERAL (
      SELECT e.id, e."userId", e."projectId", e."taskId", e.date, e.hours, e.billable, e.description, e."createdAt"
      FROM "TimeEntry" e
      WHERE ${reportFilter(workspaceId, userId, query)}
        AND ${key} = limits.group_key
      ORDER BY e.date ASC, e."createdAt" ASC, e.id ASC
      LIMIT limits.row_limit
    ) e ON TRUE
    ORDER BY limits.ord, e.date, e."createdAt", e.id
  `;
  return rows.map((row) => ({
    ...row,
    hours: asNumber(row.hours),
    projectId: row.projectId,
    taskId: row.taskId,
    description: row.description,
  }));
}
