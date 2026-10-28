import { z } from "zod";
import { dateOnly, multilineText, singleLineText } from "./common.js";

const PriorityEnum = z.enum(["NONE", "LOW", "MEDIUM", "HIGH", "URGENT"]);

/** A template's due date is at most about ten years after the task is created. */
export const MAX_DUE_OFFSET_DAYS = 3650;

export const CreateTemplateSchema = z.object({
  name: singleLineText().min(1, "Name is required").max(255),
  title: singleLineText().min(1, "Title is required").max(255),
  description: multilineText().optional(),
  priority: PriorityEnum.default("NONE"),
  statusId: z.string().optional(),
  dueOffset: z.number().int().min(0).max(MAX_DUE_OFFSET_DAYS).optional(),
  assigneeIds: z.array(z.string()).default([]),
  labelIds: z.array(z.string()).default([]),
  subtasks: z.array(z.object({ title: singleLineText().min(1).max(255) })).default([]),
});
export type CreateTemplateInput = z.infer<typeof CreateTemplateSchema>;

export const UpdateTemplateSchema = z.object({
  name: singleLineText().min(1).max(255).optional(),
  title: singleLineText().min(1).max(255).optional(),
  description: multilineText().nullable().optional(),
  priority: PriorityEnum.optional(),
  statusId: z.string().nullable().optional(),
  dueOffset: z.number().int().min(0).max(MAX_DUE_OFFSET_DAYS).nullable().optional(),
  assigneeIds: z.array(z.string()).optional(),
  labelIds: z.array(z.string()).optional(),
  subtasks: z.array(z.object({ title: singleLineText().min(1).max(255) })).optional(),
});
export type UpdateTemplateInput = z.infer<typeof UpdateTemplateSchema>;

export const InstantiateTemplateSchema = z.object({
  title: singleLineText().min(1).max(255).optional(),
  statusId: z.string().optional(),
  assigneeIds: z.array(z.string()).optional(),
  dueDate: dateOnly("Due date").optional(),
});
export type InstantiateTemplateInput = z.infer<typeof InstantiateTemplateSchema>;
