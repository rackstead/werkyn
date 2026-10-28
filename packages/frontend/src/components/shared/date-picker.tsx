import { useState, useEffect } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { committedDate } from "@/lib/date-input";

interface DatePickerProps {
  value: string | null;
  onChange: (date: string | null) => void;
  className?: string;
  disabled?: boolean;
  /** Id of the date input, for an associated <label>. */
  id?: string;
  /** Accessible name of the date input when no <label> points at it. */
  label?: string;
}

export function DatePicker({ value, onChange, className, disabled, id, label }: DatePickerProps) {
  const [local, setLocal] = useState(value);

  useEffect(() => {
    setLocal(value);
  }, [value]);

  const handleChange = (value: string) => {
    setLocal(value || null);
    // A partial year being typed is shown but not reported.
    const date = committedDate(value);
    if (date !== undefined) onChange(date);
  };

  return (
    <div className={cn("flex items-center gap-1.5", className)}>
      <input
        id={id}
        aria-label={label}
        type="date"
        value={local ?? ""}
        onChange={(e) => handleChange(e.target.value)}
        disabled={disabled}
        className={cn(
          "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors",
          "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
          "disabled:cursor-not-allowed disabled:opacity-50",
        )}
      />
      {local && !disabled && (
        <button
          type="button"
          onClick={() => handleChange("")}
          aria-label={label ? `Clear ${label.toLowerCase()}` : "Clear date"}
          className="shrink-0 rounded-md p-1 text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
        >
          <X className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
