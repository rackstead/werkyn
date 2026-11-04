import React from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WikiPageTreeItem } from "@/features/wiki/components/wiki-page-tree-item";
import {
  useEntityAutosave,
  writeAlongsideAutosave,
} from "@/hooks/use-entity-autosave";
import { useAuthStore } from "@/stores/auth-store";
const { writes, rename, create, remove } = vi.hoisted(() => ({
  writes: vi.fn(),
  rename: vi.fn(),
  create: vi.fn(),
  remove: vi.fn(),
}));
vi.mock("@/features/wiki/api", () => ({
  useWikiPageTree: () => ({ data: { data: [] } }),
  useCreateWikiPage: () => ({ mutate: create }),
  useDeleteWikiPage: () => ({ mutate: remove }),
  useUpdateWikiPage: () => ({ mutateAsync: writes }),
  wikiAutosaveKey: (u: string, p: string) => `wiki:${u}:${p}`,
}));
vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: any) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: any) => <>{children}</>,
  DropdownMenuContent: ({ children }: any) => <div>{children}</div>,
  DropdownMenuItem: ({ children, onClick }: any) => (
    <button onClick={onClick}>{children}</button>
  ),
}));
vi.mock("@/components/shared/emoji-picker", () => ({
  EmojiPicker: ({ onChange }: any) => (
    <button onClick={() => onChange("book")}>Owned icon choice</button>
  ),
}));
let seq = 0;
beforeEach(() => {
  vi.clearAllMocks();
  useAuthStore.setState({ user: { id: "revision-user" } as any });
  writes.mockResolvedValue({ data: { revision: 8 } });
});
afterEach(() => cleanup());
function tree(id: string) {
  return (
    <WikiPageTreeItem
      page={
        {
          id,
          spaceId: "s",
          parentId: null,
          title: "Original",
          icon: null,
          revision: 7,
          _count: { children: 0 },
        } as any
      }
      depth={0}
      onPageClick={() => {}}
    />
  );
}
it("tree rename carries its displayed revision without an open editor", async () => {
  const id = `rename-${++seq}`,
    s = render(tree(id));
  fireEvent.click(s.getByText("Rename"));
  fireEvent.change(s.getByRole("textbox"), {
    target: { value: "Chosen title" },
  });
  fireEvent.keyDown(s.getByRole("textbox"), { key: "Enter" });
  await waitFor(() => expect(writes).toHaveBeenCalledTimes(1));
  expect(writes.mock.calls[0][0]).toEqual({
    pageId: id,
    title: "Chosen title",
    expectedRevision: 7,
  });
});
it("tree icon carries its displayed revision without an open editor", async () => {
  const id = `icon-${++seq}`,
    s = render(tree(id));
  fireEvent.click(s.getByText("Owned icon choice"));
  await waitFor(() => expect(writes).toHaveBeenCalledTimes(1));
  expect(writes.mock.calls[0][0]).toEqual({
    pageId: id,
    icon: "book",
    expectedRevision: 7,
  });
});
it("outside callback receives own flushed ACK base rather than a stale rendered base", async () => {
  const id = `queue-${++seq}`,
    key = `wiki:revision-user:${id}`;
  let queue: any;
  const save = vi.fn(async () => 8);
  function Harness() {
    queue = useEntityAutosave(key, save, {
      author: "revision-user",
      revision: 7,
      retryFailedAutomatically: false,
      delay: 60000,
    });
    return null;
  }
  render(<Harness />);
  let captured: any;
  await act(async () => {
    queue.schedule({ content: "own draft" });
    await writeAlongsideAutosave(key, async (base?: number) => {
      captured = base;
      return 9;
    });
  });
  expect(save).toHaveBeenCalledWith({ content: "own draft" }, 7);
  expect(captured).toBe(8);
});
it("failed pending save still prevents the outside write", async () => {
  const id = `blocked-${++seq}`,
    key = `wiki:revision-user:${id}`;
  let queue: any;
  const save = vi.fn(async () => {
    throw new Error("Owned offline");
  });
  function Harness() {
    queue = useEntityAutosave(key, save, {
      author: "revision-user",
      revision: 7,
      retryFailedAutomatically: false,
      delay: 60000,
    });
    return null;
  }
  render(<Harness />);
  const outside = vi.fn(async () => 8);
  await act(async () => {
    queue.schedule({ content: "retained draft" });
    await expect(writeAlongsideAutosave(key, outside)).rejects.toThrow(
      "Save or discard",
    );
  });
  expect(outside).not.toHaveBeenCalled();
  expect(queue.draft).toEqual({ content: "retained draft" });
});
