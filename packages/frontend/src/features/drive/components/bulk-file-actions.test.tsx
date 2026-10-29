import type { ReactNode } from "react";
import { useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DriveFile } from "../api";
import { useAuthStore } from "@/stores/auth-store";
import { DriveBulkActions } from "./drive-bulk-actions";
import { DrivePage } from "./drive-page";
import { MoveDialog } from "./move-dialog";

// A fake network that holds every file PATCH open until the test finishes it,
// so tests choose the order responses come back in.
const net = vi.hoisted(() => ({
  pending: [] as Array<{
    fileId: string;
    resolve: (value: unknown) => void;
    reject: (reason: unknown) => void;
  }>,
  calls: [] as Array<{ fileId: string; body: Record<string, unknown> }>,
  inFlight: 0,
  maxInFlight: 0,
  /** The listing of the root folder; a search finds nothing. */
  root: [] as unknown[],
  /** Listings of other folders by id. */
  folders: {} as Record<string, unknown[]>,
}));

vi.mock("@/lib/api-client", () => ({
  api: {
    patch: (url: string, options: { json: Record<string, unknown> }) => {
      const fileId = url.split("/").pop()!;
      net.calls.push({ fileId, body: options.json });
      net.inFlight++;
      net.maxInFlight = Math.max(net.maxInFlight, net.inFlight);
      const response = new Promise((resolve, reject) => {
        net.pending.push({ fileId, resolve, reject });
      }).finally(() => net.inFlight--);
      return { json: () => response };
    },
    get: (url: string) => ({
      json: () =>
        Promise.resolve(
          url.includes("team-folders") || url.includes("share-status")
            ? { data: [] }
            : {
                data: url.includes("search=")
                  ? []
                  : url.includes("parentId=")
                    ? (net.folders[new URLSearchParams(url.split("?")[1]).get("parentId")!] ?? [])
                    : net.root,
                nextCursor: null,
              },
        ),
    }),
  },
}));

const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast: toasts }));

const flush = () => act(() => new Promise((resolve) => setTimeout(resolve, 0)));

/**
 * Answers every request until none is left, finishing whatever is in flight
 * newest-first (or oldest-first) one response at a time.
 */
async function answerAll(order: "reverse" | "forward", failing: Set<string>) {
  for (let round = 0; round < 200; round++) {
    await flush();
    const batch = net.pending.splice(0);
    if (batch.length === 0) return;
    if (order === "reverse") batch.reverse();
    for (const request of batch) {
      await act(async () => {
        if (failing.has(request.fileId)) request.reject(new Error(`${request.fileId} is locked`));
        else request.resolve({ data: { id: request.fileId } });
      });
    }
  }
  throw new Error("requests kept arriving");
}

const driveFile = (i: number) =>
  ({
    id: `file-${i}`,
    workspaceId: "w",
    parentId: null,
    name: `File ${i}.txt`,
    isFolder: false,
    mimeType: "text/plain",
  }) as DriveFile;

const filesWord = (n: number) => `${n} file${n === 1 ? "" : "s"}`;

let client: QueryClient;
let clientWideError: ReturnType<typeof vi.fn>;

function Providers({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  net.pending = [];
  net.calls = [];
  net.inFlight = 0;
  net.maxInFlight = 0;
  net.root = [];
  net.folders = {};
  clientWideError = vi.fn();
  client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false, onError: clientWideError },
    },
  });
});
afterEach(cleanup);

/** The drive page owns the confirmation so its Delete shortcut can open it too. */
function BulkToolbar({
  files,
  onTrashed,
  initiallyOpen = false,
}: {
  files: DriveFile[];
  onTrashed: (fileIds: string[]) => void;
  initiallyOpen?: boolean;
}) {
  const [confirmOpen, setConfirmOpen] = useState(initiallyOpen);
  return (
    <DriveBulkActions
      workspaceId="w"
      selectedFiles={files}
      onClear={vi.fn()}
      onMoveSelected={vi.fn()}
      trashConfirmOpen={confirmOpen}
      onTrashConfirmOpenChange={setConfirmOpen}
      onTrashed={onTrashed}
    />
  );
}

