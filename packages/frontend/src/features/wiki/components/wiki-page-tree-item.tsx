import { useState, useRef, useEffect } from "react";
import { ChevronRight, FileText, FilePlus, Pencil, Smile, Trash2, MoreHorizontal } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  useWikiPageTree,
  useCreateWikiPage,
  useUpdateWikiPage,
  useDeleteWikiPage,
  type WikiPageTreeItem as TreeItem,
} from "../api";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { EmojiPicker } from "@/components/shared/emoji-picker";

interface WikiPageTreeItemProps {
  page: TreeItem;
  depth?: number;
  activePageId?: string;
  onPageClick: (pageId: string) => void;
}

export function WikiPageTreeItem({
  page,
  depth = 0,
  activePageId,
  onPageClick,
}: WikiPageTreeItemProps) {
  const [expanded, setExpanded] = useState(false);
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(page.title);
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const renameRef = useRef<HTMLInputElement>(null);
  const hasChildren = page._count.children > 0;

  const { data: childrenData } = useWikiPageTree(
    page.spaceId,
    expanded ? page.id : undefined,
  );
  const children = childrenData?.data ?? [];

  const createPage = useCreateWikiPage(page.spaceId);
  const updatePage = useUpdateWikiPage();
  const deletePage = useDeleteWikiPage(page.spaceId);

  useEffect(() => {
    if (isRenaming && renameRef.current) {
      renameRef.current.focus();
      renameRef.current.select();
    }
  }, [isRenaming]);

  const handleRenameSubmit = () => {
    const trimmed = renameValue.trim();
    if (trimmed && trimmed !== page.title) {
      updatePage.mutate({ pageId: page.id, title: trimmed });
    }
    setIsRenaming(false);
  };

  const handleAddSubpage = () => {
    createPage.mutate(
      { title: "Untitled", parentId: page.id },
      {
        onSuccess: (res) => {
          setExpanded(true);
          onPageClick(res.data.id);
        },
      },
    );
  };

  const handleDelete = () => {
    deletePage.mutate(page.id);
  };

  return (
    <div>
      <div
        className={cn(
          "flex w-full items-center gap-1 rounded-md px-2 py-1 text-sm hover:bg-accent transition-colors group",
          activePageId === page.id && "bg-accent font-medium",
        )}
        style={{ paddingLeft: `${8 + depth * 16}px` }}
      >
        {hasChildren ? (
          <button
            onClick={(e) => {
              e.stopPropagation();
              setExpanded(!expanded);
            }}
            className="shrink-0 rounded p-0.5 hover:bg-accent"
          >
            <ChevronRight
              className={cn(
                "h-3.5 w-3.5 transition-transform",
                expanded && "rotate-90",
              )}
            />
          </button>
        ) : (
          <span className="w-[18px] shrink-0" />
        )}

        {isRenaming ? (
          <input
            ref={renameRef}
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onBlur={handleRenameSubmit}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleRenameSubmit();
              if (e.key === "Escape") {
                setRenameValue(page.title);
                setIsRenaming(false);
              }
            }}
            className="flex-1 bg-transparent outline-none text-sm border border-ring rounded px-1"
          />
        ) : (
          <button
            onClick={() => onPageClick(page.id)}
            className="flex flex-1 items-center gap-1 min-w-0"
          >
            {page.icon ? (
              <span className="shrink-0 text-sm">{page.icon}</span>
            ) : (
              <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            )}
            <span className="truncate">{page.title}</span>
          </button>
        )}

        {!isRenaming && (
          <>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  onClick={(e) => e.stopPropagation()}
                  className="opacity-0 group-hover:opacity-100 shrink-0 rounded p-0.5 hover:bg-accent transition-opacity"
                >
                  <MoreHorizontal className="h-3.5 w-3.5 text-muted-foreground" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" side="right" className="w-40">
                <DropdownMenuItem
                  onClick={() => {
                    setRenameValue(page.title);
                    setIsRenaming(true);
                  }}
                >
                  <Pencil className="h-3.5 w-3.5 mr-2" />
                  Rename
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => {
                  setTimeout(() => setShowEmojiPicker(true), 150);
                }}>
                  <Smile className="h-3.5 w-3.5 mr-2" />
                  Change icon
                </DropdownMenuItem>
                <DropdownMenuItem onClick={handleAddSubpage}>
                  <FilePlus className="h-3.5 w-3.5 mr-2" />
                  Add subpage
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={handleDelete}
                  className="text-destructive focus:text-destructive"
                >
                  <Trash2 className="h-3.5 w-3.5 mr-2" />
                  Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <EmojiPicker
              value={page.icon ?? null}
              onChange={(emoji) => {
                updatePage.mutate({ pageId: page.id, icon: emoji });
                setShowEmojiPicker(false);
              }}
              open={showEmojiPicker}
              onOpenChange={setShowEmojiPicker}
            />
          </>
        )}
      </div>

      {expanded && children.length > 0 && (
        <div>
          {children.map((child) => (
            <WikiPageTreeItem
              key={child.id}
              page={child}
              depth={depth + 1}
              activePageId={activePageId}
              onPageClick={onPageClick}
            />
          ))}
        </div>
      )}
    </div>
  );
}
