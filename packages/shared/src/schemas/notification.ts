import { z } from "zod";

export const NotificationQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  unreadOnly: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .optional()
    .default(false),
  type: z.string().optional(),
});
export type NotificationQueryInput = z.infer<typeof NotificationQuerySchema>;

export const MarkNotificationsReadSchema = z.object({
  notificationIds: z.array(z.string()).min(1).max(100),
});
export type MarkNotificationsReadInput = z.infer<typeof MarkNotificationsReadSchema>;

export const DueDateReminderTimingEnum = z.enum([
  "on_due_date",
  "1_day_before",
  "3_days_before",
  "1_week_before",
]);

export const UpdateNotificationPreferenceSchema = z.object({
  taskAssigned: z.boolean().optional(),
  taskStatusChanged: z.boolean().optional(),
  taskDueSoon: z.boolean().optional(),
  commentAdded: z.boolean().optional(),
  commentMention: z.boolean().optional(),
  chatMention: z.boolean().optional(),
  chatDmMessage: z.boolean().optional(),
  fileShared: z.boolean().optional(),
  dueDateReminderTiming: DueDateReminderTimingEnum.optional(),
});
export type UpdateNotificationPreferenceInput = z.infer<typeof UpdateNotificationPreferenceSchema>;
