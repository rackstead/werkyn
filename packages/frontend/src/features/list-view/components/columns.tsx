import { useState } from "react";
import { isHttpUrl } from "@pm/shared";
import { committedDate } from "@/lib/date-input";
import { createColumnHelper } from "@tanstack/react-table";
import type { Task } from "@/features/tasks/api";
import {
  useAddAssignee,
  useRemoveAssignee,
  useAddTaskLabel,
  useRemoveTaskLabel,
} from "@/features/tasks/api";
import { PriorityBadge } from "@/components/shared/priority-badge";
import { UserAvatar } from "@/components/shared/user-avatar";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
} from "@/components/ui/command";
import { Check, ExternalLink } from "lucide-react";
import { cn } from "@/lib/utils";
import type { CustomField } from "@/features/projects/api";
import { useSetCustomFieldValue } from "@/features/projects/api";
import { useCustomFieldSaver, type CustomFieldInput } from "@/features/tasks/custom-field-save";

const columnHelper = createColumnHelper<Task>();

const PRIORITIES = ["URGENT", "HIGH", "MEDIUM", "LOW", "NONE"] as const;
const priorityLabels: Record<string, string> = {
  URGENT: "Urgent",
  HIGH: "High",
  MEDIUM: "Medium",
  LOW: "Low",
  NONE: "None",
};

