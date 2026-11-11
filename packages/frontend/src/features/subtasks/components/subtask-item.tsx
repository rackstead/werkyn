import { useState, useRef, useEffect } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Subtask } from "../api";

interface SubtaskItemProps {
  subtask: Subtask;
  canEdit: boolean;
  onToggle: (id: string) => void;
  onUpdate: (id: string, title: string) => void;
  onDelete: (id: string) => void;
}

export function SubtaskItem({
  subtask,
  canEdit,
  onToggle,
  onUpdate,
  onDelete,
}: SubtaskItemProps) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(subtask.title);
  const inputRef = useRef<HTMLInputElement>(null);

  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: subtask.id, disabled: !canEdit });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  const handleSave = () => {
    setEditing(false);
    const trimmed = title.trim();
    if (trimmed && trimmed !== subtask.title) {
      onUpdate(subtask.id, trimmed);
    } else {
      setTitle(subtask.title);
    }
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        "group flex items-center gap-2 rounded-md border px-2 py-1.5 text-sm",
        isDragging && "opacity-50",
      )}
    >
      {canEdit && (
        <button
          type="button"
          {...attributes}
          {...listeners}
          aria-label={`Reorder ${subtask.title}`}
          className="cursor-grab touch-none text-muted-foreground opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 transition-opacity"
        >
          <GripVertical className="h-3.5 w-3.5" />
        </button>
      )}

      <input
        type="checkbox"
        checked={subtask.completed}
        onChange={() => onToggle(subtask.id)}
        disabled={!canEdit}
        aria-label={subtask.title}
        className="h-3.5 w-3.5 rounded border-input accent-primary"
      />

      {editing ? (
        <input
          ref={inputRef}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={handleSave}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleSave();
            if (e.key === "Escape") {
              setTitle(subtask.title);
              setEditing(false);
            }
          }}
          className="flex-1 bg-transparent outline-none text-sm"
        />
      ) : (
        <span
          onDoubleClick={() => canEdit && setEditing(true)}
          className={cn(
            "flex-1 truncate",
            subtask.completed && "line-through text-muted-foreground",
          )}
        >
          {subtask.title}
        </span>
      )}

      {canEdit && (
        <button
          type="button"
          aria-label={`Delete ${subtask.title}`}
          onClick={() => onDelete(subtask.id)}
          className="text-muted-foreground hover:text-destructive opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 transition-opacity"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}
