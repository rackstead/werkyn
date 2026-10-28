import { AlertDialog as AlertDialogPrimitive } from "radix-ui";
import { Button } from "@/components/ui/button";
import { useReturnFocus } from "@/components/ui/use-return-focus";

interface ConfirmDialogProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  description?: string;
  confirmLabel?: string;
  variant?: "destructive" | "default";
  loading?: boolean;
}

/**
 * A confirmation alert dialog. It layers correctly inside other dialogs and
 * slideovers: Escape closes only this dialog, and focus returns to its opener.
 */
export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  description,
  confirmLabel = "Confirm",
  variant = "destructive",
  loading = false,
}: ConfirmDialogProps) {
  const returnFocus = useReturnFocus<HTMLDivElement>();

  return (
    <AlertDialogPrimitive.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <AlertDialogPrimitive.Portal>
        <AlertDialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/50" />
        <AlertDialogPrimitive.Content
          aria-modal="true"
          {...(description ? {} : { "aria-describedby": undefined })}
          onFocusCapture={returnFocus.onFocusCapture}
          onCloseAutoFocus={returnFocus.onCloseAutoFocus}
          className="fixed top-1/2 left-1/2 z-50 w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-lg border bg-background p-0 shadow-lg outline-none"
        >
          <div className="p-6">
            <AlertDialogPrimitive.Title className="text-lg font-semibold">
              {title}
            </AlertDialogPrimitive.Title>
            {description && (
              <AlertDialogPrimitive.Description className="mt-2 text-sm text-muted-foreground">
                {description}
              </AlertDialogPrimitive.Description>
            )}
            <div className="mt-6 flex justify-end gap-3">
              <AlertDialogPrimitive.Cancel asChild>
                <Button variant="outline" disabled={loading}>
                  Cancel
                </Button>
              </AlertDialogPrimitive.Cancel>
              <Button variant={variant} onClick={onConfirm} disabled={loading}>
                {loading ? "..." : confirmLabel}
              </Button>
            </div>
          </div>
        </AlertDialogPrimitive.Content>
      </AlertDialogPrimitive.Portal>
    </AlertDialogPrimitive.Root>
  );
}
