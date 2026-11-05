import { useCallback, useMemo, useRef, useState } from "react";
import type { DriveFile, SortBy, SortOrder } from "../api";
import { useInfiniteScroll } from "../hooks/use-infinite-scroll";
import { useDriveWindow } from "../hooks/use-drive-window";
import { FileRow } from "./file-row";
import { KeepInView } from "./keep-in-view";
import { ChevronUp, ChevronDown, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

// Height of a row until one is measured (as measured in Chromium with the
// app's font: the actions button's line, 8 px padding above and below and a
// 1 px border).
const ROW_ESTIMATE = 43;

interface FileListViewProps {
  files: DriveFile[];
  /** The element that scrolls the list (only the rows near its view are rendered). */
  scrollElement: HTMLElement | null;
  /** The entry being dragged, which stays rendered while the view scrolls. */
  draggingId?: string | null;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  canEdit: boolean;
  selectable?: boolean;
  selectedIds?: Set<string>;
  anySelected?: boolean;
  allSelected?: boolean;
  onToggleAll?: () => void;
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

function SortIndicator({ column, sortBy, sortOrder }: { column: SortBy; sortBy?: SortBy; sortOrder?: SortOrder }) {
  if (column !== sortBy) return null;
  return sortOrder === "asc"
    ? <ChevronUp className="h-3 w-3" />
    : <ChevronDown className="h-3 w-3" />;
}

export function FileListView({
  files,
  scrollElement,
  draggingId,
  hasNextPage,
  isFetchingNextPage,
  canEdit,
  selectable,
  selectedIds,
  anySelected,
  allSelected,
  onToggleAll,
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
  sortBy,
  sortOrder,
  onSort,
}: FileListViewProps) {
  const sentinelRef = useInfiniteScroll(hasNextPage, isFetchingNextPage, onLoadMore);
  const bodyRef = useRef<HTMLTableSectionElement>(null);

  // The row that last held focus stays rendered while scrolled out of view:
  // a menu opened from it keeps its trigger, and arrow keys reach the rows
  // next to it.
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const indexById = useMemo(() => new Map(files.map((file, i) => [file.id, i])), [files]);
  const keep = useMemo(
    () =>
      [focusedId, draggingId].flatMap((id) => {
        const index = id ? indexById.get(id) : undefined;
        return index === undefined ? [] : [index];
      }),
    [focusedId, draggingId, indexById],
  );
  const { segments, rowHeight, onCorrected } = useDriveWindow({
    count: files.length,
    scroller: scrollElement,
    container: bodyRef,
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
  const offsetOf = useCallback((index: number) => index * rowHeight, [rowHeight]);

  if (files.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
        <p className="text-sm">No files yet</p>
        <p className="text-xs mt-1">Upload files or create a folder to get started</p>
      </div>
    );
  }

  const sortableHeaderClass = "cursor-pointer select-none hover:text-foreground transition-colors";

  return (
    <div>
      {/* Fixed layout: column widths come from the header, not from whichever
          rows are rendered, and long names are cut off in their cell. */}
      <table className="w-full min-w-[36rem] table-fixed border-separate border-spacing-0">
        <thead>
          <tr className="group/header text-left text-xs text-muted-foreground">
            <th
              scope="col"
              className={cn("border-b px-3 py-2 font-medium", sortableHeaderClass)}
              onClick={() => onSort?.("name")}
            >
              <div className="flex items-center gap-2">
                {selectable && (
                  <div className="relative h-4 w-4 shrink-0">
                    <input
                      type="checkbox"
                      checked={!!allSelected}
                      onChange={() => onToggleAll?.()}
                      onClick={(e) => e.stopPropagation()}
                      className={cn(
                        "h-4 w-4 rounded border-input accent-primary cursor-pointer transition-opacity",
                        anySelected ? "opacity-100" : "opacity-0 group-hover/header:opacity-100",
                      )}
                    />
                  </div>
                )}
                Name
                <SortIndicator column="name" sortBy={sortBy} sortOrder={sortOrder} />
              </div>
            </th>
            <th
              scope="col"
              className={cn("border-b px-3 py-2 font-medium w-24", sortableHeaderClass)}
              onClick={() => onSort?.("size")}
            >
              <div className="flex items-center gap-1">
                Size
                <SortIndicator column="size" sortBy={sortBy} sortOrder={sortOrder} />
              </div>
            </th>
            <th
              scope="col"
              className={cn("border-b px-3 py-2 font-medium w-32", sortableHeaderClass)}
              onClick={() => onSort?.("uploadedBy")}
            >
              <div className="flex items-center gap-1">
                Uploaded by
                <SortIndicator column="uploadedBy" sortBy={sortBy} sortOrder={sortOrder} />
              </div>
            </th>
            <th
              scope="col"
              className={cn("border-b px-3 py-2 font-medium w-28", sortableHeaderClass)}
              onClick={() => onSort?.("updatedAt")}
            >
              <div className="flex items-center gap-1">
                Modified
                <SortIndicator column="updatedAt" sortBy={sortBy} sortOrder={sortOrder} />
              </div>
            </th>
            <th scope="col" className="border-b px-3 py-2 w-10" />
          </tr>
        </thead>
        <tbody ref={bodyRef}>
          <KeepInView
            scroller={scrollElement}
            container={bodyRef}
            indexOf={indexOf}
            offsetOf={offsetOf}
            onCorrected={onCorrected}
            onShort={hasNextPage ? onShort : undefined}
          >
            {segments.map((segment) => {
              if (segment.kind === "gap")
                return (
                  <tr key={segment.key} aria-hidden="true" style={{ overflowAnchor: "none" }}>
                    <td colSpan={5} style={{ height: segment.height, padding: 0 }} />
                  </tr>
                );
              const file = files[segment.index];
              return (
                <FileRow
                  key={file.id}
                  file={file}
                  index={segment.index}
                  onRowFocus={setFocusedId}
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
              );
            })}
          </KeepInView>
        </tbody>
      </table>

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
