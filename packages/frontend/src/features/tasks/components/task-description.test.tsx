import { type ReactNode } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Editor } from "@tiptap/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UpdateTaskSchema } from "@pm/shared";
import { useAuthStore } from "@/stores/auth-store";
import { toast } from "sonner";
import { TaskDescription } from "./task-description";

// jsdom has no ClipboardEvent; prosemirror-view's pasteText and pasteHTML build one.
(globalThis as { ClipboardEvent?: unknown }).ClipboardEvent ??= class extends Event {
  clipboardData = null;
};

const { http, editors } = vi.hoisted(() => ({
  http: { patch: vi.fn(), get: vi.fn(), post: vi.fn(), delete: vi.fn() },
  editors: [] as unknown[],
}));
vi.mock("@/lib/api-client", () => ({ api: http }));
vi.mock("@tiptap/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tiptap/react")>();
  return {
    ...actual,
    useEditor: (...args: Parameters<typeof actual.useEditor>) => {
      const editor = actual.useEditor(...args);
      if (editor && !editors.includes(editor)) editors.push(editor);
      return editor;
    },
  };
});
vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), dismiss: vi.fn() },
}));

let client: QueryClient;
let suffix = 0;
function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
async function tick(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}
function currentEditor() {
  return editors.at(-1) as Editor;
}
beforeEach(() => {
  vi.useFakeTimers();
  editors.length = 0;
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  useAuthStore.setState({
    user: {
      id: "task-editor-user",
      email: "editor@example.test",
      displayName: "Editor",
      avatarUrl: null,
      phone: null,
      jobTitle: null,
      timezone: null,
      emailVerified: true,
    },
  });
  http.patch.mockImplementation(
    (path: string, options: { json: Record<string, unknown> }) => ({
      json: async () => ({
        data: {
          id: path.split("/").pop(),
          projectId: "project",
          ...options.json,
        },
      }),
    }),
  );
});
afterEach(async () => {
  cleanup();
  await tick(10);
  client.clear();
  vi.clearAllMocks();
  vi.useRealTimers();
});

it("real Tiptap editor remounts for another task and flushes pending text to the original ID", async () => {
  const a = `task-a-${++suffix}`,
    b = `task-b-${suffix}`;
  const screen = render(
    <TaskDescription taskId={a} description="<p>Original A</p>" canEdit />,
    { wrapper },
  );
  await tick();
  const original = currentEditor();
  act(() => {
    original.commands.setContent("<p>Unsaved A</p>");
  });
  screen.rerender(
    <TaskDescription taskId={b} description="<p>Original B</p>" canEdit />,
  );
  await tick(10);
  expect(currentEditor()).not.toBe(original);
  expect(currentEditor().getHTML()).toBe("<p>Original B</p>");
  expect(http.patch).toHaveBeenCalledTimes(1);
  expect(http.patch).toHaveBeenCalledWith(`tasks/${a}`, {
    json: { description: "<p>Unsaved A</p>" },
    context: { expectedUserId: "task-editor-user" },
  });
});

it("real Tiptap syncs idle remote updates without an update loop and protects dirty local text", async () => {
  const id = `task-sync-${++suffix}`;
  const screen = render(
    <TaskDescription taskId={id} description="<p>Initial</p>" canEdit />,
    { wrapper },
  );
  await tick();
  screen.rerender(
    <TaskDescription taskId={id} description="<p>Remote update</p>" canEdit />,
  );
  await tick();
  expect(currentEditor().getHTML()).toBe("<p>Remote update</p>");
  expect(http.patch).not.toHaveBeenCalled();
  act(() => {
    currentEditor().commands.setContent("<p>Local draft</p>");
  });
  screen.rerender(
    <TaskDescription
      taskId={id}
      description="<p>Another remote update</p>"
      canEdit
    />,
  );
  await tick();
  expect(currentEditor().getHTML()).toBe("<p>Local draft</p>");
  await tick(801);
  expect(http.patch).toHaveBeenCalledWith(`tasks/${id}`, {
    json: { description: "<p>Local draft</p>" },
    context: { expectedUserId: "task-editor-user" },
  });
  expect(currentEditor().getHTML()).toBe("<p>Local draft</p>");
});

