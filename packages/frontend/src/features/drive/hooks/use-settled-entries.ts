import { useCallback, useEffect, useRef, useState } from "react";
import type { EntriesInView } from "./use-file-share-status";

// Scrolling has settled when the entries in view have not changed for this
// long, and settles at most this often.
export const SETTLE_MS = 1000;
export const SETTLE_GAP_MS = 4000;

/**
 * The entries in view once scrolling settles, for the listing `listKey`
 * shown in the view `viewKey` (list or grid). The views report the entries
 * in view as they change (`onVisibleEntries`); a report counts once a
 * second has passed without another, and no sooner than four seconds after
 * the last that counted, so that short pauses while skimming do not count
 * page by page. The first report of a listing or a view counts at once.
 * Another listing starts with none known.
 */
export function useSettledEntries(listKey: string, viewKey: string) {
  const [settled, setSettled] = useState<{ listKey: string; range: EntriesInView } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const reportedFor = useRef<string | null>(null);
  const settledAt = useRef(0);

  const onVisibleEntries = useCallback(
    (first: number, last: number) => {
      clearTimeout(timer.current);
      const settle = () => {
        settledAt.current = Date.now();
        setSettled((current) =>
          current?.listKey === listKey && current.range[0] === first && current.range[1] === last
            ? current
            : { listKey, range: [first, last] },
        );
      };
      const reportKey = `${viewKey}\n${listKey}`;
      if (reportedFor.current !== reportKey) {
        reportedFor.current = reportKey;
        settle();
        return;
      }
      timer.current = setTimeout(
        settle,
        Math.max(SETTLE_MS, settledAt.current + SETTLE_GAP_MS - Date.now()),
      );
    },
    [listKey, viewKey],
  );
  useEffect(() => () => clearTimeout(timer.current), []);

  return {
    onVisibleEntries,
    entriesInView: settled?.listKey === listKey ? settled.range : null,
  };
}
