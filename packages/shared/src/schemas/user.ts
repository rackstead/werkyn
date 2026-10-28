import { z } from "zod";
import { singleLineText } from "./common.js";

export const UpdateUserSchema = z.object({
  displayName: singleLineText()
    .min(1, "Display name is required")
    .max(100, "Display name must be 100 characters or less")
    .optional(),
  avatarUrl: z.string().min(1).nullable().optional(),
  jobTitle: singleLineText().max(100).nullable().optional(),
  phone: singleLineText().max(30).nullable().optional(),
  timezone: singleLineText().max(50).nullable().optional(),
});
export type UpdateUserInput = z.infer<typeof UpdateUserSchema>;
