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

it("sidebar serializes two owned changes while the tree refetch is held", async () => {
  const id = `held-sidebar-${++seq}`,
    view = render(tree(id));
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let revision = 7;
  const pending: Promise<any>[] = [];
  writes.mockImplementation((input: any) => {
    const first = pending.length === 0;
    const p = (async () => {
      if (first) await gate;
      if (input.expectedRevision !== revision)
        throw new Error("REVISION_CONFLICT");
      revision++;
      return { data: { revision } };
    })();
    pending.push(p);
    return p;
  });
  try {
    fireEvent.click(view.getByText("Rename"));
    fireEvent.change(view.getByRole("textbox"), {
      target: { value: "Owned rename" },
    });
    fireEvent.keyDown(view.getByRole("textbox"), { key: "Enter" });
    await waitFor(() => expect(writes).toHaveBeenCalledTimes(1));
    fireEvent.click(view.getByText("Owned icon choice"));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(writes).toHaveBeenCalledTimes(1);
    await act(async () => {
      release();
      await Promise.allSettled(pending);
    });
    await waitFor(() => expect(writes).toHaveBeenCalledTimes(2));
    await act(async () => {
      await Promise.allSettled(pending);
    });
    expect(writes.mock.calls.map((c) => c[0].expectedRevision)).toEqual([7, 8]);
    expect(revision).toBe(9);
  } finally {
    release();
    await act(async () => {
      await Promise.allSettled(pending);
    });
  }
});

for (const openEditor of [false, true])
  it(
    "Captured rename rejects remote rerender " +
      (openEditor ? "with open clean editor" : "without editor"),
    async () => {
      const id = `rename-captured-${++seq}`;
      function View({ revision }: { revision: number }) {
        if (openEditor)
          useEntityAutosave(`wiki:revision-user:${id}`, async () => 9, {
            author: "revision-user",
            revision,
            retryFailedAutomatically: false,
            delay: 60000,
          });
        const element = tree(id);
        return React.cloneElement(element, {
          page: { ...(element.props as any).page, revision },
        });
      }
      const view = render(<View revision={7} />);
      fireEvent.click(view.getByText("Rename"));
      fireEvent.change(view.getByRole("textbox"), {
        target: { value: "Chosen before remote update" },
      });
      view.rerender(<View revision={8} />);
      expect((view.getByRole("textbox") as HTMLInputElement).value).toBe(
        "Chosen before remote update",
      );
      fireEvent.keyDown(view.getByRole("textbox"), { key: "Enter" });
      await waitFor(() => expect(writes).toHaveBeenCalledTimes(1));
      expect(writes.mock.calls[0][0].expectedRevision).toBe(7);
    },
  );

it("Competing outside writes with an open clean queue wait for the preceding own ACK", async () => {
  useAuthStore.setState({ user: { id: "outside-author" } as any });
  const key = "wiki:outside-author:owned-competing-page";
  function Harness() {
    useEntityAutosave(key, async () => 8, {
      author: "outside-author",
      revision: 7,
      retryFailedAutomatically: false,
      delay: 60000,
    });
    return null;
  }
  render(<Harness />);
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r)),
    calls: { name: string; base: number | undefined }[] = [];
  let one!: Promise<void>, two!: Promise<void>;
  await act(async () => {
    one = writeAlongsideAutosave(key, async (base) => {
      calls.push({ name: "one", base });
      expect(base).toBe(7);
      await gate;
      return 8;
    });
    two = writeAlongsideAutosave(key, async (base) => {
      calls.push({ name: "two", base });
      expect(base).toBe(8);
      return 9;
    });
    one.catch(() => {});
    two.catch(() => {});
    await Promise.resolve();
    await Promise.resolve();
  });
  try {
    expect(calls).toEqual([{ name: "one", base: 7 }]);
    await act(async () => {
      release();
      const settled = await Promise.allSettled([one, two]);
      expect(settled.map((x) => x.status)).toEqual(["fulfilled", "fulfilled"]);
    });
    expect(calls).toEqual([
      { name: "one", base: 7 },
      { name: "two", base: 8 },
    ]);
  } finally {
    release();
    await act(async () => {
      await Promise.allSettled([one, two]);
    });
  }
});

it("a failed sidebar write does not advance the next explicit change", async () => {
  const id = `sidebar-failed-${++seq}`,
    view = render(tree(id));
  let revision = 7;
  writes.mockImplementation(async (input: any) => {
    if (writes.mock.calls.length === 1)
      throw new Error("Owned offline failure");
    expect(input.expectedRevision).toBe(revision);
    return { data: { revision: ++revision } };
  });
  fireEvent.click(view.getByText("Rename"));
  fireEvent.change(view.getByRole("textbox"), {
    target: { value: "Failed title" },
  });
  fireEvent.keyDown(view.getByRole("textbox"), { key: "Enter" });
  await waitFor(() => expect(writes).toHaveBeenCalledTimes(1));
  await act(async () => {
    await Promise.allSettled([writes.mock.results[0].value]);
  });
  fireEvent.click(view.getByText("Owned icon choice"));
  await waitFor(() => expect(writes).toHaveBeenCalledTimes(2));
  await act(async () => {
    await Promise.allSettled([writes.mock.results[1].value]);
  });
  expect(writes.mock.calls.map((c) => c[0].expectedRevision)).toEqual([7, 7]);
  expect(revision).toBe(8);
});
it("an independent newer write still conflicts with the local sidebar ACK chain", async () => {
  const id = `sidebar-remote-${++seq}`,
    view = render(tree(id));
  const stored = {
    revision: 7,
    title: "Original",
    icon: null as string | null,
  };
  writes.mockImplementation(async (input: any) => {
    if (input.expectedRevision !== stored.revision)
      throw Object.assign(new Error("Remote revision changed"), {
        statusCode: 409,
        code: "REVISION_CONFLICT",
      });
    stored.revision++;
    if (input.title !== undefined) stored.title = input.title;
    if (input.icon !== undefined) stored.icon = input.icon;
    return { data: { revision: stored.revision } };
  });
  fireEvent.click(view.getByText("Rename"));
  fireEvent.change(view.getByRole("textbox"), {
    target: { value: "Own title" },
  });
  fireEvent.keyDown(view.getByRole("textbox"), { key: "Enter" });
  await waitFor(() => expect(writes).toHaveBeenCalledTimes(1));
  await act(async () => {
    await writes.mock.results[0].value;
  });
  stored.revision = 9;
  stored.title = "Remote title";
  fireEvent.click(view.getByText("Owned icon choice"));
  await waitFor(() => expect(writes).toHaveBeenCalledTimes(2));
  await expect(writes.mock.results[1].value).rejects.toMatchObject({
    statusCode: 409,
    code: "REVISION_CONFLICT",
  });
  expect(writes.mock.calls.map((c) => c[0].expectedRevision)).toEqual([7, 8]);
  expect(stored).toEqual({ revision: 9, title: "Remote title", icon: null });
});
