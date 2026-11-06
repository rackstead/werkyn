import { useCallback, useMemo, useRef } from "react";
import { useQueries } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import { ApiError } from "@/lib/api-error";
import { queryKeys } from "@/lib/query-keys";

// Share status is asked for in groups of entries. Each request names its
// entries in the URL, and one request for every loaded entry of a long
// folder outgrew the server's limit for a request's header (431) past some
// 600 entries, so no entry showed its share icon.
//
// Only the entries near the view are asked for, once scrolling has settled
// (the caller passes the entries in view then): skimming through a long
// folder costs one request per page loaded, not two, against the server's
// per-address request limit. Entries near the view that are in no group yet
// start new groups, in list order; a group keeps its members once formed, and
// an entry that leaves the list leaves its group. So an entry added near the
// top asks only for itself, an entry that comes back is asked for afresh,
// and the groups already answered keep their answers. Groups away from the
// view are not asked again (a share change, a refocused window) until the
// view is near them. Share changes ask again only for the groups holding the
// files changed (invalidateShareStatus in ../api).
export const SHARE_STATUS_GROUP = 200;
/** Entries before and after those in view whose share status is asked for too. */
export const SHARE_STATUS_MARGIN = 50;

/** The first and last index of the entries in view. */
export type EntriesInView = readonly [first: number, last: number];

/**
 * Groups for these entries: the previous groups' members that are still
 * listed, and a new group for each entry from `from` to `to` (all when
 * omitted) that is in none, filled with the entries in no group that follow
 * it, up to the group size. Scrolling on from a settled view therefore
 * finds the next entries already asked for, about four pages at a time.
 */
export function shareStatusGroups(
  previous: readonly string[][],
  fileIds: readonly string[],
  [from, to]: readonly [number, number] = [0, fileIds.length - 1],
): string[][] {
  const listed = new Set(fileIds);
  const groups = previous
    .map((group) => (group.every((id) => listed.has(id)) ? group : group.filter((id) => listed.has(id))))
    .filter((group) => group.length > 0);
  const grouped = new Set(groups.flat());
  for (let i = Math.max(0, from); i <= Math.min(fileIds.length - 1, to); i++) {
    if (grouped.has(fileIds[i])) continue;
    const group: string[] = [];
    for (let j = i; j < fileIds.length && group.length < SHARE_STATUS_GROUP; j++) {
      if (grouped.has(fileIds[j])) continue;
      grouped.add(fileIds[j]);
      group.push(fileIds[j]);
    }
    groups.push(group);
  }
  return groups;
}

// A request refused by the server's request limit is asked again once the
// limit allows (Retry-After), twice at most.
function retryRefused(failures: number, error: unknown) {
  return failures < 2 && error instanceof ApiError && error.statusCode === 429;
}
function refusedDelay(failures: number, error: unknown) {
  return (error instanceof ApiError && error.retryAfterMs) || 2000 * 2 ** failures;
}

/**
 * The IDs of these files that are shared. `inView` gives the entries in view
 * (null: none yet, nothing is asked); without it, every entry is asked for.
 * Only the Drive page uses it; it is kept out of the Drive API module, which
 * other pages load too.
 */
export function useFileShareStatus(
  wid: string,
  fileIds: string[],
  inView?: EntriesInView | null,
): Set<string> {
  const near = useMemo<readonly [number, number]>(
    () =>
      inView === undefined
        ? [0, fileIds.length - 1]
        : inView === null
          ? [0, -1]
          : [inView[0] - SHARE_STATUS_MARGIN, inView[1] + SHARE_STATUS_MARGIN],
    [inView, fileIds.length],
  );
  const previous = useRef<{ wid: string; groups: string[][]; inView?: EntriesInView | null }>({
    wid,
    groups: [],
  });
  const groups = useMemo(() => {
    const before = previous.current.wid === wid ? previous.current.groups : [];
    // New groups start from the entries near the view when it has just
    // settled; when only the list changed (a page arrived next to the view,
    // an entry was added), from the entries in view alone. So the pages
    // that keep arriving below a view at the end of the loaded entries are
    // asked for when the view settles near them, not one by one.
    const settled = previous.current.wid !== wid || previous.current.inView !== inView;
    const from: readonly [number, number] =
      settled || !inView ? near : [inView[0], inView[1]];
    const next = shareStatusGroups(before, fileIds, from);
    previous.current = { wid, groups: next, inView };
    return next;
  }, [wid, fileIds, near, inView]);
  const indexOf = useMemo(() => new Map(fileIds.map((id, i) => [id, i])), [fileIds]);
  // A group asked for again under new members (one whose entry left the
  // list) has no answer until it arrives: its entries keep the answer shown
  // before, so their icons do not blink.
  const groupsRef = useRef(groups);
  groupsRef.current = groups;
  const shown = useRef(new Set<string>());
  const combine = useCallback((results: Array<{ data?: { data: string[] } }>) => {
    const shared = new Set<string>();
    results.forEach((result, i) => {
      if (result.data) for (const id of result.data.data) shared.add(id);
      else for (const id of groupsRef.current[i] ?? []) if (shown.current.has(id)) shared.add(id);
    });
    shown.current = shared;
    return shared;
  }, []);
  return useQueries({
    queries: groups.map((ids) => ({
      queryKey: queryKeys.fileShareStatus(wid, ids),
      queryFn: () => {
        const params = new URLSearchParams();
        params.set("fileIds", ids.join(","));
        return api
          .get(`workspaces/${wid}/files/share-status?${params.toString()}`)
          .json<{ data: string[] }>();
      },
      enabled: ids.some((id) => {
        const index = indexOf.get(id);
        return index !== undefined && index >= near[0] && index <= near[1];
      }),
      retry: retryRefused,
      retryDelay: refusedDelay,
    })),
    combine,
  });
}
