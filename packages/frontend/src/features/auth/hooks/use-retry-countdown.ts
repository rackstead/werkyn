import { useEffect, useState } from "react";
import { ApiError } from "@/lib/api-error";

/** The wait a 429 asked for (Retry-After), or 0 when there is none. */
export function retryWait(error: unknown): number {
  return error instanceof ApiError && error.statusCode === 429
    ? (error.retryAfter ?? 0)
    : 0;
}

/**
 * Whole seconds left before a request refused with 429 and Retry-After may
 * be sent again, counting down to 0. A new error restarts the count.
 */
export function useRetryCountdown(error: unknown): number {
  const seconds = retryWait(error);
  const [shown, setShown] = useState({ error, left: seconds });
  if (shown.error !== error) setShown({ error, left: seconds });

  useEffect(() => {
    if (seconds <= 0) return;
    const until = Date.now() + seconds * 1000;
    const timer = setInterval(() => {
      const left = Math.max(0, Math.ceil((until - Date.now()) / 1000));
      setShown((current) =>
        current.error === error ? { error, left } : current,
      );
      if (left === 0) clearInterval(timer);
    }, 250);
    return () => clearInterval(timer);
  }, [error, seconds]);

  return shown.error === error ? shown.left : seconds;
}
