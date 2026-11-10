import { useRef, useState } from "react";
import { stripDisallowedControlCharacters, type UpdateTemplateInput } from "@pm/shared";
import { identityGeneration } from "@/lib/identity";
import {
  useTemplates,
  useCreateTemplate,
  useUpdateTemplate,
  useDeleteTemplate,
} from "../api";
import type { TaskTemplate } from "../api";
import { useStatuses, useLabels, useProjectMembers } from "@/features/projects/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ConfirmDialog } from "@/components/shared/confirm-dialog";
import { UserPicker } from "@/components/shared/user-picker";
import { LabelPicker } from "@/components/shared/label-picker";
import { cn } from "@/lib/utils";
import { Plus, Trash2, Pencil, X } from "lucide-react";

const PRIORITIES = ["NONE", "LOW", "MEDIUM", "HIGH", "URGENT"] as const;

const priorityStyles: Record<string, string> = {
  NONE: "bg-gray-50 text-gray-400 dark:bg-gray-800/50 dark:text-gray-500",
  LOW: "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300",
  MEDIUM: "bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300",
  HIGH: "bg-orange-100 text-orange-700 dark:bg-orange-900 dark:text-orange-300",
  URGENT: "bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300",
};

const NO_STATUS = "__none__";

interface TemplateManagerProps {
  projectId: string;
}

interface TemplateFormData {
  name: string;
  title: string;
  description: string;
  priority: "NONE" | "LOW" | "MEDIUM" | "HIGH" | "URGENT";
  statusId: string;
  dueOffset: string;
  assigneeIds: string[];
  labelIds: string[];
  subtasks: Array<{ title: string }>;
}

interface TemplateEdit {
  id: string;
  projectId: string;
  generation: number;
  initial: TemplateFormData;
  values: TemplateFormData;
  descriptionPieces: string[];
}

function sameOrderedIds(left: string[], right: string[]) {
  return left.length === right.length && left.every((id, i) => id === right[i]);
}

// One pass over the entities sanitize-html writes. Apostrophes are stored as
// characters. pieces[i] is the stored spelling of text[i]. Not an HTML parse:
// tags and NULs stay. A second pass would decode &amp;amp; again.
function decodeTemplateDescription(value: string): { text: string; pieces: string[] } {
  const pieces: string[] = [];
  let text = "";
  const entities = /&(?:amp|lt|gt|quot);/g;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = entities.exec(value)) !== null) {
    for (let i = last; i < match.index; i++) {
      pieces.push(value[i]);
      text += value[i];
    }
    const entity = match[0];
    pieces.push(entity);
    text += entity === "&amp;" ? "&" : entity === "&lt;" ? "<" : entity === "&gt;" ? ">" : "\"";
    last = match.index + entity.length;
  }
  for (let i = last; i < value.length; i++) {
    pieces.push(value[i]);
    text += value[i];
  }
  return { text, pieces };
}

function findAll(haystack: string, needle: string, from = 0): number[] {
  const found: number[] = [];
  if (!needle) return found;
  let at = haystack.indexOf(needle, from);
  while (at !== -1) {
    found.push(at);
    at = haystack.indexOf(needle, at + 1);
  }
  return found;
}

