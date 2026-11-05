import { useMemo } from "react";
import { useQueries } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import { queryKeys } from "@/lib/query-keys";

// Share status is asked for in groups of entries, in list order. Each
// request names its entries in the URL, and one request for every loaded
// entry of a long folder outgrew the server's limit for a request's header
// (431) past some 600 entries, so no entry showed its share icon. Loading
// the next page of a folder asks again only for the last group.
const SHARE_STATUS_GROUP = 100;

function sharedIdsOf(results: Array<{ data?: { data: string[] } }>): Set<string> {
  return new Set(results.flatMap((result) => result.data?.data ?? []));
}

/**
 * The IDs of these files that are shared. Only the Drive page uses it; it is
 * kept out of the Drive API module, which other pages load too.
 */
export function useFileShareStatus(wid: string, fileIds: string[]): Set<string> {
  const groups = useMemo(() => {
    const result: string[][] = [];
    for (let i = 0; i < fileIds.length; i += SHARE_STATUS_GROUP)
      result.push(fileIds.slice(i, i + SHARE_STATUS_GROUP));
    return result;
  }, [fileIds]);
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
    combine: sharedIdsOf,
  });
}
