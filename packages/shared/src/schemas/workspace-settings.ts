import { z } from "zod";
import { INT32_MAX, singleLineText } from "./common.js";

export const UpdateWorkspaceSettingsSchema = z.object({
  defaultRole: z.enum(["ADMIN", "MEMBER", "VIEWER"]).optional(),
  invitesEnabled: z.boolean().optional(),
  requireAdminApproval: z.boolean().optional(),
  allowedEmailDomains: z
    .array(singleLineText().min(1).max(255))
    .optional(),
  maxMembers: z.number().int().positive().max(INT32_MAX).nullable().optional(),
  enabledModules: z.array(z.enum(["drive", "wiki", "time", "chat"])).optional(),
});
export type UpdateWorkspaceSettingsInput = z.infer<typeof UpdateWorkspaceSettingsSchema>;
