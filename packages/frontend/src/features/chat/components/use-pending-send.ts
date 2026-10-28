import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

/**
 * Runs a composer send and locks the composer until the send settles: a
 * confirmed send clears the draft, an unconfirmed one leaves it for a resend.
 * The lock keeps text typed during the request from being merged into the
 * draft that was already sent.
 *
 * `scope` names the draft's destination (channel or thread). When it changes,
 * `onScopeChange` discards the draft, so a kept draft can never be resent to
 * a different destination, and a send that settles afterwards no longer
 * touches the new destination's draft.
 */
export function usePendingSend(
  textareaRef: RefObject<HTMLTextAreaElement | null>,
  disabled: boolean | undefined,
  scope: string | undefined,
  onScopeChange: () => void,
) {
  const [sending, setSending] = useState(false);
  const inFlight = useRef(false);
  const refocus = useRef(false);
  const currentScope = useRef(scope);
  const resetDraft = useRef(onScopeChange);
  resetDraft.current = onScopeChange;

  useEffect(() => {
    if (currentScope.current !== scope) {
      currentScope.current = scope;
      resetDraft.current();
    }
  }, [scope]);

  useEffect(() => {
    if (!sending && !disabled && refocus.current) {
      refocus.current = false;
      textareaRef.current?.focus();
    }
  }, [sending, disabled, textareaRef]);

  const run = useCallback(
    (send: () => void | Promise<unknown>, onConfirmed: () => void) => {
      if (inFlight.current) return;
      inFlight.current = true;
      setSending(true);
      const startedIn = currentScope.current;
      new Promise((resolve) => resolve(send()))
        .then(
          () => {
            if (currentScope.current === startedIn) onConfirmed();
          },
          () => {
            // Not confirmed as sent: keep the draft so it can be resent.
          },
        )
        .finally(() => {
          inFlight.current = false;
          refocus.current = true;
          setSending(false);
        });
    },
    [],
  );

  return { sending, run };
}
