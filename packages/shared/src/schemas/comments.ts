import { z } from "zod";
import { multilineText } from "./common.js";

export const CreateCommentSchema = z.object({
  body: multilineText()
    .min(1, "Comment body is required")
    .max(10000, "Comment must be 10000 characters or less"),
});
export type CreateCommentInput = z.infer<typeof CreateCommentSchema>;

export const UpdateCommentSchema = z.object({
  body: multilineText().min(1).max(10000),
});
export type UpdateCommentInput = z.infer<typeof UpdateCommentSchema>;

export const CommentQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type CommentQueryInput = z.infer<typeof CommentQuerySchema>;
