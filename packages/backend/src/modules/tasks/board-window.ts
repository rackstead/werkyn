import type { Prisma, PrismaClient } from "@prisma/client";
import type { TaskQueryInput } from "@pm/shared";
import { ValidationError } from "../../utils/errors.js";
import { withSearchPlans } from "../../utils/text-search.js";
import { scopeTaskRelations } from "../../utils/task-scope.js";
import { withTaskCounts } from "./tasks.service.js";

/** Task bodies in one board page. Id pages may be larger; see ID_PAGE_MAX. */
export const BOARD_TASK_PAGE_MAX = 100;
/** Ids of one column, in board order, with no task body. */
export const BOARD_ID_PAGE_MAX = 500;

const BOARD_INDEX_ORDER: Prisma.TaskOrderByWithRelationInput[] = [
  { position: "asc" },
  { createdAt: "asc" },
  { id: "asc" },
];

export interface BoardColumnPage {
  statusId: string;
  /** Tasks matching the board filters. */
  total: number;
  /** Active tasks in the column, filters ignored. The move API indexes this list. */
  size: number;
  offset: number;
  /** Present on a columnIds page: ids in display order, not task bodies. */
  ids?: string[];
}

/**
 * One page of the board. `aligned` means a task's place in this response is
 * its index in the whole active column (no filter, board order), so a drop
 * can use that index before the task's body has been loaded.
 */
export async function listBoardWindow(
  prisma: PrismaClient,
  projectId: string,
  query: TaskQueryInput,
  where: Prisma.TaskWhereInput,
  include: Prisma.TaskInclude,
  orderBy: Prisma.TaskOrderByWithRelationInput[],
) {
  const perColumn = query.perColumn;
  if (!perColumn) throw new ValidationError("perColumn is required");
  if (query.columnOffset && !query.status) {
    throw new ValidationError("columnOffset requires status");
  }
  const idsOnly = query.columnIds === true;
  const max = idsOnly ? BOARD_ID_PAGE_MAX : BOARD_TASK_PAGE_MAX;
  if (perColumn > max) {
    throw new ValidationError(
      idsOnly ? "perColumn must be at most 500 when columnIds is set" : "perColumn must be at most 100",
    );
  }

  const offset = query.status ? (query.columnOffset ?? 0) : 0;
  const userFiltered = Boolean(
    query.search || query.assignee || query.priority || query.label || query.dueBefore || query.dueAfter,
  );
  // columnIndex follows utils/task-order.ts, not a display sort. It matches
  // the page offset only for an unfiltered board-order page.
  const aligned = !userFiltered && query.sort === "position" && query.order === "asc"
    && sameOrder(orderBy, BOARD_INDEX_ORDER);

  const statuses = query.status
    ? [query.status]
    : (await prisma.statusColumn.findMany({
        where: { projectId },
        orderBy: [{ position: "asc" }, { id: "asc" }],
        select: { id: true },
      })).map((column) => column.id);

  const sizeRows = await prisma.task.groupBy({
    by: ["statusId"],
    where: { projectId, archived: false },
    _count: { _all: true },
  });
  const sizes = new Map(sizeRows.map((row) => [row.statusId, row._count._all]));

  // A handful of columns, two statements each. Kept to three at a time so a
  // board read does not take the whole pool (tests use connection_limit=5).
  if (idsOnly) {
    const loaded = await mapLimit(statuses, 3, (statusId) =>
      loadIds(prisma, query, where, orderBy, statusId, perColumn, offset),
    );
    return {
      data: [],
      aligned,
      columns: loaded.map((column) => ({
        statusId: column.statusId,
        total: column.total,
        size: sizes.get(column.statusId) ?? 0,
        offset,
        ids: column.ids,
      })),
    };
  }

  const loaded = await mapLimit(statuses, 3, (statusId) =>
    loadTasks(prisma, query, where, include, orderBy, statusId, perColumn, offset),
  );
  const tasks = loaded.flatMap((column) => column.tasks);
  const indexes = aligned
    ? new Map(tasks.map((task) => [task.id, task.columnIndex]))
    : await columnIndexes(prisma, projectId, tasks.map((task) => task.id));
  const data = (await withTaskCounts(prisma, projectId, tasks)).map((task) => {
    // The include is a TaskInclude, so Prisma will not name the nested
    // payload. The object is the same shape listTasks already scopes.
    const scoped = scopeTaskRelations(task as never) as typeof task;
    return { ...scoped, columnIndex: indexes.get(task.id) ?? 0 };
  });
  return {
    data,
    aligned,
    columns: loaded.map((column) => ({
      statusId: column.statusId,
      total: column.total,
      size: sizes.get(column.statusId) ?? 0,
      offset,
    })),
  };
}