function InlineStatusCell({
  task,
  statuses,
  onUpdateTask,
}: {
  task: Task;
  statuses: Array<{ id: string; name: string; color: string | null }>;
  onUpdateTask: (id: string, data: Record<string, unknown>) => void;
}) {
  const [editing, setEditing] = useState(false);
  const color = task.status.color ?? "#94a3b8";

  if (editing) {
    return (
      <select
        autoFocus
        className="w-full h-full border-none text-xs font-medium text-center bg-background cursor-pointer px-1 py-1 rounded"
        defaultValue={task.statusId}
        onChange={(e) => {
          onUpdateTask(task.id, { statusId: e.target.value });
          setEditing(false);
        }}
        onBlur={() => setEditing(false)}
      >
        {statuses.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </select>
    );
  }

  return (
    <button
      onClick={() => setEditing(true)}
      className="w-full flex items-center justify-center rounded px-2 py-1 text-xs font-medium text-white transition-opacity hover:opacity-80"
      style={{ backgroundColor: color }}
    >
      {task.status.name}
    </button>
  );
}

function InlinePriorityCell({
  task,
  onUpdateTask,
}: {
  task: Task;
  onUpdateTask: (id: string, data: Record<string, unknown>) => void;
}) {
  const [editing, setEditing] = useState(false);

  if (editing) {
    return (
      <select
        autoFocus
        className="w-full h-full border-none text-xs font-medium text-center bg-background cursor-pointer px-1 py-1 rounded"
        defaultValue={task.priority}
        onChange={(e) => {
          onUpdateTask(task.id, { priority: e.target.value });
          setEditing(false);
        }}
        onBlur={() => setEditing(false)}
      >
        {PRIORITIES.map((p) => (
          <option key={p} value={p}>
            {priorityLabels[p]}
          </option>
        ))}
      </select>
    );
  }

  return (
    <button
      onClick={() => setEditing(true)}
      className="flex items-center justify-center w-full transition-opacity hover:opacity-80"
    >
      <PriorityBadge priority={task.priority} />
    </button>
  );
}

export function InlineDueDateCell({
  task,
  onUpdateTask,
}: {
  task: Task;
  onUpdateTask: (id: string, data: Record<string, unknown>) => void;
}) {
  const [editing, setEditing] = useState(false);
  const isOverdue =
    task.dueDate &&
    new Date(task.dueDate) < new Date() &&
    !task.status.isCompletion;

  if (editing) {
    return (
      <div className="flex items-center gap-1">
        <input
          type="date"
          autoFocus
          className="text-xs border border-border rounded px-1 py-0.5 bg-background"
          defaultValue={task.dueDate ?? ""}
          onChange={(e) => {
            // Keep editing while a year is still being typed.
            const dueDate = committedDate(e.target.value);
            if (dueDate === undefined) return;
            onUpdateTask(task.id, { dueDate });
            setEditing(false);
          }}
          onBlur={() => setEditing(false)}
        />
      </div>
    );
  }

  return (
    <button
      onClick={() => setEditing(true)}
      className="text-left w-full transition-opacity hover:opacity-80"
    >
      {task.dueDate ? (
        <span
          className={cn(
            "text-xs",
            isOverdue && "text-destructive font-medium",
          )}
        >
          {task.dueDate}
        </span>
      ) : (
        <span className="text-muted-foreground text-xs">-</span>
      )}
    </button>
  );
}

function InlineAssigneeCell({
  task,
  members,
}: {
  task: Task;
  members: Array<{
    id: string;
    displayName: string;
    avatarUrl: string | null;
  }>;
}) {
  const [open, setOpen] = useState(false);
  const addAssignee = useAddAssignee(task.id, task.projectId);
  const removeAssignee = useRemoveAssignee(task.id, task.projectId);
  const selectedIds = task.assignees.map((a) => a.userId);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button className="w-full flex items-center gap-1 min-h-[28px] rounded transition-colors cursor-pointer">
          {task.assignees.length > 0 ? (
            <div className="flex -space-x-1">
              {task.assignees.slice(0, 3).map((a) => (
                <UserAvatar
                  key={a.userId}
                  displayName={a.user.displayName}
                  avatarUrl={a.user.avatarUrl}
                  size="sm"
                  className="ring-2 ring-background"
                />
              ))}
              {task.assignees.length > 3 && (
                <span className="flex h-6 w-6 items-center justify-center rounded-full bg-muted text-[10px] font-medium ring-2 ring-background">
                  +{task.assignees.length - 3}
                </span>
              )}
            </div>
          ) : (
            <span className="text-muted-foreground text-xs">-</span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent className="p-0 w-64" align="start">
        <Command>
          <CommandInput placeholder="Search members..." />
          <CommandList>
            <CommandEmpty>No members found.</CommandEmpty>
            <CommandGroup>
              {members.map((user) => {
                const selected = selectedIds.includes(user.id);
                return (
                  <CommandItem
                    key={user.id}
                    value={user.displayName}
                    onSelect={() => {
                      if (selected) {
                        removeAssignee.mutate(user.id);
                      } else {
                        addAssignee.mutate(user.id);
                      }
                    }}
                  >
                    <UserAvatar
                      displayName={user.displayName}
                      avatarUrl={user.avatarUrl}
                      size="sm"
                    />
                    <span className="flex-1 truncate">{user.displayName}</span>
                    {selected && <Check className="h-4 w-4 text-primary" />}
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function InlineLabelCell({
  task,
  projectLabels,
}: {
  task: Task;
  projectLabels: Array<{ id: string; name: string; color: string }>;
}) {
  const [open, setOpen] = useState(false);
  const addLabel = useAddTaskLabel(task.id, task.projectId);
  const removeLabel = useRemoveTaskLabel(task.id, task.projectId);
  const selectedIds = task.labels.map((tl) => tl.labelId);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button className="w-full flex items-center gap-1 flex-wrap min-h-[28px] rounded transition-colors cursor-pointer">
          {task.labels.length > 0 ? (
            <>
              {task.labels.slice(0, 2).map((l) => (
                <span
                  key={l.labelId}
                  className="inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium"
                  style={{
                    backgroundColor: l.label.color + "20",
                    color: l.label.color,
                  }}
                >
                  {l.label.name}
                </span>
              ))}
              {task.labels.length > 2 && (
                <span className="text-[10px] text-muted-foreground">
                  +{task.labels.length - 2}
                </span>
              )}
            </>
          ) : (
            <span className="text-muted-foreground text-xs">-</span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent className="p-0 w-56" align="start">
        <Command>
          <CommandInput placeholder="Search labels..." />
          <CommandList>
            <CommandEmpty>No labels found.</CommandEmpty>
            <CommandGroup>
              {projectLabels.map((label) => {
                const selected = selectedIds.includes(label.id);
                return (
                  <CommandItem
                    key={label.id}
                    value={label.name}
                    onSelect={() => {
                      if (selected) {
                        removeLabel.mutate(label.id);
                      } else {
                        addLabel.mutate(label.id);
                      }
                    }}
                  >
                    <div
                      className="h-3 w-3 rounded-full shrink-0"
                      style={{ backgroundColor: label.color }}
                    />
                    <span className="flex-1 truncate">{label.name}</span>
                    {selected && <Check className="h-4 w-4 text-primary" />}
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function CustomFieldDisplay({
  task,
  field,
}: {
  task: Task;
  field: CustomField;
}) {
  const cfv = task.customFieldValues?.find((v) => v.fieldId === field.id);
  const value = cfv?.value;

  if (value === undefined || value === null) {
    return <span className="text-muted-foreground text-xs">-</span>;
  }

  switch (field.type) {
    case "CHECKBOX":
      return (
        <div className="flex items-center justify-center">
          <div
            className={cn(
              "h-4 w-4 rounded border",
              value ? "bg-primary border-primary text-white flex items-center justify-center" : "border-input",
            )}
          >
            {value && <Check className="h-3 w-3" />}
          </div>
        </div>
      );
    case "SELECT": {
      const opt = field.options?.find((o) => o.value === value);
      const color = opt?.color ?? "#6366f1";
      return (
        <span
          className="inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium"
          style={{ backgroundColor: color + "20", color }}
        >
          {String(value)}
        </span>
      );
    }
    case "MULTI_SELECT": {
      const vals = Array.isArray(value) ? value : [];
      if (vals.length === 0) return <span className="text-muted-foreground text-xs">-</span>;
      return (
        <div className="flex flex-wrap gap-0.5">
          {vals.slice(0, 2).map((v) => {
            const opt = field.options?.find((o) => o.value === v);
            const color = opt?.color ?? "#6366f1";
            return (
              <span
                key={v}
                className="inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium"
                style={{ backgroundColor: color + "20", color }}
              >
                {v}
              </span>
            );
          })}
          {vals.length > 2 && (
            <span className="text-[10px] text-muted-foreground">+{vals.length - 2}</span>
          )}
        </div>
      );
    }
    case "URL":
      // Only http(s) values are links; values saved before URL fields were
      // checked may use other schemes such as javascript: or data:.
      if (!isHttpUrl(String(value))) {
        return <span className="text-xs truncate">{String(value)}</span>;
      }
      return (
        <a
          href={String(value)}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-primary hover:underline truncate flex items-center gap-1"
          onClick={(e) => e.stopPropagation()}
        >
          <ExternalLink className="h-3 w-3 shrink-0" />
          <span className="truncate">{String(value)}</span>
        </a>
      );
    case "DATE":
      return <span className="text-xs">{String(value)}</span>;
    case "NUMBER":
      return <span className="text-xs">{String(value)}</span>;
    default:
      return <span className="text-xs truncate">{String(value)}</span>;
  }
}

function InlineCustomFieldCell({
  task,
  field,
}: {
  task: Task;
  field: CustomField;
}) {
  const [editing, setEditing] = useState(false);
  const setFieldValue = useSetCustomFieldValue(task.id, task.projectId);
  const cfv = task.customFieldValues?.find((v) => v.fieldId === field.id);
  const value = cfv?.value;

  // Nothing is sent for an unchanged value or an emptied required field; the
  // cell then shows the stored value again.
  const { save: saveValue } = useCustomFieldSaver(field, value, (newValue, onError) =>
    setFieldValue.mutate({ fieldId: field.id, value: newValue }, { onError }),
  );
  const save = (newValue: CustomFieldInput) => {
    saveValue(newValue);
    setEditing(false);
  };

  switch (field.type) {
    case "CHECKBOX":
      return (
        <div className="flex items-center justify-center">
          <input
            type="checkbox"
            checked={!!value}
            onChange={(e) => save(e.target.checked)}
            className="h-3.5 w-3.5 rounded border-input accent-primary cursor-pointer"
          />
        </div>
      );

    case "SELECT": {
      if (editing) {
        return (
          <select
            autoFocus
            className="w-full h-full border-none text-xs bg-background cursor-pointer px-1 py-1 rounded"
            defaultValue={typeof value === "string" ? value : ""}
            onChange={(e) => save(e.target.value || null)}
            onBlur={() => setEditing(false)}
          >
            <option value="">-</option>
            {field.options?.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.value}
              </option>
            ))}
          </select>
        );
      }
      return (
        <button onClick={() => setEditing(true)} className="w-full text-left transition-opacity hover:opacity-80">
          <CustomFieldDisplay task={task} field={field} />
        </button>
      );
    }

    case "MULTI_SELECT": {
      const selectedVals = Array.isArray(value) ? (value as string[]) : [];
      const [open, setOpen] = useState(false);
      return (
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <button className="w-full flex items-center gap-1 flex-wrap min-h-[28px] rounded transition-colors cursor-pointer">
              <CustomFieldDisplay task={task} field={field} />
            </button>
          </PopoverTrigger>
          <PopoverContent className="p-0 w-56" align="start">
            <Command>
              <CommandInput placeholder="Search options..." />
              <CommandList>
                <CommandEmpty>No options.</CommandEmpty>
                <CommandGroup>
                  {field.options?.map((opt) => {
                    const selected = selectedVals.includes(opt.value);
                    return (
                      <CommandItem
                        key={opt.value}
                        value={opt.value}
                        onSelect={() => {
                          const next = selected
                            ? selectedVals.filter((v) => v !== opt.value)
                            : [...selectedVals, opt.value];
                          save(next.length > 0 ? next : null);
                        }}
                      >
                        <span className="flex-1 truncate">{opt.value}</span>
                        {selected && <Check className="h-4 w-4 text-primary" />}
                      </CommandItem>
                    );
                  })}
                </CommandGroup>
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
      );
    }

    case "DATE": {
      if (editing) {
        return (
          <input
            type="date"
            autoFocus
            className="text-xs border border-border rounded px-1 py-0.5 bg-background"
            defaultValue={typeof value === "string" ? value : ""}
            onChange={(e) => {
              const date = committedDate(e.target.value);
              if (date !== undefined) save(date);
            }}
            onBlur={() => setEditing(false)}
          />
        );
      }
      return (
        <button onClick={() => setEditing(true)} className="w-full text-left transition-opacity hover:opacity-80">
          <CustomFieldDisplay task={task} field={field} />
        </button>
      );
    }

    case "NUMBER": {
      if (editing) {
        return (
          <input
            type="number"
            autoFocus
            className="w-full text-xs border border-border rounded px-1 py-0.5 bg-background"
            defaultValue={typeof value === "number" ? value : ""}
            onBlur={(e) => {
              const v = e.target.value;
              save(v === "" ? null : Number(v));
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                const v = (e.target as HTMLInputElement).value;
                save(v === "" ? null : Number(v));
              }
              if (e.key === "Escape") setEditing(false);
            }}
          />
        );
      }
      return (
        <button onClick={() => setEditing(true)} className="w-full text-left transition-opacity hover:opacity-80">
          <CustomFieldDisplay task={task} field={field} />
        </button>
      );
    }

    case "URL":
    case "TEXT":
    default: {
      if (editing) {
        return (
          <input
            type={field.type === "URL" ? "url" : "text"}
            autoFocus
            className="w-full text-xs border border-border rounded px-1 py-0.5 bg-background"
            defaultValue={typeof value === "string" ? value : ""}
            onBlur={(e) => save(e.target.value || null)}
            onKeyDown={(e) => {
              if (e.key === "Enter") save((e.target as HTMLInputElement).value || null);
              if (e.key === "Escape") setEditing(false);
            }}
          />
        );
      }
      return (
        <button onClick={() => setEditing(true)} className="w-full text-left transition-opacity hover:opacity-80">
          <CustomFieldDisplay task={task} field={field} />
        </button>
      );
    }
  }
}

export function getColumns(options: {
  canEdit: boolean;
  onTaskClick: (taskId: string) => void;
  onUpdateTask: (id: string, data: Record<string, unknown>) => void;
  statuses: Array<{ id: string; name: string; color: string | null }>;
  members: Array<{
    id: string;
    displayName: string;
    avatarUrl: string | null;
  }>;
  projectLabels: Array<{ id: string; name: string; color: string }>;
  customFields?: CustomField[];
}) {
  const { canEdit, onTaskClick, onUpdateTask, statuses, members, projectLabels, customFields = [] } = options;

  return [
    columnHelper.display({
      id: "select",
      header: ({ table }) =>
        canEdit ? (
          <input
            type="checkbox"
            aria-label="Select all tasks"
            checked={table.getIsAllRowsSelected()}
            onChange={table.getToggleAllRowsSelectedHandler()}
            className="h-3.5 w-3.5 rounded border-input accent-primary"
          />
        ) : null,
      cell: ({ row }) =>
        canEdit ? (
          <input
            type="checkbox"
            aria-label={`Select ${row.original.title}`}
            checked={row.getIsSelected()}
            onChange={row.getToggleSelectedHandler()}
            className="h-3.5 w-3.5 rounded border-input accent-primary"
          />
        ) : null,
      size: 40,
      enableSorting: false,
    }),

    columnHelper.accessor("title", {
      header: "Title",
      cell: ({ row }) => (
        <button
          onClick={() => onTaskClick(row.original.id)}
          className="text-left font-medium text-sm hover:underline truncate max-w-xs"
        >
          {row.original.title}
        </button>
      ),
      size: 300,
    }),

    columnHelper.accessor("status", {
      header: "Status",
      cell: ({ row }) =>
        canEdit ? (
          <InlineStatusCell
            task={row.original}
            statuses={statuses}
            onUpdateTask={onUpdateTask}
          />
        ) : (
          <div
            className="flex items-center justify-center rounded px-2 py-1 text-xs font-medium text-white"
            style={{
              backgroundColor: row.original.status.color ?? "#94a3b8",
            }}
          >
            {row.original.status.name}
          </div>
        ),
      size: 140,
      enableSorting: false,
    }),

    columnHelper.accessor("priority", {
      header: "Priority",
      cell: ({ row }) =>
        canEdit ? (
          <InlinePriorityCell
            task={row.original}
            onUpdateTask={onUpdateTask}
          />
        ) : (
          <div className="flex items-center justify-center">
            <PriorityBadge priority={row.original.priority} />
          </div>
        ),
      size: 110,
      enableSorting: false,
    }),

    columnHelper.accessor("assignees", {
      header: "Assignees",
      cell: ({ row }) =>
        canEdit ? (
          <InlineAssigneeCell task={row.original} members={members} />
        ) : (
          (() => {
            const assignees = row.original.assignees;
            if (!assignees.length)
              return <span className="text-muted-foreground text-xs">-</span>;
            return (
              <div className="flex -space-x-1">
                {assignees.slice(0, 3).map((a) => (
                  <UserAvatar
                    key={a.userId}
                    displayName={a.user.displayName}
                    avatarUrl={a.user.avatarUrl}
                    size="sm"
                    className="ring-2 ring-background"
                  />
                ))}
                {assignees.length > 3 && (
                  <span className="flex h-6 w-6 items-center justify-center rounded-full bg-muted text-[10px] font-medium ring-2 ring-background">
                    +{assignees.length - 3}
                  </span>
                )}
              </div>
            );
          })()
        ),
      enableSorting: false,
      size: 150,
    }),

    columnHelper.accessor("labels", {
      header: "Labels",
      cell: ({ row }) =>
        canEdit ? (
          <InlineLabelCell task={row.original} projectLabels={projectLabels} />
        ) : (
          (() => {
            const labels = row.original.labels;
            if (!labels.length)
              return <span className="text-muted-foreground text-xs">-</span>;
            return (
              <div className="flex flex-wrap gap-1">
                {labels.slice(0, 3).map((l) => (
                  <span
                    key={l.labelId}
                    className="inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium"
                    style={{
                      backgroundColor: l.label.color + "20",
                      color: l.label.color,
                    }}
                  >
                    {l.label.name}
                  </span>
                ))}
                {labels.length > 3 && (
                  <span className="text-[10px] text-muted-foreground">
                    +{labels.length - 3}
                  </span>
                )}
              </div>
            );
          })()
        ),
      enableSorting: false,
      size: 180,
    }),

    columnHelper.accessor("dueDate", {
      header: "Due Date",
      cell: ({ row }) =>
        canEdit ? (
          <InlineDueDateCell
            task={row.original}
            onUpdateTask={onUpdateTask}
          />
        ) : (() => {
          const d = row.original.dueDate;
          if (!d)
            return <span className="text-muted-foreground text-xs">-</span>;
          const isOverdue =
            new Date(d) < new Date() && !row.original.status.isCompletion;
          return (
            <span
              className={cn(
                "text-xs",
                isOverdue && "text-destructive font-medium",
              )}
            >
              {d}
            </span>
          );
        })(),
      size: 120,
      enableSorting: false,
    }),

    // Dynamic custom field columns
    ...customFields.map((field) =>
      columnHelper.display({
        id: `cf_${field.id}`,
        header: field.name,
        cell: ({ row }) =>
          canEdit ? (
            <InlineCustomFieldCell task={row.original} field={field} />
          ) : (
            <CustomFieldDisplay task={row.original} field={field} />
          ),
        size: field.type === "TEXT" ? 160 : field.type === "CHECKBOX" ? 80 : 130,
        enableSorting: false,
      }),
    ),
  ];
}