it("a refetch of the just-saved description keeps the caret in place", async () => {
  const id = `task-caret-${++suffix}`;
  const screen = render(
    <TaskDescription taskId={id} description="<p>Hello</p>" canEdit />,
    { wrapper },
  );
  await tick();
  const editor = currentEditor();
  act(() => {
    editor.commands.setContent("<p>Hello world again</p>");
    editor.commands.setTextSelection(6);
  });
  await tick(801);
  expect(http.patch).toHaveBeenCalledTimes(1);
  // The detail GET invalidated by the save returns the text that was saved.
  screen.rerender(
    <TaskDescription
      taskId={id}
      description="<p>Hello world again</p>"
      canEdit
    />,
  );
  await tick();
  expect(editor.getHTML()).toBe("<p>Hello world again</p>");
  expect(editor.state.selection.from).toBe(6);
  await tick(801);
  expect(http.patch).toHaveBeenCalledTimes(1);
});

it("does not persist a prior identity's pending task description under a new identity", async () => {
  const id = `task-identity-${++suffix}`;
  const screen = render(
    <TaskDescription taskId={id} description="<p>Server</p>" canEdit />,
    { wrapper },
  );
  await tick();
  act(() => {
    currentEditor().commands.setContent("<p>Alice draft</p>");
  });
  act(() => {
    useAuthStore.setState({
      user: { ...useAuthStore.getState().user!, id: "bob" },
    });
  });
  await tick();
  expect(http.patch).not.toHaveBeenCalled();
  expect(currentEditor().getHTML()).toBe("<p>Server</p>");
  act(() => {
    useAuthStore.setState({
      user: { ...useAuthStore.getState().user!, id: "task-editor-user" },
    });
  });
  await tick();
  // The draft returns only as an explicit offer; the editor shows the server text.
  expect(currentEditor().getHTML()).toBe("<p>Server</p>");
  expect(screen.getByRole("status").textContent).toContain(
    "Earlier changes to this description were not saved",
  );
  expect(http.patch).not.toHaveBeenCalled();
  act(() => {
    screen.getByText("Restore changes").click();
  });
  await tick();
  expect(currentEditor().getHTML()).toBe("<p>Alice draft</p>");
  expect(http.patch).toHaveBeenCalledWith(`tasks/${id}`, {
    json: { description: "<p>Alice draft</p>" },
    context: { expectedUserId: "task-editor-user" },
  });
});

it("a failing autosave shows only its retry notice, not a generic error per attempt", async () => {
  const id = `task-failure-${++suffix}`;
  http.patch.mockImplementation(() => ({
    json: async () => {
      throw new Error("Offline");
    },
  }));
  const screen = render(
    <TaskDescription taskId={id} description="<p>Server</p>" canEdit />,
    { wrapper },
  );
  await tick();
  act(() => {
    currentEditor().commands.setContent("<p>Offline draft</p>");
  });
  await tick(801);
  expect(screen.getByRole("alert").textContent).toContain("Changes not saved");
  const messages = vi
    .mocked(toast.error)
    .mock.calls.map(([message]) => message);
  expect(messages).toEqual([
    "Your changes couldn't be saved. Retry before closing this tab.",
  ]);
});

