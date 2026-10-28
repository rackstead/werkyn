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

// What page lists show for a page: trees (sidebar, space view, dashboard
// widgets) list all of these, breadcrumbs only the title and icon.
const LISTED_FIELDS = [
  "title",
  "icon",
  "parentId",
  "position",
  "updatedAt",
  "lastEditedById",
];

// Refreshes each cached page list (tree or breadcrumbs) whose row for the
// updated page differs from the update. The comparison is with the list
// itself, so lists that do not show the page, or already show this version of
// it, are left alone, and a list still holding older data is refreshed again
// even while an earlier refresh is pending.
function invalidateListsShowing(pageId: string, page: Record<string, unknown>) {
  void queryClient.invalidateQueries({
    queryKey: ["wiki-pages"],
    predicate: (query) => {
      const rows = (query.state.data as { data?: unknown } | undefined)?.data;
      if (!Array.isArray(rows)) return false;
      const row: unknown = rows.find(
        (item: unknown) =>
          typeof item === "object" &&
          item !== null &&
          (item as { id?: unknown }).id === pageId,
      );
      if (!row) return false;
      const listed = row as Record<string, unknown>;
      return LISTED_FIELDS.some(
        (field) => field in listed && listed[field] !== page[field],
      );
    },
  });
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
          invalidateListsShowing(pageId, page);
          // Refetching an open page is safe for its editor: an idle editor
          // takes the new document; unsaved or set-aside changes are never
          // replaced or sent.
          invalidate(queryKeys.wikiPage(pageId), true);
          // Best effort: the server records its occasional auto-save version
          // without waiting, so this list can lag by that version until the
          // next update.
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
