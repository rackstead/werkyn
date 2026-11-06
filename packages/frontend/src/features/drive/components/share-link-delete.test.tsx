import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ShareFileDialog } from "./share-file-dialog";

const state = vi.hoisted(() => ({ create: vi.fn(), remove: vi.fn() }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/features/workspaces/api", () => ({ useWorkspaceMembers: () => ({ data: { data: [] } }) }));
vi.mock("../api", () => ({
  useFileShares: () => ({ data: { data: [] } }),
  useFileShareLinks: () => ({ data: undefined, isLoading: false }),
  useCreateFileShares: () => ({ mutate: vi.fn(), isPending: false }),
  useRemoveFileShare: () => ({ mutate: vi.fn(), isPending: false }),
  useCreateFileShareLink: () => ({ mutate: state.create, isPending: false }),
  useUpdateFileShareLink: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteFileShareLink: () => ({ mutate: state.remove, isPending: false }),
}));
afterEach(cleanup);

describe("share dialog for several files", () => {
  it("names the link's files when it removes a link created in the dialog", () => {
    state.create.mockImplementation((_input, options) =>
      options.onSuccess({
        data: {
          id: "link-1",
          token: "token-1",
          enabled: true,
          hasPassword: false,
          expiresAt: null,
          files: [{ file: { id: "a" } }, { file: { id: "b" } }],
        },
      }),
    );
    render(<ShareFileDialog open onClose={vi.fn()} workspaceId="w" fileIds={["a", "b"]} fileName="2 files" />);
    fireEvent.click(screen.getByRole("button", { name: "Link" }));
    fireEvent.click(screen.getByRole("button", { name: "Create link" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove link" }));
    expect(state.remove).toHaveBeenCalledWith({ linkId: "link-1", fileIds: ["a", "b"] }, expect.anything());
  });
});
