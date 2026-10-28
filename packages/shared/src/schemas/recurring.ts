import { z } from "zod";
import { dateOnly } from "./common.js";

export const RecurrenceFrequencyEnum = z.enum(["DAILY", "WEEKLY", "BIWEEKLY", "MONTHLY"]);
export type RecurrenceFrequency = z.infer<typeof RecurrenceFrequencyEnum>;

/**
 * The day field a frequency cannot run without: WEEKLY and BIWEEKLY schedules
 * need dayOfWeek, MONTHLY schedules need dayOfMonth, DAILY needs neither.
 */
export function requiredRecurrenceDay(
  frequency: RecurrenceFrequency,
): "dayOfWeek" | "dayOfMonth" | null {
  if (frequency === "WEEKLY" || frequency === "BIWEEKLY") return "dayOfWeek";
  if (frequency === "MONTHLY") return "dayOfMonth";
  return null;
}

export const RECURRENCE_DAY_REQUIRED_MESSAGE = {
  dayOfWeek: "dayOfWeek is required for WEEKLY/BIWEEKLY",
  dayOfMonth: "dayOfMonth is required for MONTHLY",
} as const;

export const CreateRecurringSchema = z
  .object({
    templateId: z.string().min(1, "Template is required"),
    frequency: RecurrenceFrequencyEnum,
    dayOfWeek: z.number().int().min(0).max(6).optional(),
    dayOfMonth: z.number().int().min(1).max(31).optional(),
    startDate: dateOnly("startDate"),
    endDate: dateOnly("endDate").optional(),
  })
  .superRefine((data, ctx) => {
    const day = requiredRecurrenceDay(data.frequency);
    if (day && data[day] === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [day], message: RECURRENCE_DAY_REQUIRED_MESSAGE[day] });
    }
  });
export type CreateRecurringInput = z.infer<typeof CreateRecurringSchema>;

// A partial update keeps every omitted field's stored value, so an omitted day
// can only be checked against the stored schedule (the service does that). A
// day that is explicitly cleared alongside a frequency that needs it is
// rejected here.
export const UpdateRecurringSchema = z
  .object({
    frequency: RecurrenceFrequencyEnum.optional(),
    dayOfWeek: z.number().int().min(0).max(6).nullable().optional(),
    dayOfMonth: z.number().int().min(1).max(31).nullable().optional(),
    endDate: dateOnly("endDate").nullable().optional(),
    isActive: z.boolean().optional(),
  })
  .superRefine((data, ctx) => {
    const day = data.frequency ? requiredRecurrenceDay(data.frequency) : null;
    if (day && data[day] === null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [day], message: RECURRENCE_DAY_REQUIRED_MESSAGE[day] });
    }
  });
export type UpdateRecurringInput = z.infer<typeof UpdateRecurringSchema>;
