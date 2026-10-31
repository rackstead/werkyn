import { useRef, useState } from "react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { LoadingSpinner } from "@/components/shared/lazy-load";

/** Keep the opener outside Suspense, whose loading and loaded dialogs differ. */
export function useLazyPanelFocus(onClose: () => void) {
  const [opener] = useState(() =>
    document.activeElement instanceof HTMLElement ? document.activeElement : null,
  );
  const dismissed = useRef(false);
  return {
    onClose() {
      dismissed.current = true;
      onClose();
    },
    onCloseAutoFocus(event: Event) {
      // A loading-shell handover or route/identity unmount is not dismissal.
      // Neither should restore focus over the incoming dialog or screen.
      event.preventDefault();
      if (!dismissed.current || !opener?.isConnected) return;
      const active = document.activeElement;
      if (active && active !== document.body && !active.contains(opener)) return;
      opener.focus();
    },
  };
}

/** A modal loading state that keeps the panel's dismissal and focus behavior. */
export function LoadingPanel({ title, onClose, onCloseAutoFocus }: {
  title: string;
  onClose: () => void;
  onCloseAutoFocus?: (event: Event) => void;
}) {
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent
        aria-describedby={undefined}
        onCloseAutoFocus={onCloseAutoFocus}
        className="left-auto right-0 top-0 flex h-full w-full max-w-2xl translate-x-0 translate-y-0 flex-col rounded-none border-l p-0 sm:max-w-2xl"
      >
        <DialogTitle className="sr-only">{title}</DialogTitle>
        <LoadingSpinner label={`${title}…`} />
      </DialogContent>
    </Dialog>
  );
}
