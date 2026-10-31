import { useMyTasks, type MyTask } from "@/features/my-tasks/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { AlertTriangle } from "lucide-react";
import { formatDateISO, parseDateISO } from "@/features/time/utils";

function formatDueDate(value: string): string {
  return parseDateISO(value)?.toLocaleDateString(undefined, { month: "short", day: "numeric" }) ?? value;
}

const priorityVariant: Record<string, string> = {
  LOW: "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300",
  MEDIUM: "bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300",
  HIGH: "bg-orange-100 text-orange-700 dark:bg-orange-900 dark:text-orange-300",
  URGENT: "bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300",
};

interface MyTasksWidgetProps {
  workspaceId: string;
  onTaskClick: (taskId: string, projectId: string) => void;
}

export function MyTasksWidget({ workspaceId, onTaskClick }: MyTasksWidgetProps) {
  const { data, isLoading } = useMyTasks(workspaceId);
  const tasks = data?.data ?? [];

  const todayStr = formatDateISO(new Date());
  const isOverdue = (task: MyTask) => Boolean(
    task.dueDate && task.dueDate < todayStr && !task.status.isCompletion,
  );
  const overdueTasks = tasks.filter(isOverdue);

  const grouped = tasks.reduce<Record<string, { project: { id: string; name: string; color: string | null }; tasks: MyTask[] }>>(
    (acc, task) => {
      const pid = task.project.id;
      if (!acc[pid]) {
        acc[pid] = { project: task.project, tasks: [] };
      }
      acc[pid].tasks.push(task);
      return acc;
    },
    {},
  );

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">My Tasks</CardTitle>
      </CardHeader>
      <CardContent className="pb-3">
        {isLoading ? (
          <div className="space-y-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="flex items-center gap-3">
                <Skeleton className="h-4 flex-1" />
                <Skeleton className="h-5 w-14" />
              </div>
            ))}
          </div>
        ) : tasks.length === 0 ? (
          <p className="text-sm text-muted-foreground py-2">No tasks assigned</p>
        ) : (
          <div className="max-h-[400px] overflow-y-auto space-y-4">
            {overdueTasks.length > 0 && (
              <div className="rounded-md border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/30 p-2 space-y-1">
                <div className="flex items-center gap-1.5 pb-0.5">
                  <AlertTriangle className="h-3.5 w-3.5 text-destructive" />
                  <span className="text-xs font-semibold text-destructive">
                    Overdue ({overdueTasks.length})
                  </span>
                </div>
                {overdueTasks.map((task) => (
                  <button
                    key={`overdue-${task.id}`}
                    onClick={() => onTaskClick(task.id, task.project.id)}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-left hover:bg-red-100 dark:hover:bg-red-900/30 transition-colors"
                  >
                    <div
                      className="h-2 w-2 rounded-full shrink-0"
                      style={{ backgroundColor: task.project.color ?? "#6366f1" }}
                    />
                    <span className="flex-1 min-w-0 truncate text-destructive">{task.title}</span>
                    <span className="text-xs text-destructive shrink-0">
                      {formatDueDate(task.dueDate!)}
                    </span>
                  </button>
                ))}
              </div>
            )}

            {Object.entries(grouped).map(([pid, group]) => (
              <div key={pid} className="space-y-1">
                <div className="flex items-center gap-2 pb-0.5">
                  <div
                    className="h-2.5 w-2.5 rounded-full shrink-0"
                    style={{ backgroundColor: group.project.color ?? "#6366f1" }}
                  />
                  <span className="text-xs font-semibold text-muted-foreground">
                    {group.project.name}
                  </span>
                </div>

                {group.tasks.map((task) => (
                  <button
                    key={task.id}
                    onClick={() => onTaskClick(task.id, task.project.id)}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-left hover:bg-accent transition-colors"
                  >
                    <span className="flex-1 min-w-0 truncate">{task.title}</span>
                    <Badge
                      variant="outline"
                      className={cn("text-[10px] px-1.5 py-0 border-0 shrink-0", priorityVariant[task.priority])}
                    >
                      {task.priority[0] + task.priority.slice(1).toLowerCase()}
                    </Badge>
                    {task.dueDate && (
                      <span className={cn(
                        "text-xs shrink-0",
                        isOverdue(task) ? "text-destructive" : "text-muted-foreground",
                      )}>
                        {formatDueDate(task.dueDate)}
                      </span>
                    )}
                    <Badge variant="outline" className="text-[10px] px-1.5 py-0 shrink-0">
                      {task.status.name}
                    </Badge>
                  </button>
                ))}
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
