import { useMemo } from "react";
import { useMyTasks, type MyTask } from "@/features/my-tasks/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { CalendarDays } from "lucide-react";
import { formatDateISO } from "@/features/time/utils";

interface UpcomingDatesWidgetProps {
  workspaceId: string;
  onTaskClick: (taskId: string, projectId: string) => void;
}

function formatDueDate(dateStr: string, todayStr: string): string {
  const today = new Date(todayStr + "T00:00:00");
  const due = new Date(dateStr + "T00:00:00");
  const diffDays = Math.round((due.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));

  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Tomorrow";
  return due.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr + "T00:00:00");
  d.setDate(d.getDate() + days);
  return formatDateISO(d);
}

export function UpcomingDatesWidget({ workspaceId, onTaskClick }: UpcomingDatesWidgetProps) {
  const { data, isLoading } = useMyTasks(workspaceId);
  const tasks = data?.data ?? [];

  const todayStr = formatDateISO(new Date());
  const weekEnd = addDays(todayStr, 7);

  const upcoming = useMemo(() => {
    return tasks
      .filter(
        (t: MyTask) =>
          t.dueDate &&
          t.dueDate >= todayStr &&
          t.dueDate <= weekEnd &&
          !t.status.isCompletion,
      )
      .sort((a: MyTask, b: MyTask) => a.dueDate!.localeCompare(b.dueDate!));
  }, [tasks, todayStr, weekEnd]);

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <CalendarDays className="h-4 w-4" />
          Upcoming Dates
        </CardTitle>
      </CardHeader>
      <CardContent className="pb-3">
        {isLoading ? (
          <div className="space-y-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="flex items-center gap-3">
                <Skeleton className="h-4 flex-1" />
                <Skeleton className="h-5 w-16" />
              </div>
            ))}
          </div>
        ) : upcoming.length === 0 ? (
          <p className="text-sm text-muted-foreground py-2">Nothing due this week</p>
        ) : (
          <div className="max-h-[300px] overflow-y-auto space-y-1">
            {upcoming.map((task: MyTask) => {
              const label = formatDueDate(task.dueDate!, todayStr);
              const isToday = task.dueDate === todayStr;
              return (
                <button
                  key={task.id}
                  onClick={() => onTaskClick(task.id, task.project.id)}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-left hover:bg-accent transition-colors"
                >
                  <div
                    className="h-2 w-2 rounded-full shrink-0"
                    style={{ backgroundColor: task.project.color ?? "#6366f1" }}
                  />
                  <span className="flex-1 min-w-0 truncate">{task.title}</span>
                  <span className="text-xs text-muted-foreground truncate max-w-[80px]">
                    {task.project.name}
                  </span>
                  <Badge
                    variant="outline"
                    className={cn(
                      "text-[10px] px-1.5 py-0 shrink-0",
                      isToday && "border-orange-300 bg-orange-50 text-orange-700 dark:border-orange-800 dark:bg-orange-950/30 dark:text-orange-400",
                    )}
                  >
                    {label}
                  </Badge>
                </button>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
