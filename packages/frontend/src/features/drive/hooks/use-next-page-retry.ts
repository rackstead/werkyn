import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "@/lib/api-error";

const FIRST_WAIT = 2000;
const LONGEST_WAIT = 60_000;

interface NextPageRetryOptions {
  /** The last request for the next page failed. */
  failed: boolean;
  error: unknown;
  /** Pages loaded so far: a page that arrives starts the waits over. */
  pages: number;
  fetchNextPage: () => unknown;
}

/**
 * A next page that failed to load is asked for again on its own after a
 * wait: what the server asks for (Retry-After, sent with a 429 when its
 * per-address request limit is reached), otherwise 2, 4, 8 ... up to 60
 * seconds. Until then the end of the list coming into view does not ask for
 * it (`waiting`), so a refused request is not repeated at once; `retryNow`
 * asks at once. The entries loaded stay as they are throughout.
 */
export function useNextPageRetry({ failed, error, pages, fetchNextPage }: NextPageRetryOptions) {
  const failures = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [retryAt, setRetryAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    failures.current = 0;
  }, [pages]);

  useEffect(() => {
    if (!failed) {
      setRetryAt(null);
      return;
    }
    const wait =
      (error instanceof ApiError && error.retryAfterMs) ||
      Math.min(LONGEST_WAIT, FIRST_WAIT * 2 ** failures.current);
    failures.current++;
    setRetryAt(Date.now() + wait);
    setNow(Date.now());
    timer.current = setTimeout(() => {
      setRetryAt(null);
      fetchNextPage();
    }, wait);
    return () => clearTimeout(timer.current);
  }, [failed, error, fetchNextPage]);

  // A countdown while waiting.
  useEffect(() => {
    if (retryAt === null) return;
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, [retryAt]);

  const retryNow = useCallback(() => {
    clearTimeout(timer.current);
    setRetryAt(null);
    fetchNextPage();
  }, [fetchNextPage]);

  return {
    waiting: retryAt !== null,
    retryInSeconds: retryAt === null ? null : Math.max(0, Math.ceil((retryAt - now) / 1000)),
    retryNow,
  };
}
