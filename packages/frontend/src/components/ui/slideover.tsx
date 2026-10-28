import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { motion } from "framer-motion";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useReturnFocus } from "@/components/ui/use-return-focus";

interface SlideoverProps {
  /** Accessible name of the panel, shown at the left of its header. */
  title: ReactNode;
  titleClassName?: string;
  /** Tooltip for a title that may be truncated. */
  titleTooltip?: string;
  /** Controls shown before the Close button. */
  actions?: ReactNode;
  onClose: () => void;
  className?: string;
  /** Animate size changes of the panel (framer-motion `layout`). */
  layout?: boolean;
  children: ReactNode;
}

/**
 * A modal side panel: a dialog named by its title that traps focus, hides the
 * page behind it from assistive technology, closes on Escape or a backdrop
 * click, and returns focus to the control that opened it.
 *
 * Render it only while open; unmounting it closes it.
 */
export function Slideover({
  title,
  titleClassName,
  titleTooltip,
  actions,
  onClose,
  className,
  layout,
  children,
}: SlideoverProps) {
  const returnFocus = useReturnFocus<HTMLDivElement>();
  const onCloseRef = useRef(onClose);
  const escapeRef = useRef<KeyboardEvent | null>(null);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  // Radix sees Escape in the capture phase, before controls inside the panel,
  // and only reports it here when no nested Radix layer (menu, popover,
  // dialog) is open. The close waits for the bubble phase so a control inside
  // the panel that stops the key (an editor menu, for example) keeps it.
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event !== escapeRef.current) return;
      escapeRef.current = null;
      onCloseRef.current();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []);

  return (
    <DialogPrimitive.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay asChild>
          <motion.div
            data-slot="slideover-overlay"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="fixed inset-0 z-40 bg-black/30"
          />
        </DialogPrimitive.Overlay>
        <DialogPrimitive.Content
          asChild
          aria-modal="true"
          aria-describedby={undefined}
          onFocusCapture={returnFocus.onFocusCapture}
          onCloseAutoFocus={returnFocus.onCloseAutoFocus}
          onEscapeKeyDown={(event) => {
            event.preventDefault();
            escapeRef.current = event;
          }}
          onInteractOutside={(event) => {
            // Only the backdrop dismisses; toasts and other page layers do not.
            const target = event.target;
            if (!(target instanceof Element && target.closest('[data-slot="slideover-overlay"]'))) {
              event.preventDefault();
            }
          }}
        >
          <motion.div
            data-slot="slideover"
            initial={{ x: "100%" }}
            animate={{ x: 0 }}
            transition={{ type: "spring", damping: 25, stiffness: 300 }}
            layout={layout}
            className={cn(
              "fixed right-0 top-0 z-50 flex h-full w-full flex-col bg-background shadow-xl outline-none",
              className,
            )}
          >
            <div className="flex items-center justify-between border-b px-6 py-4">
              <DialogPrimitive.Title className={titleClassName} title={titleTooltip}>
                {title}
              </DialogPrimitive.Title>
              <div className="flex shrink-0 items-center gap-1">
                {actions}
                <DialogPrimitive.Close
                  aria-label="Close"
                  className="rounded-md p-1 hover:bg-accent transition-colors"
                >
                  <X className="h-5 w-5" aria-hidden="true" />
                </DialogPrimitive.Close>
              </div>
            </div>
            {children}
          </motion.div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
