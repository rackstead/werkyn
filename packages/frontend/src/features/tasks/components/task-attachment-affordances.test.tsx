import type { ReactNode } from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAuthStore, type WorkspaceMembership } from "@/stores/auth-store";
import { AttachmentList } from "@/features/attachments/components/attachment-list";
import { TaskSlideover } from "./task-slideover";

const state = vi.hoisted(() => ({ assigned: false, remove: vi.fn(), link: vi.fn() }));

vi.mock("../api", () => ({
  useTask: () => ({
    data: { data: { id: "task", projectId: "project", title: "Plan", description: null,
      assignees: state.assigned ? [{ userId: "actor" }] : [] } },
    isLoading: false, isError: false,
  }),
}));
vi.mock("./task-title", () => ({
  TaskTitle: ({ canEdit }: { canEdit: boolean }) => <input aria-label="Task title" readOnly={!canEdit} />,
}));
vi.mock("./task-fields", () => ({ TaskFields: () => null }));
vi.mock("./task-description", () => ({ TaskDescription: () => null }));
vi.mock("./task-actions", () => ({ TaskActions: () => null }));
vi.mock("./activity-log", () => ({ ActivityLog: () => null }));
vi.mock("./dependency-list", () => ({ DependencyList: () => null }));
vi.mock("@/features/subtasks/components/subtask-list", () => ({ SubtaskList: () => null }));
vi.mock("@/features/comments/components/comment-list", () => ({ CommentList: () => null }));
vi.mock("@/components/ui/slideover", () => ({
  Slideover: ({ children, actions }: { children: ReactNode; actions: ReactNode }) => <div>{actions}{children}</div>,
}));
vi.mock("@/features/attachments/api", () => ({
  useAttachments: () => ({ data: { data: [
    { id: "own", name: "Own file", uploadedById: "actor", mimeType: "text/plain", size: 12,
      fileId: "source-own", file: { id: "source-own", trashedAt: null } },
    { id: "other", name: "Other file", uploadedById: "other-user", mimeType: "text/plain", size: 12,
      fileId: "source-other", file: { id: "source-other", trashedAt: null } },
  ] }, isLoading: false }),
  useDeleteAttachment: () => ({ mutate: state.remove }),
  useDownloadAttachment: () => ({ mutate: vi.fn() }),
  useLinkAttachment: () => ({ mutate: state.link, isPending: false }),
}));
vi.mock("@/features/drive/components/drive-file-picker", () => ({
  DriveFilePicker: ({ open, onSelect }: { open: boolean; onSelect: (file: { id: string }) => void }) =>
    open ? <button onClick={() => onSelect({ id: "new-source" })}>Choose source</button> : null,
}));

const actor = { id: "actor", email: "actor@example.test", displayName: "Actor", avatarUrl: null,
  jobTitle: null, phone: null, timezone: null, emailVerified: true };
function membership(role: WorkspaceMembership["role"], id = "workspace"): WorkspaceMembership {
  return { id: "membership-" + id, workspaceId: id, role,
    workspace: { id, slug: id === "workspace" ? "acme" : id, name: id, logoUrl: null } };
}
beforeEach(() => {
  state.assigned = false;
  state.remove.mockClear();
  state.link.mockClear();
  useAuthStore.setState({ ...useAuthStore.getInitialState(), user: actor });
});
afterEach(() => {
  cleanup();
  useAuthStore.setState(useAuthStore.getInitialState());
});

function removeButton(name: string) {
  const row = screen.getByText(name).parentElement!;
  return within(row).queryByRole("button", { name: "Remove" });
}

describe.each([false, true])("task attachment controls (fullscreen=%s)", (fullscreen) => {
  it.each([
    { name: "unassigned local admin", role: "ADMIN", assigned: false, otherAdmin: false },
    { name: "assigned member", role: "MEMBER", assigned: true, otherAdmin: false },
    { name: "unassigned discussion member", role: "MEMBER", assigned: false, otherAdmin: false },
    { name: "assigned viewer", role: "VIEWER", assigned: true, otherAdmin: false },
    { name: "member with admin role in another workspace", role: "MEMBER", assigned: false, otherAdmin: true },
    { name: "viewer with admin role in another workspace", role: "VIEWER", assigned: true, otherAdmin: true },
  ] as const)("$name", ({ role, assigned, otherAdmin }) => {
    state.assigned = assigned;
    useAuthStore.setState({ workspaces: [membership(role), ...(otherAdmin ? [membership("ADMIN", "other-workspace")] : [])] });
    render(<TaskSlideover taskId="task" workspaceSlug="acme" onClose={vi.fn()} />);
    if (fullscreen) fireEvent.click(screen.getByRole("button", { name: "Maximize" }));
    const writer = role !== "VIEWER";
    expect(!!screen.queryByRole("button", { name: "Attach file" })).toBe(writer);
    expect(!!removeButton("Own file")).toBe(writer);
    expect(!!removeButton("Other file")).toBe(role === "ADMIN");
    expect((screen.getByRole("textbox", { name: "Task title" }) as HTMLInputElement).readOnly)
      .toBe(!(role === "ADMIN" || role === "MEMBER" && assigned));
    if (writer) {
      fireEvent.click(removeButton("Own file")!);
      expect(state.remove).toHaveBeenCalledExactlyOnceWith("own", expect.any(Object));
      fireEvent.click(screen.getByRole("button", { name: "Attach file" }));
      fireEvent.click(screen.getByRole("button", { name: "Choose source" }));
      expect(state.link).toHaveBeenCalledExactlyOnceWith("new-source", expect.any(Object));
    }
  });
});

it("shows no mutation controls when the current workspace membership is missing", () => {
  useAuthStore.setState({ workspaces: [membership("ADMIN", "other-workspace")] });
  render(<AttachmentList workspaceId="workspace" taskId="task" />);
  expect(screen.queryByRole("button", { name: "Attach file" })).toBeNull();
  expect(screen.queryAllByRole("button", { name: "Remove" })).toHaveLength(0);
});

it("updates current membership affordances and closes an open picker after becoming a viewer", () => {
  useAuthStore.setState({ workspaces: [membership("MEMBER")] });
  render(<TaskSlideover taskId="task" workspaceSlug="acme" onClose={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Attach file" }));
  expect(screen.getByRole("button", { name: "Choose source" })).toBeTruthy();
  act(() => useAuthStore.setState({ workspaces: [membership("VIEWER")] }));
  expect(screen.queryByRole("button", { name: "Attach file" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Choose source" })).toBeNull();
  expect(screen.queryAllByRole("button", { name: "Remove" })).toHaveLength(0);
  expect(state.link).not.toHaveBeenCalled();
  act(() => useAuthStore.setState({ workspaces: [membership("MEMBER")] }));
  expect(screen.getByRole("button", { name: "Attach file" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Choose source" })).toBeNull();
});
