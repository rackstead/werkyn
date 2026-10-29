import { X, Loader2, Bell, BellOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { MessageItem } from "./message-item";
import { toast } from "sonner";
import { MessageInput } from "./message-input";
import {
  useThreadReplies,
  useSendMessage,
  useToggleReaction,
  useThreadSubscription,
  useSubscribeThread,
  useUnsubscribeThread,
  type ChatMessage,
} from "../api";

interface ThreadPanelProps {
  workspaceId: string;
  /** Replies go to this message's own channel. */
  parentMessage: ChatMessage;
  currentUserId: string;
  isAdmin?: boolean;
  memberMap?: Map<string, string>;
  onClose: () => void;
  onEditMessage?: (messageId: string, content: string) => void;
  onDeleteMessage?: (messageId: string) => void;
}

export function ThreadPanel({
  workspaceId,
  parentMessage,
  currentUserId,
  isAdmin,
  memberMap,
  onClose,
  onEditMessage,
  onDeleteMessage,
}: ThreadPanelProps) {
  const { channelId } = parentMessage;
  const { data, isLoading, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useThreadReplies(workspaceId, parentMessage.id);
  const sendMessage = useSendMessage(workspaceId, channelId);
  const toggleReaction = useToggleReaction(workspaceId, channelId);
  const { data: subData } = useThreadSubscription(workspaceId, parentMessage.id);
  const subscribe = useSubscribeThread(workspaceId, parentMessage.id);
  const unsubscribe = useUnsubscribeThread(workspaceId, parentMessage.id);
  const isSubscribed = subData?.data?.subscribed ?? false;

  const replies = data?.pages.flatMap((p) => p.data) ?? [];

  const handleSend = (content: string) =>
    sendMessage
      .mutateAsync({ content, parentId: parentMessage.id })
      .catch((err: Error) => {
        toast.error(`Reply not sent: ${err.message}`);
        throw err;
      });

  const handleReaction = (messageId: string, emoji: string) => {
    toggleReaction.mutate({ messageId, emoji });
  };

  const handleToggleSubscription = () => {
    if (isSubscribed) {
      unsubscribe.mutate();
    } else {
      subscribe.mutate();
    }
  };

  return (
    <div className="flex flex-col h-full w-80 border-l bg-background">
      <div className="flex items-center justify-between border-b px-4 py-3">
        <h3 className="text-sm font-semibold">Thread</h3>
        <div className="flex items-center gap-1">
          <Button
            size="icon"
            variant="ghost"
            className="h-7 w-7"
            onClick={handleToggleSubscription}
            title={isSubscribed ? "Unsubscribe from thread" : "Subscribe to thread"}
            disabled={subscribe.isPending || unsubscribe.isPending}
          >
            {isSubscribed ? (
              <Bell className="h-4 w-4 text-primary" />
            ) : (
              <BellOff className="h-4 w-4" />
            )}
          </Button>
          <Button size="icon" variant="ghost" className="h-7 w-7" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {/* Parent message */}
        <div className="border-b">
          <MessageItem
            message={parentMessage}
            currentUserId={currentUserId}
            isAdmin={isAdmin}
            memberMap={memberMap}
            onEdit={onEditMessage}
            onDelete={onDeleteMessage}
            onReaction={handleReaction}
          />
        </div>

        {/* Replies */}
        {isLoading ? (
          <div className="flex justify-center py-6">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="py-2">
            {hasNextPage && (
              <div className="flex justify-center py-2">
                <button
                  onClick={() => fetchNextPage()}
                  disabled={isFetchingNextPage}
                  className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                >
                  {isFetchingNextPage ? "Loading..." : "Load more"}
                </button>
              </div>
            )}
            {replies.map((msg) => (
              <MessageItem
                key={msg.id}
                message={msg}
                currentUserId={currentUserId}
                isAdmin={isAdmin}
                memberMap={memberMap}
                onEdit={onEditMessage}
                onDelete={onDeleteMessage}
                onReaction={handleReaction}
              />
            ))}
            {replies.length === 0 && (
              <p className="px-4 py-4 text-sm text-muted-foreground text-center">
                No replies yet
              </p>
            )}
          </div>
        )}
      </div>

      <MessageInput
        scope={parentMessage.id}
        onSend={handleSend}
        placeholder="Reply in thread..."
        disabled={sendMessage.isPending}
      />
    </div>
  );
}
