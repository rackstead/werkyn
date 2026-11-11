import {
  useSortable,
  defaultAnimateLayoutChanges,
  type AnimateLayoutChanges,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { cn } from "@/lib/utils";
import { PriorityBadge } from "@/components/shared/priority-badge";
import { DueDateChip } from "@/components/shared/due-date-chip";
import { UserAvatar } from "@/components/shared/user-avatar";
import { ListChecks, Link2 } from "lucide-react";
import type { Task } from "@/features/tasks/api";

// Animate even when items are added/removed from the SortableContext
// (cross-column moves). Default only animates within the same list.
const animateLayoutChanges: AnimateLayoutChanges = (args) => {
  const { isSorting, wasDragging } = args;
  if (isSorting || wasDragging) {
    return defaultAnimateLayoutChanges(args);
  }
  return true;
};

interface TaskCardProps {
  task: Task;
  onClick: () => void;
  isDragDisabled?: boolean;
}

export function TaskCard({ task, onClick, isDragDisabled }: TaskCardProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: task.id,
    disabled: isDragDisabled,
    animateLayoutChanges,
    transition: {
      duration: 200,
      easing: "cubic-bezier(0.25, 1, 0.5, 1)",
    },
  });

  const style = {
    transform: CSS.Translate.toString(transform),
    transition,
  };

  return (
    <div
      ref={setNodeRef}
      data-task-id={task.id}
      style={style}
      {...attributes}
      {...listeners}
      onKeyDown={(event) => {
        listeners?.onKeyDown?.(event);
        // Enter is not a drag key. A div does not activate on Enter by itself.
        if (event.key === "Enter" && !event.defaultPrevented && !isDragging) {
          event.preventDefault();
          onClick();
        }
      }}
      onClick={(e) => {
        // Don't open slideover if dragging
        if (!isDragging) {
          e.stopPropagation();
          onClick();
        }
      }}
      className={cn(
        "rounded-lg border bg-card p-3 shadow-sm cursor-pointer",
        "hover:border-primary/30 transition-[border-color,opacity,box-shadow] duration-200",
        isDragging && "opacity-0",
        isDragDisabled && "cursor-default",
      )}
    >
      {/* Labels */}
      {task.labels.length > 0 && (
        <div className="flex flex-wrap gap-1 mb-2">
          {task.labels.map((tl) => (
            <span
              key={tl.labelId}
              className="inline-block rounded-full px-2 py-0.5 text-[10px] font-medium text-white"
              style={{ backgroundColor: tl.label.color }}
            >
              {tl.label.name}
            </span>
          ))}
        </div>
      )}

      {/* Title */}
      <p className="text-sm font-medium leading-snug">{task.title}</p>

      {/* Meta row */}
      <div className="mt-2 flex items-center gap-2 flex-wrap">
        {task.priority !== "NONE" && (
          <PriorityBadge priority={task.priority} />
        )}
        {task.dueDate && <DueDateChip dueDate={task.dueDate} />}
        {task._count.subtasks > 0 && (
          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
            <ListChecks className="h-3 w-3" />
            {task._count.subtasks}
          </span>
        )}
        {task._count.blockedBy > 0 && (
          <span className="inline-flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400">
            <Link2 className="h-3 w-3" />
            Blocked
          </span>
        )}
      </div>

      {/* Assignees */}
      {task.assignees.length > 0 && (
        <div className="mt-2 flex -space-x-1">
          {task.assignees.slice(0, 3).map((a) => (
            <UserAvatar
              key={a.userId}
              displayName={a.user.displayName}
              avatarUrl={a.user.avatarUrl}
              size="sm"
              className="ring-2 ring-card"
            />
          ))}
          {task.assignees.length > 3 && (
            <span className="flex h-6 w-6 items-center justify-center rounded-full bg-muted text-[10px] font-medium ring-2 ring-card">
              +{task.assignees.length - 3}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
