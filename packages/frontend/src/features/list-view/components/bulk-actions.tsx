import { useState } from "react";
import { committedDate } from "@/lib/date-input";
import { useBulkUpdateTasks, useBulkDeleteTasks } from "@/features/tasks/api";
import { useStatuses, useProjectMembers, useLabels } from "@/features/projects/api";
import { ConfirmDialog } from "@/components/shared/confirm-dialog";
import { Button } from "@/components/ui/button";
import { X, Archive, Trash2 } from "lucide-react";

interface BulkActionsProps {
  projectId: string;
  selectedTaskIds: string[];
  onClear: () => void;
  canDelete?: boolean;
}

const priorities = ["NONE", "LOW", "MEDIUM", "HIGH", "URGENT"] as const;

export function BulkActions({
  projectId,
  selectedTaskIds,
  onClear,
  canDelete = false,
}: BulkActionsProps) {
  const bulkUpdate = useBulkUpdateTasks(projectId);
  const bulkDelete = useBulkDeleteTasks(projectId);
  const { data: statusData } = useStatuses(projectId);
  const { data: memberData } = useProjectMembers(projectId);
  const { data: labelData } = useLabels(projectId);

  const [showArchiveConfirm, setShowArchiveConfirm] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  const statuses = statusData?.data ?? [];
  const members = memberData?.data ?? [];
  const labels = labelData?.data ?? [];
  const count = selectedTaskIds.length;

  const handleUpdate = (data: {
    statusId?: string;
    priority?: (typeof priorities)[number];
    assigneeIds?: string[];
    archived?: boolean;
    labelIds?: string[];
    dueDate?: string | null;
  }) => {
    bulkUpdate.mutate(
      { taskIds: selectedTaskIds, ...data },
      { onSuccess: () => onClear() },
    );
  };

  return (
    <>
      <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-30 flex items-center gap-3 rounded-lg border bg-background px-4 py-3 shadow-lg">
        <span className="text-sm font-medium">
          {count} task{count !== 1 ? "s" : ""} selected
          {count > 50 && (
            <span className="ml-1 text-xs text-destructive">(max 50)</span>
          )}
        </span>

        {/* Change Status */}
        <select
          defaultValue=""
          onChange={(e) => {
            if (e.target.value) handleUpdate({ statusId: e.target.value });
            e.target.value = "";
          }}
          disabled={bulkUpdate.isPending}
          className="h-8 rounded-md border border-input bg-transparent px-2 text-sm"
        >
          <option value="" disabled>
            Change status
          </option>
          {statuses.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>

        {/* Change Priority */}
        <select
          defaultValue=""
          onChange={(e) => {
            if (e.target.value)
              handleUpdate({ priority: e.target.value as (typeof priorities)[number] });
            e.target.value = "";
          }}
          disabled={bulkUpdate.isPending}
          className="h-8 rounded-md border border-input bg-transparent px-2 text-sm"
        >
          <option value="" disabled>
            Change priority
          </option>
          {priorities.map((p) => (
            <option key={p} value={p}>
              {p.charAt(0) + p.slice(1).toLowerCase()}
            </option>
          ))}
        </select>

        {/* Assign */}
        <select
          defaultValue=""
          onChange={(e) => {
            if (e.target.value) handleUpdate({ assigneeIds: [e.target.value] });
            e.target.value = "";
          }}
          disabled={bulkUpdate.isPending}
          className="h-8 rounded-md border border-input bg-transparent px-2 text-sm"
        >
          <option value="" disabled>
            Assign to
          </option>
          {members.map((m) => (
            <option key={m.user.id} value={m.user.id}>
              {m.user.displayName}
            </option>
          ))}
        </select>

        {/* Set Label */}
        <select
          defaultValue=""
          onChange={(e) => {
            const val = e.target.value;
            if (val === "__clear__") {
              handleUpdate({ labelIds: [] });
            } else if (val) {
              handleUpdate({ labelIds: [val] });
            }
            e.target.value = "";
          }}
          disabled={bulkUpdate.isPending}
          className="h-8 rounded-md border border-input bg-transparent px-2 text-sm"
        >
          <option value="" disabled>
            Set label
          </option>
          <option value="__clear__">Clear labels</option>
          {labels.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </select>

        {/* Set Due Date */}
        <div className="flex items-center gap-1">
          <input
            type="date"
            onChange={(e) => {
              // Only a complete date is applied, not a year still being typed.
              const dueDate = committedDate(e.target.value);
              if (dueDate) handleUpdate({ dueDate });
            }}
            disabled={bulkUpdate.isPending}
            className="h-8 rounded-md border border-input bg-transparent px-2 text-sm"
          />
          <button
            onClick={() => handleUpdate({ dueDate: null })}
            disabled={bulkUpdate.isPending}
            className="rounded-md px-1.5 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
            title="Clear due date"
          >
            Clear
          </button>
        </div>

        {/* Archive */}
        {canDelete && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowArchiveConfirm(true)}
            disabled={bulkUpdate.isPending}
          >
            <Archive className="h-4 w-4 mr-1" />
            Archive
          </Button>
        )}

        {/* Delete */}
        {canDelete && (
          <Button
            variant="destructive"
            size="sm"
            onClick={() => setShowDeleteConfirm(true)}
            disabled={bulkDelete.isPending}
          >
            <Trash2 className="h-4 w-4 mr-1" />
            Delete
          </Button>
        )}

        <button
          onClick={onClear}
          className="rounded-md p-1 hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
          title="Clear selection"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <ConfirmDialog
        open={showArchiveConfirm}
        onClose={() => setShowArchiveConfirm(false)}
        onConfirm={() => {
          handleUpdate({ archived: true });
          setShowArchiveConfirm(false);
        }}
        title={`Archive ${count} task${count !== 1 ? "s" : ""}?`}
        description="Archived tasks can be restored later from the archived view."
        confirmLabel="Archive"
        variant="default"
        loading={bulkUpdate.isPending}
      />

      <ConfirmDialog
        open={showDeleteConfirm}
        onClose={() => setShowDeleteConfirm(false)}
        onConfirm={() => {
          bulkDelete.mutate(
            { taskIds: selectedTaskIds },
            {
              onSuccess: () => {
                setShowDeleteConfirm(false);
                onClear();
              },
            },
          );
        }}
        title={`Delete ${count} task${count !== 1 ? "s" : ""} permanently?`}
        description="This action cannot be undone. All task data including comments, subtasks, and activity logs will be permanently deleted."
        confirmLabel="Delete"
        variant="destructive"
        loading={bulkDelete.isPending}
      />
    </>
  );
}
