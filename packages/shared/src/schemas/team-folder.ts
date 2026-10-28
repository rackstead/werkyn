import { z } from "zod";
import { multilineText, singleLineText } from "./common.js";

export const CreateTeamFolderSchema = z.object({
  name: singleLineText()
    .min(1, "Name is required")
    .max(255, "Name must be 255 characters or less"),
  description: multilineText().max(1000).optional(),
  memberIds: z.array(z.string()).optional(),
});
export type CreateTeamFolderInput = z.infer<typeof CreateTeamFolderSchema>;

export const UpdateTeamFolderSchema = z.object({
  name: singleLineText()
    .min(1)
    .max(255, "Name must be 255 characters or less")
    .optional(),
  description: multilineText().max(1000).nullable().optional(),
});
export type UpdateTeamFolderInput = z.infer<typeof UpdateTeamFolderSchema>;

export const AddTeamFolderMemberSchema = z.object({
  userId: z.string().min(1, "User ID is required"),
});
export type AddTeamFolderMemberInput = z.infer<typeof AddTeamFolderMemberSchema>;
