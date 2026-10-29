import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import { queryKeys } from "@/lib/query-keys";
import { useAuthStore } from "@/stores/auth-store";

interface UserProfile {
  id: string;
  email: string;
  displayName: string;
  avatarUrl: string | null;
  jobTitle: string | null;
  phone: string | null;
  timezone: string | null;
  emailVerified: boolean;
}

export function useProfile() {
  return useQuery({
    queryKey: queryKeys.me,
    queryFn: async () => {
      const res = await api.get("users/me").json<{ data: UserProfile }>();
      return res.data;
    },
  });
}

export function useUpdateProfile() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (data: {
      displayName?: string;
      avatarUrl?: string | null;
      jobTitle?: string | null;
      phone?: string | null;
      timezone?: string | null;
    }) => {
      const res = await api
        .patch("users/me", { json: data })
        .json<{ data: UserProfile }>();
      return res.data;
    },
    onSuccess: (updatedUser) => {
      // The profile of the account that is signed in now, and no other.
      const current = useAuthStore.getState().user;
      if (current?.id !== updatedUser.id) return;
      queryClient.setQueryData(queryKeys.me, updatedUser);
      useAuthStore.setState({
        user: { ...current, ...updatedUser },
      });
    },
  });
}

export function useChangePassword() {
  return useMutation({
    mutationFn: async (data: {
      userId: string;
      currentPassword: string;
      newPassword: string;
    }) => {
      const res = await api
        .patch(`users/${data.userId}/password`, {
          json: {
            currentPassword: data.currentPassword,
            newPassword: data.newPassword,
          },
        })
        .json<{ message: string }>();
      return res;
    },
  });
}
