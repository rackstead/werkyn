import type { PrismaClient, Prisma } from "@prisma/client";
import type { CreateRecurringInput, UpdateRecurringInput } from "@pm/shared";
import { NotFoundError } from "../../utils/errors.js";

export async function listRecurringConfigs(prisma: PrismaClient, projectId: string) {
  return prisma.recurringTaskConfig.findMany({
    where: { projectId },
    include: {
      template: { select: { id: true, name: true, title: true } },
    },
    orderBy: { createdAt: "desc" },
  });
}

export async function createRecurringConfig(
  prisma: PrismaClient,
  projectId: string,
  data: CreateRecurringInput,
) {
  // Validate template belongs to project
  const template = await prisma.taskTemplate.findFirst({
    where: { id: data.templateId, projectId },
    select: { projectId: true },
  });
  if (!template) throw new NotFoundError("Template not found");

  const nextRunDate = calculateNextRunDate(
    data.frequency,
    data.startDate,
    data.dayOfWeek,
    data.dayOfMonth,
  );

  return prisma.recurringTaskConfig.create({
    data: {
      projectId,
      templateId: data.templateId,
      frequency: data.frequency,
      dayOfWeek: data.dayOfWeek,
      dayOfMonth: data.dayOfMonth,
      startDate: data.startDate,
      endDate: data.endDate,
      nextRunDate,
    },
    include: {
      template: { select: { id: true, name: true, title: true } },
    },
  });
}

export async function updateRecurringConfig(
  prisma: PrismaClient,
  projectId: string,
  configId: string,
  data: UpdateRecurringInput,
) {
  const existing = await prisma.recurringTaskConfig.findFirst({ where: { id: configId, projectId } });
  if (!existing) throw new NotFoundError("Recurring config not found");

  const updateData: Prisma.RecurringTaskConfigUpdateInput = {};
  if (data.frequency !== undefined) updateData.frequency = data.frequency;
  if (data.dayOfWeek !== undefined) updateData.dayOfWeek = data.dayOfWeek;
  if (data.dayOfMonth !== undefined) updateData.dayOfMonth = data.dayOfMonth;
  if (data.endDate !== undefined) updateData.endDate = data.endDate;
  if (data.isActive !== undefined) updateData.isActive = data.isActive;

  // Recalculate nextRunDate if frequency or day fields changed
  if (data.frequency !== undefined || data.dayOfWeek !== undefined || data.dayOfMonth !== undefined) {
    const freq = data.frequency ?? existing.frequency;
    const dow = data.dayOfWeek !== undefined ? data.dayOfWeek : existing.dayOfWeek;
    const dom = data.dayOfMonth !== undefined ? data.dayOfMonth : existing.dayOfMonth;
    updateData.nextRunDate = calculateNextRunDate(freq, existing.startDate, dow, dom);
  }

  return prisma.recurringTaskConfig.update({
    where: { id: configId, projectId },
    data: updateData,
    include: {
      template: { select: { id: true, name: true, title: true } },
    },
  });
}

export async function deleteRecurringConfig(prisma: PrismaClient, projectId: string, configId: string) {
  const existing = await prisma.recurringTaskConfig.findFirst({ where: { id: configId, projectId } });
  if (!existing) throw new NotFoundError("Recurring config not found");
  await prisma.recurringTaskConfig.delete({ where: { id: configId, projectId } });
}

// ─── Date Utilities ──────────────────────────────────────

function todayUTC(): string {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function parseDate(dateStr: string): Date {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function formatDate(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function calculateNextRunDate(
  frequency: string,
  startDate: string,
  dayOfWeek?: number | null,
  dayOfMonth?: number | null,
): string {
  const today = todayUTC();
  const start = startDate >= today ? startDate : today;
  const d = parseDate(start);

  switch (frequency) {
    case "DAILY":
      return formatDate(d);

    case "WEEKLY":
    case "BIWEEKLY": {
      const targetDay = dayOfWeek ?? 0;
      const currentDay = d.getUTCDay();
      let diff = targetDay - currentDay;
      if (diff < 0) diff += 7;
      d.setUTCDate(d.getUTCDate() + diff);
      return formatDate(d);
    }

    case "MONTHLY": {
      const targetDOM = dayOfMonth ?? 1;
      // If we're past the target day this month, move to next month
      if (d.getUTCDate() > targetDOM) {
        d.setUTCMonth(d.getUTCMonth() + 1);
      }
      // Clamp to last day of month
      const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
      d.setUTCDate(Math.min(targetDOM, lastDay));
      return formatDate(d);
    }

    default:
      return start;
  }
}

export function advanceNextRunDate(
  frequency: string,
  currentNextRunDate: string,
  dayOfWeek?: number | null,
  dayOfMonth?: number | null,
): string {
  const d = parseDate(currentNextRunDate);

  switch (frequency) {
    case "DAILY":
      d.setUTCDate(d.getUTCDate() + 1);
      return formatDate(d);

    case "WEEKLY":
      d.setUTCDate(d.getUTCDate() + 7);
      return formatDate(d);

    case "BIWEEKLY":
      d.setUTCDate(d.getUTCDate() + 14);
      return formatDate(d);

    case "MONTHLY": {
      const targetDOM = dayOfMonth ?? 1;
      d.setUTCMonth(d.getUTCMonth() + 1);
      const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
      d.setUTCDate(Math.min(targetDOM, lastDay));
      return formatDate(d);
    }

    default:
      d.setUTCDate(d.getUTCDate() + 1);
      return formatDate(d);
  }
}
