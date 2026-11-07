import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, ApiError, isIdentityChangedError } from "@/lib/api-client";
import { useAuthStore } from "@/stores/auth-store";
import type { BackupExportRequest, RestoreSummary } from "@pm/shared";
import { apiBase } from "@/lib/api-url";

export function useExportBackup(wid: string) {
  return useMutation({
    mutationFn: async (data: BackupExportRequest) => {
      const token = useAuthStore.getState().accessToken;
      const baseUrl = apiBase();
      const response = await fetch(`${baseUrl}/workspaces/${wid}/backup/export`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(data),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(
          (body as any).message || "Export failed",
        );
      }
      const blob = await response.blob();
      const disposition = response.headers.get("Content-Disposition") ?? "";
      const match = disposition.match(/filename="?([^"]+)"?/);
      const filename = match?.[1] ?? "backup.json";
      return { blob, filename };
    },
  });
}

/**
 * A preview or restore refused (429 with Retry-After) because backup uploads
 * from this account are paused after one that was too slow.
 */
export function isBackupUploadPaused(error: unknown): error is ApiError {
  return (
    error instanceof ApiError &&
    error.statusCode === 429 &&
    error.code === "BACKUP_UPLOAD_COOLDOWN"
  );
}

/**
 * Report a failed preview or restore once, in place of the app-wide error
 * toast. It runs from the mutation's own options, so a failure is reported
 * even after the backup page has gone or started another upload. A pause is
 * left to the page, which counts it down while it is shown.
 */
function reportUploadFailure(fallback: string) {
  return (error: Error) => {
    if (isIdentityChangedError(error) || isBackupUploadPaused(error)) return;
    toast.error(error.message || fallback);
  };
}

export function usePreviewRestore(wid: string) {
  return useMutation({
    mutationFn: async (file: File) => {
      const formData = new FormData();
      formData.append("file", file);
      const res = await api
        .post(`workspaces/${wid}/backup/preview`, { body: formData, timeout: 60_000 })
        .json<{ data: RestoreSummary }>();
      return res.data;
    },
    onError: reportUploadFailure("Failed to preview backup"),
  });
}

export function useExecuteRestore(wid: string) {
  return useMutation({
    mutationFn: async (file: File) => {
      const formData = new FormData();
      formData.append("file", file);
      const res = await api
        .post(`workspaces/${wid}/backup/restore`, { body: formData, timeout: 120_000 })
        .json<{ data: RestoreSummary }>();
      return res.data;
    },
    onError: reportUploadFailure("Restore failed"),
  });
}
