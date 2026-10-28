import { useRef } from "react";
import type { FocusEvent, FocusEventHandler } from "react";

interface ReturnFocusHandlers<E extends HTMLElement> {
  onFocusCapture?: FocusEventHandler<E>;
  onCloseAutoFocus?: (event: Event) => void;
}

/**
 * Returns focus to the control that opened a Radix dialog.
 *
 * Radix only restores focus to a `Dialog.Trigger`; dialogs opened from an
 * ordinary button through state would otherwise drop focus to <body> on close.
 * The opener is the element focus came from when it first entered the content,
 * which also works when a field inside uses `autoFocus`.
 */
export function useReturnFocus<E extends HTMLElement>({
  onFocusCapture,
  onCloseAutoFocus,
}: ReturnFocusHandlers<E> = {}) {
  const openerRef = useRef<HTMLElement | null>(null);

  return {
    onFocusCapture(event: FocusEvent<E>) {
      onFocusCapture?.(event);
      const from = event.relatedTarget;
      if (
        !openerRef.current &&
        from instanceof HTMLElement &&
        !event.currentTarget.contains(from)
      ) {
        openerRef.current = from;
      }
    },
    onCloseAutoFocus(event: Event) {
      const opener = openerRef.current;
      openerRef.current = null;
      onCloseAutoFocus?.(event);
      if (event.defaultPrevented || !opener?.isConnected) return;
      // Leave focus alone if something else already took it. An enclosing
      // dialog may have parked focus on itself (it contains the opener).
      const active = document.activeElement;
      if (active && active !== document.body && !active.contains(opener)) return;
      event.preventDefault();
      opener.focus();
    },
  };
}
