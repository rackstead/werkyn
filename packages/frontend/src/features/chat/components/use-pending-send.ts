import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

/**
 * Runs a composer send and locks the composer until the send settles: a
 * confirmed send clears the draft, an unconfirmed one leaves it for a resend.
 * The lock keeps text typed during the request from being merged into the
 * draft that was already sent.
 */
export function usePendingSend(
  textareaRef: RefObject<HTMLTextAreaElement | null>,
  disabled?: boolean,
) {
  const [sending, setSending] = useState(false);
  const inFlight = useRef(false);
  const refocus = useRef(false);

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
      new Promise((resolve) => resolve(send()))
        .then(onConfirmed, () => {
          // Not confirmed as sent: keep the draft so it can be resent.
        })
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