it("R1c: a failed description draft is offered on reopen, not shown or replayed over a newer description", async () => {
  const id = `task-r1c-${++suffix}`;
  let offline = true;
  const patch = http.patch.getMockImplementation()!;
  http.patch.mockImplementation((path: string, options: any) =>
    offline
      ? {
          json: async () => {
            throw new TypeError("Failed to fetch");
          },
        }
      : patch(path, options),
  );
  const first = render(
    <TaskDescription taskId={id} description="<p>Server</p>" canEdit />,
    { wrapper },
  );
  await tick();
  act(() => {
    currentEditor().commands.setContent("<p>Alice stale</p>");
  });
  // Closing inside the debounce saves immediately; that save fails.
  first.unmount();
  await tick();
  expect(http.patch).toHaveBeenCalledTimes(1);
  offline = false;
  // Someone else has since saved a newer description.
  const reopened = render(
    <TaskDescription taskId={id} description="<p>Bob newer</p>" canEdit />,
    { wrapper },
  );
  await tick();
  expect(currentEditor().getHTML()).toBe("<p>Bob newer</p>");
  expect(reopened.getByRole("status").textContent).toContain(
    "Earlier changes to this description were not saved",
  );
  reopened.unmount();
  await tick(801);
  expect(http.patch).toHaveBeenCalledTimes(1);
});

it("a failed description is only resent when the user retries it", async () => {
  const id = `task-retry-${++suffix}`;
  let offline = true;
  const patch = http.patch.getMockImplementation()!;
  http.patch.mockImplementation((path: string, options: any) =>
    offline
      ? {
          json: async () => {
            throw new TypeError("Failed to fetch");
          },
        }
      : patch(path, options),
  );
  const screen = render(
    <TaskDescription taskId={id} description="<p>Server</p>" canEdit />,
    { wrapper },
  );
  await tick();
  act(() => {
    currentEditor().commands.setContent("<p>Draft</p>");
  });
  await tick(801);
  expect(http.patch).toHaveBeenCalledTimes(1);
  offline = false;
  screen.unmount();
  await tick(801);
  expect(http.patch).toHaveBeenCalledTimes(1);
});

it("idle sync shows a newer description while a set-aside draft stays offered and unsent", async () => {
  const id = `task-sync-parked-${++suffix}`;
  let offline = true;
  const patch = http.patch.getMockImplementation()!;
  http.patch.mockImplementation((path: string, options: any) =>
    offline
      ? {
          json: async () => {
            throw new TypeError("Failed to fetch");
          },
        }
      : patch(path, options),
  );
  const first = render(
    <TaskDescription taskId={id} description="<p>Server</p>" canEdit />,
    { wrapper },
  );
  await tick();
  act(() => {
    currentEditor().commands.setContent("<p>Set aside</p>");
  });
  first.unmount();
  await tick();
  offline = false;
  const reopened = render(
    <TaskDescription taskId={id} description="<p>Server</p>" canEdit />,
    { wrapper },
  );
  await tick();
  reopened.rerender(
    <TaskDescription taskId={id} description="<p>Newer</p>" canEdit />,
  );
  await tick(801);
  expect(currentEditor().getHTML()).toBe("<p>Newer</p>");
  expect(reopened.getByText("Restore changes")).toBeTruthy();
  expect(http.patch).toHaveBeenCalledTimes(1);
});

// A task created from a template before every write path sanitized its
// description can still hold markup like this.
const LEGACY_DESCRIPTION =
  "<p>Legacy <strong>notes</strong></p>" +
  "<style>body{display:none}</style>" +
  '<button command="show-modal" commandfor="own">Open</button>' +
  '<dialog id="own"><form action="https://attacker.example/login">' +
  '<input type="password"></form></dialog>' +
  '<div popover id="pop">Popover</div>' +
  '<button popovertarget="pop">Show</button>' +
  "<svg><style>#root{outline:9px solid red}</style></svg>";

it("a reader's view of a legacy description shows its text but none of its active markup", async () => {
  const screen = render(
    <TaskDescription
      taskId={`task-legacy-${++suffix}`}
      description={LEGACY_DESCRIPTION}
      canEdit={false}
    />,
    { wrapper },
  );
  await tick();
  const view = screen.container.querySelector(".prose")!;
  expect(view.innerHTML).toBe(
    "<p>Legacy <strong>notes</strong></p>OpenPopoverShow",
  );
  // Tiptap injects its own editor styles; nothing else may add a sheet.
  expect(
    document.querySelectorAll("style:not([data-tiptap-style]), link"),
  ).toHaveLength(0);
  expect(getComputedStyle(document.body).display).not.toBe("none");
});

