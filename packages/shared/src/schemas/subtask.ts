import { z } from "zod";
import { dateOnly, singleLineText } from "./common.js";

export const CreateSubtaskSchema = z.object({
  title: singleLineText()
    .min(1, "Title is required")
    .max(255, "Title must be 255 characters or less"),
  assigneeId: z.string().optional(),
  dueDate: dateOnly("Due date").optional(),
});
export type CreateSubtaskInput = z.infer<typeof CreateSubtaskSchema>;

export const UpdateSubtaskSchema = z.object({
  title: singleLineText().min(1).max(255).optional(),
  assigneeId: z.string().nullable().optional(),
  dueDate: dateOnly("Due date").nullable().optional(),
});
export type UpdateSubtaskInput = z.infer<typeof UpdateSubtaskSchema>;
