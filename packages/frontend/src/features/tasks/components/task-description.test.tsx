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
