import { useMutation, useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import { queryClient } from "@/lib/query-client";
import { queryKeys } from "@/lib/query-keys";
import { toast } from "sonner";
import type { CreateSubtaskInput, UpdateSubtaskInput } from "@pm/shared";

export interface Subtask {
  id: string;
  taskId: string;
  title: string;
  completed: boolean;
  position: number;
  assigneeId: string | null;
  dueDate: string | null;
  createdAt: string;
  updatedAt: string;
  assignee: { id: string; displayName: string; avatarUrl: string | null } | null;
}

export function useSubtasks(tid: string) {
  return useQuery({
    queryKey: queryKeys.subtasks(tid),
    queryFn: () => api.get(`tasks/${tid}/subtasks`).json<{ data: Subtask[] }>(),
    enabled: !!tid,
  });
}

export function useCreateSubtask(tid: string, pid: string) {
  return useMutation({
    mutationFn: (data: CreateSubtaskInput) =>
      api.post(`tasks/${tid}/subtasks`, { json: data }).json<{ data: Subtask }>(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.subtasks(tid) });
      queryClient.invalidateQueries({ queryKey: queryKeys.task(tid) });
      queryClient.invalidateQueries({
        queryKey: queryKeys.tasks(pid),
        exact: false,
      });
    },
    onError: () => {
      toast.error("Failed to create subtask");
    },
  });
}

export function useUpdateSubtask(tid: string) {
  return useMutation({
    mutationFn: ({ id, ...data }: UpdateSubtaskInput & { id: string }) =>
      api.patch(`subtasks/${id}`, { json: data }).json<{ data: Subtask }>(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.subtasks(tid) });
    },
    onError: () => {
      toast.error("Failed to update subtask");
    },
  });
}

export function useToggleSubtask(tid: string, pid: string) {
  return useMutation({
    mutationFn: (subtaskId: string) =>
      api.patch(`subtasks/${subtaskId}/toggle`).json<{ data: Subtask }>(),
    onMutate: async (subtaskId) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.subtasks(tid) });
      const prev = queryClient.getQueryData<{ data: Subtask[] }>(queryKeys.subtasks(tid));
      if (prev) {
        queryClient.setQueryData(queryKeys.subtasks(tid), {
          ...prev,
          data: prev.data.map((s) =>
            s.id === subtaskId ? { ...s, completed: !s.completed } : s,
          ),
        });
      }
      return { prev };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.prev) {
        queryClient.setQueryData(queryKeys.subtasks(tid), ctx.prev);
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.subtasks(tid) });
      queryClient.invalidateQueries({ queryKey: queryKeys.task(tid) });
      queryClient.invalidateQueries({
        queryKey: queryKeys.tasks(pid),
        exact: false,
      });
    },
  });
}

export function useReorderSubtasks(tid: string) {
  return useMutation({
    mutationFn: (orderedIds: string[]) =>
      api.post(`tasks/${tid}/subtasks/reorder`, { json: { orderedIds } }).json(),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.subtasks(tid) });
    },
  });
}

export function useDeleteSubtask(tid: string, pid: string) {
  return useMutation({
    mutationFn: (subtaskId: string) => api.delete(`subtasks/${subtaskId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.subtasks(tid) });
      queryClient.invalidateQueries({ queryKey: queryKeys.task(tid) });
      queryClient.invalidateQueries({
        queryKey: queryKeys.tasks(pid),
        exact: false,
      });
      toast.success("Subtask deleted");
    },
  });
}
