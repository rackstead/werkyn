import { useState } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatLayout } from "./components/chat-layout";

const chat = vi.hoisted(() => ({
  sends: [] as Array<{ wid: string; channelId: string; input: unknown }>,
  threadReads: [] as string[],
}));

vi.mock("./api", () => {
  const user = { id: "u-1", displayName: "Ana", avatarUrl: null };
  const message = (id: string, channelId: string, content: string) => ({
    id,
    channelId,
    userId: "u-1",
    content,
    parentId: null,
    editedAt: null,
    deletedAt: null,
    pinnedAt: null,
    pinnedById: null,
    createdAt: "2026-10-01T10:00:00Z",
    user,
    _count: { replies: 1 },
    reactions: [],
  });
  const channel = (id: string, workspaceId: string, name: string) => ({
    id,
    workspaceId,
    name,
    description: null,
    type: "PUBLIC",
    createdById: "u-1",
    archivedAt: null,
    archivedById: null,
    createdAt: "2026-10-01T10:00:00Z",
    updatedAt: "2026-10-01T10:00:00Z",
    _count: { members: 2 },
    isMember: true,
  });
  const channels: Record<string, ReturnType<typeof channel>[]> = {
    "ws-1": [channel("ch-a", "ws-1", "alpha"), channel("ch-b", "ws-1", "beta")],
    "ws-2": [channel("ch-c", "ws-2", "gamma")],
  };
  const messages: Record<string, ReturnType<typeof message>[]> = {
    "ch-a": [message("m-a", "ch-a", "hello from alpha")],
    "ch-b": [message("m-b", "ch-b", "hello from beta")],
    "ch-c": [message("m-c", "ch-c", "hello from gamma")],
  };
  const page = (data: unknown[]) => ({
    data: { pages: [{ data }] },
    isLoading: false,
    fetchNextPage: () => {},
    hasNextPage: false,
    isFetchingNextPage: false,
  });
  const mutation = () => ({ mutate: () => {}, mutateAsync: async () => ({}), isPending: false });
  return {
    useChannels: (wid: string) => ({ data: { data: channels[wid] ?? [] }, isLoading: false }),
    useChannel: (wid: string, id: string) => ({
      data: id ? { data: (channels[wid] ?? []).find((c) => c.id === id) } : undefined,
    }),
    useMessages: (_wid: string, id: string) => page(messages[id] ?? []),
    useThreadReplies: (_wid: string, parentId: string) => {
      chat.threadReads.push(parentId);
      return page([]);
    },
    useSendMessage: (wid: string, channelId: string) => ({
      ...mutation(),
      mutateAsync: async (input: unknown) => {
        chat.sends.push({ wid, channelId, input });
        return {};
      },
    }),
    useUnreadCounts: () => ({ data: { data: [] } }),
    usePresence: () => ({ data: { data: [] } }),
    usePinnedMessages: () => ({ data: { data: [] }, isLoading: false }),
    useBookmarks: () => ({ data: { data: [] }, isLoading: false }),
    useSearchMessages: () => ({ data: undefined, isLoading: false }),
    useChannelMembers: () => ({ data: { data: [] } }),
    useThreadSubscription: () => ({ data: { data: { subscribed: false } } }),
    useMarkRead: mutation,
    useUpdateMessage: mutation,
    useDeleteMessage: mutation,
    useFindOrCreateDm: mutation,
    useJoinChannel: mutation,
    useSendTyping: mutation,
    useToggleReaction: mutation,
    useTogglePin: mutation,
    useToggleBookmark: mutation,
    useArchiveChannel: mutation,
    useCreateChannel: mutation,
    useUpdateChannel: mutation,
    useDeleteChannel: mutation,
    useLeaveChannel: mutation,
    useAddMembers: mutation,
    useRemoveMember: mutation,
    useSubscribeThread: mutation,
    useUnsubscribeThread: mutation,
  };
});
vi.mock("./hooks/use-chat-realtime", () => ({ useChatRealtime: () => {} }));
vi.mock("./hooks/use-typing-indicator", () => ({
  useTypingIndicator: () => ({ typingUsers: [], handleTyping: () => {} }),
}));
vi.mock("@/features/attachments/api", () => ({
  useLinkAttachment: () => ({ mutate: () => {}, isPending: false }),
}));
vi.mock("@/features/drive/components/drive-file-picker", () => ({ DriveFilePicker: () => null }));

