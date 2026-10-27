import type { Prisma, PrismaClient } from "@prisma/client";
import type { TimeReportQuery } from "@pm/shared";
import * as userRatesService from "./user-rates.service.js";
import { timeEntryProjectWhere } from "./time-entries.service.js";

export interface CurrencyAmount {
  currency: string;
  amount: number;
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
  /** hours x rate for billable entries, 0 for non-billable ones, null when billable but unrated. */
  cost: number | null;
}

interface ReportGroup extends CostTotals {
  key: string;
  label: string;
  totalHours: number;
  billableHours: number;
  nonBillableHours: number;
  entries: ReportEntry[];
}

class CostAccumulator {
  private readonly amounts = new Map<string, number>();
  private unratedBillableHours = 0;

  add(entry: ReportEntry) {
    if (!entry.billable) return;
    if (entry.cost === null || entry.currency === null) {
      this.unratedBillableHours += entry.hours;
      return;
    }
    this.amounts.set(
      entry.currency,
      (this.amounts.get(entry.currency) ?? 0) + entry.cost,
    );
  }

  totals(): CostTotals {
    const costByCurrency = [...this.amounts]
      .map(([currency, amount]) => ({ currency, amount }))
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

export async function generateReport(
  prisma: PrismaClient,
  workspaceId: string,
  userId: string,
  query: TimeReportQuery,
) {
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

  const entries = await prisma.timeEntry.findMany({
    where,
    include: {
      user: { select: { id: true, displayName: true } },
      task: { select: { id: true, title: true } },
      project: { select: { id: true, name: true } },
    },
    orderBy: [{ date: "asc" }, { createdAt: "asc" }],
  });

  // Price every entry at the rate in effect on its own date. The report end
  // date only bounds which entries are included, never which rate applies.
  const rateHistory = new Map<
    string,
    Array<{ rate: number; currency: string; effectiveFrom: string }>
  >();
  const latestEntryDate = entries.at(-1)?.date;
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

  // Group entries
  const groupMap = new Map<
    string,
    { group: Omit<ReportGroup, keyof CostTotals>; costs: CostAccumulator }
  >();
  const summaryCosts = new CostAccumulator();
  const summary = { totalHours: 0, billableHours: 0, nonBillableHours: 0 };

  for (const entry of entries) {
    let key: string;
    let label: string;

    switch (query.groupBy) {
      case "project":
        key = entry.projectId ?? "no-project";
        label = entry.project?.name ?? "No Project";
        break;
      case "date":
        key = entry.date;
        label = entry.date;
        break;
      case "user":
      default:
        key = entry.userId;
        label = entry.user.displayName;
        break;
    }

    if (!groupMap.has(key)) {
      groupMap.set(key, {
        group: {
          key,
          label,
          totalHours: 0,
          billableHours: 0,
          nonBillableHours: 0,
          entries: [],
        },
        costs: new CostAccumulator(),
      });
    }

    const { group, costs } = groupMap.get(key)!;
    const applied = userRatesService.rateInEffect(
      rateHistory.get(entry.userId) ?? [],
      entry.date,
    );
    const reportEntry: ReportEntry = {
      id: entry.id,
      date: entry.date,
      hours: entry.hours,
      billable: entry.billable,
      description: entry.description,
      userName: entry.user.displayName,
      projectName: entry.project?.name ?? null,
      taskTitle: entry.task?.title ?? null,
      rate: applied?.rate ?? null,
      // Legacy rows may store a lower-case code; one currency is one bucket.
      currency: applied?.currency.toUpperCase() ?? null,
      cost: !entry.billable ? 0 : applied ? entry.hours * applied.rate : null,
    };

    for (const totals of [group, summary]) {
      totals.totalHours += entry.hours;
      if (entry.billable) {
        totals.billableHours += entry.hours;
      } else {
        totals.nonBillableHours += entry.hours;
      }
    }
    costs.add(reportEntry);
    summaryCosts.add(reportEntry);
    group.entries.push(reportEntry);
  }

  const groups: ReportGroup[] = Array.from(
    groupMap.values(),
    ({ group, costs }) => ({
      ...group,
      ...costs.totals(),
    }),
  );

  return { groups, summary: { ...summary, ...summaryCosts.totals() } };
}

export async function exportReportCSV(
  prisma: PrismaClient,
  workspaceId: string,
  userId: string,
  query: TimeReportQuery,
) {
  const report = await generateReport(prisma, workspaceId, userId, query);

  const rows: string[] = [
    "Date,User,Project,Task,Hours,Billable,Rate,Currency,Cost,Description",
  ];

  for (const group of report.groups) {
    for (const entry of group.entries) {
      const desc = entry.description
        ? `"${entry.description.replace(/"/g, '""')}"`
        : "";
      rows.push(
        [
          entry.date,
          `"${entry.userName}"`,
          entry.projectName ? `"${entry.projectName}"` : "",
          entry.taskTitle ? `"${entry.taskTitle}"` : "",
          entry.hours.toFixed(2),
          entry.billable ? "Yes" : "No",
          entry.rate === null ? "" : entry.rate.toFixed(2),
          entry.currency ?? "",
          entry.cost === null ? "" : entry.cost.toFixed(2),
          desc,
        ].join(","),
      );
    }
  }

  return rows.join("\n");
}
