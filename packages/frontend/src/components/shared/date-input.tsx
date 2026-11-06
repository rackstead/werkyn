import { useEffect, useRef, useState } from "react";
import type {
  ChangeEvent,
  FocusEvent,
  InputHTMLAttributes,
  KeyboardEvent,
} from "react";
import { committedDate } from "@/lib/date-input";

interface DateInputOptions {
  /** The saved date (YYYY-MM-DD), or null for none. */
  value: string | null;
  /** Called with a new complete date, or null when the input was emptied. */
  onCommit: (date: string | null) => void;
}

/**
 * State and handlers for an `<input type="date">` that saves only what the
 * user finished entering.
 *
 * Typing over a date makes the browser report each intermediate state: ""
 * while a part is half typed (the first digit of a month), then dates that
 * mix typed and old parts (2026-03-20 on the way to 2027-03-15), then partial
 * years. A typed date is therefore committed on Enter or when the input loses
 * focus, and only when it is complete; otherwise the saved date is shown
 * again. Escape discards it. A date chosen in the browser's picker is
 * committed at once, as is the picker's Clear. An input emptied part by part
 * is committed as null when it loses focus, and `clear()` commits null.
 */
export function useDateInput({ value, onCommit }: DateInputOptions) {
  const [draft, setDraft] = useState(value ?? "");
  const inputRef = useRef<HTMLInputElement>(null);
  // A key is held down in the input, so a change now comes from typing.
  const keyHeld = useRef(false);
  // A typed edit not committed yet, and whether its last keystroke left the
  // input complete.
  const typed = useRef<"complete" | "partial" | null>(null);

  useEffect(() => {
    // A newer saved value replaces the input unless something is being typed.
    if (typed.current === null) setDraft(value ?? "");
  }, [value]);

  const commit = (date: string | null) => {
    typed.current = null;
    if (date !== value) onCommit(date);
  };

  const show = (date: string) => {
    typed.current = null;
    // Setting the element also resets half-typed parts, which the browser
    // keeps when a controlled value is "" both before and after.
    if (inputRef.current) inputRef.current.value = date;
    setDraft(date);
  };

  const onChange = (e: ChangeEvent<HTMLInputElement>) => {
    const input = e.currentTarget;
    setDraft(input.value);
    // As focus moves on (to the next part, or out of the input), Chromium
    // completes a half-typed part (a month "0" becomes 01). Nothing was typed,
    // so the edit keeps its state, and further typing or the blur settles it.
    if (typed.current !== null && input.ownerDocument.activeElement !== input) return;
    if (keyHeld.current) {
      typed.current = committedDate(input.value, input) === undefined ? "partial" : "complete";
      return;
    }
    // A whole date (or the picker's Clear) chosen at once.
    const date = committedDate(input.value, input);
    if (date !== undefined) commit(date);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    const input = e.currentTarget;
    if (e.key === "Enter") {
      if (typed.current === null) return;
      const date = committedDate(input.value, input);
      // Still incomplete: keep typing.
      if (date !== undefined) commit(date);
    } else if (e.key === "Escape") {
      if (typed.current === null) return;
      // Discards the typed edit; the next Escape reaches the panel or dialog.
      e.stopPropagation();
      show(value ?? "");
    } else {
      keyHeld.current = true;
    }
  };

  const onKeyUp = () => {
    keyHeld.current = false;
  };

  const onBlur = (e: FocusEvent<HTMLInputElement>) => {
    keyHeld.current = false;
    const state = typed.current;
    if (state === null) return;
    const input = e.currentTarget;
    // "" is an input emptied part by part, unless a part is still half typed.
    // A typed edit that ended half typed and is no longer "" was completed by
    // the browser on blur, not by the user.
    const date =
      input.value === ""
        ? committedDate("", input)
        : state === "partial"
          ? undefined
          : committedDate(input.value, input);
    if (date === undefined) show(value ?? "");
    else commit(date);
  };

  const clear = () => {
    show("");
    commit(null);
  };

  return {
    inputProps: { ref: inputRef, type: "date", value: draft, onChange, onKeyDown, onKeyUp, onBlur },
    clear,
  } as const;
}

type DateInputProps = DateInputOptions &
  Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "value" | "defaultValue" | "onChange">;

/** An `<input type="date">` with the commit rules of `useDateInput`. */
export function DateInput({ value, onCommit, onKeyDown, onKeyUp, onBlur, ...props }: DateInputProps) {
  const { inputProps } = useDateInput({ value, onCommit });
  return (
    <input
      {...props}
      {...inputProps}
      onKeyDown={(e) => {
        onKeyDown?.(e);
        inputProps.onKeyDown(e);
      }}
      onKeyUp={(e) => {
        onKeyUp?.(e);
        inputProps.onKeyUp();
      }}
      onBlur={(e) => {
        inputProps.onBlur(e);
        onBlur?.(e);
      }}
    />
  );
}
