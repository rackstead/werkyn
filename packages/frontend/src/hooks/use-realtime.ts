import { useEffect } from "react";
import { useRealtimeClient } from "@/components/providers/realtime-provider";
import { queryClient } from "@/lib/query-client";
import { queryKeys } from "@/lib/query-keys";
import { readId, type RealtimeEnvelope } from "@/lib/realtime-events";

const TASK_EVENTS = [
  "task_created",
  "task_updated",
  "task_deleted",
  "task_moved",
  "status_created",
  "status_updated",
  "status_deleted",
];
const SUBTASK_EVENTS = [
  "subtask_created",
  "subtask_updated",
  "subtask_toggled",
  "subtask_deleted",
];
const COMMENT_EVENTS = [
  "comment_created",
  "comment_updated",
  "comment_deleted",
];
const DEPENDENCY_EVENTS = ["dependency_created", "dependency_deleted"];
const CUSTOM_FIELD_EVENTS = [
  "custom_field_created",
  "custom_field_updated",
  "custom_field_deleted",
];

export function useRealtime(projectId: string | undefined) {
  const client = useRealtimeClient();

  useEffect(() => {
    if (!client || !projectId) return;

    client.subscribe(projectId);

    // Project events name the project they were broadcast to; anything else
    // (e.g. a late event for a project this view no longer shows) is ignored.
    const forThisProject =
      (handle: (data: RealtimeEnvelope["data"]) => void) =>
      (msg: RealtimeEnvelope) => {
        if (msg.projectId === projectId) handle(msg.data);
      };

    const invalidateTaskLists = () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.tasks(projectId),
        exact: false,
      });
    };

    const handler = forThisProject((data) => {
      const taskId = readId(data, "taskId");
      if (taskId) {
        queryClient.invalidateQueries({ queryKey: queryKeys.task(taskId) });
      }
      invalidateTaskLists();
      queryClient.invalidateQueries({
        queryKey: queryKeys.statuses(projectId),
      });
    });

    const subtaskHandler = forThisProject((data) => {
      const taskId = readId(data, "taskId");
      if (taskId) {
        queryClient.invalidateQueries({ queryKey: queryKeys.subtasks(taskId) });
        queryClient.invalidateQueries({ queryKey: queryKeys.task(taskId) });
      }
      invalidateTaskLists();
    });

    const commentHandler = forThisProject((data) => {
      const taskId = readId(data, "taskId");
      if (taskId) {
        queryClient.invalidateQueries({ queryKey: queryKeys.comments(taskId) });
        queryClient.invalidateQueries({ queryKey: queryKeys.activity(taskId) });
      }
    });

    const dependencyHandler = forThisProject((data) => {
      const taskId = readId(data, "taskId");
      const blockingTaskId = readId(data, "blockingTaskId");
      if (taskId) {
        queryClient.invalidateQueries({ queryKey: queryKeys.task(taskId) });
        queryClient.invalidateQueries({ queryKey: queryKeys.activity(taskId) });
      }
      if (blockingTaskId) {
        queryClient.invalidateQueries({
          queryKey: queryKeys.task(blockingTaskId),
        });
      }
      invalidateTaskLists();
    });

    // Field definitions changed. Renaming or removing options also rewrites
    // values (and adds activity entries) on any task of the project, so the
    // cached details and activity of this project's tasks reload.
    const customFieldHandler = forThisProject(() => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.customFields(projectId),
      });
      invalidateTaskLists();
      const projectTaskDetails = queryClient.getQueryCache().findAll({
        predicate: (query) => {
          const [root, taskId] = query.queryKey;
          const detail = query.state.data as
            | { data?: { projectId?: unknown } }
            | undefined;
          return (
            root === "tasks" &&
            query.queryKey.length === 2 &&
            typeof taskId === "string" &&
            detail?.data?.projectId === projectId
          );
        },
      });
      for (const query of projectTaskDetails) {
        const taskId = query.queryKey[1] as string;
        queryClient.invalidateQueries({
          queryKey: queryKeys.task(taskId),
          exact: true,
        });
        queryClient.invalidateQueries({ queryKey: queryKeys.activity(taskId) });
      }
    });

    const listeners: [string[], (msg: RealtimeEnvelope) => void][] = [
      [TASK_EVENTS, handler],
      [SUBTASK_EVENTS, subtaskHandler],
      [COMMENT_EVENTS, commentHandler],
      [DEPENDENCY_EVENTS, dependencyHandler],
      [CUSTOM_FIELD_EVENTS, customFieldHandler],
    ];
    for (const [events, listener] of listeners) {
      for (const event of events) client.on(event, listener);
    }

    return () => {
      client.unsubscribe(projectId);
      for (const [events, listener] of listeners) {
        for (const event of events) client.off(event, listener);
      }
    };
  }, [client, projectId]);
}
