import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DriveFile } from "../api";
import { FilePreviewSlideover } from "./file-preview-slideover";

const pdf = vi.hoisted(() => ({
  url: undefined as string | undefined,
  error: null as string | null,
  retry: vi.fn(),
  reportFrameError: vi.fn(),
  isLoading: false,
}));
vi.mock("../hooks/use-pdf-preview", () => ({ usePdfPreview: () => pdf }));

vi.mock("../api", () => ({
  useFilePreviewUrl: () => ({ data: undefined }),
  useFileTextContent: () => ({ data: "quarterly numbers" }),
}));

afterEach(() => {
  cleanup();
  pdf.url = undefined;
  pdf.error = null;
  pdf.retry.mockClear();
  pdf.reportFrameError.mockClear();
  pdf.isLoading = false;
});

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
    await waitFor(() =>
      expect(dialog.contains(document.activeElement)).toBe(true),
    );
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });
});

describe("native PDF preview", () => {
  const document = { ...file, name: "report.pdf", mimeType: "application/pdf" };
  it("embeds the native streaming URL without sending a referrer", () => {
    pdf.url =
      "/api/workspaces/workspace-1/files/file-1/preview?token=scoped-grant";
    const view = render(
      <FilePreviewSlideover
        file={document}
        workspaceId="workspace-1"
        onClose={vi.fn()}
        onDownload={vi.fn()}
      />,
    );
    const frame = screen
      .getAllByTitle("report.pdf")
      .find((element) => element.tagName === "IFRAME")!;
    expect(frame.tagName).toBe("IFRAME");
    expect(frame.getAttribute("src")).toBe(pdf.url);
    expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");
    fireEvent.click(screen.getByRole("button", { name: "Reload preview" }));
    expect(pdf.retry).toHaveBeenCalledTimes(1);
    fireEvent.error(frame);
    expect(pdf.reportFrameError).toHaveBeenCalledTimes(1);
    view.unmount();
    fireEvent.error(frame);
    expect(pdf.reportFrameError).toHaveBeenCalledTimes(1);
  });
  it("shows a visible error and a deliberate preview retry", () => {
    pdf.error = "PDF preview could not be loaded. Try again.";
    const { container } = render(
      <FilePreviewSlideover
        file={document}
        workspaceId="workspace-1"
        onClose={vi.fn()}
        onDownload={vi.fn()}
      />,
    );
    expect(screen.getByRole("alert").textContent).toBe(pdf.error);
    fireEvent.click(screen.getByRole("button", { name: "Retry preview" }));
    expect(pdf.retry).toHaveBeenCalledTimes(1);
    expect(container.querySelector("iframe")).toBeNull();
  });
});
