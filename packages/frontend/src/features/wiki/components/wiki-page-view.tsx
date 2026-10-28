import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { queryKeys } from "@/lib/query-keys";
import { useAuthStore } from "@/stores/auth-store";
import { useEntityAutosave } from "@/hooks/use-entity-autosave";
import { EditorNavigationGuard } from "@/components/shared/editor-navigation-guard";
import type { UpdateWikiPageInput } from "@pm/shared";
import { ChevronRight, FileText, History, Lock, MessageSquare, Share2, Smile } from "lucide-react";
import { EmojiPicker } from "@/components/shared/emoji-picker";
import {
  useWikiPage,
  useUpdateWikiPage,
  useWikiPageBreadcrumbs,
} from "../api";
import { WikiEditor } from "./wiki-editor";
import { VersionHistoryPanel } from "./version-history-panel";
import { WikiCommentsPanel } from "./wiki-comments-panel";
import { SharePageDialog } from "./share-page-dialog";
import { usePageLock } from "../hooks/use-page-lock";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import type { Block } from "@blocknote/core";

interface WikiPageViewProps {
  pageId: string;
  workspaceId: string;
  onNavigatePage: (pageId: string) => void;
}

export function WikiPageView({ pageId, workspaceId, onNavigatePage }: WikiPageViewProps) {
  const userId = useAuthStore((s) => s.user?.id ?? "anonymous");
  return (
    <WikiPageSession
      key={`${userId}:${pageId}`}
      pageId={pageId}
      workspaceId={workspaceId}
      onNavigatePage={onNavigatePage}
    />
  );
}

