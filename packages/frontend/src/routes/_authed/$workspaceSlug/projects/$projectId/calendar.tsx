import { lazy, Suspense } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { TaskSlideover, usePreloadTaskSlideover } from "@/features/tasks";
import { FilterBar, type Filters } from "@/components/shared/filter-bar";
import { useAuthStore } from "@/stores/auth-store";
import { usePermissions } from "@/hooks/use-permissions";
import { useRealtime } from "@/hooks/use-realtime";

const CalendarView = lazy(() =>
  import("@/features/calendar/components/calendar-view").then((m) => ({
    default: m.CalendarView,
  })),
);

const calendarSearchSchema = z.object({
  task: z.string().optional(),
  search: z.string().optional(),
  assignee: z.string().optional(),
  priority: z.string().optional(),
  label: z.string().optional(),
  archived: z.boolean().optional(),
});

export const Route = createFileRoute(
  "/_authed/$workspaceSlug/projects/$projectId/calendar",
)({
  validateSearch: calendarSearchSchema,
  component: CalendarRoute,
});

function CalendarRoute() {
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
        hideDateRange
      />
      <Suspense
        fallback={
          <div className="flex items-center justify-center p-12">
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          </div>
        }
      >
        <CalendarView
          projectId={projectId}
          filters={Object.keys(filters).length > 0 ? filters : undefined}
          onTaskClick={openTask}
          editable={!permissions.isViewer}
        />
      </Suspense>

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
