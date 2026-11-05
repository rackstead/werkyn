import type { Prisma, PrismaClient } from "@prisma/client";
import {
  REPORT_ENTRY_TOTAL_LIMIT,
  type TimeReportEntriesQuery,
  type TimeReportQuery,
} from "@pm/shared";
import * as userRatesService from "./user-rates.service.js";
import { timeEntryProjectWhere } from "./time-entries.service.js";
import { batches } from "../../utils/graph-limits.js";
import { currencyFractionDigits, reportMoneyDecimal, reportMoneyNumber, roundedCostUnits } from "./report-money.js";
import {
  csvDecimal,
  csvExactDecimal,
  csvIsoDate,
  encodeCsv,
  type CsvCell,
} from "../../utils/csv.js";

export interface CurrencyAmount {
  currency: string;
  amount: number;
  fractionDigits: number;
}

/**
 * Cost totals for a set of entries. Amounts in different currencies are never
 * added together: costByCurrency always carries one total per currency, and
 * totalCost/currency are only set when every priced amount shares a currency.
 */
interface CostTotals {
  /** Priced cost when it is all in one currency (0 when nothing is priced); null when currencies are mixed. */
  totalCost: number | null;
  /** Currency of totalCost; null when nothing is priced or currencies are mixed. */
  currency: string | null;
  /** Priced billable cost per currency, ordered by currency code. */
  costByCurrency: CurrencyAmount[];
  /** Billable hours with no rate in effect on their date; they add no cost. */
  unratedBillableHours: number;
}

interface ReportEntry {
  id: string;
  date: string;
  hours: number;
  billable: boolean;
  description: string | null;
  userName: string;
  projectName: string | null;
  taskTitle: string | null;
  /** Rate in effect on the entry's own date, or null when the member had none. */
  rate: number | null;
  currency: string | null;
  /** Currency-rounded hours x rate, 0 when non-billable, null when billable but unrated. */
  cost: number | null;
  /** Server precision used for cost; null when no currency applies. */
  costFractionDigits: number | null;
}

interface ReportGroup extends CostTotals {
  key: string;
  label: string;
  totalHours: number;
  billableHours: number;
  nonBillableHours: number;
  /** The group's first entries, at most the request's entryLimit. */
  entries: ReportEntry[];
  /** Every entry of the group; the totals cover all of them. */
  entryCount: number;
  /** More entries follow `entries` (fetch them from /time/reports/entries). */
  hasMoreEntries: boolean;
  /** Cursor for the next entries; null with hasMoreEntries means from the start. */
  nextEntryCursor: string | null;
}

/** The entry columns a report reads, for every matching entry. */
interface EntryRow {
  id: string;
  userId: string;
  projectId: string | null;
  taskId: string | null;
  date: string;
  hours: number;
  billable: boolean;
  description: string | null;
}

/** Member, project and task names, looked up for listed entries and labels only. */
interface EntryNames {
  users: Map<string, string>;
  projects: Map<string, string>;
  tasks: Map<string, string>;
}

interface PricedEntry {
  rate: number | null;
  currency: string | null;
  costFractionDigits: number | null;
  units: bigint | null;
}

class CostAccumulator {
  private readonly amounts = new Map<string, { units: bigint; fractionDigits: number }>();
  private unratedBillableHours = 0;

  add(entry: EntryRow, priced: PricedEntry) {
    if (!entry.billable) return;
    if (priced.units === null || priced.currency === null || priced.costFractionDigits === null) {
      this.unratedBillableHours += entry.hours;
      return;
    }
    const previous = this.amounts.get(priced.currency);
    this.amounts.set(priced.currency, {
      units: (previous?.units ?? 0n) + priced.units,
      fractionDigits: priced.costFractionDigits,
    });
  }

  totals(): CostTotals {
    const costByCurrency = [...this.amounts]
      .map(([currency, { units, fractionDigits }]) => ({
        currency,
        amount: reportMoneyNumber(units, fractionDigits),
        fractionDigits,
      }))
      .sort((a, b) =>
        a.currency < b.currency ? -1 : a.currency > b.currency ? 1 : 0,
      );
    const single = costByCurrency.length === 1 ? costByCurrency[0] : null;
    return {
      totalCost: costByCurrency.length > 1 ? null : (single?.amount ?? 0),
      currency: single?.currency ?? null,
      costByCurrency,
      unratedBillableHours: this.unratedBillableHours,
    };
  }
}

type ReportFilters = Omit<TimeReportQuery, "entryLimit">;

