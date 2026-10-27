import { useMutation, useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import { queryClient } from "@/lib/query-client";
import { queryKeys } from "@/lib/query-keys";
import { useAuthStore } from "@/stores/auth-store";
import { toast } from "sonner";
import type {
  CreateTaskInput,
  UpdateTaskInput,
  MoveTaskInput,
  ArchiveInput,
} from "@pm/shared";

// ─── Types ───────────────────────────────────────────────

export interface Task {
  id: string;
  projectId: string;
  statusId: string;
  title: string;
  description: string | null;
  priority: "NONE" | "LOW" | "MEDIUM" | "HIGH" | "URGENT";
  dueDate: string | null;
  startDate: string | null;
  position: number;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  assignees: Array<{
    userId: string;
    user: { id: string; displayName: string; avatarUrl: string | null };
  }>;
  labels: Array<{
    labelId: string;
    label: { id: string; name: string; color: string };
  }>;
  status: {
    id: string;
    name: string;
    color: string | null;
    isCompletion: boolean;
  };
  customFieldValues: Array<{
    fieldId: string;
    value: string | number | boolean | string[] | null;
    field: {
      id: string;
      name: string;
      type: string;
      options: Array<{ value: string; color?: string }> | null;
    };
  }>;
  _count: { subtasks: number; blockedBy: number };
}

export interface TaskDetail extends Task {
  subtasks?: Array<{
    id: string;
    title: string;
    completed: boolean;
    position: number;
  }>;
  blockedBy?: Array<{
    id: string;
    blockingTask: { id: string; title: string; status: { name: string } };
  }>;
  blocking?: Array<{
    id: string;
    blockedTask: { id: string; title: string; status: { name: string } };
  }>;
}

// ─── Queries ─────────────────────────────────────────────

export function useProjectTasks(
  pid: string,
  filters?: Record<string, unknown>,
) {
  return useQuery({
    queryKey: queryKeys.tasks(pid, filters),
    queryFn: () => {
      const searchParams: Record<string, string> = { view: "board" };
      if (filters) {
        for (const [key, value] of Object.entries(filters)) {
          if (value !== undefined && value !== null && value !== "") {
            searchParams[key] = String(value);
          }
        }
      }
      return api
        .get(`projects/${pid}/tasks`, { searchParams })
        .json<{ data: Task[] }>();
    },
    enabled: !!pid,
  });
}

export function useTask(tid: string) {
  return useQuery({
    queryKey: queryKeys.task(tid),
    queryFn: () => api.get(`tasks/${tid}`).json<{ data: TaskDetail }>(),
    enabled: !!tid,
  });
}

// ─── Helpers ────────────────────────────────────────────

function invalidateMyTasks() {
  queryClient.invalidateQueries({ queryKey: ["my-tasks"] });
}

// ─── Mutations ───────────────────────────────────────────

export function useCreateTask(pid: string) {
  return useMutation({
    mutationFn: (data: CreateTaskInput) =>
      api.post(`projects/${pid}/tasks`, { json: data }).json<{ data: Task }>(),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.tasks(pid),
        exact: false,
      });
      invalidateMyTasks();
      toast.success("Task created");
    },
  });
}

export function useUpdateTask() {
  return useMutation({
    mutationFn: ({ id, expectedUserId, ...data }: UpdateTaskInput & { id: string; expectedUserId?: string }) => {
      if (expectedUserId && useAuthStore.getState().user?.id !== expectedUserId) {
        throw new Error("Sign in as the author to save these changes");
      }
      return api.patch(`tasks/${id}`, { json: data, ...(expectedUserId ? { context: { expectedUserId } } : {}) }).json<{ data: Task }>();
    },
    onSuccess: (res, { expectedUserId }) => {
      if (expectedUserId && useAuthStore.getState().user?.id !== expectedUserId) return;
      // PATCH returns a summary, not the relations supplied by GET /tasks/:id.
      // Keep the complete cached detail visible while refreshing it.
      queryClient.invalidateQueries({ queryKey: queryKeys.task(res.data.id) });
      queryClient.invalidateQueries({
        queryKey: queryKeys.tasks(res.data.projectId),
        exact: false,
      });
      invalidateMyTasks();
    },
    onError: (err) => {
      toast.error(`Failed to update task: ${err.message}`);
    },
  });
}

export function useDeleteTask(pid: string, onDeleted?: () => void) {
  return useMutation({
    mutationFn: (tid: string) => api.delete(`tasks/${tid}`),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.tasks(pid),
        exact: false,
      });
      invalidateMyTasks();
      toast.success("Task deleted");
      onDeleted?.();
    },
  });
}

