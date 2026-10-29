import type { PrismaClient, Prisma } from "@prisma/client";
import {
  RECURRENCE_DAY_REQUIRED_MESSAGE,
  requiredRecurrenceDay,
  type CreateRecurringInput,
  type UpdateRecurringInput,
} from "@pm/shared";
import { NotFoundError, ValidationError } from "../../utils/errors.js";

// Scheduler bookkeeping, not part of the API.
const configOmit = { lastRunDate: true } as const;

export async function listRecurringConfigs(prisma: PrismaClient, projectId: string) {
  return prisma.recurringTaskConfig.findMany({
    where: { projectId },
    omit: configOmit,
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
    omit: configOmit,
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

  // An edit to the schedule must leave it with the day its frequency needs,
  // as on create. Omitted fields keep their stored values. Edits that leave
  // the schedule alone (pausing, the end date) are allowed on any stored row.
  const changesSchedule =
    data.frequency !== undefined || data.dayOfWeek !== undefined || data.dayOfMonth !== undefined;
  if (changesSchedule) {
    const merged = {
      frequency: data.frequency ?? existing.frequency,
      dayOfWeek: data.dayOfWeek !== undefined ? data.dayOfWeek : existing.dayOfWeek,
      dayOfMonth: data.dayOfMonth !== undefined ? data.dayOfMonth : existing.dayOfMonth,
    };
    const day = requiredRecurrenceDay(merged.frequency);
    if (day && merged[day] === null) {
      throw new ValidationError("Validation failed", [
        { field: day, message: RECURRENCE_DAY_REQUIRED_MESSAGE[day] },
      ]);
    }
  }

  const updateData: Prisma.RecurringTaskConfigUpdateInput = {};
  if (data.frequency !== undefined) updateData.frequency = data.frequency;
  if (data.dayOfWeek !== undefined) updateData.dayOfWeek = data.dayOfWeek;
  if (data.dayOfMonth !== undefined) updateData.dayOfMonth = data.dayOfMonth;
  if (data.endDate !== undefined) updateData.endDate = data.endDate;
  if (data.isActive !== undefined) updateData.isActive = data.isActive;

  // Recalculate nextRunDate if frequency or day fields changed. The calculation
  // is anchored to the stored startDate, so a BIWEEKLY schedule keeps its
  // two-week phase across edits.
  if (data.frequency !== undefined || data.dayOfWeek !== undefined || data.dayOfMonth !== undefined) {
    const freq = data.frequency ?? existing.frequency;
    const dow = data.dayOfWeek !== undefined ? data.dayOfWeek : existing.dayOfWeek;
    const dom = data.dayOfMonth !== undefined ? data.dayOfMonth : existing.dayOfMonth;
    updateData.nextRunDate = await firstUngeneratedRun(
      prisma,
      { ...existing, frequency: freq, dayOfWeek: dow, dayOfMonth: dom },
      calculateNextRunDate(freq, existing.startDate, dow, dom),
    );
  } else if (data.isActive === true && !existing.isActive) {
    // Resuming a paused schedule: dates that passed while it was paused are
    // skipped, not generated late. The next run moves forward on the stored
    // cycle to the first date on or after today.
    const today = todayUTC();
    let next = existing.nextRunDate;
    while (next < today) {
      next = advanceNextRunDate(existing.frequency, next, existing.dayOfWeek, existing.dayOfMonth);
    }
    updateData.nextRunDate = await firstUngeneratedRun(prisma, existing, next);
  }

  return prisma.recurringTaskConfig.update({
    where: { id: configId, projectId },
    data: updateData,
    omit: configOmit,
    include: {
      template: { select: { id: true, name: true, title: true } },
    },
  });
}

/**
 * The first run on or after `date` that the scheduler has not generated yet.
 * A recalculated next run can land on a date already generated today (an
 * edit or a resume after that day's run); it moves on to the next one.
 */
async function firstUngeneratedRun(
  prisma: PrismaClient,
  config: { id: string; frequency: string; dayOfWeek: number | null; dayOfMonth: number | null },
  date: string,
) {
  let next = date;
  while (
    await prisma.recurringTaskOccurrence.findUnique({
      where: { configId_occurrenceDate: { configId: config.id, occurrenceDate: next } },
      select: { configId: true },
    })
  ) {
    next = advanceNextRunDate(config.frequency, next, config.dayOfWeek, config.dayOfMonth);
  }
  return next;
}

export async function deleteRecurringConfig(prisma: PrismaClient, projectId: string, configId: string) {
  const existing = await prisma.recurringTaskConfig.findFirst({ where: { id: configId, projectId } });
  if (!existing) throw new NotFoundError("Recurring config not found");
  await prisma.recurringTaskConfig.delete({ where: { id: configId, projectId } });
}

// ─── Date Utilities ──────────────────────────────────────
//
// startDate, endDate and nextRunDate are calendar dates stored as YYYY-MM-DD,
// without a time of day or time zone. "Today" is the current UTC date, both
// here and in the recurring-task scheduler, and all arithmetic uses UTC Date
// methods so results never depend on the host time zone.
//
// A schedule's occurrences are the dates on or after startDate that match:
// - DAILY: every day.
// - WEEKLY: dayOfWeek (0 = Sunday) every week.
// - BIWEEKLY: the first dayOfWeek on or after startDate, then every 14 days.
//   The two-week phase comes from startDate, never from the day it is saved.
// - MONTHLY: dayOfMonth in every month, clamped to that month's last day. The
//   configured day is reapplied each month, so day 31 runs on Jan 31, Feb 28
//   (Feb 29 in leap years), Mar 31, Apr 30 and so on.
//
// calculateNextRunDate returns the first occurrence on or after the later of
// startDate and today. advanceNextRunDate returns the occurrence following a
// stored nextRunDate; the scheduler calls it once per generated task.
//
// The scheduler records each generated date (RecurringTaskOccurrence), so a
// date is generated at most once even when an edit or a resume moves
// nextRunDate back to it.

const DAY_MS = 86_400_000;

/** The UTC calendar date (YYYY-MM-DD) of an instant, by default now. */
export function todayUTC(now = new Date()): string {
  return formatDate(now);
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

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY_MS);
}

/** First date on or after `date` that falls on `dayOfWeek` (0 = Sunday). */
function onOrAfterWeekday(date: Date, dayOfWeek: number): Date {
  return addDays(date, (dayOfWeek - date.getUTCDay() + 7) % 7);
}

/**
 * The MONTHLY occurrence in the given month (`month` is zero-based and may be
 * 12 to mean January of the following year). The day is clamped to the
 * month's last day before it is applied, so a short month can never overflow
 * into the month after it.
 */
function monthlyOccurrence(year: number, month: number, dayOfMonth: number): Date {
  // Day 0 of the following month is the last day of this month.
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month, Math.min(dayOfMonth, lastDay)));
}

