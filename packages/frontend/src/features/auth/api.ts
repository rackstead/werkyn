import { useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { api } from "@/lib/api-client";
import { useAuthStore, whenLoggedOut } from "@/stores/auth-store";
import { router } from "@/lib/router";
import { toast } from "sonner";
import { queryKeys } from "@/lib/query-keys";
import type { WorkspaceAdmissionResult } from "@pm/shared";
import { rememberInviteAdmission } from "@/features/workspaces/api";

interface User {
  id: string;
  email: string;
  displayName: string;
  avatarUrl: string | null;
  jobTitle: string | null;
  phone: string | null;
  timezone: string | null;
  emailVerified: boolean;
}

interface WorkspaceMembership {
  id: string;
  workspaceId: string;
  role: "ADMIN" | "MEMBER" | "VIEWER";
  workspace: {
    id: string;
    name: string;
    slug: string;
    logoUrl: string | null;
  };
}

interface AuthResponse {
  data: {
    user: User;
    accessToken: string;
    workspaces: WorkspaceMembership[];
    admission?: WorkspaceAdmissionResult;
  };
}

export function useLogin(inviteToken?: string) {
  const navigate = useNavigate();
  return useMutation({
    mutationFn: async (data: { email: string; password: string }) => {
      // A sign-out still revoking its session must not clear this one's cookie.
      await whenLoggedOut();
      return api.post("auth/login", { json: data }).json<AuthResponse>();
    },
    onSuccess: async (res) => {
      const { user, accessToken, workspaces } = res.data;
      useAuthStore.getState().setAuth(user, accessToken, workspaces);
      await router.invalidate();
      if (inviteToken) {
        navigate({ to: "/invite/$token", params: { token: inviteToken } });
      } else {
        navigate({ to: "/" });
      }
    },
  });
}

export function useRegister(inviteToken?: string) {
  const navigate = useNavigate();
  return useMutation({
    mutationFn: async (data: {
      displayName: string;
      email: string;
      password: string;
    }) => {
      await whenLoggedOut();
      return api
        .post("auth/register", {
          json: { ...data, inviteToken },
        })
        .json<AuthResponse>();
    },
    onSuccess: async (res) => {
      const { user, accessToken, workspaces, admission } = res.data;
      useAuthStore.getState().setAuth(user, accessToken, workspaces);
      await router.invalidate();
      if (inviteToken && admission) {
        rememberInviteAdmission(user.id, inviteToken, admission);
        if (admission.status === "joined") {
          navigate({
            to: "/$workspaceSlug",
            params: { workspaceSlug: admission.workspace.slug },
          });
        } else {
          // Verification, approval or a refusal is explained on the invite.
          navigate({ to: "/invite/$token", params: { token: inviteToken } });
        }
        return;
      }
      navigate({ to: "/" });
    },
  });
}

export function useForgotPassword() {
  return useMutation({
    mutationFn: (data: { email: string }) =>
      api.post("auth/forgot-password", { json: data }).json(),
  });
}

export function useResetPassword() {
  return useMutation({
    mutationFn: ({ token, password }: { token: string; password: string }) =>
      api.post(`auth/reset-password/${token}`, { json: { password } }).json(),
  });
}

export function useVerifyEmail() {
  return useMutation({
    mutationFn: ({ token }: { token: string }) =>
      api
        .post(`auth/verify-email/${token}`)
        .json<{ data: { user: User } }>(),
    onSuccess: (res) => {
      const verifiedUser = res.data.user;
      useAuthStore.setState((state) =>
        state.user?.id === verifiedUser.id
          ? { user: { ...state.user, emailVerified: verifiedUser.emailVerified } }
          : state,
      );
      toast.success("Email verified successfully");
    },
  });
}

export function useResendVerification(inviteToken?: string) {
  return useMutation({
    mutationFn: () =>
      api
        .post("auth/resend-verification", {
          json: inviteToken ? { inviteToken } : {},
        })
        .json(),
    onSuccess: () => toast.success("Verification email sent"),
    onError: () => toast.error("Failed to send verification email"),
  });
}

// ─── SSO Info ───

export interface SsoConnectorInfo {
  connectorId: string;
  name: string;
  type: string;
}

interface SsoInfoResponse {
  data: {
    enabled: boolean;
    passwordLoginEnabled: boolean;
    connectors: SsoConnectorInfo[];
    hasUsers: boolean;
  };
}

export function useSsoInfo() {
  return useQuery({
    queryKey: queryKeys.ssoInfo,
    queryFn: () => api.get("auth/sso-info").json<SsoInfoResponse>(),
    staleTime: 60_000,
  });
}
