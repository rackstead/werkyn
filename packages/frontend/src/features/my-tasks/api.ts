import { useMemo } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import { queryKeys } from "@/lib/query-keys";
import type { Task } from "@/features/tasks/api";

interface MyTask extends Task {
  project: { id: string; name: string; color: string | null };
}

/** Server-side filters of GET /workspaces/:wid/my-tasks (date-only strings, inclusive). */
interface MyTasksFilters {
  dueAfter?: string;
  dueBefore?: string;
  /** false: only tasks outside completion columns. */
  completed?: boolean;
  /** Soonest due date first (tasks without one last) instead of project order. */
  sort?: "dueDate";
}

interface MyTasksPage {
  data: MyTask[];
  /** null on the last page. */
  nextCursor: string | null;
}

/**
 * The caller's assigned tasks, one server page (100 by default) at a time.
 * `tasks` holds every page loaded so far; `fetchNextPage` loads the next one
 * while `hasNextPage` is true.
 */
export function useMyTasks(wid: string, filters: MyTasksFilters = {}) {
  const { dueAfter, dueBefore, completed, sort } = filters;
  const query = useInfiniteQuery({
    queryKey: [...queryKeys.myTasks(wid), { dueAfter, dueBefore, completed, sort }],
    queryFn: ({ pageParam }) => {
      const searchParams: Record<string, string> = {};
      if (pageParam) searchParams.cursor = pageParam;
      if (dueAfter) searchParams.dueAfter = dueAfter;
      if (dueBefore) searchParams.dueBefore = dueBefore;
      if (completed !== undefined) searchParams.completed = String(completed);
      if (sort) searchParams.sort = sort;
      return api
        .get(`workspaces/${wid}/my-tasks`, { searchParams })
        .json<MyTasksPage>();
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: !!wid,
    staleTime: 0,
    refetchOnMount: "always",
  });
  const tasks = useMemo(
    () => query.data?.pages.flatMap((page) => page.data) ?? [],
    [query.data],
  );
  return {
    tasks,
    isLoading: query.isLoading,
    hasNextPage: query.hasNextPage,
    isFetchingNextPage: query.isFetchingNextPage,
    fetchNextPage: query.fetchNextPage,
  };
}

export type { MyTask, MyTasksFilters };
