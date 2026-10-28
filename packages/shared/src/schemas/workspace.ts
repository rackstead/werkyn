import { z } from "zod";
import { singleLineText } from "./common.js";

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
