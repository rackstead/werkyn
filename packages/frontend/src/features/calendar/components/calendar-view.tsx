import { useState, useMemo, useCallback, useRef } from "react";
import FullCalendar from "@fullcalendar/react";
import dayGridPlugin from "@fullcalendar/daygrid";
import interactionPlugin from "@fullcalendar/interaction";
import type {
  EventInput,
  EventClickArg,
  EventDropArg,
  EventContentArg,
  EventMountArg,
  DateSelectArg,
} from "@fullcalendar/core";
import type { EventResizeDoneArg } from "@fullcalendar/interaction";
import tippy from "tippy.js";
import { ChevronLeft, ChevronRight, Check } from "lucide-react";
import { useProjectTasks, useUpdateTask, type Task } from "@/features/tasks/api";
import { useMediaQuery } from "@/hooks/use-media-query";
import { CreateTaskDialog } from "@/features/tasks/components/create-task-dialog";
import { UserAvatar } from "@/components/shared/user-avatar";
import { cn } from "@/lib/utils";
import { buildEventTooltip } from "../utils/build-event-tooltip";

const PRIORITY_COLORS: Record<string, string> = {
  URGENT: "#ef4444",
  HIGH: "#f97316",
  MEDIUM: "#3b82f6",
  LOW: "#9ca3af",
};

type CalView = "dayGridMonth" | "dayGridWeek";

interface CalendarViewProps {
  projectId: string;
  filters?: Record<string, unknown>;
  onTaskClick: (taskId: string) => void;
  editable: boolean;
}

/** Format a JS Date to YYYY-MM-DD */
function formatDate(d: Date): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

/** Add days to a YYYY-MM-DD string */
function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr + "T00:00:00");
  d.setDate(d.getDate() + days);
  return formatDate(d);
}

