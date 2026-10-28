import { useState, useEffect } from "react";
import { useCreateTask } from "../api";
import { useStatuses, useLabels, useProjectMembers } from "@/features/projects/api";
import { useTemplates, useCreateTaskFromTemplate } from "@/features/templates/api";
import type { TaskTemplate } from "@/features/templates/api";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DatePicker } from "@/components/shared/date-picker";
import { UserPicker } from "@/components/shared/user-picker";
import { LabelPicker } from "@/components/shared/label-picker";
import { cn } from "@/lib/utils";
import { ChevronDown, ChevronUp } from "lucide-react";
import type { CreateTaskInput } from "@pm/shared";

const PRIORITIES = ["NONE", "LOW", "MEDIUM", "HIGH", "URGENT"] as const;

const priorityStyles: Record<string, string> = {
  NONE: "bg-gray-50 text-gray-400 dark:bg-gray-800/50 dark:text-gray-500",
  LOW: "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300",
  MEDIUM: "bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300",
  HIGH: "bg-orange-100 text-orange-700 dark:bg-orange-900 dark:text-orange-300",
  URGENT: "bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300",
};

interface CreateTaskDialogProps {
  open: boolean;
  onClose: () => void;
  projectId: string;
  defaultStatusId?: string;
  defaultDueDate?: string;
  defaultStartDate?: string;
}

