import { useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { api } from "@/lib/api-client";
import { queryClient } from "@/lib/query-client";
import { queryKeys } from "@/lib/query-keys";
import { useAuthStore } from "@/stores/auth-store";
import { toast } from "sonner";
import type {
  CreateWorkspaceInput,
  UpdateWorkspaceInput,
  UpdateWorkspaceMemberInput,
  CreateInviteInput,
  WorkspaceAdmissionResult,
} from "@pm/shared";
import type { WorkspaceMembership } from "@/stores/auth-store";

interface Workspace {
  id: string;
  name: string;
  slug: string;
  logoUrl: string | null;
  createdAt: string;
  updatedAt: string;
  _count?: { members: number; projects: number };
}

interface WorkspaceMember {
  id: string;
  userId: string;
  workspaceId: string;
  role: "ADMIN" | "MEMBER" | "VIEWER";
  joinedAt: string;
  user: {
    id: string;
    email: string;
    displayName: string;
    avatarUrl: string | null;
  };
}

export function useCreateWorkspace() {
  const navigate = useNavigate();
  return useMutation({
    mutationFn: (data: CreateWorkspaceInput) =>
      api.post("workspaces", { json: data }).json<{ data: Workspace }>(),
    onSuccess: async (res) => {
      await useAuthStore.getState().refresh();
      queryClient.invalidateQueries({ queryKey: queryKeys.workspaces });
      toast.success("Workspace created");
      navigate({
        to: "/$workspaceSlug",
        params: { workspaceSlug: res.data.slug },
      });
    },
  });
}

export function useUpdateWorkspace(wid: string) {
  return useMutation({
    mutationFn: (data: UpdateWorkspaceInput) =>
      api
        .patch(`workspaces/${wid}`, { json: data })
        .json<{ data: Workspace }>(),
    onSuccess: async () => {
      await useAuthStore.getState().refresh();
      queryClient.invalidateQueries({ queryKey: queryKeys.workspaces });
      queryClient.invalidateQueries({ queryKey: queryKeys.workspace(wid) });
      toast.success("Workspace updated");
    },
  });
}

export function useDeleteWorkspace(wid: string) {
  const navigate = useNavigate();
  return useMutation({
    mutationFn: () => api.delete(`workspaces/${wid}`),
    onSuccess: async () => {
      await useAuthStore.getState().refresh();
      queryClient.invalidateQueries({ queryKey: queryKeys.workspaces });
      toast.success("Workspace deleted");
      navigate({ to: "/" });
    },
  });
}

export function useWorkspaceMembers(wid: string) {
  return useQuery({
    queryKey: queryKeys.workspaceMembers(wid),
    queryFn: () =>
      api
        .get(`workspaces/${wid}/members`)
        .json<{ data: WorkspaceMember[] }>(),
    enabled: !!wid,
  });
}

export function useUpdateMemberRole(wid: string) {
  return useMutation({
    mutationFn: ({
      userId,
      ...data
    }: UpdateWorkspaceMemberInput & { userId: string }) =>
      api
        .patch(`workspaces/${wid}/members/${userId}`, { json: data })
        .json<{ data: WorkspaceMember }>(),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.workspaceMembers(wid),
      });
      toast.success("Role updated");
    },
  });
}

export function useRemoveMember(wid: string) {
  return useMutation({
    mutationFn: (userId: string) =>
      api.delete(`workspaces/${wid}/members/${userId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.workspaceMembers(wid),
      });
      toast.success("Member removed");
    },
  });
}

// ─── Invites ────────────────────────────────────────────

interface WorkspaceInvite {
  id: string;
  workspaceId: string;
  email: string | null;
  role: "ADMIN" | "MEMBER" | "VIEWER";
  token: string;
  expiresAt: string | null;
  maxUses: number | null;
  useCount: number;
  createdAt: string;
}

interface InviteDetails {
  id: string;
  workspace: { id: string; name: string; slug: string; logoUrl: string | null };
  role: "ADMIN" | "MEMBER" | "VIEWER";
  email: string | null;
}

export function useWorkspaceInvites(wid: string) {
  return useQuery({
    queryKey: queryKeys.invites(wid),
    queryFn: () =>
      api
        .get(`workspaces/${wid}/invites`)
        .json<{ data: WorkspaceInvite[] }>(),
    enabled: !!wid,
  });
}

export function useCreateInvite(wid: string) {
  return useMutation({
    mutationFn: (data: CreateInviteInput) =>
      api
        .post(`workspaces/${wid}/invites`, { json: data })
        .json<{ data: WorkspaceInvite }>(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.invites(wid) });
    },
  });
}

export function useRevokeInvite(wid: string) {
  return useMutation({
    mutationFn: (inviteId: string) => api.delete(`invites/${inviteId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.invites(wid) });
      toast.success("Invite revoked");
    },
  });
}