function reportWhere(
  workspaceId: string,
  userId: string,
  query: ReportFilters,
): Prisma.TimeEntryWhereInput {
  const where: Prisma.TimeEntryWhereInput = {
    workspaceId,
    ...timeEntryProjectWhere(workspaceId, userId),
    date: { gte: query.startDate, lte: query.endDate },
  };

  if (query.userIds) {
    where.userId = { in: query.userIds.split(",") };
  }
  if (query.projectIds) {
    where.projectId = { in: query.projectIds.split(",") };
  }
  if (query.billable === "true") {
    where.billable = true;
  } else if (query.billable === "false") {
    where.billable = false;
  }
  return where;
}

const NO_PROJECT = "no-project";

function groupKeyOf(groupBy: ReportFilters["groupBy"], entry: EntryRow) {
  switch (groupBy) {
    case "project":
      return entry.projectId ?? NO_PROJECT;
    case "date":
      return entry.date;
    case "user":
    default:
      return entry.userId;
  }
}

function groupWhere(
  groupBy: ReportFilters["groupBy"],
  key: string,
): Prisma.TimeEntryWhereInput {
  switch (groupBy) {
    case "project":
      return { projectId: key === NO_PROJECT ? null : key };
    case "date":
      return { date: key };
    case "user":
    default:
      return { userId: key };
  }
}

/** Report order inside a group; the ID makes it total. */
const ENTRY_ORDER: Prisma.TimeEntryOrderByWithRelationInput[] = [
  { date: "asc" },
  { createdAt: "asc" },
  { id: "asc" },
];

const ENTRY_ROW = {
  id: true,
  userId: true,
  projectId: true,
  taskId: true,
  date: true,
  hours: true,
  billable: true,
  description: true,
} as const satisfies Prisma.TimeEntrySelect;

/**
 * Prices entries at the rate in effect on each entry's own date. The report
 * end date only bounds which entries are included, never which rate applies.
 */
async function entryPricing(
  prisma: PrismaClient,
  workspaceId: string,
  entries: readonly EntryRow[],
) {
  const rateHistory = new Map<
    string,
    Array<{ rate: number | null; currency: string; effectiveFrom: string }>
  >();
  let latestEntryDate: string | undefined;
  for (const entry of entries) {
    if (latestEntryDate === undefined || entry.date > latestEntryDate) latestEntryDate = entry.date;
  }
  if (latestEntryDate) {
    const rates = await userRatesService.listRateHistory(
      prisma,
      workspaceId,
      [...new Set(entries.map((e) => e.userId))],
      latestEntryDate,
    );
    for (const rate of rates) {
      const history = rateHistory.get(rate.userId) ?? [];
      history.push(rate);
      rateHistory.set(rate.userId, history);
    }
  }
  const precisions = new Map<string, number>();
  return (entry: EntryRow): PricedEntry => {
    const inEffect = userRatesService.rateInEffect(
      rateHistory.get(entry.userId) ?? [],
      entry.date,
    );
    // A stored rate that is not a finite number prices nothing: its dates are unrated.
    const applied =
      inEffect && inEffect.rate !== null
        ? { rate: inEffect.rate, currency: inEffect.currency }
        : null;
    // Legacy lower-case codes retain one bucket; resolve its precision once.
    const currency = applied?.currency.toUpperCase() ?? null;
    let costFractionDigits: number | null = null;
    if (currency !== null) {
      costFractionDigits = precisions.get(currency) ?? currencyFractionDigits(currency);
      precisions.set(currency, costFractionDigits);
    }
    const units = entry.billable && applied && costFractionDigits !== null
      ? roundedCostUnits(entry.hours, applied.rate, costFractionDigits)
      : null;
    return { rate: applied?.rate ?? null, currency, costFractionDigits, units };
  };
}

function reportEntry(entry: EntryRow, names: EntryNames, priced: PricedEntry): ReportEntry {
  return {
    id: entry.id,
    date: entry.date,
    hours: entry.hours,
    billable: entry.billable,
    description: entry.description,
    userName: names.users.get(entry.userId) ?? "",
    projectName: entry.projectId ? (names.projects.get(entry.projectId) ?? null) : null,
    taskTitle: entry.taskId ? (names.tasks.get(entry.taskId) ?? null) : null,
    rate: priced.rate,
    currency: priced.currency,
    cost: !entry.billable
      ? 0
      : priced.units !== null
        ? reportMoneyNumber(priced.units, priced.costFractionDigits!)
        : null,
    costFractionDigits: priced.costFractionDigits,
  };
}

