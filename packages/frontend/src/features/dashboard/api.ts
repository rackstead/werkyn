import { useQuery, useMutation } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import { queryClient } from "@/lib/query-client";
import { queryKeys } from "@/lib/query-keys";
import { toast } from "sonner";
import type { Notification } from "@/features/notifications/api";

export interface DashboardProject {
  id: string;
  name: string;
  color: string | null;
  archived: boolean;
  totalTasks: number;
  completedTasks: number;
  overdueTasks: number;
}

export function useDashboard(wid: string) {
  return useQuery({
    queryKey: queryKeys.dashboard(wid),
    queryFn: () =>
      api
        .get(`workspaces/${wid}/dashboard`)
        .json<{ data: DashboardProject[] }>(),
    enabled: !!wid,
  });
}

// ─── Workspace Activity ────────────────────────────────

export interface WorkspaceActivityEntry {
  id: string;
  taskId: string;
  action: string;
  details: Record<string, unknown> | null;
  createdAt: string;
  actor: { id: string; displayName: string; avatarUrl: string | null } | null;
  task: {
    id: string;
    title: string;
    project: { id: string; name: string; color: string | null };
  };
}

export function useWorkspaceActivity(wid: string) {
  return useQuery({
    queryKey: queryKeys.workspaceActivity(wid),
    queryFn: () =>
      api
        .get(`workspaces/${wid}/activity`, {
          searchParams: { limit: "30" },
        })
        .json<{
          data: WorkspaceActivityEntry[];
          pagination: {
            page: number;
            limit: number;
            /** Exact up to 1,000 rows; 1,000 when totalCapped. */
            total: number;
            totalPages: number;
            totalCapped: boolean;
            hasMore: boolean;
          };
        }>(),
    enabled: !!wid,
  });
}

// ─── Mention Notifications ────────────────────────────

export function useMentionNotifications() {
  return useQuery({
    queryKey: queryKeys.mentionNotifications,
    queryFn: () =>
      api
        .get("notifications", {
          searchParams: {
            type: "CHAT_MENTION,COMMENT_MENTION",
            limit: "10",
          },
        })
        .json<{ data: Notification[]; nextCursor?: string }>(),
    select: (res) => res.data,
  });
}

// ─── Dashboard Preferences ────────────────────────────

export interface WidgetConfigItem {
  id: string;
  enabled: boolean;
}

export interface DashboardPreference {
  id: string;
  widgetOrder: WidgetConfigItem[];
}

export function useDashboardPreferences(wid: string) {
  return useQuery({
    queryKey: queryKeys.dashboardPreferences(wid),
    queryFn: () =>
      api
        .get(`workspaces/${wid}/dashboard/preferences`)
        .json<{ data: DashboardPreference | null }>(),
    enabled: !!wid,
  });
}

export function useUpdateDashboardPreferences(wid: string) {
  return useMutation({
    mutationFn: (data: { widgetOrder: WidgetConfigItem[] }) =>
      api
        .patch(`workspaces/${wid}/dashboard/preferences`, { json: data })
        .json<{ data: DashboardPreference }>(),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.dashboardPreferences(wid),
      });
      toast.success("Dashboard preferences saved");
    },
    onError: () => {
      toast.error("Failed to save dashboard preferences");
    },
  });
}
