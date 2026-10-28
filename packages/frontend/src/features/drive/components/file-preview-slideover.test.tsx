import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DriveFile } from "../api";
import { FilePreviewSlideover } from "./file-preview-slideover";

vi.mock("../api", () => ({
  useFilePreviewUrl: () => ({ data: undefined }),
  useFileTextContent: () => ({ data: "quarterly numbers" }),
}));

afterEach(cleanup);

const file = {
  id: "file-1",
  name: "report.txt",
  mimeType: "text/plain",
  size: 42,
  updatedAt: new Date().toISOString(),
  uploadedBy: { displayName: "Alice" },
} as unknown as DriveFile;

function Page({ onClose = vi.fn(), onDownload = vi.fn() }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Preview report.txt
      </button>
      {open && (
        <FilePreviewSlideover
          file={file}
          workspaceId="workspace-1"
          onDownload={onDownload}
          onClose={() => {
            onClose();
            setOpen(false);
          }}
        />
      )}
    </>
  );
}

describe("FilePreviewSlideover accessibility", () => {
  it("is a modal dialog named by the file with named controls", async () => {
    const onDownload = vi.fn();
    render(<Page onDownload={onDownload} />);
    fireEvent.click(screen.getByRole("button", { name: "Preview report.txt" }));
    const dialog = await screen.findByRole("dialog", { name: "report.txt" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    expect(onDownload).toHaveBeenCalledWith(file);
    expect(screen.getByRole("button", { name: "Close" })).toBeTruthy();
  });

  it("closes on Escape and returns focus to the opener", async () => {
    const onClose = vi.fn();
    render(<Page onClose={onClose} />);
    const opener = screen.getByRole("button", { name: "Preview report.txt" });
    opener.focus();
    fireEvent.click(opener);
    const dialog = await screen.findByRole("dialog", { name: "report.txt" });
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });
});
