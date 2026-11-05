// The channel settings dialog pages its member list (P02b): the count comes
// from the channel, and further members load on request.
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const members = vi.hoisted(() => ({
  state: { members: [] as unknown[], hasNextPage: true, isFetchingNextPage: false, fetchNextPage: vi.fn() },
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("../api", () => {
  const mutation = () => ({ mutate: vi.fn(), isPending: false });
  return {
    useUpdateChannel: mutation, useDeleteChannel: mutation, useAddMembers: mutation, useRemoveMember: mutation,
    useChannelMembers: () => members.state,
  };
});
import { ChannelSettingsDialog } from "./channel-settings-dialog";

afterEach(() => { cleanup(); vi.clearAllMocks(); });

const member = (id: string) => ({
  id, channelId: "c", userId: `u-${id}`, lastReadAt: "", joinedAt: "",
  user: { id: `u-${id}`, displayName: `Person ${id}`, avatarUrl: null, email: `${id}@x.test` },
});
const channel = {
  id: "c", workspaceId: "w", name: "general", description: null, type: "PUBLIC" as const,
  createdById: "me", archivedAt: null, archivedById: null, createdAt: "", updatedAt: "",
  _count: { members: 250 },
};

it("shows the channel's member count and loads more members on request", () => {
  members.state = { members: [member("1"), member("2")], hasNextPage: true, isFetchingNextPage: false, fetchNextPage: vi.fn() };
  const { rerender } = render(<ChannelSettingsDialog open onClose={vi.fn()} workspaceId="w" channel={channel} currentUserId="me" />);
  expect(screen.getByText("Members (250)")).toBeTruthy();
  expect(screen.getByText("Person 2")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Load more members" }));
  expect(members.state.fetchNextPage).toHaveBeenCalledTimes(1);

  members.state = { ...members.state, members: [member("1"), member("2"), member("3")], hasNextPage: false };
  rerender(<ChannelSettingsDialog open onClose={vi.fn()} workspaceId="w" channel={channel} currentUserId="me" />);
  expect(screen.getByText("Person 3")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Load more members" })).toBeNull();
});