export function useInviteDetails(token: string) {
  return useQuery({
    queryKey: ["invite", token],
    queryFn: () =>
      api.get(`invites/${token}`).json<{ data: InviteDetails }>(),
    enabled: !!token,
    retry: false,
  });
}

type AcceptInviteResponse = {
  data: Exclude<WorkspaceAdmissionResult, { status: "denied" | "unavailable" }> & {
    userId: string;
    workspaces?: WorkspaceMembership[];
  };
};

/** Remembers an admission result for this account and invite in memory only. */
export function rememberInviteAdmission(
  userId: string,
  token: string,
  admission: WorkspaceAdmissionResult,
) {
  queryClient.setQueryData(
    queryKeys.inviteAdmission(userId, token),
    admission,
  );
}

/** The current account's latest admission result for an invite, if any. */
export function useInviteAdmission(token: string) {
  const userId = useAuthStore((s) => s.user?.id ?? "");
  const { data } = useQuery<WorkspaceAdmissionResult | null>({
    queryKey: queryKeys.inviteAdmission(userId, token),
    // Populated by registration and acceptance; never fetched.
    queryFn: () => null,
    enabled: false,
    staleTime: Infinity,
  });
  return userId ? (data ?? null) : null;
}

export function useAcceptInvite() {
  const navigate = useNavigate();
  return useMutation({
    mutationFn: (token: string) =>
      api.post(`invites/${token}/accept`).json<AcceptInviteResponse>(),
    onSuccess: async (res, token) => {
      const result = res.data;
      // The response belongs to the account that sent it. If this browser has
      // since switched or signed out, it must not change the current session.
      if (useAuthStore.getState().user?.id !== result.userId) return;
      rememberInviteAdmission(result.userId, token, result);
      if (result.status !== "joined") return;
      useAuthStore.setState((state) =>
        state.user?.id === result.userId && result.workspaces
          ? { workspaces: result.workspaces }
          : state,
      );
      queryClient.invalidateQueries({ queryKey: queryKeys.workspaces });
      toast.success(
        result.alreadyMember
          ? `You're already a member of ${result.workspace.name}`
          : `Joined ${result.workspace.name}`,
      );
      navigate({
        to: "/$workspaceSlug",
        params: { workspaceSlug: result.workspace.slug },
      });
    },
    onError: (_error, token) => {
      // Show the current refusal rather than an earlier pending state.
      const userId = useAuthStore.getState().user?.id;
      if (userId)
        queryClient.removeQueries({
          queryKey: queryKeys.inviteAdmission(userId, token),
          exact: true,
        });
    },
  });
}

// ─── Join requests (administrator review) ───────────────

export interface AdmissionRequest {
  id: string;
  createdAt: string;
  user: {
    id: string;
    email: string;
    displayName: string;
    avatarUrl: string | null;
    emailVerified: boolean;
  };
  invite: {
    id: string;
    role: "ADMIN" | "MEMBER" | "VIEWER";
    email: string | null;
    expiresAt: string | null;
    maxUses: number | null;
    useCount: number;
  };
}

export function useAdmissionRequests(wid: string) {
  return useQuery({
    queryKey: queryKeys.admissionRequests(wid),
    queryFn: () =>
      api
        .get(`workspaces/${wid}/admission-requests`)
        .json<{ data: AdmissionRequest[] }>(),
    enabled: !!wid,
  });
}

function invalidateAdmission(wid: string) {
  queryClient.invalidateQueries({ queryKey: queryKeys.admissionRequests(wid) });
  queryClient.invalidateQueries({ queryKey: queryKeys.invites(wid) });
  queryClient.invalidateQueries({ queryKey: queryKeys.workspaceMembers(wid) });
}

export function useApproveAdmissionRequest(wid: string) {
  return useMutation({
    mutationFn: (requestId: string) =>
      api
        .post(`workspaces/${wid}/admission-requests/${requestId}/approve`)
        .json(),
    onSuccess: () => toast.success("Join request approved"),
    // A refused or stale decision also refreshes the queue and counters.
    onSettled: () => invalidateAdmission(wid),
  });
}

export function useRejectAdmissionRequest(wid: string) {
  return useMutation({
    mutationFn: (requestId: string) =>
      api.post(`workspaces/${wid}/admission-requests/${requestId}/reject`),
    onSuccess: () => toast.success("Join request rejected"),
    onSettled: () => invalidateAdmission(wid),
  });
}
