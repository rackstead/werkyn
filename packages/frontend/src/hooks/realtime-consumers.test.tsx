import type { ReactNode } from "react";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RealtimeProvider } from "@/components/providers/realtime-provider";
import { useWikiRealtime } from "@/features/wiki/hooks/use-wiki-realtime";
import { queryClient } from "@/lib/query-client";
import { queryKeys } from "@/lib/query-keys";
import { useAuthStore } from "@/stores/auth-store";
import { FakeWebSocket } from "@/test/fake-websocket";
import { useRealtime } from "./use-realtime";

// Real provider and WebSocket client; the test delivers server envelopes and
// checks which cached queries each one marks for refetch.

function wrapper({ children }: { children: ReactNode }) {
  return <RealtimeProvider>{children}</RealtimeProvider>;
}

async function connect(hook: () => void) {
  renderHook(hook, { wrapper });
  await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
  const socket = FakeWebSocket.latest();
  act(() => socket.accept());
  return (frame: unknown) => act(() => socket.deliver(frame));
}

function seed(...keys: (readonly unknown[])[]) {
  for (const key of keys) queryClient.setQueryData(key, { data: [] });
}

function stale(key: readonly unknown[]) {
  return queryClient.getQueryState(key)?.isInvalidated;
}

const page = (overrides: Record<string, unknown> = {}) => ({
  id: "page-1",
  spaceId: "space-1",
  parentId: null,
  position: 0,
  title: "Runbook",
  icon: null,
  ...overrides,
});
const tree = (sid: string) => queryKeys.wikiPageTree(sid);
const crumbs = queryKeys.wikiPageBreadcrumbs("page-1");

beforeEach(() => {
  FakeWebSocket.reset();
  vi.stubGlobal("WebSocket", FakeWebSocket);
  useAuthStore.setState({ accessToken: "access-token" });
});

afterEach(() => {
  cleanup();
  queryClient.clear();
  useAuthStore.setState({ accessToken: null });
  vi.unstubAllGlobals();
});

describe("wiki events", () => {
  it("refreshes only the open page and its history for a body-only save", async () => {
    const send = await connect(() => useWikiRealtime("ws"));
    seed(tree("space-1"), crumbs, ["wiki-versions", "page-1"]);
    queryClient.setQueryData(queryKeys.wikiPage("page-1"), { data: page() });
    send({
      event: "wiki_page_updated",
      workspaceId: "ws",
      data: { page: page({ content: [{ type: "paragraph" }] }) },
    });
    expect(stale(queryKeys.wikiPage("page-1"))).toBe(true);
    expect(stale(["wiki-versions", "page-1"])).toBe(true);
    expect(stale(tree("space-1"))).toBe(false);
    expect(stale(crumbs)).toBe(false);
  });

  it("also refreshes trees and breadcrumbs when the title changes", async () => {
    const send = await connect(() => useWikiRealtime("ws"));
    seed(tree("space-1"), tree("space-2"), crumbs);
    queryClient.setQueryData(queryKeys.wikiPage("page-1"), { data: page() });
    send({
      event: "wiki_page_updated",
      workspaceId: "ws",
      data: { page: page({ title: "Runbook v2" }) },
    });
    expect(stale(tree("space-1"))).toBe(true);
    expect(stale(crumbs)).toBe(true);
    expect(stale(tree("space-2"))).toBe(false);
  });

  it.each([
    ["wiki_page_created", { page: page() }, [tree("space-1")]],
    [
      "wiki_page_deleted",
      { pageId: "page-1", spaceId: "space-1" },
      [tree("space-1")],
    ],
    [
      "wiki_page_moved",
      { page: page(), previous: { spaceId: "space-2" } },
      [tree("space-1"), tree("space-2"), crumbs],
    ],
    [
      "wiki_page_locked",
      { pageId: "page-1", lock: {} },
      [["wiki-lock", "page-1"]],
    ],
    ["wiki_page_unlocked", { pageId: "page-1" }, [["wiki-lock", "page-1"]]],
    [
      "wiki_comment_created",
      { pageId: "page-1", comment: {} },
      [["wiki-comments", "page-1", { resolved: false }]],
    ],
    [
      "wiki_comment_resolved",
      { comment: { pageId: "page-1" } },
      [["wiki-comments", "page-1", { resolved: true }]],
    ],
    [
      "wiki_space_created",
      { space: { id: "space-3" } },
      [queryKeys.wikiSpaces("ws")],
    ],
    [
      "wiki_space_updated",
      { space: { id: "space-1" } },
      [queryKeys.wikiSpaces("ws"), queryKeys.wikiSpace("space-1")],
    ],
    [
      "wiki_space_deleted",
      { spaceId: "space-1" },
      [
        queryKeys.wikiSpaces("ws"),
        queryKeys.wikiSpace("space-1"),
        tree("space-1"),
      ],
    ],
  ] as const)(
    "%s refreshes the lists and details it names",
    async (event, data, keys) => {
      const send = await connect(() => useWikiRealtime("ws"));
      const other = ["wiki-lock", "page-9"];
      seed(...keys, other);
      send({ event, workspaceId: "ws", data });
      for (const key of keys) expect(stale(key)).toBe(true);
      expect(stale(other)).toBe(false);
    },
  );

  it("ignores events of another workspace and events without usable IDs", async () => {
    const send = await connect(() => useWikiRealtime("ws"));
    const keys = [
      queryKeys.wikiSpaces("ws"),
      queryKeys.wikiPage("page-1"),
      ["wiki-lock", "page-1"],
      tree("space-1"),
    ];
    seed(...keys);
    send({
      event: "wiki_space_created",
      workspaceId: "other",
      data: { space: { id: "s" } },
    });
    send({ event: "wiki_page_locked", data: { pageId: "page-1" } });
    send({ event: "wiki_page_locked", workspaceId: "ws", data: { pageId: 1 } });
    send({
      event: "wiki_page_updated",
      workspaceId: "ws",
      data: { page: "page-1" },
    });
    send({
      event: "wiki_page_updated",
      workspaceId: "ws",
      data: { page: { id: "" } },
    });
    send({
      event: "wiki_page_created",
      workspaceId: "ws",
      data: { page: { spaceId: ["space-1"] } },
    });
    for (const key of keys) expect(stale(key)).toBe(false);
  });
});

