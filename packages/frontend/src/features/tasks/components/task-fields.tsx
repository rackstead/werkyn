import { useState } from "react";
import { isHttpUrl } from "@pm/shared";
import {
  useUpdateTask,
  useAddAssignee,
  useRemoveAssignee,
  useAddTaskLabel,
  useRemoveTaskLabel,
  type TaskDetail,
} from "../api";
import {
  useStatuses,
  useLabels,
  useProjectMembers,
  useCustomFields,
  useSetCustomFieldValue,
  type CustomField,
} from "@/features/projects/api";
import { PriorityBadge } from "@/components/shared/priority-badge";
import { UserAvatar } from "@/components/shared/user-avatar";
import { UserPicker } from "@/components/shared/user-picker";
import { LabelPicker } from "@/components/shared/label-picker";
import { DatePicker } from "@/components/shared/date-picker";
import { shouldSaveCustomFieldValue, type CustomFieldInput } from "../custom-field-save";
import { cn } from "@/lib/utils";

const PRIORITIES = ["NONE", "LOW", "MEDIUM", "HIGH", "URGENT"] as const;

interface TaskFieldsProps {
  task: TaskDetail;
  canEdit: boolean;
}

export function TaskFields({ task, canEdit }: TaskFieldsProps) {
  const updateTask = useUpdateTask();
  const addAssignee = useAddAssignee(task.id, task.projectId);
  const removeAssignee = useRemoveAssignee(task.id, task.projectId);
  const addLabel = useAddTaskLabel(task.id, task.projectId);
  const removeLabel = useRemoveTaskLabel(task.id, task.projectId);

  const { data: statusesData } = useStatuses(task.projectId);
  const { data: labelsData } = useLabels(task.projectId);
  const { data: membersData } = useProjectMembers(task.projectId);
  const { data: customFieldsData } = useCustomFields(task.projectId);
  const customFields = customFieldsData?.data ?? [];

  const statuses = statusesData?.data ?? [];
  const labels = labelsData?.data ?? [];
  const members = membersData?.data ?? [];

  const memberUsers = members.map((m) => ({
    id: m.user.id,
    displayName: m.user.displayName,
    avatarUrl: m.user.avatarUrl,
  }));

  return (
    <div className="space-y-4">
      {/* Status */}
      <Field label="Status">
        {canEdit ? (
          <select
            aria-label="Status"
            value={task.statusId}
            onChange={(e) =>
              updateTask.mutate({ id: task.id, statusId: e.target.value })
            }
            className="rounded-md border border-input bg-transparent px-2 py-1 text-sm"
          >
            {statuses.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        ) : (
          <span className="text-sm">{task.status.name}</span>
        )}
      </Field>

      {/* Priority */}
      <Field label="Priority">
        {canEdit ? (
          <div className="flex gap-2">
            {PRIORITIES.map((p) => (
              <PriorityBadge
                key={p}
                priority={p}
                pressed={task.priority === p}
                className={cn(
                  "cursor-pointer transition-shadow",
                  task.priority === p
                    ? "ring-2 ring-primary"
                    : "hover:opacity-80",
                )}
                onClick={() => updateTask.mutate({ id: task.id, priority: p })}
              />
            ))}
          </div>
        ) : (
          <PriorityBadge priority={task.priority} />
        )}
      </Field>

      {/* Assignees */}
      <Field label="Assignees">
        <div className="flex flex-wrap items-center gap-2">
          {task.assignees.map((a) => (
            <div
              key={a.userId}
              className="flex items-center gap-1 rounded-full bg-muted px-2 py-0.5"
            >
              <UserAvatar
                displayName={a.user.displayName}
                avatarUrl={a.user.avatarUrl}
                size="sm"
              />
              <span className="text-xs">{a.user.displayName}</span>
              {canEdit && (
                <button
                  type="button"
                  aria-label={`Remove assignee ${a.user.displayName}`}
                  onClick={() => removeAssignee.mutate(a.userId)}
                  className="ml-1 text-xs text-muted-foreground hover:text-foreground"
                >
                  x
                </button>
              )}
            </div>
          ))}
          {canEdit && (
            <UserPicker
              users={memberUsers}
              selectedIds={task.assignees.map((a) => a.userId)}
              onSelect={(uid) => addAssignee.mutate(uid)}
              onDeselect={(uid) => removeAssignee.mutate(uid)}
            />
          )}
        </div>
      </Field>

      {/* Labels */}
      <Field label="Labels">
        <div className="flex flex-wrap items-center gap-1">
          {task.labels.map((tl) => (
            <span
              key={tl.labelId}
              className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium text-white"
              style={{ backgroundColor: tl.label.color }}
            >
              {tl.label.name}
              {canEdit && (
                <button
                  type="button"
                  aria-label={`Remove label ${tl.label.name}`}
                  onClick={() => removeLabel.mutate(tl.labelId)}
                  className="ml-0.5 hover:opacity-70"
                >
                  x
                </button>
              )}
            </span>
          ))}
          {canEdit && (
            <LabelPicker
              labels={labels}
              selectedIds={task.labels.map((tl) => tl.labelId)}
              onSelect={(lid) => addLabel.mutate(lid)}
              onDeselect={(lid) => removeLabel.mutate(lid)}
            />
          )}
        </div>
      </Field>

      {/* Start Date */}
      <Field label="Start date">
        {canEdit ? (
          <DatePicker
            label="Start date"
            value={task.startDate}
            onChange={(date) =>
              updateTask.mutate({ id: task.id, startDate: date })
            }
            className="max-w-[200px]"
          />
        ) : (
          <span className="text-sm">
            {task.startDate ?? "No start date"}
          </span>
        )}
      </Field>

      {/* Due Date */}
      <Field label="Due date">
        {canEdit ? (
          <DatePicker
            label="Due date"
            value={task.dueDate}
            onChange={(date) =>
              updateTask.mutate({ id: task.id, dueDate: date })
            }
            className="max-w-[200px]"
          />
        ) : (
          <span className="text-sm">
            {task.dueDate ?? "No due date"}
          </span>
        )}
      </Field>

      {/* Custom Fields */}
      {customFields.map((field) => (
        <Field key={field.id} label={field.name}>
          {canEdit ? (
            <InlineCustomFieldEditor field={field} task={task} />
          ) : (
            <CustomFieldDisplayValue field={field} task={task} />
          )}
        </Field>
      ))}
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-4">
      <span className="w-24 shrink-0 text-sm text-muted-foreground pt-1">
        {label}
      </span>
      <div className="flex-1">{children}</div>
    </div>
  );
}

function CustomFieldDisplayValue({
  field,
  task,
}: {
  field: CustomField;
  task: TaskDetail;
}) {
  const cfv = task.customFieldValues?.find((v) => v.fieldId === field.id);
  const value = cfv?.value;

  if (value === undefined || value === null) {
    return <span className="text-sm text-muted-foreground">-</span>;
  }

  switch (field.type) {
    case "CHECKBOX":
      return <span className="text-sm">{value ? "Yes" : "No"}</span>;
    case "SELECT":
      return <span className="text-sm">{String(value)}</span>;
    case "MULTI_SELECT":
      return (
        <span className="text-sm">
          {Array.isArray(value) ? value.join(", ") : String(value)}
        </span>
      );
    case "URL":
      // Only http(s) values are links; values saved before URL fields were
      // checked may use other schemes such as javascript: or data:.
      if (!isHttpUrl(String(value))) {
        return <span className="text-sm">{String(value)}</span>;
      }
      return (
        <a
          href={String(value)}
          target="_blank"
          rel="noopener noreferrer"
          className="text-sm text-primary hover:underline"
        >
          {String(value)}
        </a>
      );
    default:
      return <span className="text-sm">{String(value)}</span>;
  }
}

function InlineCustomFieldEditor({
  field,
  task,
}: {
  field: CustomField;
  task: TaskDetail;
}) {
  const setFieldValue = useSetCustomFieldValue(task.id, task.projectId);
  const cfv = task.customFieldValues?.find((v) => v.fieldId === field.id);
  const value = cfv?.value;

  // Returns false when nothing was sent (no change, or a required field left
  // empty); text inputs then show the stored value again.
  const save = (newValue: CustomFieldInput) => {
    if (!shouldSaveCustomFieldValue(field, value, newValue)) return false;
    setFieldValue.mutate({ fieldId: field.id, value: newValue });
    return true;
  };
  const saveInput = (input: HTMLInputElement, newValue: CustomFieldInput) => {
    if (!save(newValue)) {
      input.value = typeof value === "string" || typeof value === "number" ? String(value) : "";
    }
  };

  switch (field.type) {
    case "CHECKBOX":
      return (
        <input
          type="checkbox"
          aria-label={field.name}
          checked={!!value}
          onChange={(e) => save(e.target.checked)}
          className="h-4 w-4 rounded border-input accent-primary cursor-pointer"
        />
      );

    case "SELECT":
      return (
        <select
          aria-label={field.name}
          value={typeof value === "string" ? value : ""}
          onChange={(e) => save(e.target.value || null)}
          className="rounded-md border border-input bg-transparent px-2 py-1 text-sm"
        >
          <option value="">-</option>
          {field.options?.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.value}
            </option>
          ))}
        </select>
      );

    case "MULTI_SELECT": {
      const selectedVals = Array.isArray(value) ? (value as string[]) : [];
      return (
        <div className="flex flex-wrap gap-1">
          {field.options?.map((opt) => {
            const selected = selectedVals.includes(opt.value);
            return (
              <button
                key={opt.value}
                type="button"
                aria-pressed={selected}
                onClick={() => {
                  const next = selected
                    ? selectedVals.filter((v) => v !== opt.value)
                    : [...selectedVals, opt.value];
                  save(next.length > 0 ? next : null);
                }}
                className={cn(
                  "rounded-full px-2 py-0.5 text-xs font-medium transition-colors",
                  selected
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted text-muted-foreground hover:bg-accent",
                )}
              >
                {opt.value}
              </button>
            );
          })}
        </div>
      );
    }

    case "DATE":
      return (
        <DatePicker
          label={field.name}
          value={typeof value === "string" ? value : null}
          onChange={(date) => save(date)}
          className="max-w-[200px]"
        />
      );

    case "NUMBER":
      return (
        <input
          type="number"
          aria-label={field.name}
          aria-required={field.required}
          defaultValue={typeof value === "number" ? value : ""}
          onBlur={(e) => {
            const v = e.target.value;
            saveInput(e.target, v === "" ? null : Number(v));
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              const input = e.target as HTMLInputElement;
              saveInput(input, input.value === "" ? null : Number(input.value));
            }
          }}
          className="rounded-md border border-input bg-transparent px-2 py-1 text-sm max-w-[200px]"
        />
      );

    case "URL":
    case "TEXT":
    default:
      return (
        <input
          type={field.type === "URL" ? "url" : "text"}
          aria-label={field.name}
          aria-required={field.required}
          defaultValue={typeof value === "string" ? value : ""}
          onBlur={(e) => saveInput(e.target, e.target.value || null)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              const input = e.target as HTMLInputElement;
              saveInput(input, input.value || null);
            }
          }}
          className="rounded-md border border-input bg-transparent px-2 py-1 text-sm w-full"
          placeholder={field.type === "URL" ? "https://..." : ""}
        />
      );
  }
}
