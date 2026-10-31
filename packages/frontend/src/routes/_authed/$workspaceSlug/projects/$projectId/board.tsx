import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { Board } from "@/features/kanban";
import { TaskSlideover, usePreloadTaskSlideover } from "@/features/tasks";
import { FilterBar, type Filters } from "@/components/shared/filter-bar";
import { useAuthStore } from "@/stores/auth-store";
import { usePermissions } from "@/hooks/use-permissions";
import { useRealtime } from "@/hooks/use-realtime";

const boardSearchSchema = z.object({
  task: z.string().optional(),
  search: z.string().optional(),
  assignee: z.string().optional(),
  priority: z.string().optional(),
  label: z.string().optional(),
  dueBefore: z.string().optional(),
  dueAfter: z.string().optional(),
  archived: z.boolean().optional(),
});

export const Route = createFileRoute(
  "/_authed/$workspaceSlug/projects/$projectId/board",
)({
  validateSearch: boardSearchSchema,
  component: BoardRoute,
});

function BoardRoute() {
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

  const filters: Record<string, unknown> = {};
  if (search.search) filters.search = search.search;
  if (search.assignee) filters.assignee = search.assignee;
  if (search.priority) filters.priority = search.priority;
  if (search.label) filters.label = search.label;
  if (search.dueBefore) filters.dueBefore = search.dueBefore;
  if (search.dueAfter) filters.dueAfter = search.dueAfter;
  if (search.archived) filters.archived = search.archived;

  const openTask = (taskId: string) => {
    navigate({
      search: (prev) => ({ ...prev, task: taskId }),
    });
  };

  const closeTask = () => {
    navigate({
      search: (prev) => {
        const { task: _, ...rest } = prev;
        return rest;
      },
    });
  };

  const handleFilterChange = (newFilters: Filters) => {
    navigate({
      search: (prev) => ({
        task: prev.task,
        ...newFilters,
      }),
    });
  };

  return (
    <>
      <FilterBar
        projectId={projectId}
        filters={filters}
        onFilterChange={handleFilterChange}
      />
      <Board
        projectId={projectId}
        filters={Object.keys(filters).length > 0 ? filters : undefined}
        onTaskClick={openTask}
        canCreate={permissions.canCreate}
        canDrag={permissions.canEdit}
      />

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