function expectSummary(
  n: number,
  failedIds: string[],
  verb: { done: string; doneOf: (s: number, n: string) => string; none: string },
) {
  const f = failedIds.length;
  if (f === 0) {
    expect(toasts.success).toHaveBeenCalledTimes(1);
    expect(toasts.success).toHaveBeenCalledWith(verb.done);
    expect(toasts.error).not.toHaveBeenCalled();
    return;
  }
  expect(toasts.success).not.toHaveBeenCalled();
  expect(toasts.error).toHaveBeenCalledTimes(1);
  expect(toasts.error).toHaveBeenCalledWith(
    f === n ? verb.none : `${verb.doneOf(n - f, filesWord(n))}; ${f} failed`,
    { description: `${failedIds[0]} is locked` },
  );
}

const failEverySeventh = (ids: string[]) => ids.filter((_, i) => i % 7 === 3);

describe.each([1, 2, 50])("trashing %i selected file(s)", (n) => {
  const files = Array.from({ length: n }, (_, i) => driveFile(i + 1));
  const ids = files.map((f) => f.id);
  const trashVerb = {
    done: `Moved ${filesWord(n)} to trash`,
    doneOf: (s: number, total: string) => `Moved ${s} of ${total} to trash`,
    none: `Could not move ${filesWord(n)} to trash`,
  };

  async function confirmTrash(onTrashed = vi.fn()) {
    const invalidate = vi.spyOn(client, "invalidateQueries");
    render(<BulkToolbar files={files} onTrashed={onTrashed} />, { wrapper: Providers });
    fireEvent.click(screen.getByRole("button", { name: "Trash" }));
    const dialog = await screen.findByRole("alertdialog", {
      name: `Move ${n} item${n === 1 ? "" : "s"} to trash?`,
    });
    fireEvent.click(screen.getByRole("button", { name: "Trash" }));
    return { dialog, onTrashed, invalidate };
  }

  it("settles when responses come back in reverse order, then reports and deselects every file", async () => {
    const { onTrashed, invalidate } = await confirmTrash();
    await flush();
    // Busy until the batch settles; Escape does not abandon it.
    expect((screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(screen.getByRole("alertdialog")).toBeTruthy();

    await answerAll("reverse", new Set());
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());

    expect(net.calls.map((c) => c.fileId).sort()).toEqual([...ids].sort());
    for (const call of net.calls) expect(typeof call.body.trashedAt).toBe("string");
    expect(net.maxInFlight).toBeLessThanOrEqual(4);
    expectSummary(n, [], trashVerb);
    expect(onTrashed).toHaveBeenCalledTimes(1);
    expect(onTrashed).toHaveBeenCalledWith(ids);
    expect(invalidate.mock.calls).toEqual([[{ queryKey: ["files"] }]]);
    expect(clientWideError).not.toHaveBeenCalled();
  });

  it("reports partial failure truthfully and leaves only the failed files selected", async () => {
    const failed = n === 1 ? ids : n === 2 ? [ids[0]] : failEverySeventh(ids);
    const { onTrashed } = await confirmTrash();
    await answerAll("reverse", new Set(failed));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());

    expectSummary(n, failed, trashVerb);
    expect(onTrashed).toHaveBeenCalledTimes(1);
    expect(onTrashed).toHaveBeenCalledWith(ids.filter((id) => !failed.includes(id)));
    expect(clientWideError).not.toHaveBeenCalled();
  });
});