function WikiPageSession({
  pageId,
  workspaceId,
  onNavigatePage,
}: WikiPageViewProps) {
  const { data: pageData, isLoading } = useWikiPage(pageId);
  const { data: breadcrumbsData } = useWikiPageBreadcrumbs(pageId);
  const { mutateAsync: updatePage } = useUpdateWikiPage();
  const userId = useAuthStore((s) => s.user?.id ?? "anonymous");
  const save = useCallback(
    (patch: UpdateWikiPageInput) => {
      if (useAuthStore.getState().user?.id !== userId) {
        return Promise.reject(
          new Error("Sign in as the author to save these changes"),
        );
      }
      return updatePage({ ...patch, pageId, expectedUserId: userId });
    },
    [pageId, updatePage, userId],
  );
  // Only a session that currently holds the page lock may write. The backend
  // does not enforce locks, so this is what keeps a retained draft from being
  // replayed over another editor's work.
  const holdsLock = useRef(false);
  const autosave = useEntityAutosave(`wiki:${userId}:${pageId}`, save, {
    author: userId,
    canSave: () =>
      holdsLock.current ? null : "Start editing to save these changes",
    retryFailedAutomatically: true,
  });
  const { lock, isLockedByMe, isLockedByOther, acquire, release } = usePageLock(
    pageId,
    autosave.flush,
  );
  holdsLock.current = isLockedByMe;
  const queryClient = useQueryClient();
  // Remounts the editor and title when their document is replaced wholesale.
  const [documentVersion, setDocumentVersion] = useState(0);
  const router = useRouter({ warn: false });
  const [finishing, setFinishing] = useState(false);
  const [showVersions, setShowVersions] = useState(false);
  const [showComments, setShowComments] = useState(false);
  const [showShare, setShowShare] = useState(false);

  const page = pageData?.data;
  const breadcrumbs = breadcrumbsData?.data ?? [];

  const readOnly = !isLockedByMe || finishing || showVersions;

  // Losing the lock (or no longer being able to confirm it) sets unsaved
  // changes aside: the page shows the stored document again, and the changes
  // are only sent if the user restores them while holding the lock.
  useEffect(() => {
    if (isLockedByMe) return;
    if (autosave.status !== "error" && autosave.status !== "pending") return;
    autosave.park();
    setDocumentVersion((version) => version + 1);
    void queryClient.invalidateQueries({
      queryKey: queryKeys.wikiPage(pageId),
    });
  }, [isLockedByMe, autosave.status, autosave.park, queryClient, pageId]);

  const restoreParked = () => {
    void autosave.restoreParked().catch(() => {});
    setDocumentVersion((version) => version + 1);
  };

  const handleContentChange = useCallback(
    (content: Block[]) => {
      if (readOnly) return;
      autosave.schedule({ content: structuredClone(content) });
    },
    [autosave.schedule, readOnly],
  );

  const handleTitleChange = useCallback(
    (title: string) => {
      if (readOnly) return;
      // An emptied heading keeps the saved title, as before. Returning to the
      // saved title drops an unsent change; one already being saved gets a
      // corrective update instead, so an abandoned value never wins.
      const next = title || page?.title;
      if (!next) return;
      if (next === page?.title && autosave.discard("title")) return;
      autosave.schedule({ title: next });
    },
    [autosave.discard, autosave.schedule, page?.title, readOnly],
  );

  const handleStartEditing = () => {
    void acquire().catch(() =>
      toast.error("Could not start editing this page"),
    );
  };

  const finishEditing = useCallback(async () => {
    setFinishing(true);
    try {
      await release();
    } finally {
      setFinishing(false);
    }
  }, [release]);

  const handleStopEditing = () => {
    void finishEditing().catch(() => {});
  };

  if (isLoading) {
    return (
      <div className="mx-auto max-w-4xl p-8 space-y-4">
        <Skeleton className="h-4 w-48" />
        <Skeleton className="h-10 w-96" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (!page) {
    return (
      <div className="flex items-center justify-center p-12 text-muted-foreground">
        Page not found
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl p-8">
      {router && (
        <EditorNavigationGuard
          beforeLeave={finishEditing}
          hasUnsavedChanges={autosave.hasUnsavedChanges}
        />
      )}
      {/* Breadcrumbs (ancestors only, current page shown as h1 below) */}
      {breadcrumbs.length > 1 && (
        <nav className="flex items-center gap-1 text-sm text-muted-foreground mb-6">
          {breadcrumbs.slice(0, -1).map((crumb, i) => (
            <span key={crumb.id} className="flex items-center gap-1">
              {i > 0 && <ChevronRight className="h-3 w-3" />}
              <button
                onClick={() => {
                  void finishEditing()
                    .then(() => onNavigatePage(crumb.id))
                    .catch(() => {});
                }}
                className="hover:text-foreground transition-colors"
              >
                {crumb.icon ? (
                  <span className="mr-1">{crumb.icon}</span>
                ) : (
                  <FileText className="inline h-3 w-3 mr-1" />
                )}
                {crumb.title}
              </button>
            </span>
          ))}
        </nav>
      )}

      {/* Lock banner */}
      {isLockedByOther && lock && (
        <div className="mb-4 flex items-center gap-2 rounded-md bg-amber-50 border border-amber-200 px-4 py-2 text-sm text-amber-800 dark:bg-amber-900/20 dark:border-amber-800 dark:text-amber-200">
          <Lock className="h-4 w-4 shrink-0" />
          Being edited by {lock.user.displayName}
        </div>
      )}

      {/* Changes set aside after a failed save or a lost lock */}
      {autosave.parked && (
        <div
          role="status"
          className="mb-4 flex flex-wrap items-center gap-2 rounded-md bg-amber-50 border border-amber-200 px-4 py-2 text-sm text-amber-800 dark:bg-amber-900/20 dark:border-amber-800 dark:text-amber-200"
        >
          <span className="flex-1">
            Earlier changes to this page were not saved.
            {!isLockedByMe && " Start editing to restore them."}
          </span>
          <Button
            size="sm"
            variant="outline"
            disabled={!isLockedByMe}
            onClick={restoreParked}
          >
            Restore changes
          </Button>
          <Button size="sm" variant="ghost" onClick={autosave.discardParked}>
            Discard
          </Button>
        </div>
      )}

      {/* Toolbar */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          {!isLockedByMe && !isLockedByOther && (
            <Button size="sm" variant="outline" onClick={handleStartEditing}>
              <Lock className="h-3.5 w-3.5 mr-1" />
              Start Editing
            </Button>
          )}
          {isLockedByMe && (
            <Button
              size="sm"
              variant="outline"
              disabled={finishing}
              onClick={handleStopEditing}
            >
              {finishing ? "Saving…" : "Done Editing"}
            </Button>
          )}
        </div>
        <div aria-live="polite" className="text-xs text-muted-foreground">
          {autosave.status === "error" ? (
            <span role="alert">
              Changes not saved.{" "}
              <button
                className="underline disabled:no-underline disabled:opacity-60"
                disabled={!isLockedByMe}
                title={
                  isLockedByMe
                    ? undefined
                    : "Saving needs the editing lock for this page"
                }
                onClick={() => {
                  void autosave.retry().catch(() => {});
                }}
              >
                Retry save
              </button>
            </span>
          ) : autosave.hasUnsavedChanges ? (
            "Saving changes…"
          ) : autosave.parked ? null : (
            "All changes saved"
          )}
        </div>
        <div className="flex items-center gap-1">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setShowShare(true)}
          >
            <Share2 className="h-3.5 w-3.5 mr-1" />
            Share
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => { setShowComments(!showComments); setShowVersions(false); }}
          >
            <MessageSquare className="h-3.5 w-3.5 mr-1" />
            Comments
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={finishing}
            onClick={() => {
              if (showVersions) {
                setShowVersions(false);
                return;
              }
              setFinishing(true);
              void autosave
                .flush()
                .then(() => {
                  setShowVersions(true);
                  setShowComments(false);
                })
                .catch(() => {})
                .finally(() => setFinishing(false));
            }}
          >
            <History className="h-3.5 w-3.5 mr-1" />
            History
          </Button>
        </div>
      </div>

      {/* Icon */}
      <div className="mb-2 group/icon">
        {page.icon && !readOnly ? (
          <EmojiPicker
            value={page.icon}
            onChange={(emoji) => autosave.schedule({ icon: emoji })}
          >
            <button
              type="button"
              className="text-5xl leading-none rounded-md hover:bg-accent/50 p-1 transition-colors"
            >
              {page.icon}
            </button>
          </EmojiPicker>
        ) : page.icon ? (
          <span className="text-5xl leading-none p-1">{page.icon}</span>
        ) : (
          !readOnly && (
            <EmojiPicker
              value={null}
              onChange={(emoji) => emoji && autosave.schedule({ icon: emoji })}
            >
              <button
                type="button"
                className="flex items-center gap-1 rounded-md px-2 py-1 text-sm text-muted-foreground opacity-0 group-hover/icon:opacity-100 hover:bg-accent transition-all"
              >
                <Smile className="h-4 w-4" />
                Add icon
              </button>
            </EmojiPicker>
          )
        )}
      </div>

      {/* Title */}
      <EditableWikiTitle
        key={documentVersion}
        title={page.title}
        recoveredTitle={autosave.draft?.title}
        readOnly={readOnly}
        hasUnsavedChanges={autosave.hasUnsavedChanges}
        onChange={handleTitleChange}
      />

      {/* Meta info */}
      <div className="flex items-center gap-2 text-xs text-muted-foreground mb-6">
        {page.lastEditedBy && (
          <span>
            Last edited by {page.lastEditedBy.displayName}
          </span>
        )}
        <span>
          {new Date(page.updatedAt).toLocaleDateString()}
        </span>
      </div>

      {/* Editor */}
      <WikiEditor
        key={`${pageId}:${documentVersion}`}
        initialContent={page.content}
        recoveredContent={autosave.draft?.content}
        readOnly={readOnly}
        workspaceId={workspaceId}
        spaceId={page.spaceId}
        onChange={handleContentChange}
      />

      {/* Version History Panel */}
      {showVersions && (
        <VersionHistoryPanel
          pageId={pageId}
          onClose={() => setShowVersions(false)}
        />
      )}

      {/* Comments Panel */}
      {showComments && (
        <WikiCommentsPanel
          pageId={pageId}
          onClose={() => setShowComments(false)}
        />
      )}

      {/* Share Dialog */}
      <SharePageDialog
        open={showShare}
        onClose={() => setShowShare(false)}
        pageId={pageId}
      />
    </div>
  );
}

function EditableWikiTitle({
  title,
  recoveredTitle,
  readOnly,
  hasUnsavedChanges,
  onChange,
}: {
  title: string;
  recoveredTitle?: string;
  readOnly: boolean;
  hasUnsavedChanges: boolean;
  onChange: (title: string) => void;
}) {
  const element = useRef<HTMLHeadingElement>(null);
  const initialTitle = useRef(recoveredTitle ?? title);
  const wasDirty = useRef(hasUnsavedChanges);
  useEffect(() => {
    if (hasUnsavedChanges) {
      wasDirty.current = true;
      return;
    }
    if (wasDirty.current) {
      wasDirty.current = false;
      return;
    }
    if (
      !hasUnsavedChanges &&
      element.current &&
      element.current.textContent !== title
    ) {
      element.current.textContent = title;
    }
  }, [title, hasUnsavedChanges]);
  return (
    <h1
      ref={element}
      contentEditable={!readOnly}
      suppressContentEditableWarning
      onInput={(event) =>
        onChange(event.currentTarget.textContent?.trim() ?? "")
      }
      className="text-3xl font-bold outline-none mb-1 empty:before:content-['Untitled'] empty:before:text-muted-foreground"
    >
      {initialTitle.current}
    </h1>
  );
}
