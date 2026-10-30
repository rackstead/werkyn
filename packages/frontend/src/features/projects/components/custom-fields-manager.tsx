import { useState } from "react";
import {
  useCustomFields,
  useCreateCustomField,
  useUpdateCustomField,
  useDeleteCustomField,
  useReorderCustomFields,
} from "../api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ConfirmDialog } from "@/components/shared/confirm-dialog";
import { Plus, Trash2, GripVertical, ArrowUp, ArrowDown, X } from "lucide-react";
import { cn } from "@/lib/utils";

const FIELD_TYPES = [
  { value: "TEXT", label: "Text" },
  { value: "NUMBER", label: "Number" },
  { value: "DATE", label: "Date" },
  { value: "SELECT", label: "Select" },
  { value: "MULTI_SELECT", label: "Multi Select" },
  { value: "CHECKBOX", label: "Checkbox" },
  { value: "URL", label: "URL" },
] as const;

const TYPE_COLORS: Record<string, string> = {
  TEXT: "#6366f1",
  NUMBER: "#3b82f6",
  DATE: "#f59e0b",
  SELECT: "#22c55e",
  MULTI_SELECT: "#14b8a6",
  CHECKBOX: "#8b5cf6",
  URL: "#ec4899",
};

interface CustomFieldsManagerProps {
  projectId: string;
}