describe("bulk trash lifecycle", () => {
  it("opens the confirmation from the page's Delete shortcut", async () => {
    render(<BulkToolbar files={[driveFile(1), driveFile(2)]} onTrashed={vi.fn()} initiallyOpen />, {
      wrapper: Providers,
    });
    expect(await screen.findByRole("alertdialog", { name: "Move 2 items to trash?" })).toBeTruthy();
  });

  it("still settles and reports a batch whose toolbar unmounted while it ran", async () => {
    const onTrashed = vi.fn();
    const { unmount } = render(
      <BulkToolbar files={[driveFile(1), driveFile(2)]} onTrashed={onTrashed} />,
      { wrapper: Providers },
    );
    fireEvent.click(screen.getByRole("button", { name: "Trash" }));
    await screen.findByRole("alertdialog");
    fireEvent.click(screen.getByRole("button", { name: "Trash" }));
    await flush();
    unmount();
    await answerAll("forward", new Set(["file-2"]));
    await waitFor(() => expect(onTrashed).toHaveBeenCalledWith(["file-1"]));
    expect(toasts.error).toHaveBeenCalledWith("Moved 1 of 2 files to trash; 1 failed", {
      description: "file-2 is locked",
    });
  });

  it("closes a confirmation with no files on screen to trash, sending nothing", async () => {
    const onTrashed = vi.fn();
    render(<BulkToolbar files={[]} onTrashed={onTrashed} initiallyOpen />, { wrapper: Providers });
    expect((screen.queryAllByRole("button", { name: "Trash", hidden: true })[0] as HTMLButtonElement).disabled).toBe(true);
    await screen.findByRole("alertdialog", { name: "Move 0 items to trash?" });
    fireEvent.click(screen.getByRole("button", { name: "Trash" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(net.calls).toEqual([]);
    expect(onTrashed).not.toHaveBeenCalled();
  });

  it("stays busy in a toolbar mounted while another toolbar's batch runs", async () => {
    const first = render(<BulkToolbar files={[driveFile(1)]} onTrashed={vi.fn()} />, { wrapper: Providers });
    fireEvent.click(screen.getByRole("button", { name: "Trash" }));
    await screen.findByRole("alertdialog");
    fireEvent.click(screen.getByRole("button", { name: "Trash" }));
    await flush();
    first.unmount();

    render(<BulkToolbar files={[driveFile(1)]} onTrashed={vi.fn()} initiallyOpen />, { wrapper: Providers });
    await screen.findByRole("alertdialog");
    const confirm = screen.getByRole("button", { name: "..." }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.click(confirm);
    await answerAll("forward", new Set());
    expect(net.calls.map((c) => c.fileId)).toEqual(["file-1"]);
  });
});

describe("drive page bulk trash", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
    useAuthStore.setState({
      user: { id: "u-1" } as never,
      workspaces: [{ role: "MEMBER", workspace: { id: "w", slug: "acme" } }] as never,
    });
    net.root = [1, 2].map((i) => ({
      ...driveFile(i),
      size: 10,
      starred: false,
      thumbnailPath: null,
      createdAt: "2026-10-01T00:00:00Z",
      updatedAt: "2026-10-01T00:00:00Z",
      uploadedBy: { id: "u-1", displayName: "Ana", avatarUrl: null },
    }));
  });
  afterEach(() => vi.unstubAllGlobals());

  const page = (folderId?: string) => (
    <DrivePage
      workspaceId="w"
      workspaceSlug="acme"
      folderId={folderId}
      view="list"
      trash={false}
      section="drive"
      onNavigate={vi.fn()}
      onViewChange={vi.fn()}
      onTrashToggle={vi.fn()}
    />
  );

  const renderPage = () =>
    render(
      <DrivePage
        workspaceId="w"
        workspaceSlug="acme"
        view="list"
        trash={false}
        section="drive"
        onNavigate={vi.fn()}
        onViewChange={vi.fn()}
        onTrashToggle={vi.fn()}
      />,
      { wrapper: Providers },
    );

  async function select(...names: string[]) {
    for (const name of names) {
      const row = (await screen.findByText(name)).closest("tr, [role='row'], div[class*='group/row']")!;
      fireEvent.click(within(row as HTMLElement).getByRole("checkbox"));
    }
  }

  it("keeps a running Delete-key batch, and the failed file selected, when Escape is pressed", async () => {
    renderPage();
    await select("File 1.txt", "File 2.txt");
    expect(screen.getByText("2 selected")).toBeTruthy();

    fireEvent.keyDown(document.body, { key: "Delete" });
    await screen.findByRole("alertdialog", { name: "Move 2 items to trash?" });
    fireEvent.click(screen.getByRole("button", { name: "Trash" }));
    await flush();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(screen.getByRole("alertdialog")).toBeTruthy();
    expect(screen.getByText("2 selected")).toBeTruthy();

    await answerAll("reverse", new Set(["file-2"]));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(screen.getByText("1 selected")).toBeTruthy();
    expect(toasts.error).toHaveBeenCalledWith("Moved 1 of 2 files to trash; 1 failed", {
      description: "file-2 is locked",
    });
  });

  it("keeps a running batch's confirmation open when a pending search then hides its files", async () => {
    renderPage();
    await select("File 1.txt", "File 2.txt");
    // The search applies after its debounce, by when the batch is running.
    fireEvent.change(screen.getByPlaceholderText("Search files..."), { target: { value: "zzz" } });
    fireEvent.click(screen.getByRole("button", { name: "Trash" }));
    await screen.findByRole("alertdialog", { name: "Move 2 items to trash?" });
    fireEvent.click(screen.getByRole("button", { name: "Trash" }));
    await waitFor(() => expect(screen.queryByText("File 1.txt")).toBeNull());
    await flush();
    expect(screen.getByRole("alertdialog", { name: "Move 2 items to trash?" })).toBeTruthy();
    expect((screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(true);

    await answerAll("forward", new Set());
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(toasts.success).toHaveBeenCalledWith("Moved 2 files to trash");
  });

  it("ignores Delete and Ctrl+A on the page while a busy dialog is open", async () => {
    net.root = [...net.root, { id: "folder-t", name: "Target", isFolder: true, workspaceId: "w" }];
    renderPage();
    await select("File 1.txt", "File 2.txt");

    // A running bulk move: Delete must not open a trash confirmation over it.
    fireEvent.click(screen.getByRole("button", { name: "Move" }));
    const move = await screen.findByRole("dialog");
    fireEvent.click(within(move).getByText("Target"));
    fireEvent.click(within(move).getByRole("button", { name: "Move here" }));
    await flush();
    fireEvent.keyDown(document.body, { key: "Delete" });
    fireEvent.keyDown(document.body, { key: "a", ctrlKey: true });
    await flush();
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.getByText("2 selected")).toBeTruthy();
    await answerAll("forward", new Set(["file-1", "file-2"]));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    // A running bulk trash: Ctrl+A must not change the selection under it.
    fireEvent.keyDown(document.body, { key: "Delete" });
    await screen.findByRole("alertdialog", { name: "Move 2 items to trash?" });
    fireEvent.click(screen.getByRole("button", { name: "Trash" }));
    await flush();
    fireEvent.keyDown(document.body, { key: "a", ctrlKey: true });
    fireEvent.keyDown(document.body, { key: "a", metaKey: true });
    await flush();
    expect(screen.getByRole("alertdialog", { name: "Move 2 items to trash?" })).toBeTruthy();
    expect(screen.getByText("2 selected")).toBeTruthy();
    await answerAll("forward", new Set());
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  });

  it("closes the confirmation when the folder changes mid-batch; the batch still reports", async () => {
    net.folders["folder-x"] = [{ ...driveFile(9), parentId: "folder-x", name: "Other.txt", updatedAt: "2026-10-01T00:00:00Z", uploadedBy: { id: "u-1", displayName: "Ana", avatarUrl: null } }];
    const view = render(page(), { wrapper: Providers });
    await select("File 1.txt", "File 2.txt");
    fireEvent.click(screen.getByRole("button", { name: "Trash" }));
    await screen.findByRole("alertdialog");
    fireEvent.click(screen.getByRole("button", { name: "Trash" }));
    await flush();

    view.rerender(page("folder-x"));
    await select("Other.txt");
    await flush();
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.getByText("1 selected")).toBeTruthy();

    await answerAll("forward", new Set(["file-2"]));
    await waitFor(() =>
      expect(toasts.error).toHaveBeenCalledWith("Moved 1 of 2 files to trash; 1 failed", {
        description: "file-2 is locked",
      }),
    );
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.getByText("1 selected")).toBeTruthy();
  });

  it("still clears the selection with Escape when no dialog is open", async () => {
    renderPage();
    await select("File 1.txt");
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(screen.queryByText("1 selected")).toBeNull();
  });

  it("does not offer to trash selected files that a search hides", async () => {
    renderPage();
    await select("File 1.txt");
    fireEvent.change(screen.getByPlaceholderText("Search files..."), { target: { value: "zzz" } });
    await waitFor(() => expect(screen.queryByText("File 1.txt")).toBeNull());
    fireEvent.keyDown(document.body, { key: "Delete" });
    await flush();
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(net.calls).toEqual([]);
  });
});

