import { useWorkspaceSubscription } from "@/hooks/use-workspace-realtime";
import { useNotificationRealtime } from "@/hooks/use-notification-realtime";
import { useWikiRealtime } from "@/features/wiki/hooks/use-wiki-realtime";

/**
 * The workspace's always-on realtime consumers: the workspace subscription,
 * pushed notifications and wiki updates. Render it inside RealtimeProvider;
 * hooks called by the component that renders the provider get no client.
 */
export function WorkspaceRealtime({ workspaceId }: { workspaceId: string }) {
  useWorkspaceSubscription(workspaceId);
  useNotificationRealtime();
  useWikiRealtime(workspaceId);
  return null;
}