const NAME_BATCH = 10_000;

/**
 * Names for the listed entries plus the group labels. Looked up by ID for
 * these rows only, instead of joining every entry of the report.
 */
async function entryNames(
  prisma: PrismaClient,
  entries: readonly EntryRow[],
  labels: { userIds?: string[]; projectIds?: string[] } = {},
): Promise<EntryNames> {
  const ids = (values: Iterable<string | null>) =>
    [...new Set(values)].filter((id): id is string => id !== null);
  const userIds = ids([...entries.map((e) => e.userId), ...(labels.userIds ?? [])]);
  const projectIds = ids([...entries.map((e) => e.projectId), ...(labels.projectIds ?? [])]);
  const taskIds = ids(entries.map((e) => e.taskId));
  // A full export can name more tasks than one statement takes parameters.
  const inBatches = async <T>(all: string[], read: (ids: string[]) => Promise<T[]>) =>
    (await Promise.all(batches(all, NAME_BATCH).map(read))).flat();
  const [users, projects, tasks] = await Promise.all([
    inBatches(userIds, (id) => prisma.user.findMany({ where: { id: { in: id } }, select: { id: true, displayName: true } })),
    inBatches(projectIds, (id) => prisma.project.findMany({ where: { id: { in: id } }, select: { id: true, name: true } })),
    inBatches(taskIds, (id) => prisma.task.findMany({ where: { id: { in: id } }, select: { id: true, title: true } })),
  ]);
  return {
    users: new Map(users.map((u) => [u.id, u.displayName])),
    projects: new Map(projects.map((p) => [p.id, p.name])),
    tasks: new Map(tasks.map((t) => [t.id, t.title])),
  };
}

function groupLabel(groupBy: ReportFilters["groupBy"], key: string, names: EntryNames) {
  switch (groupBy) {
    case "project":
      return key === NO_PROJECT ? "No Project" : (names.projects.get(key) ?? key);
    case "date":
      return key;
    case "user":
    default:
      return names.users.get(key) ?? key;
  }
}

/**
 * The report: exact totals over every matching entry, and each group's first
 * entries. `entryLimit` caps the entries per group and REPORT_ENTRY_TOTAL_LIMIT
 * caps them across groups (groups keep report order and later groups get
 * fewer or none); "all" returns every entry (CSV export).
 */
async function buildReport(
  prisma: PrismaClient,
  workspaceId: string,
  userId: string,
  query: ReportFilters,
  entryLimit: number | "all",
) {
  const where = reportWhere(workspaceId, userId, query);
  const all = entryLimit === "all";

  // Hours that are not a finite number (only possible through direct database
  // writes; the API rejects them) cannot be read by Prisma. Such entries are
  // left out of the report and counted in summary.skippedEntries.
  const [rows, skippedEntries] = await Promise.all([
    prisma.timeEntry.findMany({
      where: { ...where, hours: userRatesService.FINITE_FLOAT },
      // No relations: names are looked up below for the listed entries only.
      select: ENTRY_ROW,
      orderBy: ENTRY_ORDER,
    }),
    prisma.timeEntry.count({
      where: { ...where, NOT: { hours: userRatesService.FINITE_FLOAT } },
    }),
  ]);

  const price = await entryPricing(prisma, workspaceId, rows);

  const groupMap = new Map<
    string,
    {
      key: string;
      totalHours: number;
      billableHours: number;
      nonBillableHours: number;
      entryCount: number;
      shown: Array<{ entry: EntryRow; priced: PricedEntry }>;
      costs: CostAccumulator;
    }
  >();
  const summaryCosts = new CostAccumulator();
  const summary = { totalHours: 0, billableHours: 0, nonBillableHours: 0 };
  const perGroup = all ? Infinity : entryLimit;

  for (const entry of rows) {
    const key = groupKeyOf(query.groupBy, entry);
    let group = groupMap.get(key);
    if (!group) {
      group = {
        key,
        totalHours: 0,
        billableHours: 0,
        nonBillableHours: 0,
        entryCount: 0,
        shown: [],
        costs: new CostAccumulator(),
      };
      groupMap.set(key, group);
    }

    const priced = price(entry);
    for (const totals of [group, summary]) {
      totals.totalHours += entry.hours;
      if (entry.billable) {
        totals.billableHours += entry.hours;
      } else {
        totals.nonBillableHours += entry.hours;
      }
    }
    group.costs.add(entry, priced);
    summaryCosts.add(entry, priced);
    group.entryCount += 1;
    if (group.shown.length < perGroup) group.shown.push({ entry, priced });
  }

  // Groups appear in the order of their first entry, as before. The response
  // limit is spent in that order too: each group keeps its first entries
  // until REPORT_ENTRY_TOTAL_LIMIT is reached, and later groups get fewer or
  // none, however their entries interleave by date.
  const groups = [...groupMap.values()];
  let budget = all ? Infinity : REPORT_ENTRY_TOTAL_LIMIT;
  for (const group of groups) {
    if (group.shown.length > budget) group.shown.length = budget;
    budget -= group.shown.length;
  }
  const keys = groups.map((group) => group.key);
  const names = await entryNames(
    prisma,
    groups.flatMap((group) => group.shown.map(({ entry }) => entry)),
    {
      userIds: query.groupBy === "user" ? keys : [],
      projectIds: query.groupBy === "project" ? keys.filter((key) => key !== NO_PROJECT) : [],
    },
  );

  const reportGroups: ReportGroup[] = groups.map((group) => {
    const entries = group.shown.map(({ entry, priced }) => reportEntry(entry, names, priced));
    const hasMoreEntries = entries.length < group.entryCount;
    return {
      key: group.key,
      label: groupLabel(query.groupBy, group.key, names),
      totalHours: group.totalHours,
      billableHours: group.billableHours,
      nonBillableHours: group.nonBillableHours,
      ...group.costs.totals(),
      entries,
      entryCount: group.entryCount,
      hasMoreEntries,
      nextEntryCursor: hasMoreEntries ? (entries.at(-1)?.id ?? null) : null,
    };
  });

  return {
    groups: reportGroups,
    summary: { ...summary, ...summaryCosts.totals(), skippedEntries },
  };
}

