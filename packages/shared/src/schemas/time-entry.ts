import { z } from "zod";
import { dateOnly, multilineText } from "./common.js";

/** Upper bound for an hourly rate in any currency. */
export const MAX_HOURLY_RATE = 1_000_000_000;

export const CreateTimeEntrySchema = z.object({
  date: dateOnly("Date"),
  hours: z
    .number()
    .finite()
    .min(0.01, "Hours must be at least 0.01")
    .max(24, "Hours cannot exceed 24"),
  description: multilineText().max(500).optional(),
  taskId: z.string().optional(),
  projectId: z.string().optional(),
  billable: z.boolean().optional(),
});
export type CreateTimeEntryInput = z.infer<typeof CreateTimeEntrySchema>;

export const UpdateTimeEntrySchema = z.object({
  date: dateOnly("Date").optional(),
  hours: z
    .number()
    .finite()
    .min(0.01, "Hours must be at least 0.01")
    .max(24, "Hours cannot exceed 24")
    .optional(),
  description: multilineText().max(500).nullable().optional(),
  taskId: z.string().nullable().optional(),
  projectId: z.string().nullable().optional(),
  billable: z.boolean().optional(),
});
export type UpdateTimeEntryInput = z.infer<typeof UpdateTimeEntrySchema>;

/** Timesheet page size when `limit` is omitted (`GET /workspaces/:wid/time/entries`). */
export const TIME_ENTRY_PAGE_DEFAULT = 100;
/** Largest timesheet page one request can ask for. */
export const TIME_ENTRY_PAGE_MAX = 500;

export const TimeEntryQuerySchema = z.object({
  startDate: dateOnly("startDate"),
  endDate: dateOnly("endDate"),
  userId: z.string().optional(),
  /** Opaque `nextCursor` of the previous page. It carries the sort position, not only the id. */
  cursor: z.string().min(1).max(1024).optional(),
  /**
   * Page size. An omitted cursor and limit return the first
   * TIME_ENTRY_PAGE_DEFAULT entries, not every entry in the range.
   */
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(TIME_ENTRY_PAGE_MAX)
    .default(TIME_ENTRY_PAGE_DEFAULT),
});
export type TimeEntryQuery = z.infer<typeof TimeEntryQuerySchema>;

/** Entries a report group carries by default; totals always cover every entry. */
export const REPORT_GROUP_ENTRY_LIMIT = 20;
/** Entries one report response carries across all of its groups. */
export const REPORT_ENTRY_TOTAL_LIMIT = 5_000;
/** Largest page of report entries one request can ask for. */
export const REPORT_ENTRY_PAGE_MAX = 500;

const TimeReportFilterSchema = z.object({
  startDate: dateOnly("startDate"),
  endDate: dateOnly("endDate"),
  userIds: z.string().optional(),
  projectIds: z.string().optional(),
  billable: z.enum(["true", "false", "all"]).optional().default("all"),
  groupBy: z
    .enum(["user", "project", "date"])
    .optional()
    .default("user"),
});

export const TimeReportQuerySchema = TimeReportFilterSchema.extend({
  /** Entries per group in the response (0 for totals only). The CSV export ignores it. */
  entryLimit: z.coerce
    .number()
    .int()
    .min(0)
    .max(REPORT_ENTRY_PAGE_MAX)
    .default(REPORT_GROUP_ENTRY_LIMIT),
});
export type TimeReportQuery = z.infer<typeof TimeReportQuerySchema>;

/** The next entries of one report group, after the group's `nextEntryCursor`. */
export const TimeReportEntriesQuerySchema = TimeReportFilterSchema.extend({
  groupKey: z.string().min(1).max(200),
  cursor: z.string().min(1).max(200).optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(REPORT_ENTRY_PAGE_MAX)
    .default(100),
});
export type TimeReportEntriesQuery = z.infer<typeof TimeReportEntriesQuerySchema>;

export const SetUserRateSchema = z.object({
  rate: z
    .number()
    .finite("Rate must be a finite number")
    .min(0, "Rate must be non-negative")
    .max(MAX_HOURLY_RATE, "Rate is too large"),
  currency: z
    .string()
    .regex(/^[A-Za-z]{3}$/, "Currency must be a 3-letter code")
    .transform((code) => code.toUpperCase())
    .optional(),
  effectiveFrom: dateOnly("effectiveFrom").optional(),
});
export type SetUserRateInput = z.infer<typeof SetUserRateSchema>;
