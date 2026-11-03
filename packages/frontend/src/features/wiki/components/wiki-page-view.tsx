import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { queryKeys } from "@/lib/query-keys";
import { useAuthStore } from "@/stores/auth-store";
import { isEditConflict } from "@/lib/edit-conflict";
import { useEntityAutosave } from "@/hooks/use-entity-autosave";
import { EditorNavigationGuard } from "@/components/shared/editor-navigation-guard";
import type { UpdateWikiPageInput } from "@pm/shared";
import { ChevronRight, FileText, History, Lock, MessageSquare, Share2, Smile } from "lucide-react";
import { EmojiPicker } from "@/components/shared/emoji-picker";
import {
  useWikiPage,
  useUpdateWikiPage,
  useWikiPageBreadcrumbs,
  wikiAutosaveKey,
  type WikiPage,
} from "../api";
import { WikiEditor } from "./lazy-wiki-editor";
import { VersionHistoryPanel } from "./version-history-panel";
import { WikiCommentsPanel } from "./wiki-comments-panel";
import { SharePageDialog } from "./share-page-dialog";
import { usePageLock } from "../hooks/use-page-lock";
import { useWikiPageAvailability } from "../hooks/use-wiki-page-availability";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import type { Block } from "@blocknote/core";
import { isIdentityChangedError } from "@/lib/api-error";

interface WikiPageViewProps {
  pageId: string;
  workspaceId: string;
  onNavigatePage: (pageId: string) => void;
}

