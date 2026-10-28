import { z } from "zod";
import { singleLineText } from "./common.js";

const HexColorSchema = z
  .string()
  .regex(
    /^#(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i,
    "Color must be a valid hex color",
  );

export const CreateStatusColumnSchema = z.object({
  name: singleLineText()
    .min(1, "Status name is required")
    .max(100, "Status name must be 100 characters or less"),
  color: HexColorSchema.optional(),
  isCompletion: z.boolean().default(false),
});
export type CreateStatusColumnInput = z.infer<typeof CreateStatusColumnSchema>;

export const UpdateStatusColumnSchema = z.object({
  name: singleLineText().min(1).max(100).optional(),
  color: HexColorSchema.optional(),
  isCompletion: z.boolean().optional(),
});
export type UpdateStatusColumnInput = z.infer<typeof UpdateStatusColumnSchema>;

export const ReorderSchema = z.object({
  orderedIds: z.array(z.string().min(1)).min(1),
});
export type ReorderInput = z.infer<typeof ReorderSchema>;
