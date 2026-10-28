import {
  useInfiniteQuery,
  useQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { useRef } from "react";
import { ApiError, api } from "@/lib/api-client";
import { queryKeys } from "@/lib/query-keys";
import type {
  CreateChannelInput,
  UpdateChannelInput,
  SendMessageInput,
  UpdateMessageInput,
  CreateDmInput,
  AddMembersInput,
} from "@pm/shared";

// ─── Types ─────────────────────────────────────────────

export interface ChatChannel {
  id: string;
  workspaceId: string;
  name: string | null;
  description: string | null;
  type: "PUBLIC" | "PRIVATE" | "DM";
  createdById: string;
  archivedAt: string | null;
  archivedById: string | null;
  createdAt: string;
  updatedAt: string;
  _count: { members: number };
  isMember?: boolean;
  members?: Array<{
    id: string;
    userId: string;
    user: { id: string; displayName: string; avatarUrl: string | null };
  }>;
}

export interface ChatChannelWithMembers extends ChatChannel {
  members: Array<{
    id: string;
    channelId: string;
    userId: string;
    lastReadAt: string;
    joinedAt: string;
    user: { id: string; displayName: string; avatarUrl: string | null };
  }>;
}

export interface ChatReaction {
  id: string;
  emoji: string;
  userId: string;
}

export interface ChatMessage {
  id: string;
  channelId: string;
  userId: string;
  content: string;
  parentId: string | null;
  editedAt: string | null;
  deletedAt: string | null;
  pinnedAt: string | null;
  pinnedById: string | null;
  createdAt: string;
  user: { id: string; displayName: string; avatarUrl: string | null };
  _count?: { replies: number };
  reactions?: ChatReaction[];
  channel?: { id: string; name: string | null; type: string };
}

export interface ChatBookmarkEntry {
  id: string;
  userId: string;
  messageId: string;
  createdAt: string;
  message: ChatMessage & { channel: { id: string; name: string | null; type: string } };
}

export interface PresenceUser {
  userId: string;
  status: "online" | "away";
}

export interface ChatSearchMessage extends ChatMessage {
  channel: { id: string; name: string | null; type: string };
}

export interface ChatMember {
  id: string;
  channelId: string;
  userId: string;
  lastReadAt: string;
  joinedAt: string;
  user: {
    id: string;
    displayName: string;
    avatarUrl: string | null;
    email: string;
  };
}

export interface UnreadCount {
  channelId: string;
  count: number;
}

interface MessagesPage {
  data: ChatMessage[];
  nextCursor?: string;
}

// ─── Channel Hooks ─────────────────────────────────────

export function useChannels(wid: string) {
  return useQuery({
    queryKey: queryKeys.chatChannels(wid),
    queryFn: () =>
      api
        .get(`chat/${wid}/channels`)
        .json<{ data: ChatChannel[] }>(),
    enabled: !!wid,
  });
}

export function useChannel(wid: string, channelId: string) {
  return useQuery({
    queryKey: queryKeys.chatChannel(channelId),
    queryFn: () =>
      api
        .get(`chat/${wid}/channels/${channelId}`)
        .json<{ data: ChatChannel }>(),
    enabled: !!wid && !!channelId,
  });
}

export function useCreateChannel(wid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: CreateChannelInput) =>
      api
        .post(`chat/${wid}/channels`, { json: data })
        .json<{ data: ChatChannel }>(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.chatChannels(wid) });
    },
  });
}

export function useUpdateChannel(wid: string, channelId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: UpdateChannelInput) =>
      api
        .patch(`chat/${wid}/channels/${channelId}`, { json: data })
        .json<{ data: ChatChannel }>(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.chatChannels(wid) });
      qc.invalidateQueries({ queryKey: queryKeys.chatChannel(channelId) });
    },
  });
}

export function useDeleteChannel(wid: string, channelId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api.delete(`chat/${wid}/channels/${channelId}`).then(() => {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.chatChannels(wid) });
    },
  });
}

export function useJoinChannel(wid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (channelId: string) =>
      api.post(`chat/${wid}/channels/${channelId}/join`).then(() => {}),
    onSuccess: (_, channelId) => {
      qc.invalidateQueries({ queryKey: queryKeys.chatChannels(wid) });
      qc.invalidateQueries({ queryKey: queryKeys.chatChannel(channelId) });
    },
  });
}

export function useLeaveChannel(wid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (channelId: string) =>
      api.post(`chat/${wid}/channels/${channelId}/leave`).then(() => {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.chatChannels(wid) });
    },
  });
}

// ─── Message Hooks ─────────────────────────────────────