it("an editor opened on a legacy description loads only its text and formatting", async () => {
  const id = `task-legacy-edit-${++suffix}`;
  const screen = render(
    <TaskDescription taskId={id} description={LEGACY_DESCRIPTION} canEdit />,
    { wrapper },
  );
  await tick();
  expect(currentEditor().getHTML()).toBe(
    "<p>Legacy <strong>notes</strong></p><p>OpenPopoverShow</p>",
  );
  expect(
    screen.container.querySelectorAll(
      "style, dialog, button[command], [popover], [popovertarget], svg",
    ),
  ).toHaveLength(0);
});

// jsdom has no ClipboardEvent; EditorView.pasteHTML creates one.
class TestClipboardEvent extends Event {
  readonly clipboardData = null;
}

function captureClipboardDocuments() {
  vi.stubGlobal("ClipboardEvent", TestClipboardEvent);
  const created: Document[] = [];
  const createHTMLDocument = document.implementation.createHTMLDocument.bind(
    document.implementation,
  );
  const spy = vi
    .spyOn(document.implementation, "createHTMLDocument")
    .mockImplementation((title?: string) => {
      const doc = createHTMLDocument(title);
      created.push(doc);
      return doc;
    });
  return {
    created,
    restore: () => {
      spy.mockRestore();
      vi.unstubAllGlobals();
    },
  };
}

it("pasted style sheets never reach the document prosemirror-view inlines styles from", async () => {
  const id = `task-paste-style-${++suffix}`;
  render(<TaskDescription taskId={id} description="<p></p>" canEdit />, {
    wrapper,
  });
  await tick();
  const clipboard = captureClipboardDocuments();
  act(() => {
    currentEditor().view.pasteHTML(
      '<meta charset="utf-8"><style>.cb{font-weight:bold}</style>' +
        '<link rel="stylesheet" href="https://attacker.example/x.css">' +
        '<p><span class="cb">Pasted</span> text</p>' +
        "<svg><style>p{color:red}</style></svg>" +
        "<noscript><style>p{color:red}</style></noscript>",
    );
  });
  clipboard.restore();
  expect(clipboard.created.length).toBeGreaterThan(0);
  for (const doc of clipboard.created) {
    expect(doc.querySelectorAll("style, link, meta")).toHaveLength(0);
    expect(doc.styleSheets).toHaveLength(0);
  }
  await tick(801);
  expect(http.patch).toHaveBeenCalledWith(`tasks/${id}`, {
    json: { description: "<p>Pasted text</p>" },
    context: { expectedUserId: "task-editor-user" },
  });
});

it("a paste with style- and link- custom elements keeps their text, not their tags", async () => {
  const id = `task-paste-custom-${++suffix}`;
  render(<TaskDescription taskId={id} description="<p></p>" canEdit />, {
    wrapper,
  });
  await tick();
  const clipboard = captureClipboardDocuments();
  act(() => {
    currentEditor().view.pasteHTML(
      '<meta charset="utf-8"><p>See <link-preview data-url="https://example.com/docs" style="color: rgb(0, 0, 0);">the docs</link-preview>' +
        ' and <style-chip style="font-weight: 400;">a chip</style-chip>, plus <code>&lt;style&gt;x&lt;/style&gt;</code> here</p>',
    );
  });
  clipboard.restore();
  await tick(801);
  expect(http.patch).toHaveBeenCalledWith(`tasks/${id}`, {
    json: {
      description:
        "<p>See the docs and a chip, plus <code>&lt;style&gt;x&lt;/style&gt;</code> here</p>",
    },
    context: { expectedUserId: "task-editor-user" },
  });
});

