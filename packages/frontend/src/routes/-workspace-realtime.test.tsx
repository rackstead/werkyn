import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { queryClient } from "@/lib/query-client";
import { routeTree } from "@/routeTree.gen";
import { useAuthStore, type WorkspaceMembership } from "@/stores/auth-store";
import { FakeWebSocket } from "@/test/fake-websocket";

// Real router, provider, WebSocket client and React Query. Only the HTTP API,
// the browser WebSocket and a few heavy views are replaced; the test plays the
// server by delivering the frames the backend broadcasts.

type Paragraph = { type: "paragraph"; content: string };
vi.hoisted(() => {
  // jsdom has no matchMedia; the theme store reads it at import.
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList;
});
const { http, server, toast, gets } = vi.hoisted(() => {
  const gets: string[] = [];
  const toast = Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    dismiss: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  });
  return {
    gets,
    toast,
    server: {
      page: null as unknown as {
        id: string;
        spaceId: string;
        title: string;
        icon: null;
        updatedAt: string;
        content: Paragraph[];
      },
      lock: null as null | {
        id: string;
        pageId: string;
        userId: string;
        user: { displayName: string };
      },
      unread: 0,
      taskTitle: "",
      comments: [] as string[],
      blockers: [] as string[],
      subtasks: [] as string[],
      patches: [] as { path: string; body: unknown }[],
    },
    http: {
      get: vi.fn(),
      post: vi.fn(),
      patch: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
    },
  };
});

vi.mock("@/lib/api-client", () => ({ api: http }));
vi.mock("sonner", () => ({ toast, Toaster: () => null }));
vi.mock("@/features/kanban", () => ({ Board: () => null }));
vi.mock("@/features/list-view/components/task-table", () => ({
  TaskTable: () => null,
}));
vi.mock("@/features/tasks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/features/tasks")>();
  const { useTask } = await import("@/features/tasks/api");
  const { useComments } = await import("@/features/comments/api");
  const { useSubtasks } = await import("@/features/subtasks/api");
  // The open task panel, reduced to the queries it reads.
  function TaskPanel({ taskId }: { taskId: string }) {
    const task = useTask(taskId).data?.data as
      | { title: string; blockedBy: { id: string }[] }
      | undefined;
    const comments = useComments(taskId).data?.pages.flatMap(
      (page) => page.data as unknown as { body: string }[],
    );
    const subtasks = useSubtasks(taskId).data?.data as
      | { title: string }[]
      | undefined;
    return (
      <section aria-label="Task panel">
        <h2>{task?.title}</h2>
        <p>blocked by {task?.blockedBy.length ?? 0}</p>
        <ul aria-label="Comments">
          {comments?.map((comment) => (
            <li key={comment.body}>{comment.body}</li>
          ))}
        </ul>
        <ul aria-label="Subtasks">
          {subtasks?.map((subtask) => (
            <li key={subtask.title}>{subtask.title}</li>
          ))}
        </ul>
      </section>
    );
  }
  return { ...actual, TaskSlideover: TaskPanel };
});
// BlockNote reduced to a document and a text box, so the real WikiEditor
// still decides when a server document replaces the one on screen.
vi.mock("@blocknote/react", async () => {
  const React = await import("react");
  return {
    useCreateBlockNote: (options: { initialContent?: unknown[] }) => {
      const [editor] = React.useState(() => {
        const editor = {
          document: options.initialContent ?? [{ type: "paragraph" }],
          isEditable: true,
          notify: () => {},
          replaceBlocks(_old: unknown, next: unknown[]) {
            editor.document = next;
            editor.notify();
          },
        };
        return editor;
      });
      return editor;
    },
  };
});
vi.mock("@blocknote/mantine", async () => {
  const React = await import("react");
  return {
    BlockNoteView: ({
      editor,
      editable,
      onChange,
    }: {
      editor: { document: Paragraph[]; notify: () => void };
      editable: boolean;
      onChange: () => void;
    }) => {
      const [, rerender] = React.useReducer((n: number) => n + 1, 0);
      editor.notify = () => {
        onChange();
        rerender();
      };
      return (
        <textarea
          aria-label="Page body"
          disabled={!editable}
          value={editor.document.map((block) => block.content ?? "").join("\n")}
          onChange={(event) => {
            editor.document = [
              { type: "paragraph", content: event.target.value },
            ];
            editor.notify();
          }}
        />
      );
    },
  };
});

