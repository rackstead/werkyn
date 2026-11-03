import { useState, useRef, useCallback } from "react";
import {
  useFiles,
  useTeamFolders,
  useCreateFolder,
  type DriveFile,
} from "../api";
import { useFileUpload } from "../hooks/use-file-upload";
import { getFileIcon, formatFileSize } from "@/lib/file-icons";
import {
  Dialog,
  DialogContent,
} from "@/components/ui/dialog";
import {
  Folder,
  ArrowLeft,
  HardDrive,
  Users,
  X,
  Check,
  Loader2,
  FolderPlus,
  Upload,
  AlertCircle,
} from "lucide-react";
import { toast } from "sonner";

interface DriveFilePickerProps {
  open: boolean;
  onClose: () => void;
  onSelect: (file: DriveFile) => void;
  workspaceId: string;
  isPending?: boolean;
}

interface FolderStackEntry {
  id: string | null;
  name: string;
  teamFolderId?: string;
}

export function DriveFilePicker(props: DriveFilePickerProps) {
  // Parent-controlled dismissal ends the session too. Unmounting releases
  // pending uploads and mutation callbacks along with the local picker state.
  if (!props.open) return null;
  return <DriveFilePickerSession key={props.workspaceId} {...props} />;
}

function DriveFilePickerSession({
  open,
  onClose,
  onSelect,
  workspaceId,
  isPending,
}: DriveFilePickerProps) {
  const [folderStack, setFolderStack] = useState<FolderStackEntry[]>([
    { id: null, name: "Drive" },
  ]);
  const [selectedFile, setSelectedFile] = useState<DriveFile | null>(null);
  const [showNewFolder, setShowNewFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [isDragging, setIsDragging] = useState(false);
  const dragCounter = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const currentFolder = folderStack[folderStack.length - 1];
  const isRoot = folderStack.length === 1;
  const currentTeamFolderId = currentFolder.teamFolderId;

  const { data, isLoading } = useFiles(
    workspaceId,
    currentFolder.id,
    currentTeamFolderId,
  );
  const { data: teamFoldersData } = useTeamFolders(workspaceId);
  const teamFolders = teamFoldersData?.data ?? [];

  const createFolder = useCreateFolder(
    workspaceId,
    currentFolder.id,
    currentTeamFolderId,
  );

  const onFileUploaded = useCallback((file: DriveFile) => {
    setSelectedFile(file);
  }, []);

  const { uploads, handleUpload, clearUploads } = useFileUpload({
    workspaceId,
    parentId: currentFolder.id,
    teamFolderId: currentTeamFolderId,
    onFileUploaded,
    autoClearMs: 2000,
  });

  const allFiles = data?.pages?.flatMap((p) => p.data) ?? [];

  const folders = allFiles.filter((f) => f.isFolder && !f.trashedAt);
  const files = allFiles.filter((f) => !f.isFolder && !f.trashedAt);

  const enterFolder = (folder: DriveFile, teamFolderId?: string) => {
    setSelectedFile(null);
    setFolderStack((s) => [
      ...s,
      { id: folder.id, name: folder.name, teamFolderId },
    ]);
  };

  const enterTeamFolder = (tf: {
    id: string;
    folderId: string;
    name: string;
  }) => {
    setSelectedFile(null);
    setFolderStack((s) => [
      ...s,
      { id: tf.folderId, name: tf.name, teamFolderId: tf.id },
    ]);
  };

  const goBack = () => {
    if (folderStack.length <= 1) return;
    setSelectedFile(null);
    setFolderStack((s) => s.slice(0, -1));
  };

  const handleClose = () => {
    setFolderStack([{ id: null, name: "Drive" }]);
    setSelectedFile(null);
    clearUploads();
    setShowNewFolder(false);
    setNewFolderName("");
    setIsDragging(false);
    dragCounter.current = 0;
    onClose();
  };

  const handleCreateFolder = () => {
    const name = newFolderName.trim();
    if (!name) return;
    createFolder.mutate(name, {
      onSuccess: () => {
        setShowNewFolder(false);
        setNewFolderName("");
      },
      onError: (err) => toast.error(err.message || "Failed to create folder"),
    });
  };

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = Array.from(e.target.files ?? []);
    if (selected.length > 0) handleUpload(selected);
    e.target.value = "";
  };

  const handleDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current += 1;
    if (dragCounter.current === 1) setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current -= 1;
    if (dragCounter.current === 0) setIsDragging(false);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    dragCounter.current = 0;
    const droppedFiles = Array.from(e.dataTransfer.files);
    if (droppedFiles.length > 0) handleUpload(droppedFiles);
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && handleClose()}>
      <DialogContent showCloseButton={false} className="max-w-md p-0 gap-0 flex flex-col max-h-[70vh]">
        {/* Header */}
        <div className="flex items-center justify-between border-b px-4 py-3">
          <div className="flex items-center gap-2">
            <HardDrive className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm font-medium">Select from Drive</span>
          </div>
          <button
            onClick={handleClose}
            aria-label="Close file picker"
            className="rounded p-1 hover:bg-accent transition-colors"
          >
            <X className="h-4 w-4 text-muted-foreground" />
          </button>
        </div>

        {/* Breadcrumb / Back */}
        <div className="flex items-center gap-1 border-b px-4 py-2">
          {folderStack.length > 1 && (
            <button
              onClick={goBack}
              aria-label="Go back"
              className="rounded p-1 hover:bg-accent transition-colors mr-1"
            >
              <ArrowLeft className="h-3.5 w-3.5 text-muted-foreground" />
            </button>
          )}
          <span className="text-xs text-muted-foreground truncate flex-1">
            {folderStack.map((f) => f.name).join(" / ")}
          </span>
        </div>

        {/* Toolbar */}
        <div className="flex items-center gap-1 border-b px-4 py-1.5">
          <button
            onClick={() => {
              setShowNewFolder(true);
              setNewFolderName("");
            }}
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
          >
            <FolderPlus className="h-3.5 w-3.5" />
            New Folder
          </button>
          <button
            onClick={() => fileInputRef.current?.click()}
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
          >
            <Upload className="h-3.5 w-3.5" />
            Upload
          </button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={handleFileInputChange}
          />
        </div>

        {/* Inline folder creation form */}
        {showNewFolder && (
          <div className="flex items-center gap-2 border-b px-4 py-2">
            <Folder className="h-4 w-4 shrink-0 text-muted-foreground" />
            <input
              type="text"
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleCreateFolder();
                if (e.key === "Escape") setShowNewFolder(false);
              }}
              placeholder="Folder name"
              className="flex-1 rounded-md border bg-transparent px-2 py-1 text-sm outline-none focus:ring-1 focus:ring-primary"
              autoFocus
            />
            <button
              onClick={handleCreateFolder}
              disabled={!newFolderName.trim() || createFolder.isPending}
              className="rounded-md bg-primary px-2 py-1 text-xs text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
            >
              {createFolder.isPending ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                "Create"
              )}
            </button>
            <button
              onClick={() => setShowNewFolder(false)}
              className="rounded p-1 hover:bg-accent transition-colors"
            >
              <X className="h-3 w-3 text-muted-foreground" />
            </button>
          </div>
        )}

        {/* File list with drag-and-drop */}
        <div
          className="flex-1 overflow-y-auto p-2 min-h-[200px] relative"
          onDragEnter={handleDragEnter}
          onDragLeave={handleDragLeave}
          onDragOver={handleDragOver}
          onDrop={handleDrop}
        >
          {/* Drag overlay */}
          {isDragging && (
            <div className="absolute inset-0 z-10 flex items-center justify-center rounded-md border-2 border-dashed border-primary bg-primary/5">
              <div className="flex flex-col items-center gap-2 text-primary">
                <Upload className="h-8 w-8" />
                <span className="text-sm font-medium">Drop files here</span>
              </div>
            </div>
          )}

          {isLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <>
              {/* Team folders at root */}
              {isRoot && teamFolders.length > 0 && (
                <>
                  {teamFolders.map((tf) => (
                    <button
                      key={tf.id}
                      onClick={() =>
                        enterTeamFolder({
                          id: tf.id,
                          folderId: tf.folder.id,
                          name: tf.name,
                        })
                      }
                      className="w-full flex items-center gap-2 rounded-md px-2.5 py-2 text-sm hover:bg-accent transition-colors text-left"
                    >
                      <Users className="h-4 w-4 shrink-0 text-muted-foreground" />
                      <span className="truncate flex-1">{tf.name}</span>
                      <span className="text-xs text-muted-foreground">
                        {tf._count.members} members
                      </span>
                    </button>
                  ))}
                  <div className="mx-1 my-1 border-b" />
                </>
              )}

              {folders.length === 0 &&
              files.length === 0 &&
              !(isRoot && teamFolders.length > 0) ? (
                <p className="text-center text-sm text-muted-foreground py-8">
                  This folder is empty
                </p>
              ) : (
                <>
                  {folders.map((folder) => (
                    <button
                      key={folder.id}
                      onClick={() => enterFolder(folder, currentTeamFolderId)}
                      className="w-full flex items-center gap-2 rounded-md px-2.5 py-2 text-sm hover:bg-accent transition-colors text-left"
                    >
                      <Folder className="h-4 w-4 shrink-0 text-muted-foreground" />
                      <span className="truncate flex-1">{folder.name}</span>
                    </button>
                  ))}
                  {files.map((file) => {
                    const Icon = getFileIcon(file.mimeType, false);
                    const isSelected = selectedFile?.id === file.id;
                    return (
                      <button
                        key={file.id}
                        onClick={() =>
                          setSelectedFile(isSelected ? null : file)
                        }
                        className={`w-full flex items-center gap-2 rounded-md px-2.5 py-2 text-sm transition-colors text-left ${
                          isSelected
                            ? "bg-primary/10 ring-1 ring-primary/30"
                            : "hover:bg-accent"
                        }`}
                      >
                        <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                        <span className="truncate flex-1">{file.name}</span>
                        <span className="text-xs text-muted-foreground shrink-0">
                          {formatFileSize(file.size)}
                        </span>
                        {isSelected && (
                          <Check className="h-3.5 w-3.5 shrink-0 text-primary" />
                        )}
                      </button>
                    );
                  })}
                </>
              )}
            </>
          )}
        </div>

        {/* Upload progress */}
        {uploads.length > 0 && (
          <div className="border-t px-4 py-2 space-y-1 max-h-28 overflow-y-auto">
            {uploads.map((item) => (
              <div key={item.id} className="flex items-center gap-2 text-xs">
                {item.status === "uploading" && (
                  <Loader2 className="h-3 w-3 animate-spin text-muted-foreground shrink-0" />
                )}
                {item.status === "done" && (
                  <Check className="h-3 w-3 text-green-500 shrink-0" />
                )}
                {item.status === "error" && (
                  <AlertCircle className="h-3 w-3 text-destructive shrink-0" />
                )}
                <span className="truncate flex-1 text-muted-foreground">
                  {item.name}
                </span>
                {item.status === "uploading" && (
                  <span className="text-muted-foreground shrink-0">
                    {Math.round(item.progress)}%
                  </span>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 border-t px-4 py-3">
          <button
            onClick={handleClose}
            className="rounded-md px-3 py-1.5 text-sm hover:bg-accent transition-colors"
          >
            Cancel
          </button>
          <button
            disabled={!selectedFile || isPending}
            onClick={() => selectedFile && onSelect(selectedFile)}
            className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:pointer-events-none flex items-center gap-1.5"
          >
            {isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Attach
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
