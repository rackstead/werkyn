import { z } from "zod";
import { QueryBooleanSchema, INT32_MAX, dateOnly, multilineText, singleLineText } from "./common.js";

export const PriorityEnum = z.enum(["NONE", "LOW", "MEDIUM", "HIGH", "URGENT"]);

export const ReminderEnum = z.enum([
  "on_due_date",
  "1_day_before",
  "3_days_before",
  "1_week_before",
]);

export const CreateTaskSchema = z.object({
  title: singleLineText()
    .min(1, "Title is required")
    .max(255, "Title must be 255 characters or less"),
  description: multilineText().optional(),
  priority: PriorityEnum.default("NONE"),
  statusId: z.string().optional(),
  dueDate: dateOnly("Due date").optional(),
  startDate: dateOnly("Start date").optional(),
  reminder: ReminderEnum.optional(),
  assigneeIds: z.array(z.string()).optional(),
  labelIds: z.array(z.string()).optional(),
});
export type CreateTaskInput = z.infer<typeof CreateTaskSchema>;

export const UpdateTaskSchema = z.object({
  title: singleLineText().min(1).max(255).optional(),
  description: multilineText().nullable().optional(),
  priority: PriorityEnum.optional(),
  statusId: z.string().optional(),
  dueDate: dateOnly("Due date").nullable().optional(),
  startDate: dateOnly("Start date").nullable().optional(),
  reminder: ReminderEnum.nullable().optional(),
});
export type UpdateTaskInput = z.infer<typeof UpdateTaskSchema>;

export const MoveTaskSchema = z.object({
  statusId: z.string().min(1, "Status column is required"),
  position: z.number().int().min(0, "Position must be >= 0").max(INT32_MAX),
});
export type MoveTaskInput = z.infer<typeof MoveTaskSchema>;

export const TaskQuerySchema = z.object({
  status: z.string().optional(),
  priority: z.string().optional(),
  assignee: z.string().optional(),
  label: z.string().optional(),
  dueBefore: dateOnly("dueBefore").optional(),
  dueAfter: dateOnly("dueAfter").optional(),
  search: singleLineText().optional(),
  archived: QueryBooleanSchema.default(false),
  sort: z
    .enum(["dueDate", "priority", "createdAt", "position"])
    .default("position"),
  order: z.enum(["asc", "desc"]).default("asc"),
  page: z.coerce.number().int().min(1).max(INT32_MAX).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  view: z.enum(["paginated", "board"]).default("paginated"),
});
export type TaskQueryInput = z.infer<typeof TaskQuerySchema>;

export const BulkUpdateTasksSchema = z.object({
  orderedIds: z.array(z.string().min(1)).min(1),
});
export type BulkUpdateTasksInput = z.infer<typeof BulkUpdateTasksSchema>;

export const BulkUpdateFieldsSchema = z.object({
  taskIds: z.array(z.string().min(1)).min(1).max(50),
  statusId: z.string().optional(),
  priority: PriorityEnum.optional(),
  assigneeIds: z.array(z.string()).optional(),
  archived: z.boolean().optional(),
  labelIds: z.array(z.string()).optional(),
  dueDate: dateOnly("Due date").nullable().optional(),
  startDate: dateOnly("Start date").nullable().optional(),
});
export type BulkUpdateFieldsInput = z.infer<typeof BulkUpdateFieldsSchema>;

export const BulkDeleteSchema = z.object({
  taskIds: z.array(z.string().min(1)).min(1).max(50),
});
export type BulkDeleteInput = z.infer<typeof BulkDeleteSchema>;

export const TaskAssigneeSchema = z.object({
  userId: z.string().min(1, "User ID is required"),
});
export type TaskAssigneeInput = z.infer<typeof TaskAssigneeSchema>;

export const TaskLabelSchema = z.object({
  labelId: z.string().min(1, "Label ID is required"),
});
export type TaskLabelInput = z.infer<typeof TaskLabelSchema>;

export const TaskDependencySchema = z.object({
  blockingTaskId: z.string().min(1, "Blocking task ID is required"),
});
export type TaskDependencyInput = z.infer<typeof TaskDependencySchema>;