const acme: WorkspaceMembership = {
  id: "member-acme",
  workspaceId: "ws-acme",
  role: "ADMIN",
  workspace: { id: "ws-acme", name: "Acme", slug: "acme", logoUrl: null },
};
const beta: WorkspaceMembership = {
  id: "member-beta",
  workspaceId: "ws-beta",
  role: "ADMIN",
  workspace: { id: "ws-beta", name: "Beta", slug: "beta", logoUrl: null },
};

function paragraph(content: string): Paragraph[] {
  return [{ type: "paragraph", content }];
}

function respond(path: string): unknown {
  if (path === "wiki/pages/page-1") return { data: server.page };
  if (path === "wiki/pages/page-1/lock") return { data: server.lock };
  if (path === "notifications/unread-count") return { count: server.unread };
  if (path.startsWith("workspaces/") && path.endsWith("/settings"))
    return { data: { enabledModules: ["drive", "wiki", "time", "chat"] } };
  if (path === "projects/p1")
    return { data: { id: "p1", name: "Launch", color: null, archived: false } };
  if (path === "tasks/t1")
    return {
      data: {
        id: "t1",
        projectId: "p1",
        title: server.taskTitle,
        blockedBy: server.blockers.map((id) => ({ id })),
        blocking: [],
      },
    };
  if (path === "tasks/t1/comments")
    return { data: server.comments.map((body) => ({ id: body, body })) };
  if (path === "tasks/t1/subtasks")
    return { data: server.subtasks.map((title) => ({ id: title, title })) };
  return { data: [] };
}

function reply(value: unknown) {
  const promise = Promise.resolve(value);
  return Object.assign(promise, { json: () => promise });
}

let socket: FakeWebSocket;
let router: ReturnType<typeof createRouter>;

async function open(url: string) {
  router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [url] }),
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
  await waitFor(() => expect(FakeWebSocket.instances.length).toBe(1));
  socket = FakeWebSocket.latest();
  act(() => socket.accept());
}

async function go(url: string) {
  await act(async () => {
    router.history.push(url);
  });
  await waitFor(() => expect(router.state.location.href).toBe(url));
  await act(async () => {
    await Promise.resolve();
  });
}

function deliver(frame: unknown) {
  act(() => socket.deliver(frame));
}

function fetchesOf(path: string) {
  return gets.filter((requested) => requested === path).length;
}

function framesSent() {
  return socket.sent.filter((frame) => frame.type !== "auth");
}

function textBox() {
  return screen.getByLabelText("Page body") as HTMLTextAreaElement;
}

beforeEach(() => {
  FakeWebSocket.reset();
  vi.stubGlobal("WebSocket", FakeWebSocket);
  gets.length = 0;
  server.page = {
    id: "page-1",
    spaceId: "space-1",
    title: "Runbook",
    icon: null,
    updatedAt: "2026-10-01T00:00:00.000Z",
    content: paragraph("first version"),
  };
  server.lock = null;
  server.unread = 0;
  server.taskTitle = "Write launch plan";
  server.comments = [];
  server.blockers = [];
  server.subtasks = [];
  server.patches = [];
  http.get.mockImplementation((path: string) => {
    gets.push(path);
    return reply(respond(path));
  });
  http.post.mockImplementation((path: string) => {
    if (path === "wiki/pages/page-1/lock") {
      server.lock = {
        id: "lock-alice",
        pageId: "page-1",
        userId: "u-alice",
        user: { displayName: "Alice" },
      };
      return reply({ data: server.lock });
    }
    return reply({ data: {} });
  });
  http.patch.mockImplementation(
    (path: string, options?: { json?: Record<string, unknown> }) => {
      if (path.endsWith("/heartbeat")) return reply(undefined);
      server.patches.push({ path, body: options?.json });
      if (path === "wiki/pages/page-1") {
        server.page = { ...server.page, ...(options?.json as object) };
        return reply({ data: server.page });
      }
      return reply({ data: {} });
    },
  );
  http.delete.mockImplementation((path: string) => {
    if (path === "wiki/pages/page-1/lock") server.lock = null;
    return reply(undefined);
  });
  useAuthStore.setState({
    accessToken: "access-token",
    isHydrated: true,
    user: {
      id: "u-alice",
      email: "alice@example.test",
      displayName: "Alice",
      avatarUrl: null,
      phone: null,
      jobTitle: null,
      timezone: null,
      emailVerified: true,
    },
    workspaces: [acme, beta],
  });
});

