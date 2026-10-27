import { z } from "zod";

const HexColorSchema = z
  .string()
  .regex(
    /^#(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i,
    "Color must be a valid hex color",
  );

export const CreateLabelSchema = z.object({
  name: z
    .string()
    .min(1, "Label name is required")
    .max(100, "Label name must be 100 characters or less"),
  color: HexColorSchema,
});
export type CreateLabelInput = z.infer<typeof CreateLabelSchema>;

export const UpdateLabelSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  color: HexColorSchema.optional(),
});
export type UpdateLabelInput = z.infer<typeof UpdateLabelSchema>;
