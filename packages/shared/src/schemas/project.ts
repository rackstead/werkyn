import { z } from "zod";
import { QueryBooleanSchema, INT32_MAX, multilineText, singleLineText } from "./common.js";

export const CreateProjectSchema = z.object({
  name: singleLineText()
    .min(1, "Project name is required")
    .max(255, "Project name must be 255 characters or less"),
  description: multilineText().optional(),
  color: z.string().optional(),
  icon: z.string().optional(),
});
export type CreateProjectInput = z.infer<typeof CreateProjectSchema>;

export const UpdateProjectSchema = z.object({
  name: singleLineText().min(1).max(255).optional(),
  description: multilineText().nullable().optional(),
  color: z.string().optional(),
  icon: z.string().nullable().optional(),
});
export type UpdateProjectInput = z.infer<typeof UpdateProjectSchema>;

export const ArchiveSchema = z.object({
  archived: z.boolean(),
});
export type ArchiveInput = z.infer<typeof ArchiveSchema>;

export const ProjectQuerySchema = z.object({
  archived: QueryBooleanSchema.default(false),
  search: singleLineText().optional(),
  page: z.coerce.number().int().min(1).max(INT32_MAX).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type ProjectQueryInput = z.infer<typeof ProjectQuerySchema>;