it("an ordinary rich-text paste is stored as before", async () => {
  const id = `task-paste-plain-${++suffix}`;
  render(<TaskDescription taskId={id} description="<p></p>" canEdit />, {
    wrapper,
  });
  await tick();
  const clipboard = captureClipboardDocuments();
  act(() => {
    currentEditor().view.pasteHTML(
      "<meta charset='utf-8'><h2>Heading</h2>" +
        '<p><strong>Bold</strong>, <em>italic</em>, <s>struck</s> and <a href="https://example.com/a?b=1&amp;c=2">a link</a></p>' +
        '<ul><li>One</li><li>Two</li></ul><ol start="4"><li>Four</li></ol>' +
        "<blockquote><p>Quoted</p></blockquote><pre><code>x &lt; y</code></pre>" +
        '<p style="font-weight:bold">Inline styled</p><table><tr><td>Cell</td></tr></table>',
    );
  });
  clipboard.restore();
  await tick(801);
  expect(http.patch).toHaveBeenCalledWith(`tasks/${id}`, {
    json: {
      description:
        "<h2>Heading</h2>" +
        '<p><strong>Bold</strong>, <em>italic</em>, <s>struck</s> and <a target="_blank" rel="noopener noreferrer nofollow" href="https://example.com/a?b=1&amp;c=2">a link</a></p>' +
        '<ul><li><p>One</p></li><li><p>Two</p></li></ul><ol start="4"><li><p>Four</p></li></ol>' +
        "<blockquote><p>Quoted</p></blockquote><pre><code>x &lt; y</code></pre>" +
        "<p><strong>Inline styled</strong></p><p>Cell</p>",
    },
    context: { expectedUserId: "task-editor-user" },
  });
});

function sentDescriptions() {
  return http.patch.mock.calls.map(
    ([, options]) => (options as { json: { description: string } }).json.description,
  );
}
function serverAccepts(description: string) {
  return UpdateTaskSchema.safeParse({ description }).success;
}

it("real Tiptap: a plain-text paste with Word and PDF breaks saves a description the server accepts", async () => {
  const id = `task-paste-${++suffix}`;
  render(<TaskDescription taskId={id} description="" canEdit />, { wrapper });
  await tick();
  act(() => {
    // Ctrl+Shift+V of Word text with a manual line break (VT) and a page break (FF).
    currentEditor().view.pasteText("Word line\u000bnext line\fnext page \u001b[0mend\u0007");
  });
  await tick(801);
  act(() => {
    currentEditor().view.pasteHTML("<p>html\u000bline</p>");
  });
  await tick(801);
  const [plain, html] = sentDescriptions();
  expect(plain).toBe("<p>Word line</p><p>next line</p><p>next page [0mend</p>");
  // The HTML paste joins the last paragraph; its vertical tab became a space.
  expect(html).toBe("<p>Word line</p><p>next line</p><p>next page [0mendhtml line</p>");
  expect(serverAccepts(plain)).toBe(true);
  expect(serverAccepts(html)).toBe(true);
});

it("real Tiptap: a legacy description with control characters saves after the next edit", async () => {
  const id = `task-legacy-${++suffix}`;
  const legacy = "<p>legacy\u000bvt esc\u001b[0m end</p>";
  expect(serverAccepts(legacy)).toBe(false);
  const screen = render(<TaskDescription taskId={id} description={legacy} canEdit />, {
    wrapper,
  });
  await tick();
  act(() => {
    const editor = currentEditor();
    editor.commands.insertContentAt(editor.state.doc.content.size - 1, " edited");
  });
  await tick(801);
  expect(sentDescriptions()).toEqual(["<p>legacy vt esc[0m end edited</p>"]);
  expect(serverAccepts(sentDescriptions()[0])).toBe(true);
  expect(screen.queryByRole("alert")).toBeNull();
  expect(toast.error).not.toHaveBeenCalled();
});

