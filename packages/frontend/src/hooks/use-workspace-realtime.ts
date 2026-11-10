import { useEffect } from "react";
import { useRealtimeClient } from "@/components/providers/realtime-provider";
import { queryClient } from "@/lib/query-client";
import { queryKeys } from "@/lib/query-keys";
import type { RealtimeEnvelope } from "@/lib/realtime-events";

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
 * Refreshes dashboard and My Tasks when a content-free invalidation arrives
 * for this workspace. The subscription itself belongs to the workspace layout.
 */
export function useWorkspaceRealtime(workspaceId: string | undefined) {
  const client = useRealtimeClient();

  useEffect(() => {
    if (!client || !workspaceId) return;

    const handler = (message: RealtimeEnvelope) => {
      if (message.workspaceId !== workspaceId) return;
      queryClient.invalidateQueries({
        queryKey: queryKeys.dashboard(workspaceId),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.myTasks(workspaceId),
      });
    };

    client.on("workspace_tasks_invalidated", handler);

    return () => {
      client.off("workspace_tasks_invalidated", handler);
    };
  }, [client, workspaceId]);
}
