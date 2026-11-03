import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DriveFilePicker } from "./drive-file-picker";
import type { DriveFile } from "../api";
import { AttachmentList } from "@/features/attachments/components/attachment-list";
import { useAuthStore, type WorkspaceMembership } from "@/stores/auth-store";

const state = vi.hoisted(() => ({
  files: vi.fn(), create: vi.fn(), upload: vi.fn(), error: vi.fn(), link: vi.fn(),
}));
vi.mock("../api", async () => {
  const { useMutation } = await import("@tanstack/react-query");
  return ({
  useFiles: (...args: unknown[]) => state.files(...args),
  useTeamFolders: () => ({ data: { data: [] } }),
  useCreateFolder: () => useMutation({ mutationFn: (name: string) => state.create(name) }),
  uploadSingleFile: (...args: unknown[]) => state.upload(...args),
});
});
vi.mock("sonner", () => ({ toast: { error: state.error } }));
vi.mock("@/lib/identity", () => ({ identityGeneration: () => 1, changeIdentity: vi.fn() }));
vi.mock("@/features/attachments/api", async () => {
  const { useMutation } = await import("@tanstack/react-query");
  return {
    useAttachments: () => ({ isLoading: false, data: { data: [{
      id: "existing", name: "Existing attachment", uploadedById: "actor", mimeType: "text/plain", size: 8,
      fileId: "existing-source", file: { id: "existing-source", trashedAt: null },
    }] } }),
    useDeleteAttachment: () => ({ mutate: vi.fn() }),
    useDownloadAttachment: () => ({ mutate: vi.fn() }),
    useLinkAttachment: () => useMutation({ mutationFn: (id: string) => state.link(id) }),
  };
});

const clients: QueryClient[] = [];
const file = (workspaceId: string, id: string, isFolder = false): DriveFile => ({
  id, workspaceId, parentId: null, name: id, isFolder,
  mimeType: isFolder ? null : "text/plain", size: 8, storagePath: null,
  uploadedById: "actor", ownerId: "actor", teamFolderId: null,
  thumbnailPath: null, trashedAt: null, createdAt: "2026-11-02", updatedAt: "2026-11-02",
  uploadedBy: { id: "actor", displayName: "Actor", avatarUrl: null },
});

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  const onClose = vi.fn(), onSelect = vi.fn();
  let props = { open: true, workspaceId: "alpha", isPending: false };
  const view = () => <QueryClientProvider client={client}>
    <DriveFilePicker {...props} onClose={onClose} onSelect={onSelect} />
  </QueryClientProvider>;
  const rendered = render(view());
  return { ...rendered, onClose, onSelect,
    update(next: Partial<typeof props>) { props = { ...props, ...next }; rendered.rerender(view()); },
  };
}
function draft(name: string) {
  fireEvent.click(screen.getByRole("button", { name: "New Folder" }));
  fireEvent.change(screen.getByPlaceholderText("Folder name"), { target: { value: name } });
}
function attach() { return screen.getByRole("button", { name: "Attach" }) as HTMLButtonElement; }
function upload(container: HTMLElement) {
  let resolve!: (value: DriveFile) => void;
  const promise = new Promise<DriveFile>((done) => { resolve = done; });
  const abort = vi.fn();
  state.upload.mockReturnValueOnce({ promise, abort });
  fireEvent.change(container.querySelector('input[type="file"]')!, {
    target: { files: [new File(["ordinary text"], "upload.txt", { type: "text/plain" })] },
  });
  return { resolve, abort };
}
async function finish(pending: ReturnType<typeof upload>, value: DriveFile) {
  await act(async () => { pending.resolve(value); await Promise.resolve(); });
}

beforeEach(() => {
  state.files.mockReset(); state.create.mockReset(); state.upload.mockReset(); state.error.mockReset(); state.link.mockReset();
  useAuthStore.setState(useAuthStore.getInitialState());
  state.files.mockImplementation((workspace: string, parent: string | null) => ({
    isLoading: false, data: { pages: [{ data: parent
      ? [file(workspace, `${workspace}-nested.txt`)]
      : [file(workspace, `${workspace}-folder`, true), file(workspace, `${workspace}-root.txt`)] }] },
  }));
});
afterEach(() => { cleanup(); for (const client of clients.splice(0)) client.clear(); useAuthStore.setState(useAuthStore.getInitialState()); });