describe("description revisions and edit conflicts", () => {
  type Stored = { description: string; descriptionRevision: number };
  const sent: Array<Record<string, unknown>> = [];
  // Stands in for the server's compare-and-set on the description revision.
  function serve(id: string, stored: Stored) {
    sent.length = 0;
    http.patch.mockImplementation(
      (_path: string, options: { json: Record<string, unknown> }) => ({
        json: async () => {
          sent.push(options.json);
          const expected = options.json.expectedDescriptionRevision;
          if (expected !== undefined && expected !== stored.descriptionRevision)
            throw Object.assign(new Error("Refused"), {
              statusCode: 409,
              code: "REVISION_CONFLICT",
              current: {
                revision: stored.descriptionRevision,
                updatedAt: "2026-10-30T00:00:00.000Z",
              },
            });
          stored.description = options.json.description as string;
          stored.descriptionRevision += 1;
          // PATCH returns a summary; the cached detail stays stale until its
          // refetch.
          return { data: { id, projectId: "project", ...stored } };
        },
      }),
    );
  }
  function view(id: string, description: string, revision: number) {
    return (
      <TaskDescription
        taskId={id}
        description={description}
        descriptionRevision={revision}
        canEdit
      />
    );
  }

  it("sends the revision it is based on and its own save's revision while the detail is stale", async () => {
    const id = `task-revision-${++suffix}`;
    const stored = { description: "<p>Start</p>", descriptionRevision: 3 };
    serve(id, stored);
    const screen = render(view(id, "<p>Start</p>", 3), { wrapper });
    await tick();
    act(() => {
      currentEditor().commands.setContent("<p>One</p>");
    });
    await tick(801);
    act(() => {
      currentEditor().commands.setContent("<p>Two</p>");
    });
    await tick(801);
    expect(sent.map((body) => body.expectedDescriptionRevision)).toEqual([3, 4]);
    expect(stored).toEqual({ description: "<p>Two</p>", descriptionRevision: 5 });
    // The refetch catches up, then another user's newer description arrives
    // while idle: it is shown, and the next edit is based on it.
    screen.rerender(view(id, "<p>Two</p>", 5));
    await tick();
    Object.assign(stored, { description: "<p>Theirs</p>", descriptionRevision: 8 });
    screen.rerender(view(id, "<p>Theirs</p>", 8));
    await tick();
    expect(currentEditor().getHTML()).toBe("<p>Theirs</p>");
    act(() => {
      currentEditor().commands.setContent("<p>Theirs and mine</p>");
    });
    await tick(801);
    expect(sent.at(-1)).toEqual({
      description: "<p>Theirs and mine</p>",
      expectedDescriptionRevision: 8,
    });
    expect(stored.descriptionRevision).toBe(9);
  });

  it("a description refused for an older revision is set aside, the stored one shown, and never resent", async () => {
    const id = `task-conflict-${++suffix}`;
    const stored = { description: "<p>Base</p>", descriptionRevision: 1 };
    serve(id, stored);
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const screen = render(view(id, "<p>Base</p>", 1), { wrapper });
    await tick();
    // Someone else saves revision 2 first.
    Object.assign(stored, { description: "<p>Theirs</p>", descriptionRevision: 2 });
    act(() => {
      currentEditor().commands.setContent("<p>Mine</p>");
    });
    await tick(801);
    expect(sent).toEqual([
      { description: "<p>Mine</p>", expectedDescriptionRevision: 1 },
    ]);
    expect(stored.description).toBe("<p>Theirs</p>");
    expect(screen.getByRole("status").textContent).toContain(
      "This description was changed elsewhere while you were editing",
    );
    expect(currentEditor().getHTML()).toBe("<p>Base</p>");
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["tasks", id] });
    expect(screen.queryByText("Retry save")).toBeNull();
    expect(toast.error).not.toHaveBeenCalled();
    act(() => {
      currentEditor().commands.blur();
    });
    await tick(5000);
    expect(sent).toHaveLength(1);

    // The refetch shows the newer description; restoring replaces it on purpose.
    screen.rerender(view(id, "<p>Theirs</p>", 2));
    await tick();
    expect(currentEditor().getHTML()).toBe("<p>Theirs</p>");
    act(() => {
      screen.getByText("Restore changes").click();
    });
    await tick();
    expect(currentEditor().getHTML()).toBe("<p>Mine</p>");
    expect(sent.at(-1)).toEqual({
      description: "<p>Mine</p>",
      expectedDescriptionRevision: 2,
    });
    expect(stored).toEqual({ description: "<p>Mine</p>", descriptionRevision: 3 });
  });
});