describe.each([1, 2, 50])("moving %i selected file(s)", (n) => {
  const ids = Array.from({ length: n }, (_, i) => `file-${i + 1}`);
  const moveVerb = {
    done: `Moved ${filesWord(n)}`,
    doneOf: (s: number, total: string) => `Moved ${s} of ${total}`,
    none: `Could not move ${filesWord(n)}`,
  };

  async function startMove() {
    net.root = [{ id: "folder-archive", name: "Archive", isFolder: true, workspaceId: "w" }];
    const onClose = vi.fn();
    const onMoved = vi.fn();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    render(
      <MoveDialog file={null} fileIds={ids} onClose={onClose} onMoved={onMoved} workspaceId="w" />,
      { wrapper: Providers },
    );
    fireEvent.click(await screen.findByText("Archive"));
    fireEvent.click(screen.getByRole("button", { name: "Move here" }));
    await flush();
    return { onClose, onMoved, invalidate };
  }

  it("moves every file to the chosen folder and settles with responses in reverse order", async () => {
    const { onClose, onMoved, invalidate } = await startMove();
    expect((screen.getByRole("button", { name: "Moving..." }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();

    await answerAll("reverse", new Set());
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));

    expect(net.calls.map((c) => c.fileId).sort()).toEqual([...ids].sort());
    for (const call of net.calls) {
      expect(call.body).toEqual({ parentId: "folder-archive", teamFolderId: null });
    }
    expect(net.maxInFlight).toBeLessThanOrEqual(4);
    expectSummary(n, [], moveVerb);
    expect(onMoved).toHaveBeenCalledWith(ids);
    expect(invalidate.mock.calls.filter(([arg]) => JSON.stringify(arg) === '{"queryKey":["files"]}')).toHaveLength(1);
    expect(clientWideError).not.toHaveBeenCalled();
  });

  it("reports partial failure truthfully and reports only the moved files", async () => {
    const failed = n === 1 ? ids : n === 2 ? [ids[1]] : failEverySeventh(ids);
    const { onClose, onMoved } = await startMove();
    await answerAll("reverse", new Set(failed));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));

    expectSummary(n, failed, moveVerb);
    expect(onMoved).toHaveBeenCalledTimes(1);
    expect(onMoved).toHaveBeenCalledWith(ids.filter((id) => !failed.includes(id)));
    expect(clientWideError).not.toHaveBeenCalled();
  });
});

