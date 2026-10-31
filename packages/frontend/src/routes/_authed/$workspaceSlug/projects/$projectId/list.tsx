import { useState, useCallback } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { TaskSlideover, usePreloadTaskSlideover } from "@/features/tasks";
import { FilterBar, type Filters } from "@/components/shared/filter-bar";
import { TaskTable } from "@/features/list-view/components/task-table";
import { BulkActions } from "@/features/list-view/components/bulk-actions";
import { useAuthStore } from "@/stores/auth-store";
import { usePermissions } from "@/hooks/use-permissions";
import { useRealtime } from "@/hooks/use-realtime";
import { useUpdateTask } from "@/features/tasks/api";
import type { RowSelectionState } from "@tanstack/react-table";

const listSearchSchema = z.object({
  task: z.string().optional(),
  search: z.string().optional(),
  assignee: z.string().optional(),
  priority: z.string().optional(),
  label: z.string().optional(),
  status: z.string().optional(),
  dueBefore: z.string().optional(),
  dueAfter: z.string().optional(),
  archived: z.boolean().optional(),
});

export const Route = createFileRoute(
  "/_authed/$workspaceSlug/projects/$projectId/list",
)({
  validateSearch: listSearchSchema,
  component: ListRoute,
});

function ListRoute() {
  const { workspaceSlug, projectId } = Route.useParams();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();

  const workspaces = useAuthStore((s) => s.workspaces);
  const user = useAuthStore((s) => s.user);
  const membership = workspaces.find(
    (w) => w.workspace.slug === workspaceSlug,
  );
  const permissions = usePermissions(membership, user?.id);

  useRealtime(projectId);
  usePreloadTaskSlideover();

  const { mutate: updateTask } = useUpdateTask();
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});

  const filters: Record<string, unknown> = {};
  if (search.search) filters.search = search.search;
  if (search.assignee) filters.assignee = search.assignee;
  if (search.priority) filters.priority = search.priority;
  if (search.label) filters.label = search.label;
  if (search.status) filters.status = search.status;
  if (search.dueBefore) filters.dueBefore = search.dueBefore;
  if (search.dueAfter) filters.dueAfter = search.dueAfter;
  if (search.archived) filters.archived = search.archived;

  const handleFilterChange = (newFilters: Filters) => {
    navigate({
      search: (prev) => ({
        task: prev.task,
        ...newFilters,
      }),
    });
  };

  // Stable so the table's cells (and the focused task button) are not
  // remounted when the slideover opens or closes; focus returns to that button.
  const openTask = useCallback(
    (taskId: string) => {
      navigate({
        search: (prev) => ({ ...prev, task: taskId }),
      });
    },
    [navigate],
  );

  const closeTask = () => {
    navigate({
      search: (prev) => {
        const { task: _, ...rest } = prev;
        return rest;
      },
    });
  };

  const handleUpdateTask = useCallback(
    (id: string, data: Record<string, unknown>) => {
      updateTask({ id, ...data } as Parameters<typeof updateTask>[0]);
    },
    [updateTask],
  );

  const selectedTaskIds = Object.keys(rowSelection).filter(
    (id) => rowSelection[id],
  );

  return (
    <>
      <FilterBar
        projectId={projectId}
        filters={filters}
        onFilterChange={handleFilterChange}
      />

      <TaskTable
        projectId={projectId}
        filters={Object.keys(filters).length > 0 ? filters : undefined}
        onTaskClick={openTask}
        canEdit={permissions.canEdit}
        rowSelection={rowSelection}
        onRowSelectionChange={setRowSelection}
        onUpdateTask={handleUpdateTask}
      />

      {selectedTaskIds.length > 0 && (
        <BulkActions
          projectId={projectId}
          selectedTaskIds={selectedTaskIds}
          onClear={() => setRowSelection({})}
          canDelete={permissions.canDelete}
        />
      )}

      {search.task && (
        <TaskSlideover
          taskId={search.task}
          workspaceSlug={workspaceSlug}
          onClose={closeTask}
        />
      )}
    </>
  );
}
