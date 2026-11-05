import { memo, useState } from "react";
import type { DriveFile } from "../api";
import { useThumbnailUrl } from "../api";
import { useFileDragDrop } from "../hooks/use-file-drag-drop";
import { getFileIcon, formatFileSize } from "@/lib/file-icons";
import { FileActionMenu, FileMenuItems } from "./file-action-menu";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Share2, Star } from "lucide-react";
import { cn } from "@/lib/utils";

interface FileCardProps {
  file: DriveFile;
  /** The index of the grid line this card starts; set on a line's first card only. */
  lineIndex?: number;
  onCardFocus?: (fileId: string) => void;
  canEdit: boolean;
  selectable?: boolean;
  selected?: boolean;
  anySelected?: boolean;
  onSelect?: (file: DriveFile, event: React.MouseEvent) => void;
  onNavigate: (folderId: string) => void;
  onFileClick?: (file: DriveFile) => void;
  onDownload: (file: DriveFile) => void;
  onRename: (file: DriveFile) => void;
  onMove: (file: DriveFile) => void;
  onTrash: (file: DriveFile) => void;
  onCopy?: (file: DriveFile) => void;
  onStar?: (file: DriveFile) => void;
  onShare?: (file: DriveFile) => void;
  onArchive?: (file: DriveFile) => void;
  isShared?: boolean;
}

// Memoized: scrolling renders the grid again, and only cards coming into
// view need to render.
export const FileCard = memo(function FileCard({
  file,
  lineIndex,
  onCardFocus,
  canEdit,
  selectable,
  selected,
  anySelected,
  onSelect,
  onNavigate,
  onFileClick,
  onDownload,
  onRename,
  onMove,
  onTrash,
  onCopy,
  onStar,
  onShare,
  onArchive,
  isShared,
}: FileCardProps) {
  const Icon = getFileIcon(file.mimeType, file.isFolder);
  const { attributes, listeners, setNodeRef, isDragging, isOver } = useFileDragDrop(file, canEdit);
  const { data: thumbnailUrl } = useThumbnailUrl(file.workspaceId, file.id, !!file.thumbnailPath);
  const [thumbError, setThumbError] = useState(false);

  const card = (
    <div
      ref={setNodeRef}
      {...(canEdit ? { ...listeners, ...attributes } : {})}
      tabIndex={0}
      data-anchor-key={file.id}
      data-file-id={file.id}
      data-drive-card=""
      data-index={lineIndex}
      // KeepInView keeps the cards in view in place; the browser's scroll
      // anchoring must not move them a second time.
      style={{ overflowAnchor: "none" }}
      onFocus={onCardFocus && (() => onCardFocus(file.id))}
      className={cn(
        "group/card relative flex flex-col items-center rounded-lg border p-4 hover:bg-accent/50 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-primary",
        "cursor-pointer",
        isDragging && "opacity-50",
        isOver && file.isFolder && "ring-2 ring-primary bg-primary/5",
        selected && "bg-primary/5",
      )}
      onClick={() => {
        if (file.isFolder) onNavigate(file.id);
        else onFileClick?.(file);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          if (file.isFolder) onNavigate(file.id);
          else onFileClick?.(file);
        }
      }}
    >
      {canEdit && (
        <div className="absolute right-1 top-1 opacity-0 group-hover/card:opacity-100 transition-opacity">
          <FileActionMenu
            file={file}
            onShare={onShare ? () => onShare(file) : undefined}
            onDownload={() => onDownload(file)}
            onArchive={onArchive ? () => onArchive(file) : undefined}
            onRename={() => onRename(file)}
            onMove={() => onMove(file)}
            onCopy={onCopy ? () => onCopy(file) : undefined}
            onStar={onStar ? () => onStar(file) : undefined}
            onTrash={() => onTrash(file)}
          />
        </div>
      )}

      {/* Star icon */}
      {onStar && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onStar(file);
          }}
          className={cn(
            "absolute left-1 top-1 rounded p-0.5 transition-opacity",
            file.starred
              ? "opacity-100 text-yellow-500"
              : "opacity-0 group-hover/card:opacity-100 text-muted-foreground hover:text-yellow-500",
          )}
          title={file.starred ? "Unstar" : "Star"}
        >
          <Star className={cn("h-3.5 w-3.5", file.starred && "fill-current")} />
        </button>
      )}

      {/* Icon/thumbnail with hover-reveal checkbox overlay */}
      <div className="relative mb-2">
        {thumbnailUrl && !thumbError ? (
          <img
            src={thumbnailUrl}
            alt={file.name}
            className="h-12 w-12 rounded object-cover"
            onError={() => setThumbError(true)}
          />
        ) : (
          <Icon className="h-12 w-12 text-muted-foreground" />
        )}
        {selectable && (
          <div
            className={cn(
              "absolute -left-1 -top-1 transition-opacity",
              anySelected ? "opacity-100" : "opacity-0 group-hover/card:opacity-100",
            )}
          >
            <input
              type="checkbox"
              checked={!!selected}
              onChange={() => {}}
              onClick={(e) => {
                e.stopPropagation();
                onSelect?.(file, e as unknown as React.MouseEvent);
              }}
              className="h-4 w-4 rounded border-input accent-primary cursor-pointer"
            />
          </div>
        )}
      </div>

      <div className="flex items-center justify-center gap-1 w-full">
        <span className="text-sm truncate text-center" title={file.name}>
          {file.name}
        </span>
        {isShared && (
          <Share2 className="h-3 w-3 shrink-0 text-muted-foreground" />
        )}
      </div>

      {/* Folders keep the line empty: every card has the same height, which
          the windowed grid relies on. */}
      <span
        className={cn("text-xs text-muted-foreground mt-0.5", file.isFolder && "invisible")}
        aria-hidden={file.isFolder || undefined}
      >
        {file.isFolder ? "\u2014" : formatFileSize(file.size)}
      </span>
    </div>
  );

  if (!canEdit) return card;

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{card}</ContextMenuTrigger>
      <ContextMenuContent>
        <FileMenuItems
          file={file}
          ItemComponent={ContextMenuItem}
          SeparatorComponent={ContextMenuSeparator}
          onShare={onShare ? () => onShare(file) : undefined}
          onDownload={() => onDownload(file)}
          onArchive={onArchive ? () => onArchive(file) : undefined}
          onRename={() => onRename(file)}
          onMove={() => onMove(file)}
          onCopy={onCopy ? () => onCopy(file) : undefined}
          onStar={onStar ? () => onStar(file) : undefined}
          onTrash={() => onTrash(file)}
        />
      </ContextMenuContent>
    </ContextMenu>
  );
});
