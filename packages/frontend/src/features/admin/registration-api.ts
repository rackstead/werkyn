import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { UpdateRegistrationConfigInput } from "@pm/shared";
import { api } from "@/lib/api-client";
import { queryKeys } from "@/lib/query-keys";

export interface RegistrationConfig {
  id: string;
  privacyPreserving: boolean;
  createdAt: string;
  updatedAt: string;
}

export function useRegistrationConfig() {
  return useQuery({
    queryKey: queryKeys.registrationConfig,
    queryFn: () =>
      api
        .get("admin/registration/config")
        .json<{ data: RegistrationConfig }>(),
  });
}

export function useUpdateRegistrationConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: UpdateRegistrationConfigInput) =>
      api
        .patch("admin/registration/config", { json: data })
        .json<{ data: RegistrationConfig }>(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.registrationConfig });
    },
  });
}
