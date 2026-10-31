import { useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComponentType } from "react";
import type { DriveFile } from "@/features/drive/api";

vi.mock("@/features/tasks/api", () => ({
  useTask: () => ({ data: { data: { id: "task-1", projectId: "p", title: "Plan", description: null, assignees: [] } }, isLoading: false, isError: false }),
}));
vi.mock("@/features/tasks/components/task-title", () => ({ TaskTitle: () => <input aria-label="Task title" /> }));
vi.mock("@/features/tasks/components/task-fields", () => ({ TaskFields: () => null }));
vi.mock("@/features/tasks/components/task-description", () => ({ TaskDescription: () => null }));
vi.mock("@/features/tasks/components/activity-log", () => ({ ActivityLog: () => null }));
vi.mock("@/features/tasks/components/dependency-list", () => ({ DependencyList: () => null }));
vi.mock("@/features/subtasks/components/subtask-list", () => ({ SubtaskList: () => null }));
vi.mock("@/features/comments/components/comment-list", () => ({ CommentList: () => null }));
vi.mock("@/features/attachments/components/attachment-list", () => ({ AttachmentList: () => null }));
vi.mock("@/features/tasks/components/task-actions", async () => {
  const { Dialog, DialogContent, DialogTitle } = await import("@/components/ui/dialog");
  return { TaskActions: () => {
    const [open, setOpen] = useState(false);
    return <><button onClick={() => setOpen(true)}>Nested action</button><Dialog open={open} onOpenChange={setOpen}><DialogContent aria-describedby={undefined}><DialogTitle>Nested dialog</DialogTitle><input aria-label="Nested input" autoFocus /></DialogContent></Dialog></>;
  } };
});
vi.mock("@/features/drive/api", () => ({
  useFilePreviewUrl: () => ({ data: undefined }),
  useFileTextContent: () => ({ data: "quarterly numbers" }),
}));

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const file = { id: "file-1", name: "Plan.txt", mimeType: "text/plain", size: 42, updatedAt: "2026-10-30T00:00:00Z" } as DriveFile;
type Kind = "task" | "preview";
type Dismissal = "Close" | "Escape" | "backdrop";

// Each case gets fresh wrapper/import state. Only the real panel module is
// deferred: its actual Slideover and focus handlers run after resolution.
async function open(kind: Kind) {
  vi.resetModules();
  let unblock!: () => void;
  let complete!: () => void;
  const pending = new Promise<void>((yes) => { unblock = yes; });
  const settled = new Promise<void>((yes) => { complete = yes; });
  const defer = async (original: () => Promise<unknown>) => {
    await pending;
    try { return await original(); }
    finally { complete(); }
  };
  if (kind === "task") {
    vi.doMock("@/features/tasks/components/task-slideover", defer);
  } else {
    vi.doMock("@/features/drive/components/file-preview-slideover", defer);
  }
  const { TaskSlideover: Task } = await import("@/features/tasks/components/lazy-task-slideover");
  const { FilePreviewSlideover: Preview } = await import("@/features/drive/components/lazy-drive-panels");
  const Panel: ComponentType<{ onClose: () => void }> = kind === "task"
    ? (({ onClose }) => <Task taskId="task-1" workspaceSlug="acme" onClose={onClose} />)
    : (({ onClose }) => <Preview file={file} workspaceId="w" onClose={onClose} onDownload={vi.fn()} />);
  function Page({ route = true }: { route?: boolean }) {
    const [visible, setVisible] = useState(false);
    return <><main><button onClick={() => setVisible(true)}>Open {kind}</button><button>Background</button></main>{visible && route && <Panel onClose={() => setVisible(false)} />}</>;
  }
  const view = render(<Page />);
  const opener = screen.getByRole("button", { name: `Open ${kind}` });
  const background = screen.getByRole("button", { name: "Background" });
  opener.focus();
  await act(async () => { fireEvent.click(opener); });
  const loading = await screen.findByRole("dialog", { name: `Loading ${kind}` });
  await waitFor(() => expect(loading.contains(document.activeElement)).toBe(true));
  const resolve = async () => { unblock(); await settled; };
  const load = async () => {
    await act(resolve);
    const loaded = await screen.findByRole("dialog", { name: kind === "task" ? "Task details" : file.name });
    await waitFor(() => expect(loaded.contains(document.activeElement)).toBe(true));
    expect(screen.queryByRole("dialog", { name: `Loading ${kind}` })).toBeNull();
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(loaded.getAttribute("aria-modal")).toBe("true");
    expect(screen.queryByRole("button", { name: "Background" })).toBeNull();
    return loaded;
  };
  return { opener, background, loading, load, resolve, leave: () => view.rerender(<Page route={false} />) };
}

async function dismiss(how: Dismissal, loaded = true) {
  if (how === "Close") fireEvent.click(screen.getByRole("button", { name: "Close" }));
  else if (how === "Escape") fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  else {
    // Radix registers pointer-outside after the opening event has completed.
    await new Promise((resolve) => setTimeout(resolve, 0));
    fireEvent.pointerDown(document.querySelector(`[data-slot="${loaded ? "slideover" : "dialog"}-overlay"]`)!, { button: 0, pointerType: "mouse" });
  }
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
}

describe.each(["task", "preview"] as const)("%s lazy panel handover", (kind) => {
  it.each(["Close", "Escape", "backdrop"] as const)("returns to its original opener after cold loading and %s", async (how) => {
    const { opener, load } = await open(kind);
    await load();
    await dismiss(how);
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });

  it.each(["Close", "Escape", "backdrop"] as const)("pending %s restores focus and a late chunk cannot reopen it", async (how) => {
    const { opener, resolve } = await open(kind);
    await dismiss(how, false);
    await waitFor(() => expect(document.activeElement).toBe(opener));
    await act(resolve);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("does not steal focus on route abandonment while the opener remains connected", async () => {
    const { opener, load, leave } = await open(kind);
    await load();
    leave();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(opener.isConnected).toBe(true);
    expect(document.activeElement).toBe(document.body);
  });

  it("does not focus an opener removed before dismissal", async () => {
    const { opener, load } = await open(kind);
    await load();
    opener.remove();
    await dismiss("Close");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(document.activeElement).toBe(document.body);
  });
});

it("a nested dialog returns inside the loaded task before the task returns to its opener", async () => {
  const { opener, load } = await open("task");
  await load();
  const action = screen.getByRole("button", { name: "Nested action" });
  action.focus();
  fireEvent.click(action);
  const nested = await screen.findByRole("dialog", { name: "Nested dialog" });
  await waitFor(() => expect(nested.contains(document.activeElement)).toBe(true));
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Nested dialog" })).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(action));
  expect(screen.getByRole("dialog", { name: "Task details" })).toBeTruthy();
  await dismiss("Escape");
  await waitFor(() => expect(document.activeElement).toBe(opener));
});