export function useMessages(wid: string, channelId: string) {
  return useInfiniteQuery({
    queryKey: queryKeys.chatMessages(channelId),
    queryFn: ({ pageParam }) => {
      const searchParams: Record<string, string> = { limit: "50" };
      if (pageParam) searchParams.cursor = pageParam;
      return api
        .get(`chat/${wid}/channels/${channelId}/messages`, { searchParams })
        .json<MessagesPage>();
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    enabled: !!wid && !!channelId,
  });
}

const RETRYABLE_SEND_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

function createClientMessageId() {
  const cryptoApi = globalThis.crypto;
  // randomUUID is missing outside secure contexts (plain-HTTP self-hosting).
  if (typeof cryptoApi.randomUUID === "function") return cryptoApi.randomUUID();
  return Array.from(cryptoApi.getRandomValues(new Uint8Array(16)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

/**
 * Sends a message with an Idempotency-Key. Resending the same text to the same
 * place after a failed or unanswered attempt reuses that attempt's key, so the
 * server returns the message it may already have stored instead of a
 * duplicate. A successful send, or different text, starts a new key.
 */
export function useSendMessage(wid: string, channelId: string) {
  const qc = useQueryClient();
  const unconfirmed = useRef<{ target: string; key: string } | null>(null);
  return useMutation({
    mutationFn: (data: SendMessageInput) => {
      const target = JSON.stringify([wid, channelId, data.parentId ?? null, data.content]);
      if (unconfirmed.current?.target !== target) {
        unconfirmed.current = { target, key: createClientMessageId() };
      }
      const attempt = unconfirmed.current;
      return api
        .post(`chat/${wid}/channels/${channelId}/messages`, {
          json: data,
          headers: { "Idempotency-Key": attempt.key },
          // Safe to repeat: the key makes the server return the stored message.
          // Network failures, timeouts and transient statuses are retried;
          // other API errors (conflict, forbidden, validation) are final.
          retry: {
            limit: 2,
            methods: ["post"],
            retryOnTimeout: true,
            shouldRetry: ({ error }) =>
              error instanceof ApiError
                ? RETRYABLE_SEND_STATUSES.has(error.statusCode)
                : undefined,
          },
        })
        .json<{ data: ChatMessage }>()
        .then((res) => {
          if (unconfirmed.current === attempt) unconfirmed.current = null;
          return res;
        });
    },
    // Callers report a failed send together with the kept draft; this
    // replaces the client-wide error toast so it is not shown twice.
    onError: () => {},
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: queryKeys.chatMessages(channelId) });
      // If this was a thread reply, also refresh the thread panel
      if (res.data.parentId) {
        qc.invalidateQueries({
          queryKey: queryKeys.chatThread(res.data.parentId),
        });
      }
    },
  });
}

export function useUpdateMessage(wid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      messageId,
      ...data
    }: UpdateMessageInput & { messageId: string; channelId: string }) =>
      api
        .patch(`chat/${wid}/messages/${messageId}`, { json: data })
        .json<{ data: ChatMessage }>(),
    onSuccess: (_, variables) => {
      qc.invalidateQueries({
        queryKey: queryKeys.chatMessages(variables.channelId),
      });
    },
  });
}

export function useDeleteMessage(wid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      messageId,
      channelId,
    }: {
      messageId: string;
      channelId: string;
    }) => api.delete(`chat/${wid}/messages/${messageId}`).then(() => {}),
    onSuccess: (_, variables) => {
      qc.invalidateQueries({
        queryKey: queryKeys.chatMessages(variables.channelId),
      });
    },
  });
}

// ─── Thread Hooks ──────────────────────────────────────

export function useThreadReplies(wid: string, messageId: string) {
  return useInfiniteQuery({
    queryKey: queryKeys.chatThread(messageId),
    queryFn: ({ pageParam }) => {
      const searchParams: Record<string, string> = { limit: "50" };
      if (pageParam) searchParams.cursor = pageParam;
      return api
        .get(`chat/${wid}/messages/${messageId}/thread`, { searchParams })
        .json<MessagesPage>();
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    enabled: !!wid && !!messageId,
    staleTime: 0,
  });
}

// ─── Unread Hooks ──────────────────────────────────────

export function useUnreadCounts(wid: string) {
  return useQuery({
    queryKey: queryKeys.chatUnread(wid),
    queryFn: () =>
      api.get(`chat/${wid}/unread`).json<{ data: UnreadCount[] }>(),
    enabled: !!wid,
    refetchInterval: 60_000,
  });
}

export function useMarkRead(wid: string, channelId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api.post(`chat/${wid}/channels/${channelId}/read`).then(() => {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.chatUnread(wid) });
    },
  });
}

// ─── DM Hooks ──────────────────────────────────────────

export function useFindOrCreateDm(wid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: CreateDmInput) =>
      api
        .post(`chat/${wid}/dm`, { json: data })
        .json<{ data: ChatChannel }>(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.chatChannels(wid) });
    },
  });
}

// ─── Member Hooks ──────────────────────────────────────

export function useChannelMembers(wid: string, channelId: string) {
  return useQuery({
    queryKey: queryKeys.chatMembers(channelId),
    queryFn: () =>
      api
        .get(`chat/${wid}/channels/${channelId}/members`)
        .json<{ data: ChatMember[] }>(),
    enabled: !!wid && !!channelId,
  });
}

export function useAddMembers(wid: string, channelId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: AddMembersInput) =>
      api
        .post(`chat/${wid}/channels/${channelId}/members`, { json: data })
        .then(() => {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.chatMembers(channelId) });
      qc.invalidateQueries({ queryKey: queryKeys.chatChannel(channelId) });
    },
  });
}

