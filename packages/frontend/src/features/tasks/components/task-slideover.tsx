import { useState, lazy, Suspense } from "react";
import { useTask } from "../api";
import { useAuthStore } from "@/stores/auth-store";
import { usePermissions } from "@/hooks/use-permissions";
import { TaskTitle } from "./task-title";
import { TaskFields } from "./task-fields";
import { TaskActions } from "./task-actions";
import { ActivityLog } from "./activity-log";
import { DependencyList } from "./dependency-list";
import { SubtaskList } from "@/features/subtasks/components/subtask-list";
import { CommentList } from "@/features/comments/components/comment-list";
import { AttachmentList } from "@/features/attachments/components/attachment-list";
import { Slideover } from "@/components/ui/slideover";
import { Maximize2, Minimize2 } from "lucide-react";

const TaskDescription = lazy(() =>
  import("./task-description").then((m) => ({
    default: m.TaskDescription,
  })),
);

export interface TaskSlideoverProps {
  taskId: string;
  workspaceSlug: string;
  onClose: () => void;
}

export function TaskSlideover({
  taskId,
  workspaceSlug,
  onClose,
}: TaskSlideoverProps) {
  const { data, isLoading, isError } = useTask(taskId);
  const task = data?.data;

  const workspaces = useAuthStore((s) => s.workspaces);
  const user = useAuthStore((s) => s.user);
  const membership = workspaces.find(
    (w) => w.workspace.slug === workspaceSlug,
  );
  const permissions = usePermissions(membership, user?.id);

  const canEdit = task ? permissions.canEditTask(task) : false;
  const workspaceId = membership?.workspace.id;
  const [isFullscreen, setIsFullscreen] = useState(false);

  return (
    <Slideover
      title="Task details"
      titleClassName="text-sm text-muted-foreground"
      onClose={onClose}
      layout
      className={isFullscreen ? undefined : "max-w-2xl border-l"}
      actions={
        <button
          type="button"
          onClick={() => setIsFullscreen((prev) => !prev)}
          className="rounded-md p-1 hover:bg-accent transition-colors"
          title={isFullscreen ? "Minimize" : "Maximize"}
          aria-label={isFullscreen ? "Minimize" : "Maximize"}
        >
          {isFullscreen ? (
            <Minimize2 className="h-5 w-5" aria-hidden="true" />
          ) : (
            <Maximize2 className="h-5 w-5" aria-hidden="true" />
          )}
        </button>
      }
    >
      {/* Content */}
      {isFullscreen ? (
        <div className="flex flex-1 overflow-hidden">
          {/* Left column */}
          <div className="flex-1 overflow-y-auto px-6 py-6 space-y-6">
            {isLoading && (
              <div className="space-y-4 animate-pulse">
                <div className="h-7 w-2/3 bg-muted rounded" />
                <div className="h-4 w-1/2 bg-muted rounded" />
                <div className="h-4 w-1/3 bg-muted rounded" />
                <div className="h-24 w-full bg-muted rounded" />
              </div>
            )}

            {isError && (
              <div className="text-center py-8">
                <p className="text-sm text-destructive">
                  Failed to load task. It may have been deleted.
                </p>
              </div>
            )}

            {task && (
              <>
                <TaskTitle
                  taskId={task.id}
                  title={task.title}
                  canEdit={canEdit}
                />

                <TaskFields task={task} canEdit={canEdit} />

                <div>
                  <h3 className="text-sm font-medium mb-2 text-muted-foreground">
                    Description
                  </h3>
                  <Suspense
                    fallback={
                      <div className="h-24 animate-pulse bg-muted rounded" />
                    }
                  >
                    <TaskDescription
                      taskId={task.id}
                      description={task.description}
                      descriptionRevision={task.descriptionRevision}
                      canEdit={canEdit}
                    />
                  </Suspense>
                </div>

                {workspaceId && (
                  <AttachmentList
                    workspaceId={workspaceId}
                    taskId={task.id}
                    canEdit={canEdit}
                  />
                )}

                <DependencyList task={task} canEdit={canEdit} />

                <SubtaskList
                  taskId={task.id}
                  projectId={task.projectId}
                  canEdit={canEdit}
                />

                <TaskActions
                  task={task}
                  canEdit={canEdit}
                  canDelete={permissions.canDelete}
                  onClose={onClose}
                />
              </>
            )}
          </div>

          {/* Right column */}
          {task && (
            <div className="w-[440px] shrink-0 border-l overflow-y-auto px-6 py-6 space-y-6">
              <CommentList
                taskId={task.id}
                canComment={permissions.canComment}
              />

              <div>
                <h3 className="text-sm font-medium mb-3 text-muted-foreground">
                  Activity
                </h3>
                <ActivityLog taskId={task.id} />
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto px-6 py-6 space-y-6">
          {isLoading && (
            <div className="space-y-4 animate-pulse">
              <div className="h-7 w-2/3 bg-muted rounded" />
              <div className="h-4 w-1/2 bg-muted rounded" />
              <div className="h-4 w-1/3 bg-muted rounded" />
              <div className="h-24 w-full bg-muted rounded" />
            </div>
          )}

          {isError && (
            <div className="text-center py-8">
              <p className="text-sm text-destructive">
                Failed to load task. It may have been deleted.
              </p>
            </div>
          )}

          {task && (
            <>
              <TaskTitle
                taskId={task.id}
                title={task.title}
                canEdit={canEdit}
              />

              <TaskFields task={task} canEdit={canEdit} />

              <div>
                <h3 className="text-sm font-medium mb-2 text-muted-foreground">
                  Description
                </h3>
                <Suspense
                  fallback={
                    <div className="h-24 animate-pulse bg-muted rounded" />
                  }
                >
                  <TaskDescription
                    taskId={task.id}
                    description={task.description}
                    descriptionRevision={task.descriptionRevision}
                    canEdit={canEdit}
                  />
                </Suspense>
              </div>

              {workspaceId && (
                <AttachmentList
                  workspaceId={workspaceId}
                  taskId={task.id}
                  canEdit={canEdit}
                />
              )}

              <DependencyList task={task} canEdit={canEdit} />

              <SubtaskList
                taskId={task.id}
                projectId={task.projectId}
                canEdit={canEdit}
              />

              <CommentList
                taskId={task.id}
                canComment={permissions.canComment}
              />

              <TaskActions
                task={task}
                canEdit={canEdit}
                canDelete={permissions.canDelete}
                onClose={onClose}
              />

              <div>
                <h3 className="text-sm font-medium mb-3 text-muted-foreground">
                  Activity
                </h3>
                <ActivityLog taskId={task.id} />
              </div>
            </>
          )}
        </div>
      )}
    </Slideover>
  );
}