export function WikiPageView({ pageId, workspaceId, onNavigatePage }: WikiPageViewProps) {
  const userId = useAuthStore((s) => s.user?.id ?? "anonymous");
  // Fetch the editor while the page itself is loading.
  useEffect(() => {
    void WikiEditor.preload();
  }, []);
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
  const pageQuery = useWikiPage(pageId);
  const { data: pageData, isLoading } = pageQuery;
  const availabilityGate = useRef<{ canWrite: () => boolean } | null>(null);
  const { data: breadcrumbsData } = useWikiPageBreadcrumbs(pageId);
  const { mutateAsync: updatePage } = useUpdateWikiPage();
  const userId = useAuthStore((s) => s.user?.id ?? "anonymous");
  const save = useCallback(
    async (patch: UpdateWikiPageInput, expectedRevision: number | undefined) => {
      if (useAuthStore.getState().user?.id !== userId) {
        throw new Error("Sign in as the author to save these changes");
      }
      // The server refuses (409) a save based on an older revision, or one
      // made while another user holds the lock, instead of overwriting.
      const result = await updatePage({
        ...patch,
        ...(expectedRevision === undefined ? {} : { expectedRevision }),
        pageId,
        expectedUserId: userId,
        canWrite: () => availabilityGate.current?.canWrite() ?? false,
      });
      return result.data.revision;
    },
    [pageId, updatePage, userId],
  );
  // Only a session that currently holds the page lock sends saves, so a
  // retained draft is not even attempted over another editor's work; the
  // server enforces the lock and the revision as well.
  const holdsLock = useRef(false);
  const autosave = useEntityAutosave(wikiAutosaveKey(userId, pageId), save, {
    author: userId,
    canSave: () => !holdsLock.current
      ? "Start editing to save these changes"
      : availabilityGate.current?.canWrite() ? null : "This page is not available for saving",
    retryFailedAutomatically: true,
    revision: pageData?.data?.revision,
    isConflict: isEditConflict,
  });
  const availability = useWikiPageAvailability({ pageId, workspaceId, userId, pageQuery, autosave,
    isLocked: () => holdsLock.current });
  availabilityGate.current = availability;
  const { lock, isLockedByMe, isLockedByOther, acquire, release } = usePageLock(
    pageId,
    autosave.flush,
    !availability.terminal,
  );
  holdsLock.current = isLockedByMe;
  const queryClient = useQueryClient();
  // Remounts the editor and title when their document is replaced wholesale.
  const [documentVersion, setDocumentVersion] = useState(0);
  const router = useRouter({ warn: false });
  const [finishing, setFinishing] = useState(false);
  const [showVersions, setShowVersions] = useState(false);
  const [historyRevision, setHistoryRevision] = useState<number | null>(null);
  const [showComments, setShowComments] = useState(false);
  const [showShare, setShowShare] = useState(false);

  const page = pageData?.data;
  const breadcrumbs = breadcrumbsData?.data ?? [];

  // A draft refused for a conflict stays set aside until it is restored or
  // discarded, and the page is not editable meanwhile: until the newer page
  // (or lock) arrives it shows an older one, and edits made there would be
  // refused again and could replace the set-aside draft.
  const readOnly =
    !isLockedByMe || finishing || showVersions || autosave.conflict !== null || availability.readOnly;

  const previousAvailabilityVersion = useRef(availability.documentVersion);
  useEffect(() => {
    if (previousAvailabilityVersion.current === availability.documentVersion) return;
    previousAvailabilityVersion.current = availability.documentVersion;
    setDocumentVersion((version) => version + 1);
  }, [availability.documentVersion]);

  // Losing the lock (or no longer being able to confirm it) sets unsaved
  // changes aside: the page shows the stored document again, and the changes
  // are only sent if the user restores them while holding the lock.
  useEffect(() => {
    if (isLockedByMe || availability.terminal) return;
    if (autosave.status !== "error" && autosave.status !== "pending") return;
    autosave.park();
    setDocumentVersion((version) => version + 1);
    void queryClient.invalidateQueries({
      queryKey: queryKeys.wikiPage(pageId),
    });
  }, [isLockedByMe, availability.terminal, autosave.status, autosave.park, queryClient, pageId]);

  // A refused save was set aside. Show the stored document again, now and
  // once its newer version is fetched; for a lock conflict, also the lock.
  const conflict = autosave.conflict;
  useEffect(() => {
    if (!conflict) return;
    setDocumentVersion((version) => version + 1);
    void queryClient.invalidateQueries({
      queryKey: queryKeys.wikiPage(pageId),
    });
    if (isEditConflict(conflict) && conflict.code === "EDIT_LOCKED")
      void queryClient.invalidateQueries({ queryKey: ["wiki-lock", pageId] });
  }, [conflict, queryClient, pageId]);

  // An editor remounted on the stored document of this render bases later
  // edits on its revision. One remounted on a restored draft does not: that
  // draft is saved on the revision already known.
  const pageRevision = page?.revision;
  const remountShowsDraft = useRef(false);
  useEffect(() => {
    if (!remountShowsDraft.current) autosave.adoptRevision(pageRevision);
    remountShowsDraft.current = false;
    // Only when the editor is remounted, not on every refetch.
  }, [documentVersion, autosave.adoptRevision]);

  const restoreParked = () => {
    void autosave.restoreParked().catch(() => {});
    remountShowsDraft.current = true;
    setDocumentVersion((version) => version + 1);
  };

  const handleContentChange = useCallback(
    (content: Block[]) => {
      if (readOnly || !availabilityGate.current?.canWrite()) return;
      autosave.schedule({ content: structuredClone(content) });
    },
    [autosave.schedule, readOnly],
  );

  const handleTitleChange = useCallback(
    (title: string) => {
      if (readOnly || !availabilityGate.current?.canWrite()) return;
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
    void acquire().catch((error) => {
      if (!isIdentityChangedError(error))
        toast.error("Could not start editing this page");
    });
  };

  const finishEditing = useCallback(async () => {
    setFinishing(true);
    try {
      await release();
    } finally {
      setFinishing(false);
    }
  }, [release]);

  // Leaving needs every change stored. If only the lock release fails after
  // that, the lock simply expires, so it does not hold the user on the page.
  const leaveEditing = useCallback(async () => {
    await autosave.flush();
    await finishEditing().catch(() => {});
  }, [autosave.flush, finishEditing]);

  const handleStopEditing = () => {
    void finishEditing().catch(() => {});
  };

  const navigationGuard = router ? <EditorNavigationGuard beforeLeave={leaveEditing}
    hasUnsavedChanges={autosave.hasUnsavedChanges} /> : null;
  if (availability.terminal) {
    const retained = autosave.parked;
    return <div className="mx-auto max-w-4xl p-8 space-y-4">
      {navigationGuard}
      <p role="status">Page no longer available</p>
      {autosave.hasUnsavedChanges && <p>Finishing an earlier save. Remaining changes will be kept in this tab.</p>}
      {retained && <section aria-label="Unsaved changes" className="space-y-3">
        <p>Your unsaved changes are kept in this tab.</p>
        {retained.title !== undefined && <p>{retained.title}</p>}
        {retained.icon !== undefined && <p>{retained.icon}</p>}
        {retained.content !== undefined && <Suspense fallback={<Skeleton className="h-40" />}>
          <WikiEditor initialContent={retained.content} readOnly />
        </Suspense>}
        <Button variant="outline" onClick={autosave.discardParked}>Discard</Button>
      </section>}
    </div>;
  }
  if (availability.failed) return <div className="mx-auto max-w-4xl p-8 space-y-3">
    {navigationGuard}<p role="status">Could not confirm whether this page is available.</p>
    <Button onClick={availability.retryRead}>Check again</Button>
  </div>;

  if (isLoading) {
    return (
      <div className="mx-auto max-w-4xl p-8 space-y-4">
        {navigationGuard}
        <Skeleton className="h-4 w-48" />
        <Skeleton className="h-10 w-96" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (!page) {
    return (
      <div className="flex items-center justify-center p-12 text-muted-foreground">
        {navigationGuard}
        {availability.readOnly ? "Checking page availability…" : "Page not found"}
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl p-8">
      {navigationGuard}
      {/* Breadcrumbs (ancestors only, current page shown as h1 below) */}
      {breadcrumbs.length > 1 && (
        <nav className="flex items-center gap-1 text-sm text-muted-foreground mb-6">
          {breadcrumbs.slice(0, -1).map((crumb, i) => (
            <span key={crumb.id} className="flex items-center gap-1">
              {i > 0 && <ChevronRight className="h-3 w-3" />}
              <button
                onClick={() => onNavigatePage(crumb.id)}
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
            {conflictMessage(autosave.conflict) ??
              "Earlier changes to this page were not saved."}
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
            disabled={finishing || (!showVersions && pageQuery.isFetching)}
            onClick={() => {
              if (showVersions) {
                setShowVersions(false);
                return;
              }
              if (queryClient.getQueryState(queryKeys.wikiPage(pageId))?.fetchStatus === "fetching") return;
              setFinishing(true);
              void autosave
                .flush()
                .then(async () => {
                  if (useAuthStore.getState().user?.id !== userId) return;
                  // Cache reconciliation after a save ACK is best effort.
                  // Confirm the displayed base with a fresh read before using it.
                  const displayed = queryClient.getQueryData<{ data: WikiPage | null }>(
                    queryKeys.wikiPage(pageId),
                  )?.data?.revision;
                  if (typeof displayed !== "number" || !Number.isInteger(displayed) || displayed < 0 || displayed > 2147483647) {
                    toast.error("The saved page is not available. Reload it before opening History.");
                    return;
                  }
                  let refreshed: Awaited<ReturnType<typeof pageQuery.refetch>>;
                  try {
                    refreshed = await pageQuery.refetch({ cancelRefetch: true, throwOnError: true });
                  } catch {
                    if (useAuthStore.getState().user?.id === userId)
                      toast.error("The page could not be refreshed. History stayed closed; try again after checking the page.");
                    return;
                  }
                  if (useAuthStore.getState().user?.id !== userId) return;
                  const confirmed = refreshed.data?.data?.revision;
                  if (confirmed !== displayed) {
                    // Dirty-to-clean editor sync can defer a replacement for
                    // one render. Show this freshly read document for review.
                    setDocumentVersion((version) => version + 1);
                    toast.error("The page was refreshed. Review the updated page, then open History again.");
                    return;
                  }
                  setHistoryRevision(confirmed);
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
            onChange={(emoji) => availabilityGate.current?.canWrite() && autosave.schedule({ icon: emoji })}
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
              onChange={(emoji) => emoji && availabilityGate.current?.canWrite() && autosave.schedule({ icon: emoji })}
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
      <Suspense fallback={<Skeleton className="h-40 w-full" />}>
        <WikiEditor
          key={`${pageId}:${documentVersion}`}
          initialContent={page.content}
          // Only unsaved body edits hold back a refreshed body; a pending title does not.
          hasUnsavedChanges={autosave.draft?.content !== undefined}
          recoveredContent={autosave.draft?.content}
          readOnly={readOnly}
          workspaceId={workspaceId}
          spaceId={page.spaceId}
          onChange={handleContentChange}
        />
      </Suspense>

      {/* Version History Panel */}
      {showVersions && historyRevision !== null && (
        <VersionHistoryPanel
          pageId={pageId}
          expectedRevision={historyRevision}
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

/** Explains why the set-aside changes were refused, or null if they were not. */
function conflictMessage(conflict: Error | null) {
  if (!isEditConflict(conflict)) return null;
  if (conflict.code === "EDIT_LOCKED") {
    const editor = conflict.current?.lockedBy?.displayName ?? "Another user";
    return `${editor} is editing this page, so your changes were not saved. The stored page is shown. Restore or discard them to continue editing.`;
  }
  return "This page was changed elsewhere while you were editing, so your changes were not saved. The stored page is shown; restoring your changes replaces it. Restore or discard them to continue editing.";
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
