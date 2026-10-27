import type { ReactNode } from "react";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { queryClient } from "@/lib/query-client";
import { queryKeys } from "@/lib/query-keys";
import { useRealtime } from "@/hooks/use-realtime";
import {
  useAddDependency,
  useRemoveDependency,
  useTask,
  useUpdateTask,
} from "./api";

const { http, handlers, socket } = vi.hoisted(() => {
  const handlers = new Map<string, (message: unknown) => void>();
  return {
    http: { get: vi.fn(), patch: vi.fn(), post: vi.fn(), delete: vi.fn() },
    handlers,
    socket: {
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
      on: vi.fn((event: string, handler: (message: unknown) => void) =>
        handlers.set(event, handler),
      ),
      off: vi.fn((event: string) => handlers.delete(event)),
    },
  };
});

vi.mock("@/lib/api-client", () => ({ api: http }));
vi.mock("@/components/providers/realtime-provider", () => ({
  useRealtimeClient: () => socket,
}));

const detail = {
  id: "task-a",
  projectId: "project",
  title: "Original title",
  blockedBy: [
    {
      id: "dependency",
      blockingTask: {
        id: "task-b",
        title: "Blocker",
        status: { name: "Todo" },
      },
    },
  ],
  blocking: [],
  subtasks: [{ id: "subtask", title: "Child", completed: false, position: 0 }],
};

function wrapper({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

beforeEach(() => {
  queryClient.clear();
  queryClient.setQueryData(queryKeys.task("task-a"), { data: detail });
  queryClient.setQueryData(queryKeys.task("task-b"), {
    data: { id: "task-b", blocking: [{ id: "dependency" }] },
  });
  queryClient.setQueryData(queryKeys.tasks("project"), { data: [detail] });
});

afterEach(() => {
  cleanup();
  queryClient.clear();
  handlers.clear();
});

describe("task detail cache", () => {
  it("keeps dependency and subtask details visible until the complete edited task is fetched", async () => {
    let finishFetch!: (value: unknown) => void;
    http.get.mockReturnValue({
      json: () =>
        new Promise((resolve) => {
          finishFetch = resolve;
        }),
    });
    http.patch.mockReturnValue({
      json: async () => ({
        data: { id: "task-a", projectId: "project", title: "Edited" },
      }),
    });

    const { result } = renderHook(
      () => ({ task: useTask("task-a"), update: useUpdateTask() }),
      { wrapper },
    );
    await act(async () => {
      await result.current.update.mutateAsync({
        id: "task-a",
        title: "Edited",
      });
    });
    await waitFor(() => expect(http.get).toHaveBeenCalledWith("tasks/task-a"));
    expect(result.current.task.data?.data.blockedBy).toEqual(detail.blockedBy);
    expect(result.current.task.data?.data.subtasks).toEqual(detail.subtasks);

    await act(async () => {
      finishFetch({ data: { ...detail, title: "Edited" } });
    });
    await waitFor(() =>
      expect(result.current.task.data?.data.title).toBe("Edited"),
    );
    expect(result.current.task.data?.data.blockedBy).toEqual(detail.blockedBy);
  });

  it("invalidates both tasks after adding a dependency without a socket connection", async () => {
    http.post.mockReturnValue({
      json: async () => ({ data: { id: "dependency" } }),
    });
    const { result } = renderHook(() => useAddDependency("task-a", "project"), {
      wrapper,
    });
    await act(async () => {
      await result.current.mutateAsync("task-b");
    });
    expect(http.post).toHaveBeenCalledWith("tasks/task-a/dependencies", {
      json: { blockingTaskId: "task-b" },
    });
    for (const id of ["task-a", "task-b"]) {
      expect(queryClient.getQueryState(queryKeys.task(id))?.isInvalidated).toBe(
        true,
      );
    }
  });

  it("invalidates both tasks after removing a dependency without a socket connection", async () => {
    http.delete.mockResolvedValue(undefined);
    const { result } = renderHook(
      () => useRemoveDependency("task-a", "project"),
      { wrapper },
    );
    await act(async () => {
      await result.current.mutateAsync({
        depId: "dependency",
        blockingTaskId: "task-b",
      });
    });
    expect(http.delete).toHaveBeenCalledWith(
      "tasks/task-a/dependencies/dependency",
    );
    for (const id of ["task-a", "task-b"]) {
      expect(queryClient.getQueryState(queryKeys.task(id))?.isInvalidated).toBe(
        true,
      );
    }
  });
});

describe("server realtime envelopes", () => {
  it.each(["dependency_created", "dependency_deleted"])(
    "refreshes both sides of %s from message.data",
    (event) => {
      queryClient.setQueryData(queryKeys.activity("task-a"), { data: [] });
      renderHook(() => useRealtime("project"));
      act(() =>
        handlers.get(event)!({
          event,
          projectId: "project",
          data: { taskId: "task-a", blockingTaskId: "task-b" },
        }),
      );
      for (const key of [
        queryKeys.task("task-a"),
        queryKeys.task("task-b"),
        queryKeys.activity("task-a"),
        queryKeys.tasks("project"),
      ]) {
        expect(queryClient.getQueryState(key)?.isInvalidated).toBe(true);
      }
    },
  );

  it.each(["task_updated", "task_moved"])(
    "refreshes an open task after a remote %s event",
    (event) => {
      renderHook(() => useRealtime("project"));
      act(() =>
        handlers.get(event)!({
          event,
          projectId: "project",
          data: { taskId: "task-a" },
        }),
      );
      expect(
        queryClient.getQueryState(queryKeys.task("task-a"))?.isInvalidated,
      ).toBe(true);
    },
  );
});