export function CustomFieldsManager({ projectId }: CustomFieldsManagerProps) {
  const { data } = useCustomFields(projectId);
  const createField = useCreateCustomField(projectId);
  const updateField = useUpdateCustomField(projectId);
  const deleteField = useDeleteCustomField(projectId);
  const reorderFields = useReorderCustomFields(projectId);

  const fields = data?.data ?? [];

  const [showForm, setShowForm] = useState(false);
  const [newName, setNewName] = useState("");
  const [newType, setNewType] = useState<string>("TEXT");
  const [newOptions, setNewOptions] = useState<Array<{ value: string; color?: string }>>([]);
  const [newOptionValue, setNewOptionValue] = useState("");

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);

  const needsOptions = newType === "SELECT" || newType === "MULTI_SELECT";

  const handleCreate = () => {
    if (!newName.trim()) return;
    if (needsOptions && newOptions.length === 0) return;
    createField.mutate(
      {
        name: newName.trim(),
        type: newType as "TEXT" | "NUMBER" | "DATE" | "SELECT" | "MULTI_SELECT" | "CHECKBOX" | "URL",
        options: needsOptions ? newOptions : undefined,
        required: false,
      },
      {
        onSuccess: () => {
          setNewName("");
          setNewType("TEXT");
          setNewOptions([]);
          setShowForm(false);
        },
      },
    );
  };

  const handleUpdate = (id: string) => {
    if (!editingName.trim()) return;
    updateField.mutate(
      { id, name: editingName.trim() },
      { onSuccess: () => setEditingId(null) },
    );
  };

  const handleAddOption = () => {
    const value = newOptionValue.trim();
    if (!value) return;
    // Values identify options, so each may appear only once.
    if (!newOptions.some((option) => option.value === value)) {
      setNewOptions([...newOptions, { value }]);
    }
    setNewOptionValue("");
  };

  const handleRemoveOption = (index: number) => {
    setNewOptions(newOptions.filter((_, i) => i !== index));
  };

  const handleMoveUp = (index: number) => {
    if (index === 0) return;
    const ids = fields.map((f) => f.id);
    [ids[index - 1], ids[index]] = [ids[index], ids[index - 1]];
    reorderFields.mutate({ orderedIds: ids });
  };

  const handleMoveDown = (index: number) => {
    if (index === fields.length - 1) return;
    const ids = fields.map((f) => f.id);
    [ids[index], ids[index + 1]] = [ids[index + 1], ids[index]];
    reorderFields.mutate({ orderedIds: ids });
  };

  return (
    <div className="space-y-3">
      <h3 className="text-sm font-semibold">Custom Fields</h3>

      <div className="space-y-2">
        {fields.map((field, index) => (
          <div
            key={field.id}
            className="flex items-center gap-2 rounded-md border px-3 py-2"
          >
            <div className="flex flex-col gap-0.5">
              <button
                onClick={() => handleMoveUp(index)}
                className="text-muted-foreground hover:text-foreground disabled:opacity-30"
                disabled={index === 0}
              >
                <ArrowUp className="h-3 w-3" />
              </button>
              <button
                onClick={() => handleMoveDown(index)}
                className="text-muted-foreground hover:text-foreground disabled:opacity-30"
                disabled={index === fields.length - 1}
              >
                <ArrowDown className="h-3 w-3" />
              </button>
            </div>

            {editingId === field.id ? (
              <Input
                value={editingName}
                onChange={(e) => setEditingName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleUpdate(field.id);
                  if (e.key === "Escape") setEditingId(null);
                }}
                onBlur={() => handleUpdate(field.id)}
                className="h-7 text-sm flex-1"
                autoFocus
              />
            ) : (
              <span
                className="flex-1 text-sm cursor-pointer"
                onClick={() => {
                  setEditingId(field.id);
                  setEditingName(field.name);
                }}
              >
                {field.name}
              </span>
            )}

            <span
              className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium text-white"
              style={{ backgroundColor: TYPE_COLORS[field.type] ?? "#6366f1" }}
            >
              {FIELD_TYPES.find((t) => t.value === field.type)?.label ?? field.type}
            </span>

            {field._count && (
              <span className="text-xs text-muted-foreground">
                {field._count.values}
              </span>
            )}

            <button
              onClick={() => setDeleteTarget(field.id)}
              className="text-muted-foreground hover:text-destructive"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
        ))}

        {fields.length === 0 && !showForm && (
          <p className="text-sm text-muted-foreground py-2">No custom fields yet</p>
        )}
      </div>

      {showForm ? (
        <div className="space-y-3 rounded-md border p-3">
          <div className="flex gap-2">
            <Input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Field name..."
              className="h-8 text-sm flex-1"
              onKeyDown={(e) => {
                if (e.key === "Enter" && !needsOptions) handleCreate();
                if (e.key === "Escape") setShowForm(false);
              }}
              autoFocus
            />
            <select
              value={newType}
              onChange={(e) => {
                setNewType(e.target.value);
                setNewOptions([]);
              }}
              className="h-8 rounded-md border border-input bg-transparent px-2 text-sm"
            >
              {FIELD_TYPES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
          </div>

          {needsOptions && (
            <div className="space-y-2">
              <div className="flex flex-wrap gap-1">
                {newOptions.map((opt, i) => (
                  <span
                    key={i}
                    className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs"
                  >
                    {opt.value}
                    <button onClick={() => handleRemoveOption(i)}>
                      <X className="h-3 w-3" />
                    </button>
                  </span>
                ))}
              </div>
              <div className="flex gap-2">
                <Input
                  value={newOptionValue}
                  onChange={(e) => setNewOptionValue(e.target.value)}
                  placeholder="Add option..."
                  className="h-7 text-sm"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      handleAddOption();
                    }
                  }}
                />
                <Button
                  size="sm"
                  variant="outline"
                  onClick={handleAddOption}
                  disabled={!newOptionValue.trim()}
                  className="h-7"
                >
                  Add
                </Button>
              </div>
            </div>
          )}

          <div className="flex gap-2">
            <Button
              size="sm"
              onClick={handleCreate}
              disabled={!newName.trim() || (needsOptions && newOptions.length === 0) || createField.isPending}
            >
              {createField.isPending ? "Creating..." : "Create Field"}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setShowForm(false);
                setNewName("");
                setNewType("TEXT");
                setNewOptions([]);
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
          onClick={() => setShowForm(true)}
        >
          <Plus className="h-3.5 w-3.5 mr-1" />
          Add Field
        </Button>
      )}

      <ConfirmDialog
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => {
          if (deleteTarget) {
            deleteField.mutate(deleteTarget, {
              onSuccess: () => setDeleteTarget(null),
            });
          }
        }}
        title="Delete custom field"
        description="This field and all its values will be permanently removed from all tasks."
        confirmLabel="Delete"
        loading={deleteField.isPending}
      />
    </div>
  );
}