// Longest stored slice at `index` that still occurs in the edited text.
// A longer slice matches a code sample and not a new tag typed in front of it.
function matchingPrefix(decoded: string, index: number, edited: string): { length: number; positions: number[] } {
  const max = Math.min(32, decoded.length - index);
  let lo = 1;
  let hi = max;
  let bestLength = 0;
  let bestPositions: number[] = [];
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const positions = findAll(edited, decoded.slice(index, index + mid));
    if (positions.length > 0) {
      bestLength = mid;
      bestPositions = positions;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return { length: bestLength, positions: bestPositions };
}

// Runs only when a changed description is submitted, not while the editor renders.
// Every edited occurrence of an unchanged bracket or quote context keeps the
// stored spelling, including a second pasted copy and an insertion of any length.
// A mark whose own context changed is tied to the nearest partner that did match.
function descriptionForEdit(pieces: string[], decoded: string, edited: string): string {
  if (pieces.length !== decoded.length || edited === decoded) return edited;
  const anchors: number[] = [];
  for (let i = 0; i < pieces.length; i++) {
    const piece = pieces[i];
    if (piece === "&lt;" || piece === "&gt;" || piece === "&quot;") anchors.push(i);
  }
  if (anchors.length === 0) return edited;
  const replacements = new Map<number, string>();
  const placed = new Map<number, number[]>();
  for (const index of anchors) {
    const match = matchingPrefix(decoded, index, edited);
    // A single bare bracket is not distinctive enough to stamp onto every copy.
    const positions = match.length >= 2 || match.positions.length === 1 ? match.positions : [];
    placed.set(index, positions);
    for (const at of positions) replacements.set(at, pieces[index]);
  }
  const nearest = (from: number, mark: string, step: -1 | 1): number => {
    for (let at = from; at >= 0 && at < edited.length; at += step) {
      if (edited[at] === mark && !replacements.has(at)) return at;
    }
    return -1;
  };
  for (let a = 0; a < anchors.length; a++) {
    const index = anchors[a];
    if ((placed.get(index) ?? []).length > 0) continue;
    const mark = decoded[index];
    const partner = mark === "<" ? ">" : mark === ">" ? "<" : "\"";
    const directions: Array<-1 | 1> = mark === "\"" ? [-1, 1] : mark === ">" ? [-1] : [1];
    for (const dir of directions) {
      let partnerIndex = -1;
      for (let b = a + dir; b >= 0 && b < anchors.length; b += dir) {
        if (decoded[anchors[b]] === partner) { partnerIndex = anchors[b]; break; }
      }
      if (partnerIndex === -1) continue;
      for (const partnerAt of placed.get(partnerIndex) ?? []) {
        const at = nearest(partnerAt + dir, mark, dir);
        if (at !== -1) replacements.set(at, pieces[index]);
      }
    }
  }
  if (replacements.size === 0) return edited;
  let out = "";
  for (let i = 0; i < edited.length; i++) out += replacements.get(i) ?? edited[i];
  return out;
}

/** Compare the raw edit snapshot before applying the existing encodings. */
function templateChanges(form: TemplateFormData, initial: TemplateFormData): UpdateTemplateInput {
  const changes: UpdateTemplateInput = {};
  if (form.name !== initial.name) changes.name = form.name.trim();
  if (form.title !== initial.title) changes.title = form.title.trim();
  // Equality is the one-pass display decode, so an unedited legacy entity
  // string is omitted. The stored spelling is applied at submit, not here.
  if (form.description !== initial.description)
    changes.description = stripDisallowedControlCharacters(form.description) || null;
  if (form.priority !== initial.priority) changes.priority = form.priority;
  if (form.statusId !== initial.statusId) changes.statusId = form.statusId || null;
  if (form.dueOffset !== initial.dueOffset)
    changes.dueOffset = form.dueOffset ? parseInt(form.dueOffset, 10) : null;
  if (!sameOrderedIds(form.assigneeIds, initial.assigneeIds)) changes.assigneeIds = form.assigneeIds;
  if (!sameOrderedIds(form.labelIds, initial.labelIds)) changes.labelIds = form.labelIds;
  // The UI appends new rows. Blank drafts must not rewrite raw legacy rows.
  const unchangedSubtasks = form.subtasks.length >= initial.subtasks.length &&
    initial.subtasks.every((subtask, i) => form.subtasks[i].title === subtask.title) &&
    form.subtasks.slice(initial.subtasks.length).every((subtask) => !subtask.title.trim());
  if (!unchangedSubtasks) changes.subtasks = form.subtasks.filter((s) => s.title.trim());
  return changes;
}

const emptyForm: TemplateFormData = {
  name: "",
  title: "",
  description: "",
  priority: "NONE",
  statusId: "",
  dueOffset: "",
  assigneeIds: [],
  labelIds: [],
  subtasks: [],
};

function TemplateForm({
  form,
  setForm,
  statuses,
  labels,
  members,
}: {
  form: TemplateFormData;
  setForm: (f: TemplateFormData) => void;
  statuses: Array<{ id: string; name: string }>;
  labels: Array<{ id: string; name: string; color: string }>;
  members: Array<{ id: string; displayName: string; avatarUrl: string | null }>;
}) {
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <Label className="text-xs">Template name</Label>
          <Input
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            placeholder="e.g. Bug report"
            className="h-8 text-sm"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Task title</Label>
          <Input
            value={form.title}
            onChange={(e) => setForm({ ...form, title: e.target.value })}
            placeholder="e.g. Fix: ..."
            className="h-8 text-sm"
          />
        </div>
      </div>

      <div className="space-y-1">
        <Label className="text-xs">Description</Label>
        <Textarea
          value={form.description}
          onChange={(e) => setForm({ ...form, description: e.target.value })}
          placeholder="Task description..."
          className="min-h-[60px]"
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <Label className="text-xs">Status</Label>
          <Select
            value={form.statusId || NO_STATUS}
            onValueChange={(v) => setForm({ ...form, statusId: v === NO_STATUS ? "" : v })}
          >
            <SelectTrigger className="h-8">
              <SelectValue placeholder="Default (first column)" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NO_STATUS}>Default (first column)</SelectItem>
              {statuses.map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {s.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Due offset (days)</Label>
          <Input
            type="number"
            min="0"
            max="3650"
            value={form.dueOffset}
            onChange={(e) => setForm({ ...form, dueOffset: e.target.value })}
            placeholder="No due date"
            className="h-8 text-sm"
          />
        </div>
      </div>

      <div className="space-y-1">
        <Label className="text-xs">Priority</Label>
        <div className="flex gap-1.5">
          {PRIORITIES.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => setForm({ ...form, priority: p })}
              className={cn(
                "rounded-full px-2.5 py-0.5 text-xs font-medium transition-all",
                priorityStyles[p],
                form.priority === p
                  ? "ring-2 ring-offset-1 ring-primary"
                  : "opacity-60 hover:opacity-100",
              )}
            >
              {p[0] + p.slice(1).toLowerCase()}
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-1">
        <Label className="text-xs">Assignees</Label>
        <div className="flex items-center gap-1.5 flex-wrap">
          {form.assigneeIds.map((id) => {
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
                    setForm({
                      ...form,
                      assigneeIds: form.assigneeIds.filter((a) => a !== id),
                    })
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
            selectedIds={form.assigneeIds}
            onSelect={(id) =>
              setForm({ ...form, assigneeIds: [...form.assigneeIds, id] })
            }
            onDeselect={(id) =>
              setForm({
                ...form,
                assigneeIds: form.assigneeIds.filter((a) => a !== id),
              })
            }
          />
        </div>
      </div>

      <div className="space-y-1">
        <Label className="text-xs">Labels</Label>
        <div className="flex items-center gap-1.5 flex-wrap">
          {form.labelIds.map((id) => {
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
                    setForm({
                      ...form,
                      labelIds: form.labelIds.filter((l) => l !== id),
                    })
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
            selectedIds={form.labelIds}
            onSelect={(id) =>
              setForm({ ...form, labelIds: [...form.labelIds, id] })
            }
            onDeselect={(id) =>
              setForm({
                ...form,
                labelIds: form.labelIds.filter((l) => l !== id),
              })
            }
          />
        </div>
      </div>

      <div className="space-y-1">
        <Label className="text-xs">Subtasks</Label>
        <div className="space-y-1.5">
          {form.subtasks.map((st, i) => (
            <div key={i} className="flex items-center gap-1.5">
              <Input
                value={st.title}
                onChange={(e) => {
                  const updated = [...form.subtasks];
                  updated[i] = { title: e.target.value };
                  setForm({ ...form, subtasks: updated });
                }}
                placeholder={`Subtask ${i + 1}`}
                className="h-7 text-sm"
              />
              <button
                type="button"
                onClick={() =>
                  setForm({
                    ...form,
                    subtasks: form.subtasks.filter((_, j) => j !== i),
                  })
                }
                className="text-muted-foreground hover:text-destructive shrink-0"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
          <button
            type="button"
            onClick={() =>
              setForm({
                ...form,
                subtasks: [...form.subtasks, { title: "" }],
              })
            }
            className="text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            + Add subtask
          </button>
        </div>
      </div>
    </div>
  );
}

function templateToForm(t: TaskTemplate): { form: TemplateFormData; descriptionPieces: string[] } {
  const description = decodeTemplateDescription(t.description ?? "");
  return {
    descriptionPieces: description.pieces,
    form: {
      name: t.name,
      title: t.title,
      description: description.text,
      priority: t.priority,
      statusId: t.statusId ?? "",
      dueOffset: t.dueOffset !== null ? String(t.dueOffset) : "",
      assigneeIds: t.assigneeIds,
      labelIds: t.labelIds,
      subtasks: t.subtasks,
    },
  };
}

export function TemplateManager({ projectId }: TemplateManagerProps) {
  const { data } = useTemplates(projectId);
  const createTemplate = useCreateTemplate(projectId);
  const updateTemplate = useUpdateTemplate(projectId);
  const deleteTemplate = useDeleteTemplate(projectId);
  const { data: statusesData } = useStatuses(projectId);
  const { data: labelsData } = useLabels(projectId);
  const { data: membersData } = useProjectMembers(projectId);

  const templates = data?.data ?? [];
  const statuses = statusesData?.data ?? [];
  const labels = labelsData?.data ?? [];
  const members = (membersData?.data ?? []).map((m) => m.user);

  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState<TemplateFormData>(emptyForm);
  const [edit, setEdit] = useState<TemplateEdit | null>(null);
  const currentProject = useRef(projectId);
  currentProject.current = projectId;
  const currentEdit = useRef(edit);
  currentEdit.current = edit;
  const generation = identityGeneration();
  const editChanges = edit ? templateChanges(edit.values, edit.initial) : {};
  const invalidChangedTitle = editChanges.title !== undefined && !editChanges.title;
  const invalidChangedName = editChanges.name !== undefined && !editChanges.name;
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);

  const handleCreate = () => {
    if (!form.name.trim() || !form.title.trim()) return;
    createTemplate.mutate(
      {
        name: form.name.trim(),
        title: form.title.trim(),
        description: stripDisallowedControlCharacters(form.description) || undefined,
        priority: form.priority,
        statusId: form.statusId || undefined,
        dueOffset: form.dueOffset ? parseInt(form.dueOffset, 10) : undefined,
        assigneeIds: form.assigneeIds,
        labelIds: form.labelIds,
        subtasks: form.subtasks.filter((s) => s.title.trim()),
      },
      {
        onSuccess: () => {
          setForm(emptyForm);
          setShowCreate(false);
        },
      },
    );
  };

  const handleEditChange = (values: TemplateFormData) => {
    setEdit((current) => {
      if (
        !current || current.initial !== edit?.initial ||
        current.projectId !== currentProject.current ||
        current.generation !== identityGeneration()
      ) return current;
      return { ...current, values };
    });
  };

  const handleUpdate = () => {
    if (
      !edit || currentEdit.current?.initial !== edit.initial ||
      edit.projectId !== currentProject.current || edit.generation !== identityGeneration() ||
      Object.keys(editChanges).length === 0 || invalidChangedName || invalidChangedTitle
    ) return;
    const changes = { ...editChanges };
    if (changes.description !== undefined) {
      changes.description = stripDisallowedControlCharacters(
        descriptionForEdit(edit.descriptionPieces, edit.initial.description, edit.values.description),
      ) || null;
    }
    updateTemplate.mutate(
      { id: edit.id, ...changes },
      {
        onSuccess: () => {
          // Keep the existing close-on-success policy, including pending edits.
          // A completion for an older editor must not close a newly opened one.
          if (edit.generation !== identityGeneration()) return;
          setEdit((current) => current?.initial === edit.initial ? null : current);
        },
      },
    );
  };

  return (
    <div className="space-y-3">
      <h3 className="text-sm font-semibold">Templates</h3>

      <div className="space-y-2">
        {templates.map((t) => (
          <div
            key={t.id}
            className="rounded-md border px-3 py-2"
          >
            {edit?.id === t.id && edit.projectId === projectId && edit.generation === generation ? (
              <div className="space-y-3">
                <TemplateForm
                  form={edit.values}
                  setForm={handleEditChange}
                  statuses={statuses}
                  labels={labels}
                  members={members}
                />
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    onClick={handleUpdate}
                    disabled={
                      Object.keys(editChanges).length === 0 ||
                      invalidChangedName || invalidChangedTitle ||
                      updateTemplate.isPending
                    }
                  >
                    {updateTemplate.isPending ? "Saving..." : "Save"}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setEdit(null)}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium truncate">{t.name}</div>
                  <div className="text-xs text-muted-foreground truncate">
                    Creates: "{t.title}"
                    {t.dueOffset !== null && ` (due in ${t.dueOffset}d)`}
                  </div>
                </div>
                <span
                  className={cn(
                    "rounded-full px-2 py-0.5 text-xs font-medium shrink-0",
                    priorityStyles[t.priority],
                  )}
                >
                  {t.priority[0] + t.priority.slice(1).toLowerCase()}
                </span>
                <button
                  onClick={() => {
                    if (
                      projectId !== currentProject.current || t.projectId !== projectId ||
                      generation !== identityGeneration()
                    ) return;
                    const loaded = templateToForm(t);
                    setEdit({
                      id: t.id,
                      projectId,
                      generation,
                      initial: loaded.form,
                      values: loaded.form,
                      descriptionPieces: loaded.descriptionPieces,
                    });
                  }}
                  className="text-muted-foreground hover:text-foreground shrink-0"
                >
                  <Pencil className="h-4 w-4" />
                </button>
                <button
                  onClick={() => setDeleteTarget(t.id)}
                  className="text-muted-foreground hover:text-destructive shrink-0"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            )}
          </div>
        ))}

        {templates.length === 0 && !showCreate && (
          <p className="text-sm text-muted-foreground py-2">
            No templates yet
          </p>
        )}
      </div>

      {showCreate ? (
        <div className="rounded-md border px-3 py-3 space-y-3">
          <TemplateForm
            form={form}
            setForm={setForm}
            statuses={statuses}
            labels={labels}
            members={members}
          />
          <div className="flex gap-2">
            <Button
              size="sm"
              onClick={handleCreate}
              disabled={
                !form.name.trim() ||
                !form.title.trim() ||
                createTemplate.isPending
              }
            >
              {createTemplate.isPending ? "Creating..." : "Create template"}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setShowCreate(false);
                setForm(emptyForm);
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <Button
          size="sm"
          variant="outline"
          onClick={() => setShowCreate(true)}
        >
          <Plus className="h-3.5 w-3.5 mr-1" />
          New template
        </Button>
      )}

      <ConfirmDialog
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => {
          if (deleteTarget) {
            deleteTemplate.mutate(deleteTarget, {
              onSuccess: () => setDeleteTarget(null),
            });
          }
        }}
        title="Delete template"
        description="This template and any recurring configs using it will be deleted."
        confirmLabel="Delete"
        loading={deleteTemplate.isPending}
      />
    </div>
  );
}
