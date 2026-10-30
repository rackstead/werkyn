import { z } from "zod";
import { isoDateTime } from "./common.js";

export const CreateFileShareSchema = z.object({
  fileIds: z.array(z.string()).min(1, "At least one file required"),
  userIds: z.array(z.string()).min(1, "At least one user required"),
});
export type CreateFileShareInput = z.infer<typeof CreateFileShareSchema>;

export const DeleteFileShareSchema = z.object({
  fileId: z.string(),
  userId: z.string(),
});
export type DeleteFileShareInput = z.infer<typeof DeleteFileShareSchema>;

export const CreateFileShareLinkSchema = z.object({
  fileIds: z.array(z.string()).min(1, "At least one file required"),
  password: z.string().max(100).optional(),
  expiresAt: isoDateTime().optional(),
});
export type CreateFileShareLinkInput = z.infer<typeof CreateFileShareLinkSchema>;

export const UpdateFileShareLinkSchema = z.object({
  enabled: z.boolean().optional(),
  password: z.string().max(100).nullable().optional(),
  expiresAt: isoDateTime().nullable().optional(),
});
export type UpdateFileShareLinkInput = z.infer<typeof UpdateFileShareLinkSchema>;

export const ValidateFileShareLinkSchema = z.object({
  password: z.string().max(100),
});
export type ValidateFileShareLinkInput = z.infer<typeof ValidateFileShareLinkSchema>;

export const SharedFilesQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type SharedFilesQueryInput = z.infer<typeof SharedFilesQuerySchema>;