function sameOrder(
  orderBy: Prisma.TaskOrderByWithRelationInput[],
  expected: Prisma.TaskOrderByWithRelationInput[],
) {
  return JSON.stringify(orderBy) === JSON.stringify(expected);
}

function columnWhere(where: Prisma.TaskWhereInput, statusId: string): Prisma.TaskWhereInput {
  return { ...where, archived: false, statusId };
}

async function loadIds(
  prisma: PrismaClient,
  query: TaskQueryInput,
  where: Prisma.TaskWhereInput,
  orderBy: Prisma.TaskOrderByWithRelationInput[],
  statusId: string,
  perColumn: number,
  offset: number,
) {
  const whereColumn = columnWhere(where, statusId);
  const pageQuery = prisma.task.findMany({
    where: whereColumn,
    orderBy,
    skip: offset,
    take: perColumn,
    select: { id: true },
  });
  const countQuery = prisma.task.count({ where: whereColumn });
  const [page, total] = await pair(prisma, query, pageQuery, countQuery);
  return { statusId, total, ids: page.map((task) => task.id) };
}

async function loadTasks(
  prisma: PrismaClient,
  query: TaskQueryInput,
  where: Prisma.TaskWhereInput,
  include: Prisma.TaskInclude,
  orderBy: Prisma.TaskOrderByWithRelationInput[],
  statusId: string,
  perColumn: number,
  offset: number,
) {
  const whereColumn = columnWhere(where, statusId);
  const pageQuery = prisma.task.findMany({
    where: whereColumn,
    include,
    orderBy,
    skip: offset,
    take: perColumn,
  });
  const countQuery = prisma.task.count({ where: whereColumn });
  const [page, total] = await pair(prisma, query, pageQuery, countQuery);
  return {
    statusId,
    total,
    tasks: page.map((task, index) => ({ ...task, columnIndex: offset + index })),
  };
}

async function pair<P, C>(
  prisma: PrismaClient,
  query: TaskQueryInput,
  pageQuery: Prisma.PrismaPromise<P>,
  countQuery: Prisma.PrismaPromise<C>,
): Promise<[P, C]> {
  if (!query.search) return Promise.all([pageQuery, countQuery]);
  // A title search is planned for its term (utils/text-search.ts). The page
  // and the count each run in their own transaction, as the full board read does.
  const [page, total] = await Promise.all([
    withSearchPlans(prisma, [pageQuery]).then(([page]) => page),
    withSearchPlans(prisma, [countQuery]).then(([count]) => count),
  ]);
  return [page, total];
}

/** Index of each id in its column's active board order (position, createdAt, id). */
async function columnIndexes(prisma: PrismaClient, projectId: string, ids: string[]) {
  if (ids.length === 0) return new Map<string, number>();
  const rows = await prisma.$queryRaw<Array<{ id: string; columnIndex: number }>>`
    SELECT id, "columnIndex" FROM (
      SELECT id,
        (row_number() OVER (
          PARTITION BY "statusId"
          ORDER BY position ASC, "createdAt" ASC, id ASC
        ) - 1)::int AS "columnIndex"
      FROM "Task"
      WHERE "projectId" = ${projectId} AND archived = false
    ) ranked
    WHERE id = ANY(${ids})
  `;
  return new Map(rows.map((row) => [row.id, row.columnIndex]));
}

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: workers }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fn(items[index]);
    }
  }));
  return results;
}
