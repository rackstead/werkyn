import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { LoadingSpinner } from "@/components/shared/lazy-load";

/** A modal loading state that keeps the panel's dismissal and focus behavior. */
export function LoadingPanel({ title, onClose }: { title: string; onClose: () => void }) {
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent
        aria-describedby={undefined}
        className="left-auto right-0 top-0 flex h-full w-full max-w-2xl translate-x-0 translate-y-0 flex-col rounded-none border-l p-0 sm:max-w-2xl"
      >
        <DialogTitle className="sr-only">{title}</DialogTitle>
        <LoadingSpinner label={`${title}…`} />
      </DialogContent>
    </Dialog>
  );
}
