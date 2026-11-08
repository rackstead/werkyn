import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ShareFileDialog } from "./share-file-dialog";

const state = vi.hoisted(() => ({
  links: [] as Array<Record<string, unknown>>,
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/features/workspaces/api", () => ({
  useWorkspaceMembers: () => ({ data: { data: [] } }),
}));
vi.mock("../api", () => ({
  useFileShares: () => ({ data: { data: [] } }),
  useFileShareLinks: () => ({ data: { data: state.links }, isLoading: false }),
  useCreateFileShares: () => ({ mutate: vi.fn(), isPending: false }),
  useRemoveFileShare: () => ({ mutate: vi.fn(), isPending: false }),
  useCreateFileShareLink: () => ({ mutate: vi.fn(), isPending: false }),
  useUpdateFileShareLink: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteFileShareLink: () => ({ mutate: vi.fn(), isPending: false }),
}));
afterEach(() => {
  cleanup();
  state.links = [];
});

function open() {
  render(
    <ShareFileDialog
      open
      onClose={vi.fn()}
      workspaceId="w"
      fileIds={["file-1"]}
      fileName="Report"
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Link" }));
}

describe("retired drive share links", () => {
  it("shows an 8-character link as dead and still offers removal and a new link", () => {
    state.links = [
      {
        id: "old",
        token: "abcdefgh",
        enabled: true,
        hasPassword: true,
        expiresAt: null,
        retired: true,
        files: [],
      },
    ];
    open();
    expect(screen.getByRole("status").textContent).toMatch(/no longer works/i);
    expect(
      (screen.getByLabelText("Retired share link") as HTMLInputElement).disabled,
    ).toBe(true);
    expect(screen.queryByRole("button", { name: "Copy link" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Open in new tab" }),
    ).toBeNull();
    expect(screen.queryByText("Sharing enabled")).toBeNull();
    expect(screen.getByRole("button", { name: "Remove link" })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Create another link" }),
    ).toBeTruthy();
  });

  it("still treats a current token as a working link", () => {
    state.links = [
      {
        id: "new",
        token: "A".repeat(43),
        enabled: true,
        hasPassword: false,
        expiresAt: null,
        retired: false,
        files: [],
      },
    ];
    open();
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByRole("button", { name: "Copy link" })).toBeTruthy();
    expect(screen.getByText("Sharing enabled")).toBeTruthy();
  });
});
