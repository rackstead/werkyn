import { useEffect, useRef, useState } from "react";
import type {
  ChangeEvent,
  FocusEvent,
  InputHTMLAttributes,
  KeyboardEvent,
  MouseEvent,
} from "react";
import { committedDate, dateInputContent, type DateInputContent } from "@/lib/date-input";

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
 *
 * `clearProps` go on a clear button next to the input. Focus moving from the
 * input to that button (Tab, or a click) keeps the typed edit for the button
 * to discard; leaving the button any other way settles the edit as a blur of
 * the input would.
 *
 * While a typed edit is pending, the input carries `data-pending-edit`, so a
 * dialog can leave the Escape that discards it to the input.
 */
export function useDateInput({ value, onCommit }: DateInputOptions) {
  const [draft, setDraft] = useState(value ?? "");
  const inputRef = useRef<HTMLInputElement>(null);
  const clearRef = useRef<HTMLButtonElement>(null);
  // A key is held down in the input, so a change now comes from typing.
  const keyHeld = useRef(false);
  // A typed edit not committed yet, and whether its last keystroke left the
  // input complete.
  const typed = useRef<"complete" | "partial" | null>(null);

  const setTyped = (state: "complete" | "partial" | null) => {
    typed.current = state;
    inputRef.current?.toggleAttribute("data-pending-edit", state !== null);
  };

  useEffect(() => {
    // A newer saved value replaces the input unless something is being typed.
    if (typed.current === null) setDraft(value ?? "");
  }, [value]);

  const commit = (date: string | null) => {
    setTyped(null);
    if (date !== value) onCommit(date);
  };

  const show = (date: string) => {
    setTyped(null);
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
      setTyped(committedDate(input.value, input) === undefined ? "partial" : "complete");
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

  /** Commits or discards the typed edit as focus leaves the input. */
  const settle = (input: HTMLInputElement) => {
    const state = typed.current;
    if (state === null) return;
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

  const onBlur = (e: FocusEvent<HTMLInputElement>) => {
    keyHeld.current = false;
    // Moving to the clear button keeps the edit for the button to discard.
    if (e.relatedTarget !== null && e.relatedTarget === clearRef.current) return;
    settle(e.currentTarget);
  };

  /** Shows the saved date again, dropping a typed edit. */
  const discard = () => show(value ?? "");

  const clear = () => {
    show("");
    commit(null);
  };

  const clearProps = {
    ref: clearRef,
    // A click keeps focus in the input, so no blur saves a date being typed.
    onMouseDown: (e: MouseEvent<HTMLElement>) => e.preventDefault(),
    // Leaving the button without using it settles the edit; so does an Escape
    // there, which may close the panel before any blur.
    onBlur: (e: FocusEvent<HTMLElement>) => {
      if (e.relatedTarget !== inputRef.current && inputRef.current) settle(inputRef.current);
    },
    onKeyDown: (e: KeyboardEvent<HTMLElement>) => {
      if (e.key === "Escape" && inputRef.current) settle(inputRef.current);
    },
  };

  return {
    inputProps: { ref: inputRef, type: "date", value: draft, onChange, onKeyDown, onKeyUp, onBlur },
    clear,
    discard,
    clearProps,
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

const contentOf = (date: string | null): DateInputContent =>
  date ? { kind: "date", date } : { kind: "empty" };

const sameContent = (a: DateInputContent, b: DateInputContent) =>
  a.kind === b.kind && (a.kind !== "date" || b.kind !== "date" || a.date === b.date);

/**
 * A date input in a form that is sent with a button, such as a share link's
 * expiry. Unlike `useDateInput`, leaving the input commits and reverts
 * nothing: the form sends what the input shows when the button is used, so
 * it must not send while `content` is incomplete.
 *
 * Chromium fires no input event while the parts of an empty date input are
 * typed (the value stays ""), and completes a half-typed part (a month "0"
 * becomes 01) only as focus leaves the input. The content is therefore read
 * again on every key and on blur, and `read()` reads the input itself.
 *
 * A mouse press on the form's button moves focus, so the browser may complete
 * a half-typed part between the press and the click, turning an incomplete
 * input into a date nobody saw. The button takes `submitProps`, and `read()`
 * returns null for a click whose own press changed the input: that click
 * sends nothing, and the date now shown needs a second click. The button must
 * therefore not be `disabled` while the input is incomplete (a disabled
 * button gets no press, yet still gets the click once the completion enables
 * it); mark it `aria-disabled` and let the form refuse.
 *
 * A click can also come with no press and leave focus in the input
 * (`element.click()`, as some assistive technology and automation send it).
 * Nothing has settled the input then: a lone month "0" in an empty input
 * still reads as empty. `read()` therefore settles the input itself by
 * moving focus out of it, and returns null when that changed it.
 */
export function useDateField(initial: string | null = null) {
  const ref = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(initial ?? "");
  const [content, setContent] = useState<DateInputContent>(() => contentOf(initial));
  const [focused, setFocused] = useState(false);
  // The input's content when the form's button was pressed.
  const pressed = useRef<DateInputContent | null>(null);

  const update = (next: DateInputContent) =>
    setContent((prev) => (sameContent(prev, next) ? prev : next));

  const refresh = (input: HTMLInputElement) => {
    setValue(input.value);
    const next = dateInputContent(input);
    update(next);
    return next;
  };

  const onRead = (e: { currentTarget: HTMLInputElement }) => {
    refresh(e.currentTarget);
  };

  /**
   * The input's content once settled, for the form to send, or null when the
   * press on the form's button, or settling the input, changed it (see above).
   */
  const read = (): DateInputContent | null => {
    const input = ref.current;
    if (!input) return content;
    // What was shown: at the press, or now when nothing was pressed.
    const before = pressed.current ?? dateInputContent(input);
    pressed.current = null;
    if (input.ownerDocument.activeElement === input) input.blur();
    const now = refresh(input);
    return sameContent(before, now) ? now : null;
  };

  /** Shows `date`, or empties the input (half-typed parts included). */
  const set = (date: string | null) => {
    if (ref.current) ref.current.value = date ?? "";
    setValue(date ?? "");
    update(contentOf(date));
  };

  return {
    inputProps: {
      ref,
      type: "date",
      value,
      onChange: onRead,
      onInput: onRead,
      onKeyUp: onRead,
      onFocus: () => {
        pressed.current = null;
        setFocused(true);
      },
      onBlur: (e: FocusEvent<HTMLInputElement>) => {
        setFocused(false);
        refresh(e.currentTarget);
      },
    },
    submitProps: {
      // Before the press moves focus: the content the user saw.
      onPointerDown: () => {
        pressed.current = ref.current ? dateInputContent(ref.current) : content;
      },
    },
    content,
    focused,
    read,
    set,
  } as const;
}