export function useArchiveTask(pid: string, onArchived?: () => void) {
  return useMutation({
    mutationFn: ({ id, ...data }: ArchiveInput & { id: string }) =>
      api.patch(`tasks/${id}/archive`, { json: data }).json<{ data: Task }>(),
    onSuccess: (res) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.tasks(pid),
        exact: false,
      });
      queryClient.invalidateQueries({ queryKey: queryKeys.task(res.data.id) });
      invalidateMyTasks();
      toast.success(res.data.archived ? "Task archived" : "Task unarchived");
      if (res.data.archived) onArchived?.();
    },
  });
}

export function useMoveTask(pid: string) {
  return useMutation({
    mutationFn: ({ id, ...data }: MoveTaskInput & { id: string }) =>
      api
        .patch(`tasks/${id}/move`, { json: data })
        .json<{ data: Task & { warning?: string } }>(),
    onMutate: async ({ id, statusId, position }) => {
      // Cancel any outgoing refetches
      await queryClient.cancelQueries({
        queryKey: queryKeys.tasks(pid),
        exact: false,
      });

      // Snapshot all task queries for this project
      const queryCache = queryClient.getQueryCache();
      const taskQueries = queryCache.findAll({
        queryKey: ["tasks"],
      });

      const snapshots: Array<{
        queryKey: readonly unknown[];
        data: unknown;
      }> = [];

      for (const query of taskQueries) {
        const key = query.queryKey;
        const data = queryClient.getQueryData(key);
        if (data) {
          snapshots.push({ queryKey: key, data });
        }
      }

      // Optimistically update the tasks list, normalizing positions
      // in affected columns to match the backend logic exactly.
      for (const snapshot of snapshots) {
        const cached = snapshot.data as { data: Task[] } | undefined;
        if (!cached?.data || !Array.isArray(cached.data)) continue;

        const tasks = cached.data;
        const task = tasks.find((t) => t.id === id);
        if (!task) continue;

        const oldStatusId = task.statusId;
        const isSameColumn = oldStatusId === statusId;

        // Build a position map for all affected tasks
        const posMap = new Map<
          string,
          { position: number; statusId?: string }
        >();

        if (isSameColumn) {
          // Same-column reorder: remove task, re-insert at index
          const colTasks = tasks
            .filter((t) => t.statusId === statusId)
            .sort((a, b) => a.position - b.position);
          const ordered = colTasks.filter((t) => t.id !== id);
          const insertIdx = Math.min(position, ordered.length);
          ordered.splice(insertIdx, 0, task);
          for (let i = 0; i < ordered.length; i++) {
            posMap.set(ordered[i].id, { position: i });
          }
        } else {
          // Cross-column: normalize source (close gap) and destination (insert)
          const srcTasks = tasks
            .filter((t) => t.statusId === oldStatusId && t.id !== id)
            .sort((a, b) => a.position - b.position);
          for (let i = 0; i < srcTasks.length; i++) {
            posMap.set(srcTasks[i].id, { position: i });
          }

          const dstTasks = tasks
            .filter((t) => t.statusId === statusId)
            .sort((a, b) => a.position - b.position);
          const dstOrdered = [...dstTasks];
          const insertIdx = Math.min(position, dstOrdered.length);
          dstOrdered.splice(insertIdx, 0, task);
          for (let i = 0; i < dstOrdered.length; i++) {
            posMap.set(dstOrdered[i].id, {
              position: i,
              ...(dstOrdered[i].id === id ? { statusId } : {}),
            });
          }
        }

        const updatedTasks = tasks.map((t) => {
          const update = posMap.get(t.id);
          if (update) {
            return {
              ...t,
              position: update.position,
              ...(update.statusId ? { statusId: update.statusId } : {}),
            };
          }
          return t;
        });

        queryClient.setQueryData(snapshot.queryKey, {
          ...cached,
          data: updatedTasks,
        });
      }

      return { snapshots };
    },
    onError: (err, _vars, context) => {
      // Rollback to snapshots
      if (context?.snapshots) {
        for (const snapshot of context.snapshots) {
          queryClient.setQueryData(snapshot.queryKey, snapshot.data);
        }
      }
      const message =
        err instanceof Error ? err.message : "Failed to move task";
      toast.error(message);
    },
    onSuccess: (res) => {
      if (res.data.warning) {
        toast.warning(res.data.warning);
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.tasks(pid),
        exact: false,
      });
      invalidateMyTasks();
    },
  });
}

export function useAddAssignee(tid: string, pid: string) {
  return useMutation({
    mutationFn: (userId: string) =>
      api.post(`tasks/${tid}/assignees`, { json: { userId } }).json(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.task(tid) });
      queryClient.invalidateQueries({
        queryKey: queryKeys.tasks(pid),
        exact: false,
      });
      invalidateMyTasks();
    },
  });
}

