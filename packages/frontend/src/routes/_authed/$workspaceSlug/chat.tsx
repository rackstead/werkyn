import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { z } from "zod";
import { useEffect, useMemo } from "react";
import { useAuthStore } from "@/stores/auth-store";
import { useWorkspaceSettings } from "@/features/admin/api";
import { useWorkspaceMembers } from "@/features/workspaces/api";
import { ChatLayout } from "@/features/chat/components/chat-layout";
import { useWorkspaceRealtime } from "@/hooks/use-workspace-realtime";

const chatSearchSchema = z.object({
  channelId: z.string().optional(),
});

export const Route = createFileRoute("/_authed/$workspaceSlug/chat")({
  validateSearch: chatSearchSchema,
  component: ChatRoute,
});

function ChatRoute() {
  const { workspaceSlug } = Route.useParams();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const navTo = useNavigate();

  const workspaces = useAuthStore((s) => s.workspaces);
  const user = useAuthStore((s) => s.user);
  const workspace = workspaces.find(
    (w) => w.workspace.slug === workspaceSlug,
  )?.workspace;
  const membership = workspaces.find(
    (w) => w.workspace.slug === workspaceSlug,
  );

  const { data: settingsData } = useWorkspaceSettings(workspace?.id ?? "");
  const enabledModules = settingsData?.data?.enabledModules;

  useEffect(() => {
    if (enabledModules && !enabledModules.includes("chat")) {
      navTo({ to: "/$workspaceSlug", params: { workspaceSlug } });
    }
  }, [enabledModules, navTo, workspaceSlug]);

  useWorkspaceRealtime(workspace?.id);

  const { data: membersData } = useWorkspaceMembers(workspace?.id ?? "");
  const workspaceMembers = useMemo(
    () =>
      (membersData?.data ?? []).map((m) => ({
        id: m.user.id,
        displayName: m.user.displayName,
        email: m.user.email,
        avatarUrl: m.user.avatarUrl,
      })),
    [membersData],
  );

  if (enabledModules && !enabledModules.includes("chat")) {
    return null;
  }

  if (!workspace || !user) {
    return (
      <div className="flex items-center justify-center p-12">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      </div>
    );
  }

  const handleChannelSelect = (channelId: string) => {
    navigate({
      search: channelId ? { channelId } : { channelId: undefined },
    });
  };

  return (
    <ChatLayout
      // A workspace gets a fresh chat: no panel, dialog or draft carries over.
      key={workspace.id}
      workspaceId={workspace.id}
      channelId={search.channelId}
      currentUserId={user.id}
      isAdmin={membership?.role === "ADMIN"}
      workspaceMembers={workspaceMembers}
      onChannelSelect={handleChannelSelect}
    />
  );
}
