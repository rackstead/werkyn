import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AttachmentList } from "./attachment-list";

const state = vi.hoisted(() => ({ download: vi.fn(), remove: vi.fn() }));
vi.mock("../api", () => ({
  useAttachments: () => ({
    data: {
      data: [
        {
          id: "set-null",
          name: "Unavailable file",
          mimeType: "application/octet-stream",
          size: 0,
          fileId: null,
          file: null,
        },
        {
          id: "readable",
          name: "Readable document.txt",
          mimeType: "text/plain",
          size: 12,
          fileId: "source",
          file: { id: "source", trashedAt: null },
        },
        {
          id: "old-trash-response",
          name: "Trashed document.txt",
          mimeType: "text/plain",
          size: 12,
          fileId: "trashed-source",
          file: { id: "trashed-source", trashedAt: "2026-01-01" },
        },
      ],
    },
    isLoading: false,
  }),
  useDownloadAttachment: () => ({ mutate: state.download }),
  useDeleteAttachment: () => ({ mutate: state.remove }),
  useLinkAttachment: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/features/drive/components/drive-file-picker", () => ({
  DriveFilePicker: () => null,
}));
afterEach(() => cleanup());

it("shows SetNull sources as unavailable, disables unavailable downloads and retains cleanup and readable downloads", () => {
  render(<AttachmentList workspaceId="workspace" taskId="task" canEdit />);
  expect(screen.getByText("Unavailable file")).toBeTruthy();
  const unavailable = screen.getAllByRole("button", {
    name: "Source file is unavailable",
  });
  expect(unavailable).toHaveLength(2);
  for (const button of unavailable) {
    expect((button as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(button);
  }
  expect(state.download).not.toHaveBeenCalled();
  fireEvent.click(screen.getAllByRole("button", { name: "Remove" })[0]);
  expect(state.remove).toHaveBeenCalledWith("set-null", expect.any(Object));
  fireEvent.click(screen.getByRole("button", { name: "Download" }));
  expect(state.download).toHaveBeenCalledExactlyOnceWith(
    { attachmentId: "readable", fileName: "Readable document.txt" },
    expect.any(Object),
  );
});