describe("double submission", () => {
  it("starts one bulk move for two clicks on Move here with no render between them", async () => {
    net.root = [{ id: "folder-archive", name: "Archive", isFolder: true, workspaceId: "w" }];
    const onClose = vi.fn();
    render(<MoveDialog file={null} fileIds={["file-1", "file-2"]} onClose={onClose} workspaceId="w" />, {
      wrapper: Providers,
    });
    fireEvent.click(await screen.findByText("Archive"));
    const button = screen.getByRole("button", { name: "Move here" });
    fireEvent.click(button);
    fireEvent.click(button);
    await answerAll("forward", new Set());
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(net.calls.map((c) => c.fileId)).toEqual(["file-1", "file-2"]);
    expect(toasts.success).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("starts one bulk trash for two confirm clicks with no render between them", async () => {
    render(<BulkToolbar files={[driveFile(1), driveFile(2)]} onTrashed={vi.fn()} initiallyOpen />, {
      wrapper: Providers,
    });
    const confirm = within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Trash" });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    await answerAll("forward", new Set());
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(net.calls.map((c) => c.fileId)).toEqual(["file-1", "file-2"]);
    expect(toasts.success).toHaveBeenCalledTimes(1);
  });
});

describe("bulk move cancel", () => {
  it("closes without moving or deselecting anything", async () => {
    const onClose = vi.fn();
    const onMoved = vi.fn();
    render(
      <MoveDialog file={null} fileIds={["file-1", "file-2"]} onClose={onClose} onMoved={onMoved} workspaceId="w" />,
      { wrapper: Providers },
    );
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onMoved).not.toHaveBeenCalled();
    expect(net.calls).toEqual([]);
  });
});
