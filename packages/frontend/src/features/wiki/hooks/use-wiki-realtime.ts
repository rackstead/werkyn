import { useEffect } from "react";
import { useRealtimeClient } from "@/components/providers/realtime-provider";
import { queryClient } from "@/lib/query-client";
import { queryKeys } from "@/lib/query-keys";
import {
  readId,
  readRecord,
  type RealtimeEnvelope,
} from "@/lib/realtime-events";

const WIKI_EVENTS = [
  "wiki_space_created",
  "wiki_space_updated",
  "wiki_space_deleted",
  "wiki_page_created",
  "wiki_page_updated",
  "wiki_page_deleted",
  "wiki_page_moved",
  "wiki_page_locked",
  "wiki_page_unlocked",
  "wiki_comment_created",
  "wiki_comment_resolved",
];

function invalidate(queryKey: readonly unknown[], exact = false) {
  void queryClient.invalidateQueries({ queryKey, exact });
}

// Every page tree list of a space, whatever parent it was loaded for.
function invalidateSpacePages(spaceId: string | undefined) {
  if (spaceId) invalidate(["wiki-pages", { sid: spaceId }]);
}

// Breadcrumbs show the titles of a page and its ancestors.
function invalidateBreadcrumbs() {
  void queryClient.invalidateQueries({
    queryKey: ["wiki-pages"],
    predicate: (query) => query.queryKey[2] === "breadcrumbs",
  });
}

// Whether an update may change how the page is listed (trees, breadcrumbs).
// Body-only saves, by far the most frequent update, do not.
function changesOutline(pageId: string, page: Record<string, unknown>) {
  const cached = queryClient.getQueryData<{ data?: Record<string, unknown> }>(
    queryKeys.wikiPage(pageId),
  )?.data;
  return (
    !cached ||
    cached.title !== page.title ||
    cached.icon !== page.icon ||
    cached.parentId !== page.parentId ||
    cached.position !== page.position
  );
}

/**
 * Applies a workspace's wiki events (spaces, page trees, open pages, locks,
 * comments). Must run below the RealtimeProvider while the workspace is
 * subscribed.
 */
export function useWikiRealtime(workspaceId: string | undefined) {
  const client = useRealtimeClient();

  useEffect(() => {
    if (!client || !workspaceId) return;

    const handler = ({ event, data, workspaceId: scope }: RealtimeEnvelope) => {
      // Wiki events are broadcast to one workspace; ignore any other's, such
      // as a late event from the workspace the user just left.
      if (scope !== workspaceId) return;

      const space = readRecord(data, "space");
      const page = readRecord(data, "page");
      const comment = readRecord(data, "comment");

      switch (event) {
        case "wiki_space_created":
        case "wiki_space_updated": {
          invalidate(queryKeys.wikiSpaces(workspaceId));
          const spaceId = readId(space, "id");
          if (spaceId) invalidate(queryKeys.wikiSpace(spaceId));
          break;
        }
        case "wiki_space_deleted": {
          invalidate(queryKeys.wikiSpaces(workspaceId));
          const spaceId = readId(data, "spaceId");
          if (spaceId) invalidate(queryKeys.wikiSpace(spaceId));
          invalidateSpacePages(spaceId);
          break;
        }
        case "wiki_page_created":
          invalidateSpacePages(readId(page, "spaceId"));
          break;
        case "wiki_page_updated": {
          const pageId = readId(page, "id");
          if (!page || !pageId) break;
          if (changesOutline(pageId, page)) {
            invalidateSpacePages(readId(page, "spaceId"));
            invalidateBreadcrumbs();
          }
          // Refetching an open page is safe for its editor: an idle editor
          // takes the new document; unsaved or set-aside changes are never
          // replaced or sent.
          invalidate(queryKeys.wikiPage(pageId), true);
          invalidate(["wiki-versions", pageId]);
          break;
        }
        case "wiki_page_deleted":
          invalidateSpacePages(readId(data, "spaceId"));
          break;
        case "wiki_page_moved":
          // A move changes the trees of both spaces and the breadcrumbs of
          // the page and everything below it.
          if (readId(page, "id")) invalidate(["wiki-pages"]);
          break;
        case "wiki_page_locked":
        case "wiki_page_unlocked": {
          const pageId = readId(data, "pageId");
          if (pageId) invalidate(["wiki-lock", pageId]);
          break;
        }
        case "wiki_comment_created":
        case "wiki_comment_resolved": {
          const pageId = readId(data, "pageId") ?? readId(comment, "pageId");
          if (pageId) invalidate(["wiki-comments", pageId]);
          break;
        }
      }
    };

    for (const event of WIKI_EVENTS) client.on(event, handler);
    return () => {
      for (const event of WIKI_EVENTS) client.off(event, handler);
    };
  }, [client, workspaceId]);
}