export async function generateReport(
  prisma: PrismaClient,
  workspaceId: string,
  userId: string,
  query: TimeReportQuery,
) {
  return buildReport(prisma, workspaceId, userId, query, query.entryLimit);
}

/**
 * The next entries of one report group, in report order, after `cursor` (an
 * entry ID from nextEntryCursor or a previous page). A cursor that is not an
 * entry of the group gives an empty page.
 */
export async function listReportEntries(
  prisma: PrismaClient,
  workspaceId: string,
  userId: string,
  query: TimeReportEntriesQuery,
) {
  const where: Prisma.TimeEntryWhereInput = {
    AND: [
      reportWhere(workspaceId, userId, query),
      groupWhere(query.groupBy, query.groupKey),
      { hours: userRatesService.FINITE_FLOAT },
    ],
  };
  if (query.cursor) {
    const scopedCursor = await prisma.timeEntry.findFirst({
      where: { AND: [where, { id: query.cursor }] },
      select: { id: true },
    });
    if (!scopedCursor) return { data: [], nextCursor: null };
  }
  const rows = await prisma.timeEntry.findMany({
    where,
    select: ENTRY_ROW,
    orderBy: ENTRY_ORDER,
    take: query.limit + 1,
    ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
  });
  const hasMore = rows.length > query.limit;
  if (hasMore) rows.pop();
  const [price, names] = await Promise.all([
    entryPricing(prisma, workspaceId, rows),
    entryNames(prisma, rows),
  ]);
  return {
    data: rows.map((row) => reportEntry(row, names, price(row))),
    nextCursor: hasMore ? rows[rows.length - 1].id : null,
  };
}

export async function exportReportCSV(
  prisma: PrismaClient,
  workspaceId: string,
  userId: string,
  query: TimeReportQuery,
) {
  // The export stays complete: every matching entry, not the bounded groups.
  const report = await buildReport(prisma, workspaceId, userId, query, "all");

  const header = [
    "Date",
    "User",
    "Project",
    "Task",
    "Hours",
    "Billable",
    "Rate",
    "Currency",
    "Cost",
    "Description",
  ];
  const records = report.groups.flatMap((group) =>
    group.entries.map((entry): CsvCell[] => [
      csvIsoDate(entry.date),
      entry.userName,
      entry.projectName,
      entry.taskTitle,
      csvDecimal(entry.hours),
      entry.billable ? "Yes" : "No",
      entry.rate === null ? null : csvDecimal(entry.rate),
      entry.currency,
      entry.cost === null ? null : csvExactDecimal(reportMoneyDecimal(entry.cost, entry.costFractionDigits ?? 2)),
      entry.description,
    ]),
  );

  return {
    csv: encodeCsv(header, records),
    skippedEntries: report.summary.skippedEntries,
  };
}