export function calculateNextRunDate(
  frequency: string,
  startDate: string,
  dayOfWeek?: number | null,
  dayOfMonth?: number | null,
  today: string = todayUTC(),
): string {
  const earliest = startDate >= today ? startDate : today;
  const from = parseDate(earliest);

  switch (frequency) {
    case "DAILY":
      return formatDate(from);

    case "WEEKLY":
      return formatDate(onOrAfterWeekday(from, dayOfWeek ?? 0));

    case "BIWEEKLY": {
      const first = onOrAfterWeekday(parseDate(startDate), dayOfWeek ?? 0);
      if (first.getTime() >= from.getTime()) return formatDate(first);
      // Whole two-week periods from the first occurrence, rounded up to reach `from`.
      const elapsedDays = Math.round((from.getTime() - first.getTime()) / DAY_MS);
      return formatDate(addDays(first, Math.ceil(elapsedDays / 14) * 14));
    }

    case "MONTHLY": {
      const targetDOM = dayOfMonth ?? 1;
      const year = from.getUTCFullYear();
      const month = from.getUTCMonth();
      const thisMonth = monthlyOccurrence(year, month, targetDOM);
      if (thisMonth.getTime() >= from.getTime()) return formatDate(thisMonth);
      return formatDate(monthlyOccurrence(year, month + 1, targetDOM));
    }

    default:
      return earliest;
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

    case "MONTHLY":
      // Reapply the configured day (not the previous, possibly clamped, date)
      // to the following month.
      return formatDate(monthlyOccurrence(d.getUTCFullYear(), d.getUTCMonth() + 1, dayOfMonth ?? 1));

    default:
      d.setUTCDate(d.getUTCDate() + 1);
      return formatDate(d);
  }
}
