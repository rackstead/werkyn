import { useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TaskSlideover } from "@/features/tasks/components/lazy-task-slideover";
import { FilePreviewSlideover } from "@/features/drive/components/lazy-drive-panels";
import type { DriveFile } from "@/features/drive/api";

// Hold the real dynamic imports pending so the production Suspense fallbacks
// remain visible throughout every interaction below.
vi.mock("@/features/tasks/components/task-slideover", () => new Promise(() => {}));
vi.mock("@/features/drive/components/file-preview-slideover", () => new Promise(() => {}));

afterEach(cleanup);

const file = { id: "file-1", name: "Plan.txt", mimeType: "text/plain" } as DriveFile;

function Page({ kind }: { kind: "task" | "preview" }) {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  return (
    <>
      <main>
        <button type="button" onClick={() => setOpen(true)}>Open {kind}</button>
        <button type="button">Background</button>
      </main>
      {open && (kind === "task"
        ? <TaskSlideover taskId="task-1" workspaceSlug="acme" onClose={close} />
        : <FilePreviewSlideover file={file} workspaceId="w" onClose={close} onDownload={vi.fn()} />)}
    </>
  );
}

describe.each(["task", "preview"] as const)("pending %s panel", (kind) => {
  async function open() {
    render(<Page kind={kind} />);
    const opener = screen.getByRole("button", { name: `Open ${kind}` });
    const background = screen.getByRole("button", { name: "Background" });
    opener.focus();
    fireEvent.click(opener);
    const dialog = await screen.findByRole("dialog", { name: `Loading ${kind}` });
    return { opener, background, dialog };
  }

  it("is modal, contains focus and restores its opener when closed", async () => {
    const { opener, background, dialog } = await open();
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    expect(screen.queryByRole("button", { name: "Background" })).toBeNull();
    background.focus();
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    fireEvent.keyDown(document.activeElement!, { key: "Tab" });
    expect(dialog.contains(document.activeElement)).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });

  it("closes on Escape while its chunk is pending", async () => {
    const { opener } = await open();
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });

  it("closes on a backdrop press while its chunk is pending", async () => {
    const { opener } = await open();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const overlay = document.querySelector('[data-slot="dialog-overlay"]');
    expect(overlay).toBeTruthy();
    fireEvent.pointerDown(overlay!, { button: 0, pointerType: "mouse" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });
});
