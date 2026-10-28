import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { useAuthStore } from "@/stores/auth-store";
import { useUIStore } from "@/stores/ui-store";
import { usePermissions } from "@/hooks/use-permissions";
import { WorkspaceSwitcher } from "./workspace-switcher";
import { cn } from "@/lib/utils";
import {
  LayoutDashboard,
  HardDrive,
  Clock,
  MessageSquare,
  Plus,
  PanelLeftClose,
  UserPlus,
} from "lucide-react";
import { WikiSpaceSidebarItem } from "@/features/wiki/components/wiki-space-sidebar-item";
import type { WikiSpace } from "@/features/wiki/api";
import { InviteDialog } from "@/features/workspaces/components/invite-dialog";
import { useState, useEffect, useCallback } from "react";

interface SidebarProps {
  projects?: Array<{ id: string; name: string; color: string | null; icon: string | null }>;
  wikiSpaces?: WikiSpace[];
  enabledModules?: string[];
  onCreateProject?: () => void;
  onCreateSpace?: () => void;
}

export function Sidebar({ projects = [], wikiSpaces = [], enabledModules = ["drive", "wiki", "time", "chat"], onCreateProject, onCreateSpace }: SidebarProps) {
  const { workspaceSlug } = useParams({ strict: false }) as { workspaceSlug: string };
  const { projectId } = useParams({ strict: false }) as { projectId?: string };
  const workspaces = useAuthStore((s) => s.workspaces);
  const user = useAuthStore((s) => s.user);
  const collapsed = useUIStore((s) => s.sidebarCollapsed);
  const toggle = useUIStore((s) => s.toggleSidebar);
  const setSidebarCollapsed = useUIStore((s) => s.setSidebarCollapsed);
  const navigate = useNavigate();
  const [inviteOpen, setInviteOpen] = useState(false);

  const isMobile = useIsMobile();

  // Auto-collapse on small screens
  useEffect(() => {
    const handleResize = () => {
      setSidebarCollapsed(window.innerWidth < 768);
    };
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [setSidebarCollapsed]);

  const membership = workspaces.find((w) => w.workspace.slug === workspaceSlug);
  const permissions = usePermissions(membership, user?.id);
  const workspaceId = membership?.workspace.id;

  return (
    <>
      {/* Mobile overlay backdrop */}
      {isMobile && !collapsed && (
        <div
          className="fixed inset-0 z-40 bg-black/50"
          onClick={toggle}
        />
      )}
      <aside
        // Collapsed, the sidebar is off-canvas (mobile) or zero-width; keep its
        // links out of the Tab order and the accessibility tree.
        inert={collapsed}
        className={cn(
          "flex h-full flex-col border-r bg-background transition-all duration-200",
          isMobile
            ? cn("fixed inset-y-0 left-0 z-50", collapsed ? "-translate-x-full" : "translate-x-0 w-64")
            : cn(collapsed ? "w-0 overflow-hidden" : "w-64"),
        )}
      >
        <div>
          <div className="flex h-12 items-center justify-between px-3 border-b border-sidebar-border dark:border-white/10">
            <img
              src="/werkyn_logo.svg"
              alt="Werkyn"
              className="h-6 w-auto dark:brightness-0 dark:invert"
            />
            <div className="flex items-center gap-1">
              {permissions.canManageWorkspace && (
                <button
                  onClick={() => setInviteOpen(true)}
                  className="rounded-md p-1 hover:bg-accent transition-colors"
                  aria-label="Invite members"
                >
                  <UserPlus className="h-4 w-4" />
                </button>
              )}
              <button
                onClick={toggle}
                className="rounded-md p-1 hover:bg-accent transition-colors"
                aria-label="Collapse sidebar"
              >
                <PanelLeftClose className="h-4 w-4" />
              </button>
            </div>
          </div>
          <div className="px-3 py-3 border-b border-sidebar-border dark:border-white/10">
            <WorkspaceSwitcher currentSlug={workspaceSlug} />
          </div>
        </div>

      <nav className="flex-1 overflow-y-auto p-3 space-y-1">
        <Link
          to="/$workspaceSlug"
          params={{ workspaceSlug }}
          className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent transition-colors"
          activeProps={{ className: "bg-accent font-medium" }}
          activeOptions={{ exact: true }}
        >
          <LayoutDashboard className="h-4 w-4" />
          Dashboard
        </Link>

        {enabledModules.includes("drive") && (
          <Link
            to="/$workspaceSlug/drive"
            params={{ workspaceSlug }}
            className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent transition-colors"
            activeProps={{ className: "bg-accent font-medium" }}
          >
            <HardDrive className="h-4 w-4" />
            Drive
          </Link>
        )}

        {enabledModules.includes("time") && (
          <Link
            to="/$workspaceSlug/time"
            params={{ workspaceSlug }}
            className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent transition-colors"
            activeProps={{ className: "bg-accent font-medium" }}
          >
            <Clock className="h-4 w-4" />
            Time
          </Link>
        )}

        {enabledModules.includes("chat") && (
          <Link
            to="/$workspaceSlug/chat"
            params={{ workspaceSlug }}
            className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent transition-colors"
            activeProps={{ className: "bg-accent font-medium" }}
          >
            <MessageSquare className="h-4 w-4" />
            Chat
          </Link>
        )}

        <div className="pt-4">
          <div className="flex items-center justify-between px-2 pb-1">
            <Link
              to="/$workspaceSlug/projects"
              params={{ workspaceSlug }}
              className="text-xs font-semibold uppercase text-muted-foreground hover:text-foreground transition-colors"
              activeProps={{ className: "text-foreground" }}
            >
              Projects
            </Link>
            {permissions.canCreate && (
              <button
                onClick={onCreateProject}
                className="rounded p-0.5 hover:bg-accent transition-colors"
                aria-label="New project"
              >
                <Plus className="h-3.5 w-3.5 text-muted-foreground" />
              </button>
            )}
          </div>

          {projects.map((project) => (
            <Link
              key={project.id}
              to="/$workspaceSlug/projects/$projectId/board"
              params={{ workspaceSlug, projectId: project.id }}
              className={cn(
                "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent transition-colors",
                projectId === project.id && "bg-accent font-medium",
              )}
            >
              <div
                className="h-3 w-3 rounded-sm shrink-0"
                style={{ backgroundColor: project.color ?? "#6366f1" }}
              />
              <span className="truncate">{project.name}</span>
            </Link>
          ))}

          {projects.length === 0 && (
            <p className="px-2 py-2 text-xs text-muted-foreground">
              No projects yet
            </p>
          )}
        </div>

        {enabledModules.includes("wiki") && (
          <div className="pt-4">
            <div className="flex items-center justify-between px-2 pb-1">
              <Link
                to="/$workspaceSlug/knowledge"
                params={{ workspaceSlug }}
                className="text-xs font-semibold uppercase text-muted-foreground hover:text-foreground transition-colors"
                activeProps={{ className: "text-foreground" }}
              >
                Knowledge
              </Link>
              {permissions.canCreate && (
                <button
                  onClick={onCreateSpace}
                  className="rounded p-0.5 hover:bg-accent transition-colors"
                  aria-label="New space"
                >
                  <Plus className="h-3.5 w-3.5 text-muted-foreground" />
                </button>
              )}
            </div>

            {wikiSpaces.map((space) => (
              <WikiSpaceSidebarItem
                key={space.id}
                space={space}
                onPageClick={(pageId, spaceId) => {
                  navigate({
                    to: "/$workspaceSlug/knowledge",
                    params: { workspaceSlug },
                    search: pageId
                      ? { spaceId, pageId }
                      : { spaceId },
                  });
                }}
              />
            ))}

            {wikiSpaces.length === 0 && (
              <p className="px-2 py-2 text-xs text-muted-foreground">
                No spaces yet
              </p>
            )}
          </div>
        )}
      </nav>

      {workspaceId && (
        <InviteDialog
          open={inviteOpen}
          onClose={() => setInviteOpen(false)}
          workspaceId={workspaceId}
        />
      )}
    </aside>
    </>
  );
}

function useIsMobile() {
  const [isMobile, setIsMobile] = useState(window.innerWidth < 768);
  useEffect(() => {
    const handleResize = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);
  return isMobile;
}
