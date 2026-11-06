import { useCallback, useMemo, useRef } from "react";
import { useQueries } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import { queryKeys } from "@/lib/query-keys";

// Share status is asked for in groups of entries. Each request names its
// entries in the URL, and one request for every loaded entry of a long
// folder outgrew the server's limit for a request's header (431) past some
// 600 entries, so no entry showed its share icon.
//
// A group keeps its entries once formed: entries new to the list (the next
// page, an upload, an entry moved in) join the last group while it has
// room, or start a new one. So an entry added near the top of a long folder
// asks again only for the last group, not for every group after it, and the
// groups already answered keep their answers. Groups none of whose entries
// are listed any more are dropped. Share changes ask again only for the
// groups holding the files changed (invalidateShareStatus in ../api).
export const SHARE_STATUS_GROUP = 200;

/** Groups for these entries, keeping the previous groups' members. */
export function shareStatusGroups(previous: readonly string[][], fileIds: readonly string[]): string[][] {
  const listed = new Set(fileIds);
  const groups = previous.filter((group) => group.some((id) => listed.has(id)));
  const grouped = new Set(groups.flat());
  let last = groups.length > 0 ? [...groups[groups.length - 1]] : null;
  if (last) groups.pop();
  for (const id of fileIds) {
    if (grouped.has(id)) continue;
    grouped.add(id);
    if (!last || last.length >= SHARE_STATUS_GROUP) {
      if (last) groups.push(last);
      last = [];
    }
    last.push(id);
  }
  if (last) groups.push(last);
  return groups;
}

/**
 * The IDs of these files that are shared. Only the Drive page uses it; it is
 * kept out of the Drive API module, which other pages load too.
 */
export function useFileShareStatus(wid: string, fileIds: string[]): Set<string> {
  const previous = useRef<{ wid: string; groups: string[][] }>({ wid, groups: [] });
  const groups = useMemo(() => {
    const before = previous.current.wid === wid ? previous.current.groups : [];
    const next = shareStatusGroups(before, fileIds);
    previous.current = { wid, groups: next };
    return next;
  }, [wid, fileIds]);
  // A group asked for again under new members (the last group, as entries
  // are added) has no answer until it arrives: its entries keep the answer
  // shown before, so their icons do not blink.
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
    })),
    combine,
  });
}
