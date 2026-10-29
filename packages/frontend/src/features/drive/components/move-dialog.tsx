import { useState, useEffect, useRef } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  useFiles,
  useTeamFolders,
  useMoveFile,
  useCopyFile,
  useBulkMoveFiles,
  type DriveFile,
} from "../api";
import { Folder, ChevronRight, Loader2, Users } from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { toastBulkFileResult } from "./bulk-result-toast";

interface MoveDialogProps {
  file: DriveFile | null;
  fileIds?: string[];
  onClose: () => void;
  /** Called once a batch move settles, with the files that were moved. */
  onMoved?: (fileIds: string[]) => void;
  workspaceId: string;
  mode?: "move" | "copy";
}

interface SelectedTarget {
  folderId: string | null;
  teamFolderId?: string | null;
}

export function MoveDialog({
  file,
  fileIds,
  onClose,
  onMoved,
  workspaceId,
  mode = "move",
}: MoveDialogProps) {
  const [selected, setSelected] = useState<SelectedTarget>({ folderId: null });
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(
    new Set(),
  );
  const moveFile = useMoveFile(workspaceId);
  const copyFile = useCopyFile(workspaceId);
  const bulkMove = useBulkMoveFiles(workspaceId);
  const isProcessingBatch = bulkMove.isPending;
  // Set before the batch starts: a second click that lands before React
  // re-renders the busy state must not start a second batch.
  const batchRunning = useRef(false);
  const { data: teamFoldersData } = useTeamFolders(workspaceId);
  const teamFolders = teamFoldersData?.data ?? [];

  const isCopy = mode === "copy";
  const mutation = isCopy ? copyFile : moveFile;

  const isBatch = !isCopy && fileIds && fileIds.length > 0;
  const isOpen = isBatch ? fileIds.length > 0 : !!file;

  // Reset state when dialog opens
  useEffect(() => {
    if (file || (fileIds && fileIds.length > 0)) {
      setSelected({ folderId: null });
      setExpandedFolders(new Set());
    }
  }, [file?.id, fileIds?.length]);

  // Load root-level personal folders
  const { data: rootData } = useFiles(workspaceId, null, undefined);
  const rootFolders = (rootData?.pages ?? [])
    .flatMap((p) => p.data)
    .filter((f) => f.isFolder && f.id !== file?.id);

  const toggleExpand = (folderId: string) => {
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(folderId)) next.delete(folderId);
      else next.add(folderId);
      return next;
    });
  };

  const handleAction = async () => {
    if (isBatch && fileIds) {
      if (batchRunning.current || bulkMove.isPending) return;
      batchRunning.current = true;
      try {
        const result = await bulkMove.mutateAsync({
          fileIds,
          parentId: selected.folderId,
          teamFolderId: selected.teamFolderId,
        });
        toastBulkFileResult(result, "move");
        // Moved files leave the selection; failed ones stay selected to retry.
        onMoved?.(result.succeeded);
      } catch {
        // Not a per-file failure; the client-wide mutation handler reported it.
      } finally {
        batchRunning.current = false;
      }
      onClose();
      return;
    }

    if (!file) return;

    mutation.mutate(
      {
        fileId: file.id,
        parentId: selected.folderId,
        teamFolderId: selected.teamFolderId,
      },
      {
        onSuccess: () => {
          toast.success(isCopy ? "Copied successfully" : "Moved successfully");
          onClose();
        },
        onError: (err) => {
          toast.error(err.message || `Failed to ${isCopy ? "copy" : "move"}`);
        },
      },
    );
  };

  const isSelected = (folderId: string | null, teamFolderId?: string | null) =>
    selected.folderId === folderId && selected.teamFolderId === teamFolderId;

  const actionVerb = isCopy ? "Copy" : "Move";
  const title = isBatch
    ? `Move ${fileIds!.length} file${fileIds!.length !== 1 ? "s" : ""}`
    : `${actionVerb} "${file?.name}"`;

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(v) => {
        // A batch move under way stays on screen until it settles.
        if (!v && !isProcessingBatch) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>

        <div className="max-h-64 overflow-y-auto border rounded-md">
          {/* Personal drive root */}
          <button
            onClick={() => setSelected({ folderId: null, teamFolderId: null })}
            className={cn(
              "flex w-full items-center gap-2 px-3 py-2 text-sm hover:bg-accent transition-colors",
              isSelected(null, null) && "bg-accent font-medium",
            )}
          >
            <Folder className="h-4 w-4 text-muted-foreground" />
            My Files (root)
          </button>

          {rootFolders.map((folder) => (
            <FolderItem
              key={folder.id}
              folder={folder}
              workspaceId={workspaceId}
              excludeId={file?.id}
              selected={selected}
              expandedFolders={expandedFolders}
              onSelect={(folderId) =>
                setSelected({ folderId, teamFolderId: null })
              }
              onToggle={toggleExpand}
              depth={1}
            />
          ))}

          {/* Team folders section */}
          {teamFolders.length > 0 && (
            <>
              <div className="flex items-center gap-2 px-3 py-2 text-xs font-semibold text-muted-foreground uppercase tracking-wider border-t mt-1 pt-2">
                <Users className="h-3 w-3" />
                Team Folders
              </div>
              {teamFolders.map((tf) => (
                <TeamFolderItem
                  key={tf.id}
                  teamFolder={tf}
                  workspaceId={workspaceId}
                  excludeId={file?.id}
                  selected={selected}
                  expandedFolders={expandedFolders}
                  onSelect={setSelected}
                  onToggle={toggleExpand}
                />
              ))}
            </>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={isProcessingBatch}>
            Cancel
          </Button>
          <Button onClick={handleAction} disabled={mutation.isPending || isProcessingBatch}>
            {mutation.isPending || isProcessingBatch
              ? `${isCopy ? "Copying" : "Moving"}...`
              : `${actionVerb} here`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function TeamFolderItem({
  teamFolder,
  workspaceId,
  excludeId,
  selected,
  expandedFolders,
  onSelect,
  onToggle,
}: {
  teamFolder: { id: string; folderId: string; name: string };
  workspaceId: string;
  excludeId?: string;
  selected: SelectedTarget;
  expandedFolders: Set<string>;
  onSelect: (target: SelectedTarget) => void;
  onToggle: (id: string) => void;
}) {
  const tfKey = `tf-${teamFolder.id}`;
  const isExpanded = expandedFolders.has(tfKey);
  const isSelected =
    selected.folderId === teamFolder.folderId &&
    selected.teamFolderId === teamFolder.id;

  const { data: childData, isLoading } = useFiles(
    workspaceId,
    teamFolder.folderId,
    teamFolder.id,
    undefined,
    { enabled: isExpanded },
  );
  const childFolders = isExpanded
    ? (childData?.pages ?? [])
        .flatMap((p) => p.data)
        .filter((f) => f.isFolder && f.id !== excludeId)
    : [];

  return (
    <>
      <div
        className={cn(
          "flex items-center gap-1 px-3 py-2 text-sm hover:bg-accent transition-colors cursor-pointer",
          isSelected && "bg-accent font-medium",
        )}
        style={{ paddingLeft: "28px" }}
        onClick={() =>
          onSelect({
            folderId: teamFolder.folderId,
            teamFolderId: teamFolder.id,
          })
        }
      >
        <button
          onClick={(e) => {
            e.stopPropagation();
            onToggle(tfKey);
          }}
          className="shrink-0 p-0.5"
        >
          <ChevronRight
            className={cn(
              "h-3 w-3 transition-transform",
              isExpanded && "rotate-90",
            )}
          />
        </button>
        <Users className="h-4 w-4 text-muted-foreground shrink-0" />
        <span className="truncate">{teamFolder.name}</span>
      </div>

      {isExpanded && isLoading && (
        <div
          className="flex items-center gap-2 px-3 py-2 text-sm text-muted-foreground"
          style={{ paddingLeft: "44px" }}
        >
          <Loader2 className="h-3 w-3 animate-spin" />
        </div>
      )}
      {isExpanded &&
        !isLoading &&
        childFolders.map((child) => (
          <FolderItem
            key={child.id}
            folder={child}
            workspaceId={workspaceId}
            teamFolderId={teamFolder.id}
            excludeId={excludeId}
            selected={selected}
            expandedFolders={expandedFolders}
            onSelect={(folderId) =>
              onSelect({ folderId, teamFolderId: teamFolder.id })
            }
            onToggle={onToggle}
            depth={2}
          />
        ))}
    </>
  );
}

function FolderItem({
  folder,
  workspaceId,
  teamFolderId,
  excludeId,
  selected,
  expandedFolders,
  onSelect,
  onToggle,
  depth,
}: {
  folder: DriveFile;
  workspaceId: string;
  teamFolderId?: string;
  excludeId?: string;
  selected: SelectedTarget;
  expandedFolders: Set<string>;
  onSelect: (id: string) => void;
  onToggle: (id: string) => void;
  depth: number;
}) {
  const isExpanded = expandedFolders.has(folder.id);
  const isSelected = selected.folderId === folder.id;
  const { data: childData, isLoading } = useFiles(
    workspaceId,
    folder.id,
    teamFolderId,
    undefined,
    { enabled: isExpanded },
  );
  const childFolders = isExpanded
    ? (childData?.pages ?? [])
        .flatMap((p) => p.data)
        .filter((f) => f.isFolder && f.id !== excludeId)
    : [];

  return (
    <>
      <div
        className={cn(
          "flex items-center gap-1 px-3 py-2 text-sm hover:bg-accent transition-colors cursor-pointer",
          isSelected && "bg-accent font-medium",
        )}
        style={{ paddingLeft: `${depth * 16 + 12}px` }}
        onClick={() => onSelect(folder.id)}
      >
        <button
          onClick={(e) => {
            e.stopPropagation();
            onToggle(folder.id);
          }}
          className="shrink-0 p-0.5"
        >
          <ChevronRight
            className={cn(
              "h-3 w-3 transition-transform",
              isExpanded && "rotate-90",
            )}
          />
        </button>
        <Folder className="h-4 w-4 text-muted-foreground shrink-0" />
        <span className="truncate">{folder.name}</span>
      </div>

      {isExpanded && isLoading && (
        <div
          className="flex items-center gap-2 px-3 py-2 text-sm text-muted-foreground"
          style={{ paddingLeft: `${(depth + 1) * 16 + 12}px` }}
        >
          <Loader2 className="h-3 w-3 animate-spin" />
        </div>
      )}
      {isExpanded &&
        !isLoading &&
        childFolders.map((child) => (
          <FolderItem
            key={child.id}
            folder={child}
            workspaceId={workspaceId}
            teamFolderId={teamFolderId}
            excludeId={excludeId}
            selected={selected}
            expandedFolders={expandedFolders}
            onSelect={onSelect}
            onToggle={onToggle}
            depth={depth + 1}
          />
        ))}
    </>
  );
}
