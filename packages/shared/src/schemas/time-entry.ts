import { z } from "zod";

const datePattern = /^\d{4}-\d{2}-\d{2}$/;

export const CreateTimeEntrySchema = z.object({
  date: z.string().regex(datePattern, "Date must be YYYY-MM-DD"),
  hours: z
    .number()
    .min(0.01, "Hours must be at least 0.01")
    .max(24, "Hours cannot exceed 24"),
  description: z.string().max(500).optional(),
  taskId: z.string().optional(),
  projectId: z.string().optional(),
  billable: z.boolean().optional(),
});
export type CreateTimeEntryInput = z.infer<typeof CreateTimeEntrySchema>;

export const UpdateTimeEntrySchema = z.object({
  date: z.string().regex(datePattern, "Date must be YYYY-MM-DD").optional(),
  hours: z
    .number()
    .min(0.01, "Hours must be at least 0.01")
    .max(24, "Hours cannot exceed 24")
    .optional(),
  description: z.string().max(500).nullable().optional(),
  taskId: z.string().nullable().optional(),
  projectId: z.string().nullable().optional(),
  billable: z.boolean().optional(),
});
export type UpdateTimeEntryInput = z.infer<typeof UpdateTimeEntrySchema>;

export const TimeEntryQuerySchema = z.object({
  startDate: z.string().regex(datePattern, "startDate must be YYYY-MM-DD"),
  endDate: z.string().regex(datePattern, "endDate must be YYYY-MM-DD"),
  userId: z.string().optional(),
});
export type TimeEntryQuery = z.infer<typeof TimeEntryQuerySchema>;

export const TimeReportQuerySchema = z.object({
  startDate: z.string().regex(datePattern, "startDate must be YYYY-MM-DD"),
  endDate: z.string().regex(datePattern, "endDate must be YYYY-MM-DD"),
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
  rate: z.number().min(0, "Rate must be non-negative"),
  currency: z
    .string()
    .regex(/^[A-Za-z]{3}$/, "Currency must be a 3-letter code")
    .transform((code) => code.toUpperCase())
    .optional(),
  effectiveFrom: z
    .string()
    .regex(datePattern, "effectiveFrom must be YYYY-MM-DD")
    .optional(),
});
export type SetUserRateInput = z.infer<typeof SetUserRateSchema>;