export function CreateTaskDialog({
  open,
  onClose,
  projectId,
  defaultStatusId,
  defaultDueDate,
  defaultStartDate,
}: CreateTaskDialogProps) {
  const createTask = useCreateTask(projectId);
  const createFromTemplate = useCreateTaskFromTemplate(projectId);
  const { data: statusesData } = useStatuses(projectId);
  const { data: labelsData } = useLabels(projectId);
  const { data: membersData } = useProjectMembers(projectId);
  const { data: templatesData } = useTemplates(projectId);

  const statuses = statusesData?.data ?? [];
  const labels = labelsData?.data ?? [];
  const members = (membersData?.data ?? []).map((m) => m.user);
  const templates = templatesData?.data ?? [];

  const [selectedTemplateId, setSelectedTemplateId] = useState("");
  const [title, setTitle] = useState("");
  const [statusId, setStatusId] = useState(defaultStatusId ?? "");
  const [priority, setPriority] = useState<CreateTaskInput["priority"]>("NONE");
  const [startDate, setStartDate] = useState<string | null>(null);
  const [dueDate, setDueDate] = useState<string | null>(null);
  const [assigneeIds, setAssigneeIds] = useState<string[]>([]);
  const [labelIds, setLabelIds] = useState<string[]>([]);
  const [showMore, setShowMore] = useState(false);

  const firstStatusId = statuses[0]?.id ?? "";

  // Reset form when dialog opens/closes
  useEffect(() => {
    if (open) {
      setSelectedTemplateId("");
      setTitle("");
      setStatusId(defaultStatusId ?? firstStatusId);
      setPriority("NONE");
      setStartDate(defaultStartDate ?? null);
      setDueDate(defaultDueDate ?? null);
      setAssigneeIds([]);
      setLabelIds([]);
      setShowMore(!!(defaultStartDate || defaultDueDate));
    }
  }, [open, defaultStatusId, firstStatusId, defaultDueDate, defaultStartDate]);

  const handleTemplateSelect = (templateId: string) => {
    setSelectedTemplateId(templateId);
    if (!templateId) return;
    const t = templates.find((t) => t.id === templateId);
    if (!t) return;
    setTitle(t.title);
    setPriority(t.priority);
    if (t.statusId) setStatusId(t.statusId);
    setAssigneeIds(t.assigneeIds);
    setLabelIds(t.labelIds);
    setShowMore(true);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;

    if (selectedTemplateId) {
      createFromTemplate.mutate(
        {
          templateId: selectedTemplateId,
          title: title.trim(),
          ...(statusId && { statusId }),
          ...(assigneeIds.length > 0 && { assigneeIds }),
          ...(startDate && { startDate }),
          ...(dueDate && { dueDate }),
        },
        { onSuccess: () => onClose() },
      );
    } else {
      const data: CreateTaskInput = {
        title: title.trim(),
        priority,
        ...(statusId && { statusId }),
        ...(startDate && { startDate }),
        ...(dueDate && { dueDate }),
        ...(assigneeIds.length > 0 && { assigneeIds }),
        ...(labelIds.length > 0 && { labelIds }),
      };

      createTask.mutate(data, {
        onSuccess: () => onClose(),
      });
    }
  };

  const isPending = createTask.isPending || createFromTemplate.isPending;
  const isError = createTask.isError || createFromTemplate.isError;

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>Create task</DialogTitle>
          </DialogHeader>

          <div className="mt-4 space-y-4">
            {/* Template selector */}
            {templates.length > 0 && (
              <div className="space-y-2">
                <Label htmlFor="task-template">From template</Label>
                <select
                  id="task-template"
                  value={selectedTemplateId}
                  onChange={(e) => handleTemplateSelect(e.target.value)}
                  className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                >
                  <option value="">None (blank task)</option>
                  {templates.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {/* Title */}
            <div className="space-y-2">
              <Label htmlFor="task-title">Title</Label>
              <Input
                id="task-title"
                placeholder="Task title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                autoFocus
              />
            </div>

            {/* More options toggle */}
            <button
              type="button"
              onClick={() => setShowMore(!showMore)}
              className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
            >
              {showMore ? (
                <ChevronUp className="h-4 w-4" />
              ) : (
                <ChevronDown className="h-4 w-4" />
              )}
              More options
            </button>

            {showMore && (
              <div className="space-y-4">
                {/* Status */}
                <div className="space-y-2">
                  <Label htmlFor="task-status">Status</Label>
                  <select
                    id="task-status"
                    value={statusId}
                    onChange={(e) => setStatusId(e.target.value)}
                    className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  >
                    {statuses.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                </div>

                {/* Priority */}
                <div className="space-y-2">
                  <Label>Priority</Label>
                  <div className="flex gap-2">
                    {PRIORITIES.map((p) => (
                      <button
                        key={p}
                        type="button"
                        onClick={() => setPriority(p)}
                        className={cn(
                          "rounded-full px-3 py-1 text-xs font-medium transition-all",
                          priorityStyles[p],
                          priority === p
                            ? "ring-2 ring-offset-1 ring-primary"
                            : "opacity-60 hover:opacity-100",
                        )}
                      >
                        {p[0] + p.slice(1).toLowerCase()}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Start date */}
                <div className="space-y-2">
                  <Label>Start date</Label>
                  <DatePicker value={startDate} onChange={setStartDate} />
                </div>

                {/* Due date */}
                <div className="space-y-2">
                  <Label>Due date</Label>
                  <DatePicker value={dueDate} onChange={setDueDate} />
                </div>

                {/* Assignees */}
                <div className="space-y-2">
                  <Label>Assignees</Label>
                  <div className="flex items-center gap-2 flex-wrap">
                    {assigneeIds.map((id) => {
                      const user = members.find((u) => u.id === id);
                      if (!user) return null;
                      return (
                        <span
                          key={id}
                          className="inline-flex items-center gap-1 rounded-full bg-secondary px-2 py-0.5 text-xs"
                        >
                          {user.displayName}
                          <button
                            type="button"
                            onClick={() =>
                              setAssigneeIds((prev) =>
                                prev.filter((a) => a !== id),
                              )
                            }
                            className="ml-0.5 hover:text-destructive"
                          >
                            &times;
                          </button>
                        </span>
                      );
                    })}
                    <UserPicker
                      users={members}
                      selectedIds={assigneeIds}
                      onSelect={(id) =>
                        setAssigneeIds((prev) => [...prev, id])
                      }
                      onDeselect={(id) =>
                        setAssigneeIds((prev) =>
                          prev.filter((a) => a !== id),
                        )
                      }
                    />
                  </div>
                </div>

                {/* Labels */}
                <div className="space-y-2">
                  <Label>Labels</Label>
                  <div className="flex items-center gap-2 flex-wrap">
                    {labelIds.map((id) => {
                      const label = labels.find((l) => l.id === id);
                      if (!label) return null;
                      return (
                        <span
                          key={id}
                          className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium text-white"
                          style={{ backgroundColor: label.color }}
                        >
                          {label.name}
                          <button
                            type="button"
                            onClick={() =>
                              setLabelIds((prev) =>
                                prev.filter((l) => l !== id),
                              )
                            }
                            className="ml-0.5 hover:opacity-70"
                          >
                            &times;
                          </button>
                        </span>
                      );
                    })}
                    <LabelPicker
                      labels={labels}
                      selectedIds={labelIds}
                      onSelect={(id) =>
                        setLabelIds((prev) => [...prev, id])
                      }
                      onDeselect={(id) =>
                        setLabelIds((prev) =>
                          prev.filter((l) => l !== id),
                        )
                      }
                    />
                  </div>
                </div>
              </div>
            )}
          </div>

          {isError && (
            <p className="mt-2 text-sm text-destructive">
              Failed to create task. Please try again.
            </p>
          )}

          <DialogFooter className="mt-6">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={!title.trim() || isPending}
            >
              {isPending ? "Creating..." : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
