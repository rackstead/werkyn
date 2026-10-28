import { useEffect } from "react";
import { useRealtimeClient } from "@/components/providers/realtime-provider";
import { queryClient } from "@/lib/query-client";
import { queryKeys } from "@/lib/query-keys";

/**
 * Keeps the connection subscribed to a workspace's events (wiki, presence,
 * chat channels). The workspace layout is the single owner of this
 * subscription, so it survives every route change inside the workspace.
 */
export function useWorkspaceSubscription(workspaceId: string | undefined) {
  const client = useRealtimeClient();

  useEffect(() => {
    if (!client || !workspaceId) return;
    client.subscribeWorkspace(workspaceId);
    return () => client.unsubscribeWorkspace(workspaceId);
  }, [client, workspaceId]);
}

/**
 * Refreshes the workspace's task summaries when a task event arrives. It only
 * listens: the subscription itself belongs to the workspace layout.
 */
export function useWorkspaceRealtime(workspaceId: string | undefined) {
  const client = useRealtimeClient();

  useEffect(() => {
    if (!client || !workspaceId) return;

    const handler = () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.dashboard(workspaceId),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.myTasks(workspaceId),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.projects(workspaceId),
      });
    };

    client.on("task_created", handler);
    client.on("task_updated", handler);
    client.on("task_deleted", handler);
    client.on("task_moved", handler);

    return () => {
      client.off("task_created", handler);
      client.off("task_updated", handler);
      client.off("task_deleted", handler);
      client.off("task_moved", handler);
    };
  }, [client, workspaceId]);
}
