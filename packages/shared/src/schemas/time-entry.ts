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

export const TimeEntryQuerySchema = z.object({
  startDate: dateOnly("startDate"),
  endDate: dateOnly("endDate"),
  userId: z.string().optional(),
});
export type TimeEntryQuery = z.infer<typeof TimeEntryQuerySchema>;

export const TimeReportQuerySchema = z.object({
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
export type TimeReportQuery = z.infer<typeof TimeReportQuerySchema>;

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
