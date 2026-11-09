import { useMemo } from "react";
import { useNavigate } from "@tanstack/react-router";
import { BarChart3 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAuthStore } from "@/stores/auth-store";
import { usePermissions } from "@/hooks/use-permissions";
import { useTimeEntries } from "../api";
import {
  parseWeekParam,
  getWeekDays,
  formatDateISO,
  getSunday,
  getMonday,
} from "../utils";
import { WeekNavigator } from "./week-navigator";
import { TimesheetGrid } from "./timesheet-grid";
import { AllMembersView } from "./all-members-view";

interface TimesheetPageProps {
  workspaceId: string;
  workspaceSlug: string;
  membership: { role: "ADMIN" | "MEMBER" | "VIEWER" };
  week?: string;
  userId?: string;
  view?: "my" | "all";
}

export function TimesheetPage({
  workspaceId,
  workspaceSlug,
  membership,
  week,
  userId,
  view,
}: TimesheetPageProps) {
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);
  const permissions = usePermissions(membership, user?.id);
  const isAdmin = membership.role === "ADMIN";

  const currentView = view ?? "my";
  const monday = useMemo(() => parseWeekParam(week), [week]);
  const sunday = getSunday(monday);
  const weekDays = useMemo(() => getWeekDays(monday), [monday]);
  const startDate = formatDateISO(monday);
  const endDate = formatDateISO(sunday);

  // For "all" view, don't filter by userId; for "my" or drilled-in view, filter
  const filterUserId =
    currentView === "all" && !userId
      ? undefined
      : userId ?? user?.id;

  const {
    data: entries = [],
    isLoading,
    isError,
    isFetching,
    refetch,
  } = useTimeEntries(
    workspaceId,
    startDate,
    endDate,
    currentView === "all" && !userId ? undefined : filterUserId,
  );

  function navWeek(newMonday: Date) {
    navigate({
      to: "/$workspaceSlug/time",
      params: { workspaceSlug },
      search: {
        week: formatDateISO(newMonday),
        view: currentView,
        userId,
      },
    });
  }

  function handlePrev() {
    const prev = new Date(monday);
    prev.setDate(prev.getDate() - 7);
    navWeek(prev);
  }

  function handleNext() {
    const next = new Date(monday);
    next.setDate(next.getDate() + 7);
    navWeek(next);
  }

  function handleToday() {
    navWeek(getMonday(new Date()));
  }

  function toggleView() {
    navigate({
      to: "/$workspaceSlug/time",
      params: { workspaceSlug },
      search: {
        week: formatDateISO(monday),
        view: currentView === "my" ? "all" : "my",
        userId: undefined,
      },
    });
  }

  function handleSelectUser(uid: string) {
    navigate({
      to: "/$workspaceSlug/time",
      params: { workspaceSlug },
      search: {
        week: formatDateISO(monday),
        view: "all",
        userId: uid,
      },
    });
  }

  function handleBackToAll() {
    navigate({
      to: "/$workspaceSlug/time",
      params: { workspaceSlug },
      search: {
        week: formatDateISO(monday),
        view: "all",
        userId: undefined,
      },
    });
  }

  const readOnly = membership.role === "VIEWER" || (currentView === "all" && !!userId && userId !== user?.id);

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-bold">Time Tracking</h1>
        </div>
        <div className="flex items-center gap-2">
          {isAdmin && (
            <>
              <Button
                size="sm"
                variant={currentView === "my" ? "default" : "outline"}
                onClick={() => currentView !== "my" && toggleView()}
              >
                My Timesheet
              </Button>
              <Button
                size="sm"
                variant={currentView === "all" ? "default" : "outline"}
                onClick={() => currentView !== "all" && toggleView()}
              >
                All Members
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  navigate({
                    to: "/$workspaceSlug/time/reports",
                    params: { workspaceSlug },
                    search: { startDate, endDate },
                  })
                }
              >
                <BarChart3 className="h-4 w-4 mr-1" />
                Reports
              </Button>
            </>
          )}
        </div>
      </div>

      <WeekNavigator
        monday={monday}
        onPrev={handlePrev}
        onNext={handleNext}
        onToday={handleToday}
      />

      {isError ? (
        <div role="alert" className="space-y-2 border rounded-lg p-8">
          <p className="text-sm text-destructive">Could not load time entries.</p>
          <Button
            size="sm"
            variant="outline"
            onClick={() => refetch()}
            disabled={isFetching}
          >
            Try again
          </Button>
        </div>
      ) : currentView === "all" && !userId ? (
        <AllMembersView
          workspaceId={workspaceId}
          entries={entries}
          onSelectUser={handleSelectUser}
        />
      ) : null}

      {!isError && (currentView === "my" || userId) && (
        <>
          {userId && currentView === "all" && (
            <div className="flex items-center gap-2">
              <Button size="sm" variant="ghost" onClick={handleBackToAll}>
                &larr; Back to All Members
              </Button>
              <span className="text-sm text-muted-foreground">
                Viewing: {entries[0]?.user?.displayName ?? "Member"}
              </span>
            </div>
          )}

          {isLoading ? (
            <div className="border rounded-lg p-8">
              <div className="h-32 animate-pulse bg-muted rounded" />
            </div>
          ) : (
            <TimesheetGrid
              workspaceId={workspaceId}
              entries={entries}
              weekDays={weekDays}
              readOnly={readOnly}
            />
          )}
        </>
      )}
    </div>
  );
}
