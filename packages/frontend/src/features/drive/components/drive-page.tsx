import { useState, useRef, useCallback, useMemo, useEffect } from "react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  type DragStartEvent,
  type DragEndEvent,
} from "@dnd-kit/core";
import { useIsMutating } from "@tanstack/react-query";
import {
  bulkTrashMutationKey,
  useFiles,
  useDownloadFile,
  useTrashFile,
  useMoveFile,
  useTeamFolders,
  useStarFile,
  useUnstarFile,
  useFileShareStatus,
  useArchiveFiles,
  type DriveFile,
  type SortBy,
  type SortOrder,
} from "../api";
import { FilePreviewSlideover, UploadProgress } from "./lazy-drive-panels";
import { DriveBulkActions } from "./drive-bulk-actions";
import { useFileUpload } from "../hooks/use-file-upload";
import { useFileSelection } from "../hooks/use-file-selection";
import { useRecentFiles } from "../hooks/use-recent-files";
import { useAuthStore } from "@/stores/auth-store";
import { usePermissions } from "@/hooks/use-permissions";
import { getFileIcon } from "@/lib/file-icons";
import { FileBreadcrumbs } from "./file-breadcrumbs";
import { FileListView } from "./file-list-view";
import { FileGridView } from "./file-grid-view";
import { TrashView } from "./trash-view";
import { CreateFolderDialog } from "./create-folder-dialog";
import { RenameDialog } from "./rename-dialog";
import { MoveDialog } from "./move-dialog";
import { UploadDropzone } from "./upload-dropzone";
import { TeamFoldersSection } from "./team-folders-section";
import { StarredSection } from "./starred-section";
import { RecentFilesSection } from "./recent-files-section";
import { ShareFileDialog } from "./share-file-dialog";
import { SearchInput } from "@/components/shared/search-input";
import { Button } from "@/components/ui/button";
import {
  FolderPlus,
  Upload,
  List,
  LayoutGrid,
  Trash2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

interface DrivePageProps {
  workspaceId: string;
  workspaceSlug: string;
  folderId?: string;
  teamFolderId?: string;
  view: "list" | "grid";
  trash: boolean;
  section?: "home" | "drive" | "starred" | "recent";
  onNavigate: (folderId?: string, teamFolderId?: string) => void;
  onViewChange: (view: "list" | "grid") => void;
  onTrashToggle: (trash: boolean) => void;
}

export function DrivePage({
  workspaceId,
  workspaceSlug,
  folderId,
  teamFolderId,
  view,
  trash,
  section = "home",
  onNavigate,
  onViewChange,
  onTrashToggle,
}: DrivePageProps) {
  const workspaces = useAuthStore((s) => s.workspaces);
  const user = useAuthStore((s) => s.user);
  const membership = workspaces.find(
    (w) => w.workspace.slug === workspaceSlug,
  );
  const permissions = usePermissions(membership, user?.id);
  const canEdit = permissions.canEdit;
  const isAdmin = membership?.role === "ADMIN";

  // Search state
  const [searchQuery, setSearchQuery] = useState("");
  const isSearching = searchQuery.length > 0;

  // Sort state
  const [sortBy, setSortBy] = useState<SortBy>("name");
  const [sortOrder, setSortOrder] = useState<SortOrder>("asc");
  const handleSort = useCallback((column: SortBy) => {
    if (sortBy === column) setSortOrder((prev) => (prev === "asc" ? "desc" : "asc"));
    else { setSortBy(column); setSortOrder("asc"); }
  }, [sortBy]);

  // Determine if we're at root level (no folderId AND no teamFolderId)
  const isRoot = !folderId && !teamFolderId;
  const showInlineSections = isRoot && !isSearching && section === "home";

  const { data, hasNextPage, isFetchingNextPage, fetchNextPage, isLoading, isError, refetch } =
    useFiles(
      workspaceId,
      isSearching ? null : (folderId ?? null),
      isSearching ? undefined : teamFolderId,
      isSearching ? searchQuery : undefined,
      { sortBy, sortOrder },
    );
  const files = useMemo(() => (data?.pages ?? []).flatMap((p) => p.data), [data]);

  // Fetch team folder info for breadcrumbs
  const { data: teamFoldersData } = useTeamFolders(workspaceId);
  const currentTeamFolder = teamFolderId
    ? teamFoldersData?.data?.find((tf) => tf.id === teamFolderId)
    : undefined;

  const downloadFile = useDownloadFile(workspaceId);
  const trashFile = useTrashFile(workspaceId);
  const moveFile = useMoveFile(workspaceId);
  const starFile = useStarFile(workspaceId);
  const unstarFile = useUnstarFile(workspaceId);
  const archiveFiles = useArchiveFiles(workspaceId);

  const { uploads, handleUpload, clearUploads } = useFileUpload({
    workspaceId,
    parentId: folderId ?? null,
    teamFolderId,
  });

  // Recent files tracking
  const { recents, addRecent } = useRecentFiles(workspaceId);

  const [createFolderOpen, setCreateFolderOpen] = useState(false);
  const [renameFile, setRenameFile] = useState<DriveFile | null>(null);
  const [moveFileDialog, setMoveFileDialog] = useState<DriveFile | null>(null);
  const [moveFileIds, setMoveFileIds] = useState<string[]>([]);
  const [copyFileDialog, setCopyFileDialog] = useState<DriveFile | null>(null);
  const [shareTarget, setShareTarget] = useState<{ fileIds: string[]; fileName: string } | null>(null);
  const [previewFile, setPreviewFile] = useState<DriveFile | null>(null);
  const [activeDrag, setActiveDrag] = useState<DriveFile | null>(null);
  const [showTrashConfirm, setShowTrashConfirm] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const selection = useFileSelection();

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 8 },
    }),
  );

  const handleLoadMore = useCallback(() => fetchNextPage(), [fetchNextPage]);

  const handleDragStart = useCallback((event: DragStartEvent) => {
    const file = event.active.data.current?.file as DriveFile | undefined;
    setActiveDrag(file ?? null);
  }, []);

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      setActiveDrag(null);

      const { active, over } = event;
      if (!over) return;

      const activeFileId = active.data.current?.id as string;
      const overData = over.data.current;
      if (!overData || overData.type !== "folder") return;

      const targetFolderId = overData.id as string;

      if (activeFileId === targetFolderId) return;

      moveFile.mutate(
        { fileId: activeFileId, parentId: targetFolderId },
        {
          onSuccess: () => toast.success("File moved"),
          onError: (err) => toast.error(err.message || "Failed to move file"),
        },
      );
    },
    [moveFile],
  );

  const handleDownload = useCallback(
    (file: DriveFile) => {
      addRecent(file);
      downloadFile.mutate(
        { fileId: file.id, fileName: file.name },
        { onError: () => toast.error("Download failed") },
      );
    },
    [downloadFile, addRecent],
  );

  const handleTrash = useCallback(
    (file: DriveFile) => {
      trashFile.mutate(file.id, {
        onSuccess: () => toast.success("Moved to trash"),
        onError: (err) => toast.error(err.message || "Failed to trash"),
      });
    },
    [trashFile],
  );

  const handleStar = useCallback(
    (file: DriveFile) => {
      if (file.starred) {
        unstarFile.mutate(file.id);
      } else {
        starFile.mutate(file.id);
      }
    },
    [starFile, unstarFile],
  );

  const handleArchive = useCallback(
    (file: DriveFile) => {
      archiveFiles.mutate(
        { fileIds: [file.id], archiveName: `${file.name}.zip` },
        { onError: () => toast.error("Archive download failed") },
      );
    },
    [archiveFiles],
  );

  const handleFileClick = useCallback(
    (file: DriveFile) => {
      addRecent(file);
      setPreviewFile(file);
    },
    [addRecent],
  );

  // Clear search, selection and the trash confirmation when the folder or
  // workspace changes. A batch still running for the old folder keeps going
  // and reports through its toast.
  useEffect(() => {
    setSearchQuery("");
    selection.clear();
    setShowTrashConfirm(false);
  }, [workspaceId, folderId, teamFolderId]);

  const handleNavigate = useCallback(
    (id: string) => {
      setSearchQuery("");
      selection.clear();
      onNavigate(id, teamFolderId);
    },
    [onNavigate, teamFolderId, selection],
  );

  const fileIds = useMemo(() => files.map((f) => f.id), [files]);

  // Share status for indicators
  const { data: shareStatusData } = useFileShareStatus(workspaceId, fileIds);
  const sharedFileIds = useMemo(
    () => new Set(shareStatusData?.data ?? []),
    [shareStatusData],
  );

  const handleShare = useCallback(
    (file: DriveFile) => {
      setShareTarget({ fileIds: [file.id], fileName: file.name });
    },
    [],
  );

  const handleSelect = useCallback(
    (file: DriveFile, event: React.MouseEvent) => {
      selection.toggle(file.id, fileIds, event);
    },
    [selection, fileIds],
  );

  const handleToggleAll = useCallback(() => {
    selection.toggleAll(fileIds);
  }, [selection, fileIds]);

  const selectedFiles = useMemo(
    () => files.filter((f) => selection.selectedIds.has(f.id)),
    [files, selection.selectedIds],
  );

  // The trash confirmation is for the selected files on screen; it closes
  // when none are left (the selection was cleared, or a search hid them),
  // except while its batch runs: that batch closes it once it settles.
  const isTrashingBatch = useIsMutating({ mutationKey: bulkTrashMutationKey(workspaceId) }) > 0;
  useEffect(() => {
    if (selectedFiles.length === 0 && !isTrashingBatch) setShowTrashConfirm(false);
  }, [selectedFiles.length, isTrashingBatch]);

  const handleMoveSelected = useCallback(() => {
    setMoveFileIds(Array.from(selection.selectedIds));
  }, [selection.selectedIds]);

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // These shortcuts are the file list's. None applies while a dialog or
      // slideover is open (even when focus has fallen to the page because a
      // busy dialog disabled its focused button), to a key an open layer has
      // already handled (Escape), or to a key pressed inside a menu. So no
      // shortcut can change the selection or open a dialog under a batch.
      if (
        e.defaultPrevented ||
        document.querySelector('[role="dialog"], [role="alertdialog"]') ||
        (e.target instanceof Element && e.target.closest('[role="menu"]'))
      ) {
        return;
      }
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || (e.target as HTMLElement)?.isContentEditable) {
        return;
      }

      // Escape: close preview if open, else clear selection
      if (e.key === "Escape") {
        if (previewFile) {
          setPreviewFile(null);
        } else if (selection.count > 0) {
          selection.clear();
        }
        return;
      }

      // Ctrl/Cmd+A: select all
      if ((e.metaKey || e.ctrlKey) && e.key === "a") {
        e.preventDefault();
        selection.toggleAll(fileIds);
        return;
      }

      // Delete/Backspace: trash selected
      // Like the toolbar's Trash button, Delete waits for a running bulk
      // trash to settle, so no new confirmation can open under it (or be
      // closed by it when it settles, even after a folder change).
      if (
        (e.key === "Delete" || e.key === "Backspace") &&
        canEdit &&
        selectedFiles.length > 0 &&
        !isTrashingBatch
      ) {
        e.preventDefault();
        setShowTrashConfirm(true);
      }
    };

    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [previewFile, selection, fileIds, canEdit, selectedFiles.length, isTrashingBatch]);

  const dragOverlayIcon = activeDrag
    ? getFileIcon(activeDrag.mimeType, activeDrag.isFolder)
    : null;

  const contentArea = (
    <>
      {isLoading ? (
        <div className="flex items-center justify-center py-16">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
        </div>
      ) : isError ? (
        <div className="flex flex-col items-center justify-center gap-3 py-16">
          <p className="text-sm text-destructive">Failed to load files</p>
          <Button variant="outline" size="sm" onClick={() => refetch()}>
            Try again
          </Button>
        </div>
      ) : view === "list" ? (
        <FileListView
          files={files}
          hasNextPage={!!hasNextPage}
          isFetchingNextPage={isFetchingNextPage}
          canEdit={canEdit}
          selectable={canEdit}
          selectedIds={selection.selectedIds}
          anySelected={selection.count > 0}
          allSelected={selection.allSelected(fileIds)}
          onToggleAll={handleToggleAll}
          onSelect={handleSelect}
          onLoadMore={handleLoadMore}
          onNavigate={handleNavigate}
          onFileClick={handleFileClick}
          onDownload={handleDownload}
          onRename={setRenameFile}
          onMove={setMoveFileDialog}
          onTrash={handleTrash}
          onCopy={canEdit ? setCopyFileDialog : undefined}
          onStar={handleStar}
          onShare={canEdit ? handleShare : undefined}
          onArchive={handleArchive}
          sharedFileIds={sharedFileIds}
          sortBy={sortBy}
          sortOrder={sortOrder}
          onSort={handleSort}
        />
      ) : (
        <FileGridView
          files={files}
          hasNextPage={!!hasNextPage}
          isFetchingNextPage={isFetchingNextPage}
          canEdit={canEdit}
          selectable={canEdit}
          selectedIds={selection.selectedIds}
          anySelected={selection.count > 0}
          onSelect={handleSelect}
          onLoadMore={handleLoadMore}
          onNavigate={handleNavigate}
          onFileClick={handleFileClick}
          onDownload={handleDownload}
          onRename={setRenameFile}
          onMove={setMoveFileDialog}
          onTrash={handleTrash}
          onCopy={canEdit ? setCopyFileDialog : undefined}
          onStar={handleStar}
          onShare={canEdit ? handleShare : undefined}
          onArchive={handleArchive}
          sharedFileIds={sharedFileIds}
          sortBy={sortBy}
          sortOrder={sortOrder}
          onSort={handleSort}
        />
      )}
    </>
  );

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="space-y-3 px-6 pt-6 pb-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            {trash ? (
              <h1 className="text-2xl font-bold">Trash</h1>
            ) : (
              <>
                <h1 className="text-2xl font-bold">Drive</h1>
                <SearchInput
                  value={searchQuery}
                  onChange={setSearchQuery}
                  placeholder="Search files..."
                />
              </>
            )}
          </div>

        <div className="flex items-center gap-2">
          {!trash && (
            <>
              <div className="flex items-center rounded-md border">
                <button
                  onClick={() => onViewChange("list")}
                  aria-label="List view"
                  aria-pressed={view === "list"}
                  className={cn(
                    "rounded-l-md p-1.5 transition-colors",
                    view === "list"
                      ? "bg-accent text-foreground"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  <List className="h-4 w-4" />
                </button>
                <button
                  onClick={() => onViewChange("grid")}
                  aria-label="Grid view"
                  aria-pressed={view === "grid"}
                  className={cn(
                    "rounded-r-md p-1.5 transition-colors",
                    view === "grid"
                      ? "bg-accent text-foreground"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  <LayoutGrid className="h-4 w-4" />
                </button>
              </div>

              {canEdit && (
                <>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setCreateFolderOpen(true)}
                  >
                    <FolderPlus className="mr-1.5 h-4 w-4" />
                    New Folder
                  </Button>
                  <Button
                    size="sm"
                    onClick={() => fileInputRef.current?.click()}
                  >
                    <Upload className="mr-1.5 h-4 w-4" />
                    Upload
                  </Button>
                </>
              )}

              <Button
                variant="ghost"
                size="sm"
                onClick={() => onTrashToggle(true)}
                aria-label="View trash"
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </>
          )}
        </div>
        </div>
        {!trash && !isSearching && (folderId || teamFolderId) && (
          <FileBreadcrumbs
            workspaceId={workspaceId}
            folderId={folderId}
            teamFolderId={teamFolderId}
            teamFolderName={currentTeamFolder?.name}
            onNavigate={onNavigate}
          />
        )}
        {isSearching && (
          <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider px-1">
            Search results
          </h3>
        )}
      </div>

      {/* Content */}
      {trash ? (
        <div className="flex-1 overflow-y-auto">
          <TrashView workspaceId={workspaceId} />
        </div>
      ) : (
        <UploadDropzone
          onDrop={handleUpload}
          fileInputRef={fileInputRef}
          disabled={!canEdit}
        >
          <div className="flex-1 overflow-y-auto">
            {/* Starred section — home or starred view */}
            {(showInlineSections || (section === "starred" && isRoot && !isSearching)) && (
              <StarredSection
                workspaceId={workspaceId}
                onNavigate={onNavigate}
                onFileClick={handleFileClick}
              />
            )}

            {/* Recent files section — home or recent view */}
            {(showInlineSections || (section === "recent" && isRoot && !isSearching)) && (
              <RecentFilesSection
                recents={recents}
                onNavigate={onNavigate}
                onFileClick={handleFileClick}
              />
            )}

            {/* Team folders section — home only */}
            {showInlineSections && (
              <TeamFoldersSection
                workspaceId={workspaceId}
                isAdmin={isAdmin}
                onNavigate={onNavigate}
              />
            )}

            {/* Personal files header at root, home view only */}
            {showInlineSections && (
              <div className="px-4 pt-3 pb-1">
                <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider px-1">
                  My Files
                </h3>
              </div>
            )}

            {canEdit && !trash ? (
              <DndContext
                sensors={sensors}
                onDragStart={handleDragStart}
                onDragEnd={handleDragEnd}
              >
                {contentArea}
                <DragOverlay dropAnimation={null}>
                  {activeDrag && dragOverlayIcon && (() => {
                    const Icon = dragOverlayIcon;
                    return (
                      <div className="flex items-center gap-2 rounded-md border bg-background px-3 py-1.5 shadow-lg">
                        <Icon className="h-4 w-4 text-muted-foreground" />
                        <span className="text-sm truncate max-w-48">{activeDrag.name}</span>
                      </div>
                    );
                  })()}
                </DragOverlay>
              </DndContext>
            ) : (
              contentArea
            )}
          </div>
        </UploadDropzone>
      )}

      {/* Dialogs */}
      <CreateFolderDialog
        open={createFolderOpen}
        onClose={() => setCreateFolderOpen(false)}
        workspaceId={workspaceId}
        parentId={folderId}
        teamFolderId={teamFolderId}
      />

      <RenameDialog
        file={renameFile}
        onClose={() => setRenameFile(null)}
        workspaceId={workspaceId}
      />

      <MoveDialog
        file={moveFileDialog}
        fileIds={moveFileIds.length > 0 ? moveFileIds : undefined}
        onClose={() => {
          setMoveFileDialog(null);
          setMoveFileIds([]);
        }}
        onMoved={selection.deselect}
        workspaceId={workspaceId}
      />

      {shareTarget && (
        <ShareFileDialog
          open
          onClose={() => setShareTarget(null)}
          workspaceId={workspaceId}
          fileIds={shareTarget.fileIds}
          fileName={shareTarget.fileName}
        />
      )}

      <MoveDialog
        file={copyFileDialog}
        onClose={() => setCopyFileDialog(null)}
        workspaceId={workspaceId}
        mode="copy"
      />

      <UploadProgress
        uploads={uploads}
        onDismiss={clearUploads}
      />

      {/* Bulk Actions */}
      {selection.count > 0 && (
        <DriveBulkActions
          workspaceId={workspaceId}
          selectedFiles={selectedFiles}
          onClear={selection.clear}
          onMoveSelected={handleMoveSelected}
          trashConfirmOpen={showTrashConfirm}
          onTrashConfirmOpenChange={setShowTrashConfirm}
          onTrashed={selection.deselect}
          onShareSelected={() => {
            const ids = Array.from(selection.selectedIds);
            setShareTarget({
              fileIds: ids,
              fileName: `${ids.length} files`,
            });
          }}
          parentId={folderId ?? null}
          teamFolderId={teamFolderId}
        />
      )}

      {/* File Preview */}
      {previewFile && (
        <FilePreviewSlideover
          file={previewFile}
          workspaceId={workspaceId}
          onClose={() => setPreviewFile(null)}
          onDownload={handleDownload}
        />
      )}
    </div>
  );
}
