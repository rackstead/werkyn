import { useState, useRef, useEffect } from "react";
import { useUpdateTask } from "../api";

interface TaskTitleProps {
  taskId: string;
  title: string;
  canEdit: boolean;
}

export function TaskTitle({ taskId, title, canEdit }: TaskTitleProps) {
  const [value, setValue] = useState(title);
  const inputRef = useRef<HTMLInputElement>(null);
  const updateTask = useUpdateTask();

  useEffect(() => {
    setValue(title);
  }, [title]);

  const handleSave = () => {
    const trimmed = value.trim();
    if (trimmed && trimmed !== title) {
      updateTask.mutate({ id: taskId, title: trimmed });
    } else {
      setValue(title);
    }
  };

  if (!canEdit) {
    return <h2 className="text-xl font-semibold">{title}</h2>;
  }

  return (
    <input
      ref={inputRef}
      aria-label="Task title"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={handleSave}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          inputRef.current?.blur();
        }
      }}
      className="w-full text-xl font-semibold bg-transparent outline-none border-b border-transparent focus:border-primary transition-colors"
    />
  );
}