beforeEach(() => {
  chat.sends = [];
  chat.threadReads = [];
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(cleanup);

type Route = { workspaceId: string; channelId?: string };
let navigate: (route: Route) => void;

/** Stands in for the chat route: the URL decides the workspace and channel. */
function ChatRoute() {
  const [route, setRoute] = useState<Route>({ workspaceId: "ws-1", channelId: "ch-a" });
  navigate = setRoute;
  return (
    <ChatLayout
      workspaceId={route.workspaceId}
      channelId={route.channelId}
      currentUserId="u-1"
      onChannelSelect={(id) => setRoute((r) => ({ ...r, channelId: id || undefined }))}
    />
  );
}

const threadHeading = () => screen.queryByRole("heading", { name: "Thread" });
const composer = () => screen.getByPlaceholderText("Type a message... Use @ to mention") as HTMLTextAreaElement;
const replyBox = () => screen.getByPlaceholderText("Reply in thread...") as HTMLTextAreaElement;

function openThreadWithDrafts() {
  render(<ChatRoute />);
  fireEvent.click(screen.getByRole("button", { name: "Reply in thread" }));
  expect(threadHeading()).toBeTruthy();
  fireEvent.change(composer(), { target: { value: "draft for alpha" } });
  fireEvent.change(replyBox(), { target: { value: "reply draft for alpha" } });
}

async function send(box: HTMLTextAreaElement, text: string) {
  fireEvent.change(box, { target: { value: text } });
  await act(async () => {
    fireEvent.keyDown(box, { key: "Enter" });
  });
}

describe("chat thread and draft scope", () => {
  it("sends a thread reply to the parent message's channel", async () => {
    render(<ChatRoute />);
    fireEvent.click(screen.getByRole("button", { name: "Reply in thread" }));
    await send(replyBox(), "a reply");
    expect(chat.sends).toEqual([
      { wid: "ws-1", channelId: "ch-a", input: { content: "a reply", parentId: "m-a" } },
    ]);
  });

  it("closes the thread and drops both drafts when another channel is clicked", async () => {
    openThreadWithDrafts();
    const reads = chat.threadReads.length;
    fireEvent.click(screen.getByRole("button", { name: "beta" }));

    expect(screen.getByText("hello from beta")).toBeTruthy();
    expect(threadHeading()).toBeNull();
    expect(screen.queryByPlaceholderText("Reply in thread...")).toBeNull();
    expect(composer().value).toBe("");
    expect(chat.threadReads.slice(reads)).toEqual([]);

    await send(composer(), "for beta");
    expect(chat.sends).toEqual([{ wid: "ws-1", channelId: "ch-b", input: { content: "for beta" } }]);
  });

  it("closes the thread and side panels when the URL moves to another channel, and keeps them closed on return", () => {
    openThreadWithDrafts();
    const reads = chat.threadReads.length;
    act(() => navigate({ workspaceId: "ws-1", channelId: "ch-b" }));
    expect(threadHeading()).toBeNull();
    expect(composer().value).toBe("");
    expect(chat.threadReads.slice(reads)).toEqual([]);

    fireEvent.click(screen.getByRole("button", { name: "Pinned messages" }));
    expect(screen.getByRole("heading", { name: "Pinned Messages" })).toBeTruthy();
    act(() => navigate({ workspaceId: "ws-1", channelId: "ch-a" }));
    expect(screen.queryByRole("heading", { name: "Pinned Messages" })).toBeNull();
    expect(threadHeading()).toBeNull();
    expect(composer().value).toBe("");
  });

  it("closes the thread when the workspace changes", () => {
    openThreadWithDrafts();
    const reads = chat.threadReads.length;
    act(() => navigate({ workspaceId: "ws-2", channelId: "ch-c" }));
    expect(screen.getByText("hello from gamma")).toBeTruthy();
    expect(threadHeading()).toBeNull();
    expect(composer().value).toBe("");
    expect(chat.threadReads.slice(reads)).toEqual([]);
  });

  it("keeps the thread open while the channel stays the same", () => {
    openThreadWithDrafts();
    fireEvent.click(screen.getByRole("button", { name: "alpha" }));
    expect(threadHeading()).toBeTruthy();
    expect(replyBox().value).toBe("reply draft for alpha");
  });
});