afterEach(async () => {
  cleanup();
  queryClient.clear();
  useAuthStore.setState({ accessToken: null, user: null, workspaces: [] });
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("workspace realtime subscriptions", () => {
  it("keeps one workspace subscription and cleans project subscriptions across routes", async () => {
    await open("/acme/projects/p1/board");
    await waitFor(() =>
      expect(framesSent()).toEqual(
        expect.arrayContaining([
          { type: "subscribe_workspace", workspaceId: "ws-acme" },
          { type: "subscribe", projectId: "p1" },
        ]),
      ),
    );
    expect(framesSent()).toHaveLength(2);

    // Board -> list of the same project: nothing to change on the server.
    await go("/acme/projects/p1/list");
    expect(framesSent()).toHaveLength(2);

    // Leaving the project releases it; the workspace stays subscribed.
    await go("/acme/knowledge?pageId=page-1");
    await waitFor(() =>
      expect(framesSent().slice(2)).toEqual([
        { type: "unsubscribe", projectId: "p1" },
      ]),
    );
    await go("/acme/projects");
    expect(framesSent()).toHaveLength(3);

    // Switching workspace moves the one subscription.
    await go("/beta/projects");
    await waitFor(() => expect(framesSent()).toHaveLength(5));
    expect(framesSent().slice(3)).toEqual(
      expect.arrayContaining([
        { type: "unsubscribe_workspace", workspaceId: "ws-acme" },
        { type: "subscribe_workspace", workspaceId: "ws-beta" },
      ]),
    );
    expect(
      framesSent().filter((frame) => frame.type === "subscribe_workspace"),
    ).toHaveLength(2);
  });

  it("ignores a late event from the workspace that was left", async () => {
    await open("/acme/projects");
    await go("/beta/projects");
    const spaces = "workspaces/ws-beta/wiki/spaces";
    await waitFor(() => expect(fetchesOf(spaces)).toBe(1));
    deliver({
      event: "wiki_space_created",
      workspaceId: "ws-acme",
      data: { space: { id: "space-x" } },
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(fetchesOf(spaces)).toBe(1);
    deliver({
      event: "wiki_space_created",
      workspaceId: "ws-beta",
      data: { space: { id: "space-y" } },
    });
    await waitFor(() => expect(fetchesOf(spaces)).toBe(2));
  });

  it("closes the connection and its subscriptions on sign-out", async () => {
    await open("/acme/projects/p1/board");
    await waitFor(() =>
      expect(framesSent()).toContainEqual({
        type: "subscribe",
        projectId: "p1",
      }),
    );
    act(() => useAuthStore.setState({ accessToken: null }));
    expect(socket.closed).toBe(true);
  });
});

describe("wiki pages, locks and notifications", () => {
  it("shows another user's page update on an open, idle page without a reload", async () => {
    await open("/acme/knowledge?pageId=page-1");
    await waitFor(() => expect(textBox().value).toBe("first version"));
    const before = fetchesOf("wiki/pages/page-1");

    server.page = {
      ...server.page,
      title: "Runbook v2",
      content: paragraph("bob's version"),
    };
    deliver({
      event: "wiki_page_updated",
      workspaceId: "ws-acme",
      data: { page: server.page },
    });
    await waitFor(() => expect(textBox().value).toBe("bob's version"));
    expect(fetchesOf("wiki/pages/page-1")).toBe(before + 1);
    expect(server.patches).toEqual([]);
  });

  it("keeps a dirty draft, and sends only that draft once, when an update arrives mid-edit", async () => {
    await open("/acme/knowledge?pageId=page-1");
    await waitFor(() => expect(screen.getByText("Start Editing")).toBeTruthy());
    fireEvent.click(screen.getByText("Start Editing"));
    await waitFor(() => expect(textBox().disabled).toBe(false));

    fireEvent.change(textBox(), { target: { value: "alice's draft" } });
    server.page = { ...server.page, content: paragraph("bob's version") };
    const before = fetchesOf("wiki/pages/page-1");
    deliver({
      event: "wiki_page_updated",
      workspaceId: "ws-acme",
      data: { page: server.page },
    });
    await waitFor(() =>
      expect(fetchesOf("wiki/pages/page-1")).toBe(before + 1),
    );
    expect(textBox().value).toBe("alice's draft");

    fireEvent.click(screen.getByText("Done Editing"));
    await waitFor(() => expect(server.lock).toBeNull());
    expect(server.patches).toEqual([
      {
        path: "wiki/pages/page-1",
        body: expect.objectContaining({ content: paragraph("alice's draft") }),
      },
    ]);
    expect(textBox().value).toBe("alice's draft");
  });

  it("follows another user's lock and release on an open page", async () => {
    await open("/acme/knowledge?pageId=page-1");
    await waitFor(() => expect(screen.getByText("Start Editing")).toBeTruthy());

    server.lock = {
      id: "lock-bob",
      pageId: "page-1",
      userId: "u-bob",
      user: { displayName: "Bob" },
    };
    deliver({
      event: "wiki_page_locked",
      workspaceId: "ws-acme",
      data: { pageId: "page-1", lock: server.lock },
    });
    await waitFor(() =>
      expect(screen.getByText(/Being edited by Bob/)).toBeTruthy(),
    );
    expect(screen.queryByText("Start Editing")).toBeNull();

    server.lock = null;
    deliver({
      event: "wiki_page_unlocked",
      workspaceId: "ws-acme",
      data: { pageId: "page-1" },
    });
    await waitFor(() => expect(screen.getByText("Start Editing")).toBeTruthy());
  });

  it("refreshes the bell and shows the title of a pushed notification", async () => {
    await open("/acme/projects");
    await waitFor(() =>
      expect(fetchesOf("notifications/unread-count")).toBeGreaterThan(0),
    );
    const before = fetchesOf("notifications/unread-count");
    server.unread = 1;
    deliver({
      event: "notification_new",
      data: {
        id: "n1",
        type: "TASK_ASSIGNED",
        title: "Bob assigned you a task",
      },
    });
    await waitFor(() =>
      expect(fetchesOf("notifications/unread-count")).toBe(before + 1),
    );
    expect(toast).toHaveBeenCalledWith("Bob assigned you a task", {
      duration: 4000,
    });

    // Chat mentions and direct messages push under another name.
    server.unread = 2;
    deliver({
      event: "notification_created",
      data: { id: "n2", type: "CHAT_MENTION", title: "Bob mentioned you" },
    });
    await waitFor(() =>
      expect(fetchesOf("notifications/unread-count")).toBe(before + 2),
    );
    expect(toast).toHaveBeenCalledTimes(1);
  });

  it("safely ignores malformed and unknown frames, then handles the next valid one", async () => {
    await open("/acme/knowledge?pageId=page-1");
    await waitFor(() => expect(textBox().value).toBe("first version"));
    const before = fetchesOf("wiki/pages/page-1");

    for (const frame of [
      "{not json",
      "[]",
      { event: 42 },
      { event: "wiki_page_updated", workspaceId: "ws-acme", data: "page-1" },
      {
        event: "wiki_page_updated",
        workspaceId: "ws-acme",
        data: { page: { id: 7 } },
      },
      {
        event: "wiki_page_updated",
        workspaceId: "ws-acme",
        data: { page: null },
      },
      { event: "wiki_page_locked", workspaceId: "ws-acme", data: {} },
      { event: "notification_new", data: { title: { html: "<b>x</b>" } } },
      {
        event: "no_such_event",
        workspaceId: "ws-acme",
        data: { pageId: "page-1" },
      },
    ]) {
      expect(() => deliver(frame)).not.toThrow();
    }
    await act(async () => {
      await Promise.resolve();
    });
    expect(fetchesOf("wiki/pages/page-1")).toBe(before);
    expect(toast).not.toHaveBeenCalled();

    server.page = { ...server.page, content: paragraph("after noise") };
    deliver({
      event: "wiki_page_updated",
      workspaceId: "ws-acme",
      data: { page: server.page },
    });
    await waitFor(() => expect(textBox().value).toBe("after noise"));
  });
});

describe("project task panel", () => {
  it("refreshes an open task's detail, comments, dependencies and subtasks from server envelopes", async () => {
    await open("/acme/projects/p1/board?task=t1");
    await waitFor(() =>
      expect(screen.getByText("Write launch plan")).toBeTruthy(),
    );

    server.taskTitle = "Write the final launch plan";
    deliver({ event: "task_updated", projectId: "p1", data: { taskId: "t1" } });
    await waitFor(() =>
      expect(screen.getByText("Write the final launch plan")).toBeTruthy(),
    );

    server.comments = ["Bob: looks good"];
    deliver({
      event: "comment_created",
      projectId: "p1",
      data: { taskId: "t1", commentId: "c1" },
    });
    await waitFor(() =>
      expect(screen.getByText("Bob: looks good")).toBeTruthy(),
    );

    server.blockers = ["dep-1"];
    deliver({
      event: "dependency_created",
      projectId: "p1",
      data: { taskId: "t1", blockingTaskId: "t2" },
    });
    await waitFor(() => expect(screen.getByText("blocked by 1")).toBeTruthy());

    server.subtasks = ["Draft outline"];
    deliver({
      event: "subtask_created",
      projectId: "p1",
      data: { taskId: "t1", subtaskId: "s1" },
    });
    await waitFor(() => expect(screen.getByText("Draft outline")).toBeTruthy());
  });
});
