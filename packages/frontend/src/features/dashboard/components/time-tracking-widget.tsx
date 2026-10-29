import { useMemo } from "react";
import { useTimeEntries, type TimeEntry } from "@/features/time/api";
import { formatDateISO, getMonday } from "@/features/time/utils";
import { useAuthStore } from "@/stores/auth-store";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Clock } from "lucide-react";

interface TimeTrackingWidgetProps {
  workspaceId: string;
}

export function TimeTrackingWidget({ workspaceId }: TimeTrackingWidgetProps) {
  const user = useAuthStore((s) => s.user);
  const userId = user?.id;

  // Entry dates are the user's local calendar dates.
  const now = new Date();
  const today = formatDateISO(now);
  const weekStart = formatDateISO(getMonday(now));

  const { data: entries, isLoading } = useTimeEntries(workspaceId, weekStart, today, userId);

  const { hoursToday, hoursThisWeek, projectBreakdown } = useMemo(() => {
    const list: TimeEntry[] = entries ?? [];
    let todayH = 0;
    let weekH = 0;
    const byProject: Record<string, { name: string; color: string | null; hours: number }> = {};

    for (const e of list) {
      weekH += e.hours;
      if (e.date === today) todayH += e.hours;
      if (e.project) {
        const pid = e.project.id;
        if (!byProject[pid]) {
          byProject[pid] = { name: e.project.name, color: e.project.color, hours: 0 };
        }
        byProject[pid].hours += e.hours;
      }
    }

    return {
      hoursToday: todayH,
      hoursThisWeek: weekH,
      projectBreakdown: Object.entries(byProject)
        .sort(([, a], [, b]) => b.hours - a.hours)
        .slice(0, 5),
    };
  }, [entries, today]);

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Clock className="h-4 w-4" />
          Time Tracking
        </CardTitle>
      </CardHeader>
      <CardContent className="pb-3">
        {isLoading ? (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <Skeleton className="h-12 rounded-md" />
              <Skeleton className="h-12 rounded-md" />
            </div>
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-4 w-1/2" />
          </div>
        ) : (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-md bg-muted/50 px-3 py-2">
                <p className="text-lg font-semibold">{hoursToday.toFixed(1)}h</p>
                <p className="text-xs text-muted-foreground">Today</p>
              </div>
              <div className="rounded-md bg-muted/50 px-3 py-2">
                <p className="text-lg font-semibold">{hoursThisWeek.toFixed(1)}h</p>
                <p className="text-xs text-muted-foreground">This Week</p>
              </div>
            </div>

            {projectBreakdown.length > 0 ? (
              <div className="space-y-1.5">
                <p className="text-xs font-medium text-muted-foreground">By project</p>
                {projectBreakdown.map(([pid, proj]) => (
                  <div
                    key={pid}
                    className="flex items-center justify-between text-sm py-1"
                  >
                    <div className="flex items-center gap-1.5 min-w-0">
                      <div
                        className="h-2 w-2 rounded-full shrink-0"
                        style={{ backgroundColor: proj.color ?? "#6366f1" }}
                      />
                      <span className="truncate">{proj.name}</span>
                    </div>
                    <span className="text-muted-foreground shrink-0 ml-2 text-xs">
                      {proj.hours.toFixed(1)}h
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground py-1">No time logged this week</p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
