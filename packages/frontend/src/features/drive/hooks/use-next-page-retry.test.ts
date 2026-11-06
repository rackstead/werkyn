import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api-error";
import { NEXT_PAGE_RETRIES, useNextPageRetry } from "./use-next-page-retry";

const refused = (retryAfterMs?: number) => {
  const error = new ApiError(429, "Too Many Requests", "Rate limit exceeded");
  error.retryAfterMs = retryAfterMs;
  return error;
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function setup() {
  const fetchNextPage = vi.fn();
  const view = renderHook(
    (props: { listKey: string; failed: boolean; error: unknown; pages: number }) =>
      useNextPageRetry({ ...props, fetchNextPage }),
    { initialProps: { listKey: "a", failed: false, error: null as unknown, pages: 1 } },
  );
  return { fetchNextPage, ...view };
}

describe("useNextPageRetry", () => {
  it("asks again after the server's Retry-After, and not before", () => {
    const { fetchNextPage, result, rerender } = setup();
    rerender({ listKey: "a", failed: true, error: refused(30_000), pages: 1 });
    expect(result.current.waiting).toBe(true);
    expect(result.current.retryInSeconds).toBe(30);
    act(() => vi.advanceTimersByTime(29_000));
    expect(fetchNextPage).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1_000));
    expect(fetchNextPage).toHaveBeenCalledTimes(1);
    expect(result.current.waiting).toBe(false);
  });

  it("waits 2, 4, 8 ... seconds without Retry-After, five times at most", () => {
    const { fetchNextPage, result, rerender } = setup();
    const waits: number[] = [];
    for (let attempt = 0; attempt < NEXT_PAGE_RETRIES + 1; attempt++) {
      rerender({ listKey: "a", failed: true, error: refused(), pages: 1 });
      waits.push(result.current.retryInSeconds ?? 0);
      act(() => vi.advanceTimersByTime(60_000));
    }
    expect(waits).toEqual([2, 4, 8, 16, 32, 0]);
    expect(fetchNextPage).toHaveBeenCalledTimes(NEXT_PAGE_RETRIES);
    expect(result.current.waiting).toBe(false);
    // "Try again" still asks.
    act(() => result.current.retryNow());
    expect(fetchNextPage).toHaveBeenCalledTimes(NEXT_PAGE_RETRIES + 1);
  });

  it("starts over for another listing, or once a page arrives", () => {
    const { result, rerender } = setup();
    for (let attempt = 0; attempt < 3; attempt++) {
      rerender({ listKey: "a", failed: true, error: refused(), pages: 1 });
      act(() => vi.advanceTimersByTime(60_000));
    }
    rerender({ listKey: "b", failed: false, error: null, pages: 1 });
    rerender({ listKey: "b", failed: true, error: refused(), pages: 1 });
    expect(result.current.retryInSeconds).toBe(2);
    act(() => vi.advanceTimersByTime(60_000));
    rerender({ listKey: "b", failed: true, error: refused(), pages: 1 });
    expect(result.current.retryInSeconds).toBe(4);
    act(() => vi.advanceTimersByTime(60_000));
    rerender({ listKey: "b", failed: false, error: null, pages: 2 });
    rerender({ listKey: "b", failed: true, error: refused(), pages: 2 });
    expect(result.current.retryInSeconds).toBe(2);
  });

  it("does not ask again on its own for a request the server rejected for what it asked", () => {
    const { fetchNextPage, result, rerender } = setup();
    rerender({ listKey: "a", failed: true, error: new ApiError(403, "Forbidden", "No access"), pages: 1 });
    expect(result.current.waiting).toBe(false);
    act(() => vi.advanceTimersByTime(120_000));
    expect(fetchNextPage).not.toHaveBeenCalled();
    // A failure without an answer (network) is asked again.
    rerender({ listKey: "a", failed: true, error: new TypeError("Failed to fetch"), pages: 1 });
    expect(result.current.waiting).toBe(true);
  });
});
