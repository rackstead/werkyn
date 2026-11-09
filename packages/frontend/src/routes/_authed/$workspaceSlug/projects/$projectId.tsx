import { useState } from "react";
import { createFileRoute, Outlet, Link, useLocation } from "@tanstack/react-router";
import { useProject } from "@/features/projects/api";
import { useAuthStore } from "@/stores/auth-store";
import { usePermissions } from "@/hooks/use-permissions";
import { Settings, Kanban, List, Calendar, Plus } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { CreateTaskDialog } from "@/features/tasks";

export const Route = createFileRoute(
  "/_authed/$workspaceSlug/projects/$projectId",
)({
  component: ProjectLayout,
});

const views = [
  { id: "board", label: "Board", icon: Kanban },
  { id: "list", label: "List", icon: List },
  { id: "calendar", label: "Calendar", icon: Calendar },
] as const;

function ProjectLayout() {
  const { workspaceSlug, projectId } = Route.useParams();
  const location = useLocation();
  const workspaces = useAuthStore((s) => s.workspaces);
  const user = useAuthStore((s) => s.user);
  const membership = workspaces.find(
    (w) => w.workspace.slug === workspaceSlug,
  );
  const permissions = usePermissions(membership, user?.id);

  const { data: project, isLoading } = useProject(projectId);
  const [createOpen, setCreateOpen] = useState(false);

  // Derive current view from pathname
  const pathEnd = location.pathname.split("/").pop();
  const currentView = views.find((v) => v.id === pathEnd)?.id ?? "board";

  if (isLoading) {
    return (
      <div className="flex items-center justify-center p-12">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      </div>
    );
  }

  if (!project) {
    return (
      <div className="p-6 text-center">
        <h2 className="text-lg font-semibold">Project not found</h2>
      </div>
    );
  }

  // The board fills <main>, which is already shorter when a workspace
  // banner is showing. The list and the calendar keep growing inside <main>.
  const boardLocked = pathEnd === "board";

  return (
    <div
      className={
        boardLocked
          ? "flex h-full min-h-0 flex-col overflow-hidden"
          : "flex flex-1 flex-col overflow-hidden"
      }
    >
      <div className="flex items-center justify-between border-b px-6 py-3">
        <div className="flex items-center gap-3">
          <div
            className="h-4 w-4 rounded-sm"
            style={{ backgroundColor: project.data.color ?? "#6366f1" }}
          />
          <h2 className="text-lg font-semibold">{project.data.name}</h2>
          {project.data.archived && (
            <span className="rounded bg-amber-100 px-2 py-0.5 text-xs text-amber-700 dark:bg-amber-900 dark:text-amber-300">
              Archived
            </span>
          )}

          {/* View Switcher */}
          <div className="ml-4 flex items-center gap-0.5 rounded-lg bg-muted p-0.5">
            {views.map((view) => (
                <Link
                  key={view.id}
                  to={`/$workspaceSlug/projects/$projectId/${view.id}`}
                  params={{ workspaceSlug, projectId }}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                    currentView === view.id
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  <view.icon className="h-3.5 w-3.5" />
                  {view.label}
                </Link>
              ))}
          </div>
        </div>

        <div className="flex items-center gap-2">
          {permissions.canCreate && (
            <Button size="sm" onClick={() => setCreateOpen(true)}>
              <Plus className="h-4 w-4" />
              New Task
            </Button>
          )}
          {permissions.canManageProject && (
            <Link
              to="/$workspaceSlug/projects/$projectId/settings"
              params={{ workspaceSlug, projectId }}
              className="rounded-md p-1.5 hover:bg-accent transition-colors"
              aria-label="Project settings"
            >
              <Settings className="h-4 w-4" />
            </Link>
          )}
        </div>
      </div>
      <div
        className={
          boardLocked
            ? "flex min-h-0 flex-1 flex-col overflow-hidden"
            : "flex flex-1 flex-col overflow-hidden"
        }
      >
        <Outlet />
      </div>

      <CreateTaskDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        projectId={projectId}
      />
    </div>
  );
}
