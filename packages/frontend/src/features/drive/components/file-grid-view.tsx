import { useCallback, useMemo, useRef, useState } from "react";
import type { DriveFile, SortBy, SortOrder } from "../api";
import { useInfiniteScroll } from "../hooks/use-infinite-scroll";
import { useDriveWindow } from "../hooks/use-drive-window";
import { GRID_CLASS, useGridColumns } from "../hooks/use-grid-columns";
import { FileCard } from "./file-card";
import { KeepInView } from "./keep-in-view";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ArrowUpDown, Check, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";

// Gap between cards, horizontally and vertically (gap-3).
const GAP = 12;
// Height of a line of cards (with the gap below it) until one is measured:
// a 48 px icon, its 8 px margin, a 20 px name, an 18 px size line, 16 px
// padding above and below and a 1 px border.
const ROW_ESTIMATE = 128 + GAP;

interface FileGridViewProps {
  files: DriveFile[];
  /** The element that scrolls the grid (only the cards near its view are rendered). */
  scrollElement: HTMLElement | null;
  /** The entry being dragged, which stays rendered while the view scrolls. */
  draggingId?: string | null;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  canEdit: boolean;
  selectable?: boolean;
  selectedIds?: Set<string>;
  anySelected?: boolean;
  onSelect?: (file: DriveFile, event: React.MouseEvent) => void;
  onLoadMore: () => void;
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
  sharedFileIds?: Set<string>;
  sortBy?: SortBy;
  sortOrder?: SortOrder;
  onSort?: (column: SortBy) => void;
}

const SORT_OPTIONS: { value: SortBy; label: string }[] = [
  { value: "name", label: "Name" },
  { value: "size", label: "Size" },
  { value: "updatedAt", label: "Modified" },
  { value: "uploadedBy", label: "Uploaded by" },
];

export function FileGridView({
  files,
  scrollElement,
  draggingId,
  hasNextPage,
  isFetchingNextPage,
  canEdit,
  selectable,
  selectedIds,
  anySelected,
  onSelect,
  onLoadMore,
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
  sharedFileIds,
  sortBy = "name",
  sortOrder = "asc",
  onSort,
}: FileGridViewProps) {
  const sentinelRef = useInfiniteScroll(hasNextPage, isFetchingNextPage, onLoadMore);
  const gridRef = useRef<HTMLDivElement>(null);
  const columns = useGridColumns();

  // The card that last held focus stays rendered while scrolled out of
  // view: a menu opened from it keeps its trigger.
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const indexById = useMemo(() => new Map(files.map((file, i) => [file.id, i])), [files]);
  const keep = useMemo(
    () =>
      [focusedId, draggingId].flatMap((id) => {
        const index = id ? indexById.get(id) : undefined;
        return index === undefined ? [] : [Math.floor(index / columns)];
      }),
    [focusedId, draggingId, indexById, columns],
  );
  const { segments, rowHeight, onCorrected } = useDriveWindow({
    count: Math.ceil(files.length / columns),
    scroller: scrollElement,
    container: gridRef,
    estimate: ROW_ESTIMATE,
    keep,
  });
  const indexOf = useCallback((id: string) => indexById.get(id), [indexById]);
  // Space held below the entries while they are kept in place at the end of
  // the list until the next page arrives (see KeepInView's onShort). It
  // lasts until the entries change.
  const [hold, setHold] = useState<{ files: DriveFile[]; height: number } | null>(null);
  const holdHeight = hold?.files === files ? hold.height : 0;
  const onShort = useCallback(
    (height: number) =>
      setHold((current) => ({
        files,
        height: (current?.files === files ? current.height : 0) + height,
      })),
    [files],
  );
  const offsetOf = useCallback(
    (index: number) => Math.floor(index / columns) * rowHeight,
    [columns, rowHeight],
  );

  if (files.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
        <p className="text-sm">No files yet</p>
        <p className="text-xs mt-1">Upload files or create a folder to get started</p>
      </div>
    );
  }

  const activeLabel = SORT_OPTIONS.find((o) => o.value === sortBy)?.label ?? "Name";

  return (
    <div>
      <div className="flex items-center justify-end px-4 pb-2">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" className="text-xs text-muted-foreground">
              <ArrowUpDown className="mr-1 h-3 w-3" />
              {activeLabel} ({sortOrder === "asc" ? "A-Z" : "Z-A"})
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {SORT_OPTIONS.map((opt) => (
              <DropdownMenuItem
                key={opt.value}
                onClick={() => onSort?.(opt.value)}
              >
                {sortBy === opt.value && <Check className="mr-2 h-3 w-3" />}
                {sortBy !== opt.value && <span className="mr-2 w-3" />}
                {opt.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* One grid holds the rendered lines of cards, so a card keeps its
          element when entries before it are added or removed; a gap spanning
          every column holds the height of the lines not rendered. Each line's
          first card carries the line's index (data-index). */}
      <div ref={gridRef} className={`${GRID_CLASS} gap-3 px-4`}>
        <KeepInView
          scroller={scrollElement}
          container={gridRef}
          indexOf={indexOf}
          offsetOf={offsetOf}
          onCorrected={onCorrected}
          onShort={hasNextPage ? onShort : undefined}
        >
          {segments.flatMap((segment) => {
            if (segment.kind === "gap")
              return [
                <div
                  key={segment.key}
                  aria-hidden="true"
                  className="col-span-full"
                  // The grid's gap follows this element too.
                  style={{ height: segment.height - GAP, overflowAnchor: "none" }}
                />,
              ];
            // Cards are siblings keyed by file, not grouped by line: a card
            // that moves to another line keeps its element.
            const line = files.slice(segment.index * columns, (segment.index + 1) * columns);
            return line.map((file, i) => (
              <FileCard
                key={file.id}
                file={file}
                lineIndex={i === 0 ? segment.index : undefined}
                onCardFocus={setFocusedId}
                canEdit={canEdit}
                selectable={selectable}
                selected={selectedIds?.has(file.id)}
                anySelected={anySelected}
                onSelect={onSelect}
                onNavigate={onNavigate}
                onFileClick={onFileClick}
                onDownload={onDownload}
                onRename={onRename}
                onMove={onMove}
                onTrash={onTrash}
                onCopy={onCopy}
                onStar={onStar}
                onShare={onShare}
                onArchive={onArchive}
                isShared={sharedFileIds?.has(file.id)}
              />
            ));
          })}
        </KeepInView>
      </div>

      {hasNextPage && (
        <div ref={sentinelRef} className="flex justify-center py-4">
          {isFetchingNextPage && (
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          )}
        </div>
      )}
      {holdHeight > 0 && <div aria-hidden="true" style={{ height: holdHeight }} />}
    </div>
  );
}
