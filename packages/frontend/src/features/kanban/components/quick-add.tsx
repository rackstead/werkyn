import { useState, useRef } from "react";
import { useCreateTask } from "@/features/tasks/api";
import { Plus } from "lucide-react";

interface QuickAddProps {
  projectId: string;
  statusId: string;
  /** The new task is appended, past whatever page is loaded. */
  onCreated?: () => void;
}

export function QuickAdd({ projectId, statusId, onCreated }: QuickAddProps) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const createTask = useCreateTask(projectId);

  const handleSubmit = () => {
    const trimmed = title.trim();
    if (!trimmed) {
      setEditing(false);
      return;
    }
    setTitle("");
    createTask.mutate(
      { title: trimmed, statusId, priority: "NONE" },
      {
        onSuccess: () => {
          inputRef.current?.focus();
          onCreated?.();
        },
      },
    );
  };

  if (!editing) {
    return (
      <button
        onClick={() => {
          setEditing(true);
          requestAnimationFrame(() => inputRef.current?.focus());
        }}
        className="flex w-full items-center gap-1 rounded-md px-2 py-1.5 text-sm text-muted-foreground hover:bg-accent transition-colors"
      >
        <Plus className="h-4 w-4" />
        Add task
      </button>
    );
  }

  return (
    <div className="rounded-lg border bg-card p-2">
      <input
        ref={inputRef}
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            handleSubmit();
          }
          if (e.key === "Escape") {
            setTitle("");
            setEditing(false);
          }
        }}
        onBlur={handleSubmit}
        placeholder="Task title..."
        disabled={createTask.isPending}
        className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
        autoFocus
      />
    </div>
  );
}
