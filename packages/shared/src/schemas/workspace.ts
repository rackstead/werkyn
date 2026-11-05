import { z } from "zod";
import { QueryBooleanSchema, dateOnly, singleLineText } from "./common.js";

export const CreateWorkspaceSchema = z.object({
  name: singleLineText()
    .min(1, "Workspace name is required")
    .max(100, "Workspace name must be 100 characters or less"),
  slug: z
    .string()
    .min(1, "Slug is required")
    .max(50, "Slug must be 50 characters or less")
    .regex(
      /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
      "Slug must be lowercase letters, numbers, and hyphens",
    ),
});
export type CreateWorkspaceInput = z.infer<typeof CreateWorkspaceSchema>;

export const UpdateWorkspaceSchema = z.object({
  name: singleLineText()
    .min(1)
    .max(100, "Workspace name must be 100 characters or less")
    .optional(),
  slug: z
    .string()
    .min(1)
    .max(50)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    .optional(),
  logoUrl: z.string().url().nullable().optional(),
});
export type UpdateWorkspaceInput = z.infer<typeof UpdateWorkspaceSchema>;

/** Assigned tasks one my-tasks page returns by default. */
export const MY_TASKS_PAGE_DEFAULT = 100;

export const MyTasksQuerySchema = z.object({
  /** Opaque `nextCursor` of the previous page (it carries a project name of up to 255 characters). */
  cursor: z.string().min(1).max(4096).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(MY_TASKS_PAGE_DEFAULT),
  /** Due on or before this date (tasks without a due date are left out). */
  dueBefore: dateOnly("dueBefore").optional(),
  /** Due on or after this date (tasks without a due date are left out). */
  dueAfter: dateOnly("dueAfter").optional(),
  /** false: only tasks outside completion columns; true: only completed tasks. */
  completed: QueryBooleanSchema.optional(),
});
export type MyTasksQueryInput = z.infer<typeof MyTasksQuerySchema>;
