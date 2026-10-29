import { useRef, useState } from "react";
import { useIsMutating } from "@tanstack/react-query";
import type { DriveFile } from "../api";
import { bulkTrashMutationKey, useArchiveFiles, useBulkTrashFiles } from "../api";
import { ConfirmDialog } from "@/components/shared/confirm-dialog";
import { Button } from "@/components/ui/button";
import { X, FolderInput, Archive, Share2, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { toastBulkFileResult } from "./bulk-result-toast";

interface DriveBulkActionsProps {
  workspaceId: string;
  selectedFiles: DriveFile[];
  onClear: () => void;
  onMoveSelected: () => void;
  onShareSelected?: () => void;
  /** Whether the trash confirmation is open; the page's Delete shortcut opens it too. */
  trashConfirmOpen: boolean;
  onTrashConfirmOpenChange: (open: boolean) => void;
  /** Called once a trash batch settles, with the files that were trashed. */
  onTrashed: (fileIds: string[]) => void;
  parentId?: string | null;
  teamFolderId?: string;
}

export function DriveBulkActions({
  workspaceId,
  selectedFiles,
  onClear,
  onMoveSelected,
  onShareSelected,
  trashConfirmOpen,
  onTrashConfirmOpenChange,
  onTrashed,
  parentId,
  teamFolderId,
}: DriveBulkActionsProps) {
  const archiveFiles = useArchiveFiles(workspaceId);
  const bulkTrash = useBulkTrashFiles(workspaceId);
  // Busy while any toolbar's batch runs, so a toolbar mounted mid-batch
  // cannot start a second one.
  const trashingElsewhere = useIsMutating({ mutationKey: bulkTrashMutationKey(workspaceId) }) > 0;
  const isTrashingBatch = bulkTrash.isPending || trashingElsewhere;
  // The confirmation keeps naming the batch it started, even if a search
  // changes which selected files are on screen while it runs.
  const [batchSize, setBatchSize] = useState<number | null>(null);
  // Set before the batch starts, so a second click before the busy render
  // cannot start a second batch.
  const batchRunning = useRef(false);

  const count = selectedFiles.length;

  const handleDownloadAsZip = () => {
    const fileIds = selectedFiles.map((f) => f.id);
    archiveFiles.mutate(
      { fileIds, archiveName: "files.zip" },
      { onError: () => toast.error("Archive download failed") },
    );
  };

  const handleTrashAll = async () => {
    if (batchRunning.current || isTrashingBatch) return;
    const fileIds = selectedFiles.map((f) => f.id);
    if (fileIds.length === 0) {
      onTrashConfirmOpenChange(false);
      return;
    }
    batchRunning.current = true;
    setBatchSize(fileIds.length);
    try {
      const result = await bulkTrash.mutateAsync(fileIds);
      toastBulkFileResult(result, "trash");
      // Trashed files leave the selection; failed ones stay selected to retry.
      onTrashed(result.succeeded);
    } catch {
      // Not a per-file failure; the client-wide mutation handler reported it.
    } finally {
      batchRunning.current = false;
      setBatchSize(null);
      onTrashConfirmOpenChange(false);
    }
  };

  return (
    <>
      <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-30 flex items-center gap-3 rounded-lg border bg-background px-4 py-3 shadow-lg">
        <span className="text-sm font-medium">
          {count} selected
        </span>

        {onShareSelected && (
          <Button variant="outline" size="sm" onClick={onShareSelected}>
            <Share2 className="h-4 w-4 mr-1" />
            Share
          </Button>
        )}

        <Button variant="outline" size="sm" onClick={onMoveSelected}>
          <FolderInput className="h-4 w-4 mr-1" />
          Move
        </Button>

        <Button
          variant="outline"
          size="sm"
          onClick={handleDownloadAsZip}
          disabled={archiveFiles.isPending}
        >
          <Archive className="h-4 w-4 mr-1" />
          Download as ZIP
        </Button>

        <Button
          variant="destructive"
          size="sm"
          onClick={() => onTrashConfirmOpenChange(true)}
          disabled={count === 0 || isTrashingBatch}
        >
          <Trash2 className="h-4 w-4 mr-1" />
          Trash
        </Button>

        <button
          onClick={onClear}
          className="rounded-md p-1 hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
          title="Clear selection"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <ConfirmDialog
        open={trashConfirmOpen}
        onClose={() => {
          // The batch is already under way; the dialog shows it until it settles.
          if (!isTrashingBatch) onTrashConfirmOpenChange(false);
        }}
        onConfirm={handleTrashAll}
        title={`Move ${batchSize ?? count} item${(batchSize ?? count) !== 1 ? "s" : ""} to trash?`}
        description="Items in trash can be restored later."
        confirmLabel="Trash"
        variant="destructive"
        loading={isTrashingBatch}
      />
    </>
  );
}
