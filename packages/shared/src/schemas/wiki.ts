import { z } from "zod";
import { QueryBooleanSchema, INT32_MAX, multilineText, singleLineText } from "./common.js";

// ─── Wiki Spaces ────────────────────────────────────────

export const CreateWikiSpaceSchema = z.object({
  name: singleLineText()
    .min(1, "Space name is required")
    .max(100, "Space name must be 100 characters or less"),
  description: multilineText().max(500).optional(),
  icon: z.string().optional(),
});
export type CreateWikiSpaceInput = z.infer<typeof CreateWikiSpaceSchema>;

export const UpdateWikiSpaceSchema = z.object({
  name: singleLineText().min(1).max(100).optional(),
  description: multilineText().max(500).nullable().optional(),
  icon: z.string().nullable().optional(),
  position: z.number().int().min(0).max(INT32_MAX).optional(),
});
export type UpdateWikiSpaceInput = z.infer<typeof UpdateWikiSpaceSchema>;

// ─── Wiki Pages ─────────────────────────────────────────

export const CreateWikiPageSchema = z.object({
  title: singleLineText()
    .min(1, "Page title is required")
    .max(500, "Page title must be 500 characters or less"),
  parentId: z.string().optional(),
  content: z.any().optional(),
  icon: z.string().optional(),
});
export type CreateWikiPageInput = z.infer<typeof CreateWikiPageSchema>;

export const UpdateWikiPageSchema = z.object({
  title: singleLineText().min(1).max(500).optional(),
  content: z.any().optional(),
  icon: z.string().nullable().optional(),
  // The page `revision` this edit is based on. When it is not the stored
  // revision the save is refused with 409 REVISION_CONFLICT. Omitted, the
  // save applies to whatever is stored (last writer wins).
  expectedRevision: z.number().int().min(0).max(INT32_MAX).optional(),
});
export type UpdateWikiPageInput = z.infer<typeof UpdateWikiPageSchema>;

export const MoveWikiPageSchema = z.object({
  parentId: z.string().nullable().optional(),
  spaceId: z.string().optional(),
  position: z.number().int().min(0).max(INT32_MAX),
});
export type MoveWikiPageInput = z.infer<typeof MoveWikiPageSchema>;

export const WikiPageTreeQuerySchema = z.object({
  parentId: z.string().optional(),
});
export type WikiPageTreeQueryInput = z.infer<typeof WikiPageTreeQuerySchema>;

// ─── Wiki Page Versions ─────────────────────────────────

export const WikiPageVersionQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
export type WikiPageVersionQueryInput = z.infer<typeof WikiPageVersionQuerySchema>;

export const CreateNamedVersionSchema = z.object({
  name: singleLineText().min(1).max(255),
});
export type CreateNamedVersionInput = z.infer<typeof CreateNamedVersionSchema>;

// ─── Wiki Page Comments ─────────────────────────────────

export const CreateWikiCommentSchema = z.object({
  body: multilineText().min(1).max(10000),
  highlightId: z.string().min(1).max(100),
  selectionStart: z.any().optional(),
  selectionEnd: z.any().optional(),
});
export type CreateWikiCommentInput = z.infer<typeof CreateWikiCommentSchema>;

export const UpdateWikiCommentSchema = z.object({
  body: multilineText().min(1).max(10000),
});
export type UpdateWikiCommentInput = z.infer<typeof UpdateWikiCommentSchema>;

export const WikiCommentQuerySchema = z.object({
  resolved: QueryBooleanSchema.optional(),
});
export type WikiCommentQueryInput = z.infer<typeof WikiCommentQuerySchema>;

// ─── Wiki Page Sharing ──────────────────────────────────

export const CreateWikiShareSchema = z.object({
  password: z.string().max(100).optional(),
});
export type CreateWikiShareInput = z.infer<typeof CreateWikiShareSchema>;

export const UpdateWikiShareSchema = z.object({
  enabled: z.boolean().optional(),
  password: z.string().max(100).nullable().optional(),
});
export type UpdateWikiShareInput = z.infer<typeof UpdateWikiShareSchema>;

export const ValidateWikiShareSchema = z.object({
  password: z.string().max(100),
});
export type ValidateWikiShareInput = z.infer<typeof ValidateWikiShareSchema>;
