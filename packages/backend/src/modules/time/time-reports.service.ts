import type { Prisma, PrismaClient } from "@prisma/client";
import type { TimeReportQuery } from "@pm/shared";
import * as userRatesService from "./user-rates.service.js";
import { timeEntryProjectWhere } from "./time-entries.service.js";

interface ReportGroup {
  key: string;
  label: string;
  totalHours: number;
  billableHours: number;
  nonBillableHours: number;
  totalCost: number;
  entries: Array<{
    id: string;
    date: string;
    hours: number;
    billable: boolean;
    description: string | null;
    userName: string;
    projectName: string | null;
    taskTitle: string | null;
    rate: number;
    cost: number;
  }>;
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

  // Build a rate cache: userId -> rate at each entry date
  const rateCache = new Map<string, number>();
  const uniqueUserIds = [...new Set(entries.map((e) => e.userId))];
  for (const uid of uniqueUserIds) {
    const rate = await userRatesService.getRate(prisma, workspaceId, uid, query.endDate);
    rateCache.set(uid, rate?.rate ?? 0);
  }

  // Group entries
  const groupMap = new Map<string, ReportGroup>();

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
        key,
        label,
        totalHours: 0,
        billableHours: 0,
        nonBillableHours: 0,
        totalCost: 0,
        entries: [],
      });
    }

    const group = groupMap.get(key)!;
    const rate = rateCache.get(entry.userId) ?? 0;
    const cost = entry.billable ? entry.hours * rate : 0;

    group.totalHours += entry.hours;
    if (entry.billable) {
      group.billableHours += entry.hours;
    } else {
      group.nonBillableHours += entry.hours;
    }
    group.totalCost += cost;

    group.entries.push({
      id: entry.id,
      date: entry.date,
      hours: entry.hours,
      billable: entry.billable,
      description: entry.description,
      userName: entry.user.displayName,
      projectName: entry.project?.name ?? null,
      taskTitle: entry.task?.title ?? null,
      rate,
      cost,
    });
  }

  const groups = Array.from(groupMap.values());
  const summary = {
    totalHours: groups.reduce((s, g) => s + g.totalHours, 0),
    billableHours: groups.reduce((s, g) => s + g.billableHours, 0),
    nonBillableHours: groups.reduce((s, g) => s + g.nonBillableHours, 0),
    totalCost: groups.reduce((s, g) => s + g.totalCost, 0),
  };

  return { groups, summary };
}

export async function exportReportCSV(
  prisma: PrismaClient,
  workspaceId: string,
  userId: string,
  query: TimeReportQuery,
) {
  const report = await generateReport(prisma, workspaceId, userId, query);

  const rows: string[] = [
    "Date,User,Project,Task,Hours,Billable,Rate,Cost,Description",
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
          entry.rate.toFixed(2),
          entry.cost.toFixed(2),
          desc,
        ].join(","),
      );
    }
  }

  return rows.join("\n");
}
