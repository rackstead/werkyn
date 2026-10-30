import { useMutation } from "@tanstack/react-query";
import { useAuthStore } from "@/stores/auth-store";
import { apiBase } from "@/lib/api-url";

interface UploadInput {
  file: File;
  purpose?: string;
  workspaceId: string;
  spaceId?: string;
}

interface UploadResult {
  data: { url: string };
}

export function useUploadFile() {
  return useMutation({
    mutationFn: async ({ file, purpose, workspaceId, spaceId }: UploadInput): Promise<UploadResult> => {
      const token = useAuthStore.getState().accessToken;
      const baseUrl = apiBase();

      const formData = new FormData();
      formData.append("workspaceId", workspaceId);
      if (purpose) {
        formData.append("purpose", purpose);
      }
      if (spaceId) {
        formData.append("spaceId", spaceId);
      }
      formData.append("file", file);

      const response = await fetch(`${baseUrl}/uploads`, {
        method: "POST",
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        credentials: "include",
        body: formData,
      });

      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(
          (body as { message?: string }).message || "Upload failed",
        );
      }

      return response.json() as Promise<UploadResult>;
    },
  });
}
