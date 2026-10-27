import { type ReactNode } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Editor } from "@tiptap/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAuthStore } from "@/stores/auth-store";
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
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

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
  expect(currentEditor().getHTML()).toBe("<p>Alice draft</p>");
  // Closing as the original identity retries the retained draft immediately.
  screen.unmount();
  await tick();
  expect(http.patch).toHaveBeenCalledWith(`tasks/${id}`, {
    json: { description: "<p>Alice draft</p>" },
    context: { expectedUserId: "task-editor-user" },
  });
});
