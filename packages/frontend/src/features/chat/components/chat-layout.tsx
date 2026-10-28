import { useState, useMemo, useCallback } from "react";
import { ChannelList } from "./channel-list";
import { ChannelHeader } from "./channel-header";
import { MessageList } from "./message-list";
import { MentionInput } from "./mention-input";
import { ThreadPanel } from "./thread-panel";
import { TypingIndicator } from "./typing-indicator";
import { ChannelSettingsDialog } from "./channel-settings-dialog";
import { CreateChannelDialog } from "./create-channel-dialog";
import { DmUserPicker } from "./dm-user-picker";
import { PinnedMessagesPanel } from "./pinned-messages-panel";
import { BookmarksPanel } from "./bookmarks-panel";
import { ChannelSearchBar } from "./channel-search-bar";
import { AttachmentList } from "@/features/attachments/components/attachment-list";
import { DriveFilePicker } from "@/features/drive/components/drive-file-picker";
import { useLinkAttachment } from "@/features/attachments/api";
import { toast } from "sonner";
import {
  useChannels,
  useChannel,
  useMessages,
  useSendMessage,
  useUpdateMessage,
  useDeleteMessage,
  useUnreadCounts,
  useMarkRead,
  useFindOrCreateDm,
  useJoinChannel,
  useSendTyping,
  useToggleReaction,
  useTogglePin,
  useToggleBookmark,
  usePinnedMessages,
  useArchiveChannel,
  usePresence,
  type ChatMessage,
  type ChatChannel,
} from "../api";
import { useChatRealtime } from "../hooks/use-chat-realtime";
import { useTypingIndicator } from "../hooks/use-typing-indicator";
import { Button } from "@/components/ui/button";
import { Loader2, LogIn, MessageSquare, Archive } from "lucide-react";

interface ChatLayoutProps {
  workspaceId: string;
  channelId?: string;
  currentUserId: string;
  isAdmin?: boolean;
  workspaceMembers?: Array<{
    id: string;
    displayName: string;
    email: string;
    avatarUrl: string | null;
  }>;
  onChannelSelect: (channelId: string) => void;
}