it("keeps ordinary selection, toggle, folder navigation and pending attachment behavior", () => {
  const picker = mount();
  expect(attach().disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: /alpha-root.txt/ }));
  expect(attach().disabled).toBe(false);
  picker.update({ isPending: true });
  expect(attach().disabled).toBe(true);
  fireEvent.click(attach()); expect(picker.onSelect).not.toHaveBeenCalled();
  picker.update({ isPending: false }); fireEvent.click(attach());
  expect(picker.onSelect).toHaveBeenCalledExactlyOnceWith(file("alpha", "alpha-root.txt"));
  fireEvent.click(screen.getByRole("button", { name: /alpha-root.txt/ }));
  expect(attach().disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "alpha-folder" }));
  fireEvent.click(screen.getByRole("button", { name: /alpha-nested.txt/ }));
  fireEvent.click(screen.getByRole("button", { name: "Go back" }));
  expect(attach().disabled).toBe(true);
});

it("retains the explicit cancel reset and close callback", () => {
  const picker = mount();
  fireEvent.click(screen.getByRole("button", { name: "alpha-folder" }));
  draft("Unfinished"); fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(picker.onClose).toHaveBeenCalledOnce();
  expect(screen.queryByRole("button", { name: "Go back" })).toBeNull();
  expect(screen.queryByPlaceholderText("Folder name")).toBeNull();
  expect(attach().disabled).toBe(true);
});

it("starts at root with no selection, folder draft or drag overlay after a parent-controlled close", () => {
  const picker = mount();
  fireEvent.click(screen.getByRole("button", { name: "alpha-folder" }));
  fireEvent.click(screen.getByRole("button", { name: /alpha-nested.txt/ }));
  draft("Unfinished");
  const list = screen.getByRole("button", { name: /alpha-nested.txt/ }).parentElement!;
  fireEvent.dragEnter(list);
  expect(screen.getByText("Drop files here")).toBeTruthy();
  picker.update({ open: false }); picker.update({ open: true });
  expect(screen.queryByRole("button", { name: "Go back" })).toBeNull();
  expect(screen.queryByPlaceholderText("Folder name")).toBeNull();
  expect(screen.queryByText("Drop files here")).toBeNull();
  expect(attach().disabled).toBe(true);
  expect(picker.onClose).not.toHaveBeenCalled();
});

it("queries the new workspace root without the previous workspace folder and clears its selection", () => {
  const picker = mount();
  fireEvent.click(screen.getByRole("button", { name: "alpha-folder" }));
  fireEvent.click(screen.getByRole("button", { name: /alpha-nested.txt/ }));
  draft("Alpha draft"); state.files.mockClear();
  picker.update({ workspaceId: "beta" });
  expect(state.files.mock.calls.every(([workspace, parent]) => workspace === "beta" && parent === null)).toBe(true);
  expect(screen.getByRole("button", { name: "beta-folder" })).toBeTruthy();
  expect(screen.queryByPlaceholderText("Folder name")).toBeNull();
  expect(attach().disabled).toBe(true);
  expect(picker.onSelect).not.toHaveBeenCalled();
});

it("aborts an unfinished upload when the parent closes and ignores its late completion on reopen", async () => {
  const picker = mount(); const pending = upload(picker.baseElement);
  picker.update({ open: false });
  expect(pending.abort).toHaveBeenCalledOnce();
  picker.update({ open: true }); await finish(pending, file("alpha", "late.txt"));
  expect(attach().disabled).toBe(true);
  expect(picker.onSelect).not.toHaveBeenCalled();
});

it("aborts an old workspace upload and ignores its late completion in the new workspace", async () => {
  const picker = mount(); const pending = upload(picker.baseElement);
  picker.update({ workspaceId: "beta" });
  expect(pending.abort).toHaveBeenCalledOnce();
  await finish(pending, file("alpha", "late.txt"));
  expect(attach().disabled).toBe(true);
  expect(picker.onSelect).not.toHaveBeenCalled();
});

it("selects an upload completed in the current open session", async () => {
  const picker = mount(); const pending = upload(picker.baseElement);
  const uploaded = file("alpha", "uploaded.txt"); await finish(pending, uploaded);
  expect(pending.abort).not.toHaveBeenCalled();
  expect(attach().disabled).toBe(false); fireEvent.click(attach());
  expect(picker.onSelect).toHaveBeenCalledExactlyOnceWith(uploaded);
});

