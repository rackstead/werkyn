import { toast } from "sonner";
import type { BulkFileResult } from "../api";

const filesWord = (n: number) => `${n} file${n === 1 ? "" : "s"}`;

/**
 * Reports a whole bulk file action in one toast: success only when every file
 * succeeded, otherwise how many succeeded and failed with the first failure's
 * reason.
 */
export function toastBulkFileResult(result: BulkFileResult, action: "move" | "trash") {
  const total = result.succeeded.length + result.failed.length;
  const where = action === "trash" ? " to trash" : "";
  if (result.failed.length === 0) {
    toast.success(`Moved ${filesWord(total)}${where}`);
    return;
  }
  const reason = result.failed[0].error;
  const title =
    result.succeeded.length === 0
      ? `Could not move ${filesWord(total)}${where}`
      : `Moved ${result.succeeded.length} of ${filesWord(total)}${where}; ${result.failed.length} failed`;
  toast.error(title, {
    description: reason instanceof Error && reason.message ? reason.message : undefined,
  });
}
