import { z } from "zod";
import { QueryBooleanSchema } from "./common.js";

export const CreateFolderSchema = z.object({
  name: z
    .string()
    .min(1, "Folder name is required")
    .max(255, "Folder name must be 255 characters or less"),
  parentId: z.string().optional(),
  teamFolderId: z.string().optional(),
});
export type CreateFolderInput = z.infer<typeof CreateFolderSchema>;

export const UpdateFileSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(255, "File name must be 255 characters or less")
    .optional(),
  parentId: z.string().nullable().optional(),
  teamFolderId: z.string().nullable().optional(),
  trashedAt: z.string().datetime().nullable().optional(),
});
export type UpdateFileInput = z.infer<typeof UpdateFileSchema>;

export const FileQuerySchema = z.object({
  parentId: z.string().nullable().optional(),
  teamFolderId: z.string().optional(),
  search: z.string().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  trashed: QueryBooleanSchema.default(false),
  sortBy: z.enum(["name", "size", "updatedAt", "uploadedBy"]).optional().default("name"),
  sortOrder: z.enum(["asc", "desc"]).optional().default("asc"),
});
export type FileQueryInput = z.infer<typeof FileQuerySchema>;

export const CopyFileSchema = z.object({
  parentId: z.string().nullable(),
  teamFolderId: z.string().nullable().optional(),
});
export type CopyFileInput = z.infer<typeof CopyFileSchema>;

export const UploadFileSchema = z.object({
  parentId: z.string().optional(),
});
export type UploadFileInput = z.infer<typeof UploadFileSchema>;

export const ArchiveFilesSchema = z.object({
  fileIds: z.array(z.string()).min(1),
});
export type ArchiveFilesInput = z.infer<typeof ArchiveFilesSchema>;

