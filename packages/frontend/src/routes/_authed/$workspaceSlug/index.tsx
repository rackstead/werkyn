import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { useAuthStore } from "@/stores/auth-store";
import { usePermissions } from "@/hooks/use-permissions";
import { useDashboard, useDashboardPreferences } from "@/features/dashboard/api";
import { ProjectGrid } from "@/features/dashboard/components/project-grid";
import { MyTasksWidget } from "@/features/dashboard/components/my-tasks-widget";
import { StarredFilesWidget } from "@/features/dashboard/components/starred-files-widget";
import { UnreadChatsWidget } from "@/features/dashboard/components/unread-chats-widget";
import { RecentWikiWidget } from "@/features/dashboard/components/recent-wiki-widget";
import { TimeTrackingWidget } from "@/features/dashboard/components/time-tracking-widget";
import { UpcomingDatesWidget } from "@/features/dashboard/components/upcoming-dates-widget";
import { WorkspaceStatsWidget } from "@/features/dashboard/components/workspace-stats-widget";
import { RecentFilesWidget } from "@/features/dashboard/components/recent-files-widget";
import { MyWikiEditsWidget } from "@/features/dashboard/components/my-wiki-edits-widget";
import { MentionsWidget } from "@/features/dashboard/components/mentions-widget";
import { ActivityFeedWidget } from "@/features/dashboard/components/activity-feed-widget";
import { CustomizeDashboardDialog } from "@/features/dashboard/components/customize-dashboard-dialog";
import { DEFAULT_WIDGET_ORDER } from "@/features/dashboard/widget-registry";
import { TaskSlideover, usePreloadTaskSlideover } from "@/features/tasks";
import { Button } from "@/components/ui/button";
import { Plus, Settings } from "lucide-react";
import { useState } from "react";
import { CreateProjectDialog } from "@/features/projects/components/create-project-dialog";
import { useWorkspaceRealtime } from "@/hooks/use-workspace-realtime";

const dashboardSearchSchema = z.object({
  task: z.string().optional(),
});

export const Route = createFileRoute("/_authed/$workspaceSlug/")({
  validateSearch: dashboardSearchSchema,
  component: WorkspaceDashboard,
});

function WorkspaceDashboard() {
  const { workspaceSlug } = Route.useParams();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const { workspace, membership } = Route.useRouteContext();
  const user = useAuthStore((s) => s.user);
  const permissions = usePermissions(membership, user?.id);
  const [createOpen, setCreateOpen] = useState(false);
  const [customizeOpen, setCustomizeOpen] = useState(false);

  const workspaceId = workspace?.id ?? "";

  useWorkspaceRealtime(workspaceId);
  usePreloadTaskSlideover();

  const { data, isLoading } = useDashboard(workspaceId);
  const projects = data?.data ?? [];

  const { data: prefData } = useDashboardPreferences(workspaceId);
  const widgetOrder = prefData?.data?.widgetOrder ?? DEFAULT_WIDGET_ORDER;
  const enabledWidgets = widgetOrder.filter((w) => w.enabled);

  const WIDGET_COMPONENTS: Record<string, React.ComponentType<any>> = {
    "starred-files": StarredFilesWidget,
    "unread-chats": UnreadChatsWidget,
    "recent-wiki": RecentWikiWidget,
    "time-tracking": TimeTrackingWidget,
    "upcoming-dates": UpcomingDatesWidget,
    "workspace-stats": WorkspaceStatsWidget,
    "recent-files": RecentFilesWidget,
    "my-wiki-edits": MyWikiEditsWidget,
    "mentions": MentionsWidget,
  };

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

  if (!workspace) return null;

  return (
    <>
      <div className="p-6 space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold">Dashboard</h1>
            <p className="text-sm text-muted-foreground mt-1">
              Welcome back, {user?.displayName}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => setCustomizeOpen(true)}
            >
              <Settings className="h-4 w-4 mr-1" />
              Customize
            </Button>
            {permissions.canCreate && (
              <Button size="sm" onClick={() => setCreateOpen(true)}>
                <Plus className="h-4 w-4 mr-1" />
                New project
              </Button>
            )}
          </div>
        </div>

        <MyTasksWidget workspaceId={workspaceId} onTaskClick={openTask} />

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {enabledWidgets.map((w) => {
            const Component = WIDGET_COMPONENTS[w.id];
            if (!Component) return null;
            return (
              <Component
                key={w.id}
                workspaceId={workspaceId}
                workspaceSlug={workspaceSlug}
                onTaskClick={openTask}
              />
            );
          })}
        </div>

        <ActivityFeedWidget workspaceId={workspaceId} onTaskClick={openTask} />

        {isLoading ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {Array.from({ length: 3 }).map((_, i) => (
              <div
                key={i}
                className="h-28 rounded-lg border bg-muted animate-pulse"
              />
            ))}
          </div>
        ) : (
          <ProjectGrid
            projects={projects}
            workspaceSlug={workspaceSlug}
            canCreate={permissions.canCreate}
            onCreateProject={() => setCreateOpen(true)}
          />
        )}

        <CreateProjectDialog
          open={createOpen}
          onClose={() => setCreateOpen(false)}
          workspaceId={workspaceId}
        />

        <CustomizeDashboardDialog
          open={customizeOpen}
          onClose={() => setCustomizeOpen(false)}
          workspaceId={workspaceId}
        />
      </div>

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
