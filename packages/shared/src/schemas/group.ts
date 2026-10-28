import { z } from "zod";
import { multilineText, singleLineText } from "./common.js";

export const CreateGroupSchema = z.object({
  name: singleLineText()
    .min(1, "Name is required")
    .max(100, "Name must be 100 characters or less"),
  description: multilineText().max(500).optional(),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, "Invalid hex color")
    .optional(),
  memberIds: z.array(z.string()).optional(),
});
export type CreateGroupInput = z.infer<typeof CreateGroupSchema>;

export const UpdateGroupSchema = z.object({
  name: singleLineText()
    .min(1)
    .max(100, "Name must be 100 characters or less")
    .optional(),
  description: multilineText().max(500).nullable().optional(),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, "Invalid hex color")
    .optional(),
});
export type UpdateGroupInput = z.infer<typeof UpdateGroupSchema>;

export const AddGroupMemberSchema = z.object({
  userId: z.string().min(1, "User ID is required"),
});
export type AddGroupMemberInput = z.infer<typeof AddGroupMemberSchema>;

export const AddTeamFolderGroupSchema = z.object({
  groupId: z.string().min(1, "Group ID is required"),
});
export type AddTeamFolderGroupInput = z.infer<typeof AddTeamFolderGroupSchema>;
