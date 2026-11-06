import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useDateInput } from "./date-input";

interface DatePickerProps {
  value: string | null;
  /** Called with a typed date once it is complete and entered (Enter or blur),
   *  a date chosen in the picker, or null when cleared. */
  onChange: (date: string | null) => void;
  className?: string;
  disabled?: boolean;
  /** Id of the date input, for an associated <label>. */
  id?: string;
  /** Accessible name of the date input when no <label> points at it. */
  label?: string;
}

export function DatePicker({ value, onChange, className, disabled, id, label }: DatePickerProps) {
  const date = useDateInput({ value, onCommit: onChange });

  return (
    <div className={cn("flex items-center gap-1.5", className)}>
      <input
        {...date.inputProps}
        id={id}
        aria-label={label}
        disabled={disabled}
        className={cn(
          "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors",
          "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
          "disabled:cursor-not-allowed disabled:opacity-50",
        )}
      />
      {value && !disabled && (
        <button
          type="button"
          // Keeps focus in the input, so a date being typed is discarded by
          // the clear instead of being saved by the blur just before it.
          onMouseDown={(e) => e.preventDefault()}
          onClick={date.clear}
          aria-label={label ? `Clear ${label.toLowerCase()}` : "Clear date"}
          className="shrink-0 rounded-md p-1 text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
        >
          <X className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
