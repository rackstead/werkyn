import { motion, AnimatePresence } from "framer-motion";
import { Check, AlertCircle, X } from "lucide-react";
import { formatFileSize } from "@/lib/file-icons";

export interface UploadItem {
  id: string;
  name: string;
  size: number;
  status: "uploading" | "done" | "error";
  progress: number; // 0-100
  loaded: number; // bytes uploaded
  speed: number; // bytes per second
}

function formatSpeed(bytesPerSecond: number): string {
  if (bytesPerSecond < 1024) return `${bytesPerSecond.toFixed(0)} B/s`;
  if (bytesPerSecond < 1024 * 1024) return `${(bytesPerSecond / 1024).toFixed(1)} KB/s`;
  return `${(bytesPerSecond / (1024 * 1024)).toFixed(1)} MB/s`;
}

export interface UploadProgressProps {
  uploads: UploadItem[];
  onDismiss: () => void;
}

export function UploadProgress({ uploads, onDismiss }: UploadProgressProps) {
  if (uploads.length === 0) return null;

  const activeUploads = uploads.filter((u) => u.status === "uploading");
  const doneCount = uploads.filter((u) => u.status === "done").length;
  const headerText =
    activeUploads.length > 0
      ? `Uploading ${activeUploads.length} file${activeUploads.length > 1 ? "s" : ""}`
      : `${doneCount} upload${doneCount !== 1 ? "s" : ""} complete`;

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: 20 }}
        className="fixed bottom-4 right-4 z-50 w-80 rounded-lg border bg-background shadow-lg"
      >
        <div className="flex items-center justify-between border-b px-3 py-2">
          <span className="text-sm font-medium">{headerText}</span>
          <button
            onClick={onDismiss}
            aria-label="Dismiss upload progress"
            className="rounded-md p-0.5 hover:bg-accent transition-colors"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="max-h-48 overflow-y-auto p-2 space-y-1">
          {uploads.map((item) => (
            <div key={item.id} className="rounded px-2 py-1.5">
              <div className="flex items-center gap-2 text-sm">
                {item.status === "done" && (
                  <Check className="h-4 w-4 text-green-500 shrink-0" />
                )}
                {item.status === "error" && (
                  <AlertCircle className="h-4 w-4 text-destructive shrink-0" />
                )}
                <span className="truncate flex-1">{item.name}</span>
                {item.status === "uploading" && (
                  <span className="text-xs text-muted-foreground shrink-0">
                    {formatSpeed(item.speed)}
                  </span>
                )}
              </div>
              {item.status === "uploading" && (
                <div className="mt-1.5 space-y-1">
                  <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
                    <div
                      className="h-full rounded-full bg-primary transition-all duration-300"
                      style={{ width: `${item.progress}%` }}
                    />
                  </div>
                  <div className="flex justify-between text-[11px] text-muted-foreground">
                    <span>{formatFileSize(item.loaded)} / {formatFileSize(item.size)}</span>
                    <span>{Math.round(item.progress)}%</span>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      </motion.div>
    </AnimatePresence>
  );
}