export function useRemoveMember(wid: string, channelId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) =>
      api
        .delete(`chat/${wid}/channels/${channelId}/members/${userId}`)
        .then(() => {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.chatMembers(channelId) });
      qc.invalidateQueries({ queryKey: queryKeys.chatChannel(channelId) });
    },
  });
}

// ─── Typing ────────────────────────────────────────────

let lastTypingSent = 0;

export function useSendTyping(wid: string, channelId: string) {
  return useMutation({
    mutationFn: () => {
      const now = Date.now();
      if (now - lastTypingSent < 3000) return Promise.resolve();
      lastTypingSent = now;
      return api
        .post(`chat/${wid}/channels/${channelId}/typing`)
        .then(() => {});
    },
  });
}

// ─── Reactions ────────────────────────────────────────

export function useToggleReaction(wid: string, channelId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { messageId: string; emoji: string }) =>
      api
        .post(`chat/${wid}/messages/${data.messageId}/reactions`, {
          json: { emoji: data.emoji },
        })
        .json<{ data: { action: "added" | "removed" } }>(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.chatMessages(channelId) });
      qc.invalidateQueries({ queryKey: ["chat-thread"] });
    },
  });
}

// ─── Pin Hooks ────────────────────────────────────────

export function useTogglePin(wid: string, channelId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { messageId: string; pinned: boolean }) =>
      api
        .post(`chat/${wid}/messages/${data.messageId}/pin`, {
          json: { pinned: data.pinned },
        })
        .json<{ data: ChatMessage }>(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.chatMessages(channelId) });
      qc.invalidateQueries({ queryKey: queryKeys.chatPins(channelId) });
      qc.invalidateQueries({ queryKey: ["chat-thread"] });
    },
  });
}

export function usePinnedMessages(wid: string, channelId: string) {
  return useQuery({
    queryKey: queryKeys.chatPins(channelId),
    queryFn: () =>
      api
        .get(`chat/${wid}/channels/${channelId}/pins`)
        .json<{ data: ChatMessage[] }>(),
    enabled: !!wid && !!channelId,
  });
}

// ─── Bookmark Hooks ───────────────────────────────────

export function useToggleBookmark(wid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (messageId: string) =>
      api
        .post(`chat/${wid}/messages/${messageId}/bookmark`)
        .json<{ data: { action: "added" | "removed" } }>(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.chatBookmarks(wid) });
    },
  });
}

export function useBookmarks(wid: string) {
  return useQuery({
    queryKey: queryKeys.chatBookmarks(wid),
    queryFn: () =>
      api
        .get(`chat/${wid}/bookmarks`)
        .json<{ data: ChatBookmarkEntry[]; nextCursor?: string }>(),
    enabled: !!wid,
  });
}

// ─── Thread Subscription Hooks ────────────────────────

export function useThreadSubscription(wid: string, messageId: string) {
  return useQuery({
    queryKey: queryKeys.chatThreadSub(messageId),
    queryFn: () =>
      api
        .get(`chat/${wid}/messages/${messageId}/subscription`)
        .json<{ data: { subscribed: boolean } }>(),
    enabled: !!wid && !!messageId,
  });
}

export function useSubscribeThread(wid: string, messageId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api.post(`chat/${wid}/messages/${messageId}/subscription`).then(() => {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.chatThreadSub(messageId) });
    },
  });
}

export function useUnsubscribeThread(wid: string, messageId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api.delete(`chat/${wid}/messages/${messageId}/subscription`).then(() => {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.chatThreadSub(messageId) });
    },
  });
}

// ─── Archive Hooks ────────────────────────────────────

export function useArchiveChannel(wid: string, channelId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (archived: boolean) =>
      api
        .post(`chat/${wid}/channels/${channelId}/archive`, {
          json: { archived },
        })
        .json<{ data: ChatChannel }>(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.chatChannels(wid) });
      qc.invalidateQueries({ queryKey: queryKeys.chatChannel(channelId) });
    },
  });
}

// ─── Search Hooks ─────────────────────────────────────

export function useSearchMessages(
  wid: string,
  query: string,
  channelId?: string,
) {
  return useQuery({
    queryKey: queryKeys.chatSearch(wid, query, channelId),
    queryFn: () => {
      const url = channelId
        ? `chat/${wid}/channels/${channelId}/messages/search`
        : `chat/${wid}/messages/search`;
      return api
        .get(url, { searchParams: { q: query } })
        .json<{ data: ChatSearchMessage[]; nextCursor?: string }>();
    },
    enabled: !!wid && query.length >= 2,
    staleTime: 10_000,
  });
}

// ─── Presence Hooks ───────────────────────────────────

export function usePresence(wid: string) {
  return useQuery({
    queryKey: queryKeys.chatPresence(wid),
    queryFn: () =>
      api
        .get(`chat/${wid}/presence`)
        .json<{ data: PresenceUser[] }>(),
    enabled: !!wid,
    refetchInterval: 60_000,
  });
}