export function CalendarView({
  projectId,
  filters,
  onTaskClick,
  editable,
}: CalendarViewProps) {
  const isMobile = useMediaQuery("(max-width: 768px)");
  const { data: tasksData, isLoading } = useProjectTasks(projectId, filters);
  const updateTask = useUpdateTask();
  const [title, setTitle] = useState("");
  const [activeView, setActiveView] = useState<CalView>(
    isMobile ? "dayGridWeek" : "dayGridMonth",
  );
  const calRef = useRef<FullCalendar>(null);

  // Create dialog state
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [defaultDueDate, setDefaultDueDate] = useState<string | undefined>();
  const [defaultStartDate, setDefaultStartDate] = useState<string | undefined>();

  const handleDatesSet = useCallback((arg: { view: { title: string; type: string } }) => {
    setTitle(arg.view.title);
    setActiveView(arg.view.type as CalView);
  }, []);

  // Multi-day bars for tasks with both dates, single-day dots for the rest
  const events: EventInput[] = useMemo(() => {
    if (!tasksData?.data) return [];
    return tasksData.data
      .filter((t) => t.startDate || t.dueDate)
      .map((t) => {
        const color = t.status.color || "#9ca3af";
        const base = {
          id: t.id,
          title: t.title,
          backgroundColor: color,
          borderColor: color,
          extendedProps: { task: t },
        };

        if (t.startDate && t.dueDate) {
          return {
            ...base,
            start: t.startDate,
            end: addDays(t.dueDate, 1), // FullCalendar end is exclusive
          };
        }

        return { ...base, start: (t.startDate ?? t.dueDate)! };
      });
  }, [tasksData]);

  const handleEventClick = useCallback(
    (info: EventClickArg) => {
      onTaskClick(info.event.id);
    },
    [onTaskClick],
  );

  // Drag-drop: multi-day events update both dates, single-day updates whichever date exists
  const handleEventDrop = useCallback(
    (info: EventDropArg) => {
      const newStart = info.event.start;
      if (!newStart) return;
      const startFormatted = formatDate(newStart);

      if (info.event.end) {
        const endFormatted = addDays(formatDate(info.event.end), -1); // exclusive → inclusive
        updateTask.mutate({
          id: info.event.id,
          startDate: startFormatted,
          dueDate: endFormatted,
        });
      } else {
        const task = info.event.extendedProps.task as { startDate: string | null; dueDate: string | null } | undefined;
        const field = task?.startDate ? "startDate" : "dueDate";
        updateTask.mutate({ id: info.event.id, [field]: startFormatted });
      }
    },
    [updateTask],
  );

  // Resize: always updates both dates
  const handleEventResize = useCallback(
    (info: EventResizeDoneArg) => {
      const newStart = info.event.start;
      const newEnd = info.event.end;
      if (!newStart || !newEnd) return;
      updateTask.mutate({
        id: info.event.id,
        startDate: formatDate(newStart),
        dueDate: addDays(formatDate(newEnd), -1), // exclusive → inclusive
      });
    },
    [updateTask],
  );

  // Select: drag-select date range or single click
  const handleSelect = useCallback(
    (info: DateSelectArg) => {
      const startStr = formatDate(info.start);
      const endStr = addDays(formatDate(info.end), -1); // exclusive → inclusive

      if (startStr === endStr) {
        // Single-day click — default to due date
        setDefaultDueDate(startStr);
        setDefaultStartDate(undefined);
      } else {
        // Multi-day drag — set both dates
        setDefaultStartDate(startStr);
        setDefaultDueDate(endStr);
      }
      setCreateDialogOpen(true);
      calRef.current?.getApi().unselect();
    },
    [],
  );

  // dateClick fallback (fires when selectable is false)
  const handleDateClick = useCallback(
    (info: { dateStr: string }) => {
      setDefaultDueDate(info.dateStr);
      setDefaultStartDate(undefined);
      setCreateDialogOpen(true);
    },
    [],
  );

  const handleCreateDialogClose = useCallback(() => {
    setCreateDialogOpen(false);
    setDefaultDueDate(undefined);
    setDefaultStartDate(undefined);
  }, []);

  // Custom event rendering
  const renderEventContent = useCallback((arg: EventContentArg) => {
    const task = arg.event.extendedProps.task as {
      priority: string;
      status: { isCompletion: boolean };
      assignees: Array<{
        user: { id: string; displayName: string; avatarUrl: string | null };
      }>;
    } | undefined;

    if (!task) {
      return <span className="truncate text-xs">{arg.event.title}</span>;
    }

    const isComplete = task.status.isCompletion;
    const firstAssignee = task.assignees[0]?.user;

    return (
      <div className="flex items-center gap-1 overflow-hidden w-full">
        {/* Priority dot */}
        <span
          className="shrink-0 h-2 w-2 rounded-full"
          style={{ backgroundColor: PRIORITY_COLORS[task.priority] ?? PRIORITY_COLORS.MEDIUM }}
        />

        {/* Title */}
        <span
          className={cn(
            "truncate text-xs flex-1",
            isComplete && "line-through opacity-60",
          )}
        >
          {arg.event.title}
        </span>

        {/* Completion check */}
        {isComplete && (
          <Check className="shrink-0 h-3 w-3 text-green-300" />
        )}

        {/* Assignee avatar */}
        {firstAssignee && (
          <UserAvatar
            displayName={firstAssignee.displayName}
            avatarUrl={firstAssignee.avatarUrl}
            size="sm"
            className="!h-4 !w-4 shrink-0"
          />
        )}
      </div>
    );
  }, []);

  // Tippy tooltip on hover
  const handleEventDidMount = useCallback((info: EventMountArg) => {
    const task = info.event.extendedProps.task as Task | undefined;
    if (!task) return;
    tippy(info.el, {
      content: buildEventTooltip(task),
      allowHTML: false,
      delay: [300, 0],
      placement: "top",
      theme: "pm",
      touch: false,
      interactive: false,
      appendTo: document.body,
    });
  }, []);

  const handleEventWillUnmount = useCallback((info: EventMountArg) => {
    (info.el as HTMLElement & { _tippy?: { destroy(): void } })._tippy?.destroy();
  }, []);

  const goPrev = () => calRef.current?.getApi().prev();
  const goNext = () => calRef.current?.getApi().next();
  const changeView = (view: CalView) => calRef.current?.getApi().changeView(view);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center p-12">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      </div>
    );
  }

  const btnBase =
    "rounded-md px-2.5 h-[30px] text-xs font-medium transition-colors border border-border shadow-none outline-none";
  const btnDefault =
    "bg-secondary text-secondary-foreground hover:bg-accent hover:text-accent-foreground";
  const btnActive = "bg-primary text-primary-foreground border-primary";

  return (
    <div
      className={[
        "p-4",
        // Base text
        "[&_.fc]:text-sm [&_.fc]:text-foreground",
        // Table borders + rounding on outer grid
        "[&_.fc-theme-standard_td]:!border-border [&_.fc-theme-standard_th]:!border-border",
        "[&_.fc-theme-standard_.fc-scrollgrid]:!border-border [&_.fc-theme-standard_.fc-scrollgrid]:!rounded-lg [&_.fc-theme-standard_.fc-scrollgrid]:!overflow-hidden",
        "[&_.fc-view-harness]:!rounded-lg",
        // Kill default white backgrounds on scrollgrid table and thead so rounded corners don't leak
        "[&_.fc-scrollgrid]:!bg-background [&_.fc-scrollgrid_table]:!bg-background",
        "[&_.fc-scrollgrid_thead]:!bg-muted [&_.fc-col-header]:!bg-muted",
        // Day header (weekday names)
        "[&_.fc-col-header-cell]:!bg-muted [&_.fc-col-header-cell]:!text-muted-foreground [&_.fc-col-header-cell]:!font-medium [&_.fc-col-header-cell]:!py-2",
        // Day cells
        "[&_.fc-daygrid-day]:min-h-[80px] [&_.fc-daygrid-day]:!bg-background",
        "[&_.fc-day-today]:!bg-accent/50",
        "[&_.fc-day-other_.fc-daygrid-day-top]:!opacity-40",
        // Day numbers
        "[&_.fc-daygrid-day-number]:!text-foreground [&_.fc-daygrid-day-number]:!text-sm [&_.fc-daygrid-day-number]:!py-1 [&_.fc-daygrid-day-number]:!px-2",
        // Events
        "[&_.fc-event]:cursor-pointer [&_.fc-event]:!text-xs [&_.fc-event]:!rounded-md [&_.fc-event]:!pl-1.5 [&_.fc-event]:!pr-2 [&_.fc-event]:!py-1 [&_.fc-event]:!border-0",
        "[&_.fc-event-main]:flex [&_.fc-event-main]:items-center [&_.fc-event-main]:overflow-hidden",
        "[&_.fc-event]:!text-white",
        // Event spacing from cell edges
        "[&_.fc-daygrid-event-harness]:!mx-1",
        // Selection highlight
        "[&_.fc-highlight]:!bg-primary/5 dark:[&_.fc-highlight]:!bg-primary/10",
        // More link
        "[&_.fc-daygrid-more-link]:!text-muted-foreground [&_.fc-daygrid-more-link:hover]:!text-foreground",
        // Popover (more events popup)
        "[&_.fc-popover]:!bg-popover [&_.fc-popover]:!border-border [&_.fc-popover]:!rounded-lg [&_.fc-popover]:!shadow-lg",
        "[&_.fc-popover-header]:!bg-muted [&_.fc-popover-header]:!text-muted-foreground [&_.fc-popover-header]:!rounded-t-lg [&_.fc-popover-header]:!px-3 [&_.fc-popover-header]:!py-2",
      ].join(" ")}
    >
      {/* Custom toolbar */}
      <div className="mb-3 flex items-center gap-2">
        {/* Nav arrows */}
        <div className="flex">
          <button onClick={goPrev} className={`${btnBase} ${btnDefault} rounded-r-none`}>
            <ChevronLeft className="h-4 w-4" />
          </button>
          <button onClick={goNext} className={`${btnBase} ${btnDefault} rounded-l-none border-l-0`}>
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>

        {/* Title */}
        <span className="text-base font-semibold text-foreground">
          {title}
        </span>

        <div className="ml-auto flex items-center gap-2">
          {/* View switcher */}
          <div className="flex">
            <button
              onClick={() => changeView("dayGridMonth")}
              className={`${btnBase} rounded-r-none ${activeView === "dayGridMonth" ? btnActive : btnDefault}`}
            >
              Month
            </button>
            <button
              onClick={() => changeView("dayGridWeek")}
              className={`${btnBase} rounded-l-none border-l-0 ${activeView === "dayGridWeek" ? btnActive : btnDefault}`}
            >
              Week
            </button>
          </div>
        </div>
      </div>

      <FullCalendar
        ref={calRef}
        plugins={[dayGridPlugin, interactionPlugin]}
        initialView={isMobile ? "dayGridWeek" : "dayGridMonth"}
        headerToolbar={false}
        events={events}
        eventClick={handleEventClick}
        eventContent={renderEventContent}
        eventDidMount={handleEventDidMount}
        eventWillUnmount={handleEventWillUnmount}
        eventDrop={editable ? handleEventDrop : undefined}
        eventResize={editable ? handleEventResize : undefined}
        editable={editable}
        eventResizableFromStart={editable}
        eventDurationEditable={editable}
        selectable={editable}
        select={editable ? handleSelect : undefined}
        dateClick={editable ? handleDateClick : undefined}
        unselectAuto={true}
        droppable={false}
        nowIndicator={true}
        height="auto"
        dayMaxEvents={4}
        datesSet={handleDatesSet}
      />

      <CreateTaskDialog
        open={createDialogOpen}
        onClose={handleCreateDialogClose}
        projectId={projectId}
        defaultDueDate={defaultDueDate}
        defaultStartDate={defaultStartDate}
      />
    </div>
  );
}