describe("project events", () => {
  it("ignores an event broadcast for another project", async () => {
    const send = await connect(() => useRealtime("project"));
    seed(queryKeys.task("task"), queryKeys.tasks("project"));
    send({
      event: "task_updated",
      projectId: "elsewhere",
      data: { taskId: "task" },
    });
    send({ event: "task_updated", data: { taskId: "task" } });
    expect(stale(queryKeys.task("task"))).toBe(false);
    expect(stale(queryKeys.tasks("project"))).toBe(false);
  });

  it.each(["comment_created", "comment_updated", "comment_deleted"])(
    "%s refreshes the task's comments and activity",
    async (event) => {
      const send = await connect(() => useRealtime("project"));
      seed(queryKeys.comments("task"), queryKeys.activity("task"));
      send({
        event,
        projectId: "project",
        data: { taskId: "task", commentId: "c" },
      });
      expect(stale(queryKeys.comments("task"))).toBe(true);
      expect(stale(queryKeys.activity("task"))).toBe(true);
    },
  );

  it.each([
    "subtask_created",
    "subtask_updated",
    "subtask_toggled",
    "subtask_deleted",
  ])(
    "%s refreshes the task's subtasks, detail and the task lists",
    async (event) => {
      const send = await connect(() => useRealtime("project"));
      seed(
        queryKeys.subtasks("task"),
        queryKeys.task("task"),
        queryKeys.tasks("project", { search: "x" }),
      );
      send({ event, projectId: "project", data: { taskId: "task" } });
      expect(stale(queryKeys.subtasks("task"))).toBe(true);
      expect(stale(queryKeys.task("task"))).toBe(true);
      expect(stale(queryKeys.tasks("project", { search: "x" }))).toBe(true);
    },
  );

  it("does not read a malformed task ID as a task", async () => {
    const send = await connect(() => useRealtime("project"));
    seed(queryKeys.task("[object Object]"), queryKeys.tasks("project"));
    send({
      event: "task_updated",
      projectId: "project",
      data: { taskId: { id: "task" } },
    });
    expect(stale(queryKeys.task("[object Object]"))).toBe(false);
    // The project's lists still refresh.
    expect(stale(queryKeys.tasks("project"))).toBe(true);
  });
});
