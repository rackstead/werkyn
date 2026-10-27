import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CreateApiKeyInput } from "@pm/shared";
import { api } from "@/lib/api-client";
import { queryKeys } from "@/lib/query-keys";
import { useAuthStore } from "@/stores/auth-store";

export interface ApiKeyMetadata {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export function useApiKeys() {
  const userId = useAuthStore((state) => state.user?.id);
  return useQuery({
    queryKey: queryKeys.apiKeys(userId ?? ""),
    queryFn: () => api.get("api-keys").json<{ data: ApiKeyMetadata[] }>(),
    enabled: !!userId,
  });
}

export function useCreateApiKey() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateApiKeyInput) =>
      api
        .post("api-keys", { json: input })
        .json<{ data: ApiKeyMetadata & { key: string } }>(),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: ["api-keys"] });
    },
  });
}

export function useRevokeApiKey() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`api-keys/${id}`),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: ["api-keys"] });
    },
  });
}
