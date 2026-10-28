import { cn } from "@/lib/utils";

interface PriorityBadgeProps {
  priority: "NONE" | "LOW" | "MEDIUM" | "HIGH" | "URGENT";
  className?: string;
  onClick?: () => void;
  /** With `onClick`: whether this priority is the selected one. */
  pressed?: boolean;
}

const priorityConfig = {
  NONE: { label: "None", className: "bg-gray-50 text-gray-400 dark:bg-gray-800/50 dark:text-gray-500" },
  LOW: { label: "Low", className: "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300" },
  MEDIUM: { label: "Medium", className: "bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300" },
  HIGH: { label: "High", className: "bg-orange-100 text-orange-700 dark:bg-orange-900 dark:text-orange-300" },
  URGENT: { label: "Urgent", className: "bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300" },
};

export function PriorityBadge({ priority, className, onClick, pressed }: PriorityBadgeProps) {
  const config = priorityConfig[priority];
  const classes = cn(
    "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium",
    config.className,
    className,
  );

  if (onClick) {
    return (
      <button type="button" aria-pressed={pressed} onClick={onClick} className={classes}>
        {config.label}
      </button>
    );
  }

  return <span className={classes}>{config.label}</span>;
}