it("does not let an old folder creation clear a new session's draft", async () => {
  let resolve!: (value: unknown) => void;
  state.create.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
  const picker = mount(); draft("Old draft"); fireEvent.click(screen.getByRole("button", { name: "Create" }));
  await waitFor(() => expect(state.create).toHaveBeenCalledOnce());
  picker.update({ open: false }); picker.update({ open: true }); draft("New draft");
  await act(async () => { resolve({}); await Promise.resolve(); });
  expect((screen.getByPlaceholderText("Folder name") as HTMLInputElement).value).toBe("New draft");
});

it("does not display a previous workspace's folder creation error in the new session", async () => {
  let reject!: (error: Error) => void;
  state.create.mockReturnValueOnce(new Promise((_done, fail) => { reject = fail; }));
  const picker = mount(); draft("Old draft"); fireEvent.click(screen.getByRole("button", { name: "Create" }));
  await waitFor(() => expect(state.create).toHaveBeenCalledOnce());
  picker.update({ workspaceId: "beta" });
  await act(async () => { reject(new Error("Old request failed")); await Promise.resolve(); });
  expect(state.error).not.toHaveBeenCalled();
});

it("retains current-session folder success and error feedback", async () => {
  state.create.mockResolvedValueOnce({});
  mount(); draft("  New folder  "); fireEvent.click(screen.getByRole("button", { name: "Create" }));
  await waitFor(() => expect(state.create).toHaveBeenCalledExactlyOnceWith("New folder"));
  await waitFor(() => expect(screen.queryByPlaceholderText("Folder name")).toBeNull());
  state.create.mockRejectedValueOnce(new Error("Try again"));
  draft("Retry"); fireEvent.click(screen.getByRole("button", { name: "Create" }));
  await waitFor(() => expect(state.error).toHaveBeenCalledExactlyOnceWith("Try again"));
});

function membership(role: WorkspaceMembership["role"]): WorkspaceMembership {
  return { id: "member", workspaceId: "alpha", role,
    workspace: { id: "alpha", name: "Alpha", slug: "alpha", logoUrl: null } };
}
function mountAttachmentList() {
  useAuthStore.setState({ user: { id: "actor", email: "actor@example.test", displayName: "Actor",
    avatarUrl: null, jobTitle: null, phone: null, timezone: null, emailVerified: true },
    workspaces: [membership("MEMBER")] });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  return render(<QueryClientProvider client={client}>
    <AttachmentList workspaceId="alpha" taskId="task" />
  </QueryClientProvider>);
}

it("resets the real attachment parent's picker after successful linking", async () => {
  state.link.mockResolvedValueOnce({}); mountAttachmentList();
  fireEvent.click(screen.getByRole("button", { name: "Attach file" }));
  fireEvent.click(screen.getByRole("button", { name: "alpha-folder" }));
  fireEvent.click(screen.getByRole("button", { name: /alpha-nested.txt/ }));
  fireEvent.click(attach());
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(state.link).toHaveBeenCalledExactlyOnceWith("alpha-nested.txt");
  fireEvent.click(screen.getByRole("button", { name: "Attach file" }));
  expect(screen.queryByRole("button", { name: "Go back" })).toBeNull();
  expect(attach().disabled).toBe(true);
});

it("resets the real attachment parent's picker when membership loss dismisses it", () => {
  mountAttachmentList(); fireEvent.click(screen.getByRole("button", { name: "Attach file" }));
  fireEvent.click(screen.getByRole("button", { name: "alpha-folder" }));
  fireEvent.click(screen.getByRole("button", { name: /alpha-nested.txt/ }));
  act(() => useAuthStore.setState({ workspaces: [membership("VIEWER")] }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.queryByRole("button", { name: "Attach file" })).toBeNull();
  act(() => useAuthStore.setState({ workspaces: [membership("MEMBER")] }));
  expect(screen.queryByRole("dialog")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Attach file" }));
  expect(screen.queryByRole("button", { name: "Go back" })).toBeNull();
  expect(attach().disabled).toBe(true);
  expect(state.link).not.toHaveBeenCalled();
});
