import { useEffect } from "react";
import { useRealtimeClient } from "@/components/providers/realtime-provider";
import { queryClient } from "@/lib/query-client";
import { queryKeys } from "@/lib/query-keys";

export function useRealtime(projectId: string | undefined) {
  const client = useRealtimeClient();

  useEffect(() => {
    if (!client || !projectId) return;

    client.subscribe(projectId);

    const handler = (msg: unknown) => {
      const data = (msg as { data?: { taskId?: string } })?.data;
      if (data?.taskId) {
        queryClient.invalidateQueries({
          queryKey: queryKeys.task(data.taskId),
        });
      }
      // Invalidate task queries for this project
      queryClient.invalidateQueries({
        queryKey: queryKeys.tasks(projectId),
        exact: false,
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.statuses(projectId),
      });
    };

    const subtaskHandler = (msg: unknown) => {
      const data = (msg as { data?: { taskId?: string } })?.data;
      if (data?.taskId) {
        queryClient.invalidateQueries({
          queryKey: queryKeys.subtasks(data.taskId),
        });
        queryClient.invalidateQueries({
          queryKey: queryKeys.task(data.taskId),
        });
      }
      queryClient.invalidateQueries({
        queryKey: queryKeys.tasks(projectId),
        exact: false,
      });
    };

    const commentHandler = (msg: unknown) => {
      const data = (msg as { data?: { taskId?: string } })?.data;
      if (data?.taskId) {
        queryClient.invalidateQueries({
          queryKey: queryKeys.comments(data.taskId),
        });
        queryClient.invalidateQueries({
          queryKey: queryKeys.activity(data.taskId),
        });
      }
    };

    const dependencyHandler = (msg: unknown) => {
      const data = (
        msg as { data?: { taskId?: string; blockingTaskId?: string } }
      )?.data;
      if (data?.taskId) {
        queryClient.invalidateQueries({
          queryKey: queryKeys.task(data.taskId),
        });
        queryClient.invalidateQueries({
          queryKey: queryKeys.activity(data.taskId),
        });
      }
      if (data?.blockingTaskId) {
        queryClient.invalidateQueries({
          queryKey: queryKeys.task(data.blockingTaskId),
        });
      }
      queryClient.invalidateQueries({
        queryKey: queryKeys.tasks(projectId),
        exact: false,
      });
    };

    // Listen for task-related events
    client.on("task_created", handler);
    client.on("task_updated", handler);
    client.on("task_deleted", handler);
    client.on("task_moved", handler);
    client.on("status_created", handler);
    client.on("status_updated", handler);
    client.on("status_deleted", handler);

    // Subtask events
    client.on("subtask_created", subtaskHandler);
    client.on("subtask_updated", subtaskHandler);
    client.on("subtask_toggled", subtaskHandler);
    client.on("subtask_deleted", subtaskHandler);

    // Comment events
    client.on("comment_created", commentHandler);
    client.on("comment_updated", commentHandler);
    client.on("comment_deleted", commentHandler);

    // Dependency events
    client.on("dependency_created", dependencyHandler);
    client.on("dependency_deleted", dependencyHandler);

    return () => {
      client.unsubscribe(projectId);
      client.off("task_created", handler);
      client.off("task_updated", handler);
      client.off("task_deleted", handler);
      client.off("task_moved", handler);
      client.off("status_created", handler);
      client.off("status_updated", handler);
      client.off("status_deleted", handler);
      client.off("subtask_created", subtaskHandler);
      client.off("subtask_updated", subtaskHandler);
      client.off("subtask_toggled", subtaskHandler);
      client.off("subtask_deleted", subtaskHandler);
      client.off("comment_created", commentHandler);
      client.off("comment_updated", commentHandler);
      client.off("comment_deleted", commentHandler);
      client.off("dependency_created", dependencyHandler);
      client.off("dependency_deleted", dependencyHandler);
    };
  }, [client, projectId]);
}
