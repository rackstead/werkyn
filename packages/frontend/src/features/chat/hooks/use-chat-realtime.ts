import { useEffect, useCallback } from "react";
import { useRealtimeClient } from "@/components/providers/realtime-provider";
import { queryClient } from "@/lib/query-client";
import { queryKeys } from "@/lib/query-keys";
import type { ChatMessage } from "../api";

interface ChatRealtimeMessage {
  event: string;
  data: {
    message?: ChatMessage;
    messageId?: string;
    channelId?: string;
    channel?: unknown;
    userId?: string;
    displayName?: string;
    parentId?: string;
  };
  channelId?: string;
}

export function useChatRealtime(
  workspaceId: string | undefined,
  channelId: string | undefined,
  onTyping?: (userId: string, displayName: string) => void,
) {
  const client = useRealtimeClient();

  const handleEvent = useCallback(
    (msg: unknown) => {
      const { event, data } = msg as ChatRealtimeMessage;

      switch (event) {
        case "chat_message_created":
          if (data.channelId) {
            queryClient.invalidateQueries({
              queryKey: queryKeys.chatMessages(data.channelId),
            });
            // Also invalidate unread counts
            if (workspaceId) {
              queryClient.invalidateQueries({
                queryKey: queryKeys.chatUnread(workspaceId),
              });
            }
            // If it's a thread reply, invalidate the thread and parent message list
            if (data.message?.parentId) {
              queryClient.invalidateQueries({
                queryKey: queryKeys.chatThread(data.message.parentId),
              });
            }
          }
          break;

        case "chat_message_updated":
          if (data.channelId) {
            queryClient.invalidateQueries({
              queryKey: queryKeys.chatMessages(data.channelId),
            });
          }
          break;

        case "chat_message_deleted":
          if (data.channelId) {
            queryClient.invalidateQueries({
              queryKey: queryKeys.chatMessages(data.channelId),
            });
          }
          break;

        case "chat_channel_updated":
          if (data.channelId) {
            queryClient.invalidateQueries({
              queryKey: queryKeys.chatChannel(data.channelId),
            });
          }
          if (workspaceId) {
            queryClient.invalidateQueries({
              queryKey: queryKeys.chatChannels(workspaceId),
            });
          }
          break;

        case "chat_member_added":
        case "chat_member_removed":
          if (data.channelId) {
            queryClient.invalidateQueries({
              queryKey: queryKeys.chatMembers(data.channelId),
            });
            queryClient.invalidateQueries({
              queryKey: queryKeys.chatChannel(data.channelId),
            });
          }
          break;

        case "chat_reaction_updated":
          if (data.channelId) {
            queryClient.invalidateQueries({
              queryKey: queryKeys.chatMessages(data.channelId),
            });
          }
          break;

        case "chat_typing":
          if (data.userId && data.displayName && onTyping) {
            onTyping(data.userId, data.displayName);
          }
          break;

        case "chat_message_pinned":
        case "chat_message_unpinned":
          if (data.channelId) {
            queryClient.invalidateQueries({
              queryKey: queryKeys.chatMessages(data.channelId),
            });
            queryClient.invalidateQueries({
              queryKey: queryKeys.chatPins(data.channelId),
            });
          }
          break;

        case "chat_thread_reply":
          if (data.parentId) {
            queryClient.invalidateQueries({
              queryKey: queryKeys.chatThread(data.parentId),
            });
          }
          if (data.channelId) {
            queryClient.invalidateQueries({
              queryKey: queryKeys.chatMessages(data.channelId),
            });
          }
          break;

        case "presence_online":
        case "presence_offline":
          if (workspaceId) {
            queryClient.invalidateQueries({
              queryKey: queryKeys.chatPresence(workspaceId),
            });
          }
          break;
      }
    },
    [workspaceId, onTyping],
  );

  // Subscribe to channel-level events
  useEffect(() => {
    if (!client || !channelId) return;

    client.subscribeChannel(channelId);

    client.on("chat_message_created", handleEvent);
    client.on("chat_message_updated", handleEvent);
    client.on("chat_message_deleted", handleEvent);
    client.on("chat_channel_updated", handleEvent);
    client.on("chat_member_added", handleEvent);
    client.on("chat_member_removed", handleEvent);
    client.on("chat_typing", handleEvent);
    client.on("chat_reaction_updated", handleEvent);
    client.on("chat_message_pinned", handleEvent);
    client.on("chat_message_unpinned", handleEvent);

    return () => {
      client.unsubscribeChannel(channelId);
      client.off("chat_message_created", handleEvent);
      client.off("chat_message_updated", handleEvent);
      client.off("chat_message_deleted", handleEvent);
      client.off("chat_channel_updated", handleEvent);
      client.off("chat_member_added", handleEvent);
      client.off("chat_member_removed", handleEvent);
      client.off("chat_typing", handleEvent);
      client.off("chat_reaction_updated", handleEvent);
      client.off("chat_message_pinned", handleEvent);
      client.off("chat_message_unpinned", handleEvent);
    };
  }, [client, channelId, handleEvent]);

  // Subscribe to workspace-level events
  useEffect(() => {
    if (!client || !workspaceId) return;

    const handleWorkspaceEvent = (msg: unknown) => {
      const { event, data } = msg as ChatRealtimeMessage;

      switch (event) {
        case "chat_channel_created":
        case "chat_channel_deleted":
        case "chat_channel_archived":
        case "chat_channel_unarchived":
          queryClient.invalidateQueries({
            queryKey: queryKeys.chatChannels(workspaceId),
          });
          if (data.channelId) {
            queryClient.invalidateQueries({
              queryKey: queryKeys.chatChannel(data.channelId),
            });
          }
          break;

        case "presence_online":
        case "presence_offline":
          queryClient.invalidateQueries({
            queryKey: queryKeys.chatPresence(workspaceId),
          });
          break;

        case "chat_thread_reply":
          if (data.parentId) {
            queryClient.invalidateQueries({
              queryKey: queryKeys.chatThread(data.parentId),
            });
          }
          break;
      }
    };

    client.on("chat_channel_created", handleWorkspaceEvent);
    client.on("chat_channel_deleted", handleWorkspaceEvent);
    client.on("chat_channel_archived", handleWorkspaceEvent);
    client.on("chat_channel_unarchived", handleWorkspaceEvent);
    client.on("presence_online", handleWorkspaceEvent);
    client.on("presence_offline", handleWorkspaceEvent);
    client.on("chat_thread_reply", handleWorkspaceEvent);

    return () => {
      client.off("chat_channel_created", handleWorkspaceEvent);
      client.off("chat_channel_deleted", handleWorkspaceEvent);
      client.off("chat_channel_archived", handleWorkspaceEvent);
      client.off("chat_channel_unarchived", handleWorkspaceEvent);
      client.off("presence_online", handleWorkspaceEvent);
      client.off("presence_offline", handleWorkspaceEvent);
      client.off("chat_thread_reply", handleWorkspaceEvent);
    };
  }, [client, workspaceId]);
}