export function ChatLayout({
  workspaceId,
  channelId,
  currentUserId,
  isAdmin,
  workspaceMembers = [],
  onChannelSelect,
}: ChatLayoutProps) {
  const [createOpen, setCreateOpen] = useState(false);
  const [dmPickerOpen, setDmPickerOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [threadMessage, setThreadMessage] = useState<ChatMessage | null>(null);
  const [showPins, setShowPins] = useState(false);
  const [showBookmarks, setShowBookmarks] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const [attachMessageId, setAttachMessageId] = useState<string | null>(null);

  // Data queries
  const { data: channelsData, isLoading: channelsLoading } = useChannels(workspaceId);
  const channels = channelsData?.data ?? [];

  const { data: channelData } = useChannel(workspaceId, channelId ?? "");
  const channel = channelData?.data;

  const {
    data: messagesData,
    isLoading: messagesLoading,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useMessages(workspaceId, channelId ?? "");

  const messages = useMemo(
    () => messagesData?.pages.flatMap((p) => p.data) ?? [],
    [messagesData],
  );

  const { data: unreadData } = useUnreadCounts(workspaceId);
  const unreadCounts = unreadData?.data ?? [];

  const { data: presenceData } = usePresence(workspaceId);
  const presenceUsers = presenceData?.data ?? [];

  const { data: pinsData } = usePinnedMessages(workspaceId, channelId ?? "");
  const pinnedCount = pinsData?.data?.length ?? 0;

  const markRead = useMarkRead(workspaceId, channelId ?? "");
  const sendMessage = useSendMessage(workspaceId, channelId ?? "");
  const updateMessage = useUpdateMessage(workspaceId);
  const deleteMessage = useDeleteMessage(workspaceId);
  const sendTyping = useSendTyping(workspaceId, channelId ?? "");
  const findOrCreateDm = useFindOrCreateDm(workspaceId);
  const joinChannel = useJoinChannel(workspaceId);
  const toggleReaction = useToggleReaction(workspaceId, channelId ?? "");
  const togglePin = useTogglePin(workspaceId, channelId ?? "");
  const toggleBookmark = useToggleBookmark(workspaceId);
  const archiveChannel = useArchiveChannel(workspaceId, channelId ?? "");
  const linkAttachment = useLinkAttachment(workspaceId, "message", attachMessageId ?? "");

  // Member map for mention display
  const memberMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of workspaceMembers) {
      map.set(m.id, m.displayName);
    }
    return map;
  }, [workspaceMembers]);

  // Member options for mention input
  const mentionMembers = useMemo(
    () =>
      workspaceMembers.map((m) => ({
        id: m.id,
        displayName: m.displayName,
        avatarUrl: m.avatarUrl,
      })),
    [workspaceMembers],
  );

  // Typing indicator
  const { typingUsers, handleTyping } = useTypingIndicator(currentUserId);

  // Realtime
  useChatRealtime(workspaceId, channelId, handleTyping);

  // Build DM members map for display
  const dmMembers = useMemo(() => {
    const map: Record<string, Array<{ id: string; displayName: string; avatarUrl: string | null }>> = {};
    for (const ch of channels) {
      if (ch.type === "DM" && ch.members) {
        map[ch.id] = ch.members.map((m) => ({
          id: m.user.id,
          displayName: m.user.displayName,
          avatarUrl: m.user.avatarUrl,
        }));
      }
    }
    return map;
  }, [channels]);

  // Presence status for current DM
  const dmPresenceStatus = useMemo(() => {
    if (!channel || channel.type !== "DM") return undefined;
    const members = dmMembers[channel.id] ?? [];
    const otherMember = members.find((m) => m.id !== currentUserId);
    if (!otherMember) return undefined;
    const p = presenceUsers.find((pu) => pu.userId === otherMember.id);
    return p?.status ?? ("offline" as const);
  }, [channel, dmMembers, currentUserId, presenceUsers]);

  const isArchived = !!channel?.archivedAt;

  // Mark read when viewing a channel
  const handleChannelSelect = useCallback(
    (id: string) => {
      onChannelSelect(id);
      setShowPins(false);
      setShowBookmarks(false);
      setShowSearch(false);
      setTimeout(() => {
        markRead.mutate();
      }, 500);
    },
    [onChannelSelect, markRead],
  );

  const handleSend = useCallback(
    (content: string) =>
      sendMessage.mutateAsync({ content }).then(
        () => markRead.mutate(),
        (err: Error) => {
          toast.error(`Message not sent: ${err.message}. Your draft was kept.`);
          throw err;
        },
      ),
    [sendMessage, markRead],
  );

  const handleEdit = useCallback(
    (messageId: string, content: string) => {
      if (!channelId) return;
      updateMessage.mutate({ messageId, content, channelId });
    },
    [updateMessage, channelId],
  );

  const handleDelete = useCallback(
    (messageId: string) => {
      if (!channelId) return;
      deleteMessage.mutate({ messageId, channelId });
    },
    [deleteMessage, channelId],
  );

  const handleCreateDm = useCallback(
    (userIds: string[]) => {
      findOrCreateDm.mutate(
        { userIds },
        {
          onSuccess: (res) => {
            setDmPickerOpen(false);
            onChannelSelect(res.data.id);
          },
        },
      );
    },
    [findOrCreateDm, onChannelSelect],
  );

  const handleThreadClick = useCallback(
    (messageId: string) => {
      const msg = messages.find((m) => m.id === messageId);
      if (msg) {
        setThreadMessage(msg);
        setShowPins(false);
        setShowBookmarks(false);
      }
    },
    [messages],
  );

  const handleReaction = useCallback(
    (messageId: string, emoji: string) => {
      toggleReaction.mutate({ messageId, emoji });
    },
    [toggleReaction],
  );

  const handlePin = useCallback(
    (messageId: string, pinned: boolean) => {
      togglePin.mutate({ messageId, pinned });
    },
    [togglePin],
  );

  const handleBookmark = useCallback(
    (messageId: string) => {
      toggleBookmark.mutate(messageId);
    },
    [toggleBookmark],
  );

  const handleAttach = useCallback((messageId: string) => {
    setAttachMessageId(messageId);
  }, []);

  return (
    <div className="flex h-full">
      {/* Channel sidebar */}
      <div className="w-60 border-r shrink-0">
        {channelsLoading ? (
          <div className="flex items-center justify-center h-32">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <ChannelList
            channels={channels}
            activeChannelId={channelId}
            unreadCounts={unreadCounts}
            currentUserId={currentUserId}
            dmMembers={dmMembers}
            presenceUsers={presenceUsers}
            onChannelClick={handleChannelSelect}
            onCreateChannel={() => setCreateOpen(true)}
            onCreateDm={() => setDmPickerOpen(true)}
            onBookmarksClick={() => {
              setShowBookmarks(true);
              setShowPins(false);
              setThreadMessage(null);
            }}
          />
        )}
      </div>

      {/* Message area */}
      <div className="flex flex-1 min-w-0">
        {channel && channelId ? (
          <div className="flex flex-col flex-1 min-w-0">
            <ChannelHeader
              channel={channel}
              pinnedCount={pinnedCount}
              presenceStatus={dmPresenceStatus}
              onSettingsClick={
                channel.type !== "DM"
                  ? () => setSettingsOpen(true)
                  : undefined
              }
              onSearchClick={() => setShowSearch(!showSearch)}
              onPinsClick={() => {
                setShowPins(!showPins);
                setShowBookmarks(false);
                setThreadMessage(null);
              }}
            />

            {showSearch && (
              <ChannelSearchBar
                workspaceId={workspaceId}
                channelId={channelId}
                onClose={() => setShowSearch(false)}
              />
            )}

            {messagesLoading ? (
              <div className="flex-1 flex items-center justify-center">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            ) : (
              <MessageList
                messages={messages}
                currentUserId={currentUserId}
                isAdmin={isAdmin}
                activeThreadId={threadMessage?.id}
                hasMore={hasNextPage}
                isFetchingMore={isFetchingNextPage}
                onLoadMore={() => fetchNextPage()}
                onThreadClick={handleThreadClick}
                onEditMessage={handleEdit}
                onDeleteMessage={handleDelete}
                onReaction={handleReaction}
                onPin={isArchived ? undefined : handlePin}
                onBookmark={handleBookmark}
                onAttach={isArchived ? undefined : handleAttach}
                memberMap={memberMap}
              />
            )}

            <TypingIndicator typingUsers={typingUsers} />

            {isArchived ? (
              <div className="flex items-center justify-center gap-3 border-t px-4 py-3 bg-muted/50">
                <Archive className="h-4 w-4 text-muted-foreground" />
                <p className="text-sm text-muted-foreground">
                  This channel is archived. No new messages can be sent.
                </p>
              </div>
            ) : channel.isMember === false ? (
              <div className="flex items-center justify-center gap-3 border-t px-4 py-3">
                <p className="text-sm text-muted-foreground">
                  Join this channel to send messages
                </p>
                <Button
                  size="sm"
                  onClick={() => {
                    joinChannel.mutate(channelId!, {
                      onSuccess: () => markRead.mutate(),
                    });
                  }}
                  disabled={joinChannel.isPending}
                >
                  <LogIn className="h-4 w-4 mr-1.5" />
                  {joinChannel.isPending ? "Joining..." : "Join Channel"}
                </Button>
              </div>
            ) : (
              <MentionInput
                onSend={handleSend}
                onTyping={() => sendTyping.mutate()}
                members={mentionMembers}
                disabled={sendMessage.isPending}
              />
            )}
          </div>
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground">
            <MessageSquare className="h-10 w-10 mb-3" />
            <p className="text-sm">Select a channel to start chatting</p>
          </div>
        )}

        {/* Side panels (only one at a time) */}
        {threadMessage && channelId && !showPins && !showBookmarks && (
          <ThreadPanel
            workspaceId={workspaceId}
            channelId={channelId}
            parentMessage={threadMessage}
            currentUserId={currentUserId}
            isAdmin={isAdmin}
            memberMap={memberMap}
            onClose={() => setThreadMessage(null)}
            onEditMessage={handleEdit}
            onDeleteMessage={handleDelete}
          />
        )}

        {showPins && channelId && (
          <PinnedMessagesPanel
            workspaceId={workspaceId}
            channelId={channelId}
            currentUserId={currentUserId}
            isAdmin={isAdmin}
            onClose={() => setShowPins(false)}
          />
        )}

        {showBookmarks && (
          <BookmarksPanel
            workspaceId={workspaceId}
            onClose={() => setShowBookmarks(false)}
            onNavigate={(id) => {
              setShowBookmarks(false);
              onChannelSelect(id);
            }}
          />
        )}
      </div>

      {/* Dialogs */}
      <CreateChannelDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        workspaceId={workspaceId}
        onCreated={onChannelSelect}
      />

      <DmUserPicker
        open={dmPickerOpen}
        onClose={() => setDmPickerOpen(false)}
        members={workspaceMembers}
        currentUserId={currentUserId}
        onSubmit={handleCreateDm}
        loading={findOrCreateDm.isPending}
      />

      {channel && channel.type !== "DM" && (
        <ChannelSettingsDialog
          open={settingsOpen}
          onClose={() => setSettingsOpen(false)}
          workspaceId={workspaceId}
          channel={channel}
          currentUserId={currentUserId}
          isAdmin={isAdmin}
          workspaceMembers={workspaceMembers}
          onDeleted={() => onChannelSelect("")}
          onArchive={
            (channel.createdById === currentUserId || isAdmin)
              ? (archived: boolean) => {
                  archiveChannel.mutate(archived, {
                    onSuccess: () => {
                      toast.success(archived ? "Channel archived" : "Channel unarchived");
                      setSettingsOpen(false);
                    },
                    onError: (err) => toast.error(err.message),
                  });
                }
              : undefined
          }
          isArchived={isArchived}
        />
      )}

      {/* File attachment picker */}
      <DriveFilePicker
        open={!!attachMessageId}
        onClose={() => setAttachMessageId(null)}
        workspaceId={workspaceId}
        isPending={linkAttachment.isPending}
        onSelect={(file) => {
          linkAttachment.mutate(file.id, {
            onSuccess: () => {
              setAttachMessageId(null);
              toast.success("File attached");
            },
            onError: (err) => toast.error(err.message || "Failed to attach file"),
          });
        }}
      />
    </div>
  );
}
