import { z } from "zod";
import { QueryBooleanSchema } from "./common.js";

export const CreateProjectSchema = z.object({
  name: z
    .string()
    .min(1, "Project name is required")
    .max(255, "Project name must be 255 characters or less"),
  description: z.string().optional(),
  color: z.string().optional(),
  icon: z.string().optional(),
});
export type CreateProjectInput = z.infer<typeof CreateProjectSchema>;

export const UpdateProjectSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().nullable().optional(),
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
  search: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type ProjectQueryInput = z.infer<typeof ProjectQuerySchema>;
