import { z } from "zod";
import { WorkspaceRoleEnum } from "./workspace-member.js";

export const CreateInviteSchema = z.object({
  email: z.string().email("Invalid email address").optional(),
  role: WorkspaceRoleEnum.default("MEMBER"),
  expiresAt: z.string().datetime().optional(),
  maxUses: z.number().int().min(1).nullable().optional(),
});
export type CreateInviteInput = z.infer<typeof CreateInviteSchema>;

// Optional invitation context carried through a resent verification email.
export const ResendVerificationSchema = z
  .object({ inviteToken: z.string().min(1).max(200).optional() })
  .optional();
export type ResendVerificationInput = z.infer<typeof ResendVerificationSchema>;

export type WorkspaceAdmissionDenialReason =
  | "not_found"
  | "expired"
  | "exhausted"
  | "disabled"
  | "email_mismatch"
  | "domain_not_allowed"
  | "member_limit";

export interface WorkspaceAdmissionWorkspace {
  id: string;
  name: string;
  slug: string;
}

// Result of joining a workspace through an invitation. "unavailable" is only
// reported by registration, whose account remains committed after an
// unexpected admission failure; opening the invitation again retries.
export type WorkspaceAdmissionResult =
  | {
      status: "joined";
      workspace: WorkspaceAdmissionWorkspace;
      role: "ADMIN" | "MEMBER" | "VIEWER";
      alreadyMember: boolean;
    }
  | {
      status: "verification_required";
      workspace: WorkspaceAdmissionWorkspace;
      email: string;
    }
  | {
      status: "approval_pending";
      workspace: WorkspaceAdmissionWorkspace;
      requestId: string;
      requestedAt: string;
    }
  | {
      status: "denied";
      reason: WorkspaceAdmissionDenialReason;
      message: string;
    }
  | { status: "unavailable"; message: string };