export function useRemoveAssignee(tid: string, pid: string) {
  return useMutation({
    mutationFn: (userId: string) =>
      api.delete(`tasks/${tid}/assignees/${userId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.task(tid) });
      queryClient.invalidateQueries({
        queryKey: queryKeys.tasks(pid),
        exact: false,
      });
      invalidateMyTasks();
    },
  });
}

export function useAddTaskLabel(tid: string, pid: string) {
  return useMutation({
    mutationFn: (labelId: string) =>
      api.post(`tasks/${tid}/labels`, { json: { labelId } }).json(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.task(tid) });
      queryClient.invalidateQueries({
        queryKey: queryKeys.tasks(pid),
        exact: false,
      });
      invalidateMyTasks();
    },
  });
}

// ─── Bulk Update ────────────────────────────────────────

export function useBulkUpdateTasks(pid: string) {
  return useMutation({
    mutationFn: (data: {
      taskIds: string[];
      statusId?: string;
      priority?: "NONE" | "LOW" | "MEDIUM" | "HIGH" | "URGENT";
      assigneeIds?: string[];
      archived?: boolean;
      labelIds?: string[];
      dueDate?: string | null;
    }) =>
      api
        .post(`projects/${pid}/tasks/bulk-update`, { json: data })
        .json<{ data: { count: number } }>(),
    onSuccess: (res) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.tasks(pid),
        exact: false,
      });
      invalidateMyTasks();
      toast.success(`Updated ${res.data.count} tasks`);
    },
    onError: () => {
      toast.error("Failed to update tasks");
    },
  });
}

export function useBulkDeleteTasks(pid: string) {
  return useMutation({
    mutationFn: (data: { taskIds: string[] }) =>
      api
        .post(`projects/${pid}/tasks/bulk-delete`, { json: data })
        .json<{ data: { count: number } }>(),
    onSuccess: (res) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.tasks(pid),
        exact: false,
      });
      invalidateMyTasks();
      toast.success(`Deleted ${res.data.count} tasks`);
    },
    onError: () => {
      toast.error("Failed to delete tasks");
    },
  });
}

// ─── Duplicate ──────────────────────────────────────────

export function useDuplicateTask(pid: string) {
  return useMutation({
    mutationFn: (tid: string) =>
      api.post(`tasks/${tid}/duplicate`).json<{ data: Task }>(),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.tasks(pid),
        exact: false,
      });
      invalidateMyTasks();
      toast.success("Task duplicated");
    },
    onError: () => {
      toast.error("Failed to duplicate task");
    },
  });
}

// ─── Activity ───────────────────────────────────────────

export interface ActivityEntry {
  id: string;
  taskId: string;
  action: string;
  details: Record<string, unknown> | null;
  createdAt: string;
  actor: { id: string; displayName: string; avatarUrl: string | null } | null;
}

export function useTaskActivity(tid: string, page = 1, limit = 20) {
  return useQuery({
    queryKey: [...queryKeys.activity(tid), { page, limit }],
    queryFn: () =>
      api
        .get(`tasks/${tid}/activity`, {
          searchParams: { page: String(page), limit: String(limit) },
        })
        .json<{
          data: ActivityEntry[];
          pagination: {
            page: number;
            limit: number;
            total: number;
            totalPages: number;
          };
        }>(),
    enabled: !!tid,
  });
}

export function useRemoveTaskLabel(tid: string, pid: string) {
  return useMutation({
    mutationFn: (labelId: string) =>
      api.delete(`tasks/${tid}/labels/${labelId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.task(tid) });
      queryClient.invalidateQueries({
        queryKey: queryKeys.tasks(pid),
        exact: false,
      });
      invalidateMyTasks();
    },
  });
}

// ─── Dependencies ───────────────────────────────────────

export function useAddDependency(tid: string, pid: string) {
  return useMutation({
    mutationFn: (blockingTaskId: string) =>
      api
        .post(`tasks/${tid}/dependencies`, { json: { blockingTaskId } })
        .json(),
    onSuccess: (_res, blockingTaskId) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.task(tid) });
      queryClient.invalidateQueries({
        queryKey: queryKeys.task(blockingTaskId),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.tasks(pid),
        exact: false,
      });
      invalidateMyTasks();
      toast.success("Dependency added");
    },
    onError: (err) => {
      const message =
        err instanceof Error ? err.message : "Failed to add dependency";
      toast.error(message);
    },
  });
}

export function useRemoveDependency(tid: string, pid: string) {
  return useMutation({
    mutationFn: ({ depId }: { depId: string; blockingTaskId: string }) =>
      api.delete(`tasks/${tid}/dependencies/${depId}`),
    onSuccess: (_res, { blockingTaskId }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.task(tid) });
      queryClient.invalidateQueries({
        queryKey: queryKeys.task(blockingTaskId),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.tasks(pid),
        exact: false,
      });
      invalidateMyTasks();
      toast.success("Dependency removed");
    },
  });
}
