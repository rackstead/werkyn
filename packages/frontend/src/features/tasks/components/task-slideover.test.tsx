import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskSlideover } from "./task-slideover";

const state = vi.hoisted(() => ({ loading: false }));

vi.mock("../api", () => ({
  useTask: () =>
    state.loading
      ? { data: undefined, isLoading: true, isError: false }
      : {
          data: {
            data: {
              id: "task-1",
              projectId: "project-1",
              title: "Write the plan",
              description: null,
              assignees: [],
            },
          },
          isLoading: false,
          isError: false,
        },
}));
vi.mock("./task-title", () => ({ TaskTitle: () => <input aria-label="Task title" /> }));
vi.mock("./task-fields", () => ({ TaskFields: () => null }));
vi.mock("./task-description", () => ({ TaskDescription: () => null }));
vi.mock("./activity-log", () => ({ ActivityLog: () => null }));
vi.mock("./dependency-list", () => ({ DependencyList: () => null }));
vi.mock("@/features/subtasks/components/subtask-list", () => ({ SubtaskList: () => null }));
vi.mock("@/features/comments/components/comment-list", () => ({ CommentList: () => null }));
vi.mock("@/features/attachments/components/attachment-list", () => ({ AttachmentList: () => null }));
// The real task actions open a confirm dialog from inside the panel.
vi.mock("./task-actions", async () => {
  const { ConfirmDialog } = await import("@/components/shared/confirm-dialog");
  const { useState } = await import("react");
  return {
    TaskActions: () => {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Archive
          </button>
          <ConfirmDialog
            open={open}
            onClose={() => setOpen(false)}
            onConfirm={() => setOpen(false)}
            title="Archive task?"
          />
        </>
      );
    },
  };
});

beforeEach(() => {
  state.loading = false;
});
afterEach(cleanup);

function Page({ onClose = vi.fn() }: { onClose?: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <main>
        <button type="button" onClick={() => setOpen(true)}>
          Write the plan
        </button>
      </main>
      {open && (
        <TaskSlideover
          taskId="task-1"
          workspaceSlug="acme"
          onClose={() => {
            onClose();
            setOpen(false);
          }}
        />
      )}
    </>
  );
}

async function openFromKeyboard() {
  const opener = screen.getByRole("button", { name: "Write the plan" });
  opener.focus();
  fireEvent.click(opener);
  const dialog = await screen.findByRole("dialog", { name: "Task details" });
  return { opener, dialog };
}

describe("TaskSlideover accessibility", () => {
  it("is a named modal dialog with named icon buttons and focus inside", async () => {
    render(<Page />);
    const { dialog } = await openFromKeyboard();
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(screen.getByRole("button", { name: "Close" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Maximize" })).toBeTruthy();
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
  });

  it("hides the page behind it from assistive technology", async () => {
    render(<Page />);
    await openFromKeyboard();
    expect(screen.queryByRole("button", { name: "Write the plan" })).toBeNull();
  });

  it("keeps Tab focus inside the panel", async () => {
    state.loading = true;
    render(<Page />);
    await openFromKeyboard();
    const close = screen.getByRole("button", { name: "Close" });
    close.focus();
    fireEvent.keyDown(close, { key: "Tab" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Maximize" }));
  });

  it("closes on Escape and returns focus to the opener", async () => {
    const onClose = vi.fn();
    render(<Page onClose={onClose} />);
    const { opener } = await openFromKeyboard();
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });

  it("closes from the named Close button and returns focus to the opener", async () => {
    const onClose = vi.fn();
    render(<Page onClose={onClose} />);
    const { opener } = await openFromKeyboard();
    const close = screen.getByRole("button", { name: "Close" });
    close.focus();
    fireEvent.click(close);
    expect(onClose).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });

  it("lets Escape close a confirm dialog inside the panel without closing the panel", async () => {
    const onClose = vi.fn();
    render(<Page onClose={onClose} />);
    await openFromKeyboard();
    const archive = screen.getByRole("button", { name: "Archive" });
    archive.focus();
    fireEvent.click(archive);
    await screen.findByRole("alertdialog", { name: "Archive task?" });
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancel" })));
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Task details" })).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(archive));
  });

  it("closes when the backdrop is clicked", async () => {
    const onClose = vi.fn();
    render(<Page onClose={onClose} />);
    const { dialog } = await openFromKeyboard();
    fireEvent.pointerDown(dialog);
    fireEvent.click(dialog);
    expect(onClose).not.toHaveBeenCalled();
    const backdrop = document.querySelector('[data-slot="slideover-overlay"]');
    expect(backdrop).toBeTruthy();
    fireEvent.pointerDown(backdrop!);
    fireEvent.click(backdrop!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
