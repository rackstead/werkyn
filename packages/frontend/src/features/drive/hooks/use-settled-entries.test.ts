import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SETTLE_GAP_MS, SETTLE_MS, useSettledEntries } from "./use-settled-entries";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const setup = () =>
  renderHook(({ listKey, viewKey }) => useSettledEntries(listKey, viewKey), {
    initialProps: { listKey: "a", viewKey: "list" },
  });

describe("useSettledEntries", () => {
  it("counts the first report at once, later ones once scrolling settles, at most every few seconds", () => {
    const { result } = setup();
    expect(result.current.entriesInView).toBeNull();
    act(() => result.current.onVisibleEntries(0, 20));
    expect(result.current.entriesInView).toEqual([0, 20]);
    // Scrolling on: nothing counts while reports keep coming.
    act(() => result.current.onVisibleEntries(10, 30));
    act(() => vi.advanceTimersByTime(500));
    act(() => result.current.onVisibleEntries(20, 40));
    act(() => vi.advanceTimersByTime(SETTLE_MS - 1));
    expect(result.current.entriesInView).toEqual([0, 20]);
    // Settled, but not yet four seconds after the last one counted.
    act(() => vi.advanceTimersByTime(SETTLE_GAP_MS - 500 - SETTLE_MS));
    expect(result.current.entriesInView).toEqual([0, 20]);
    act(() => vi.advanceTimersByTime(1));
    expect(result.current.entriesInView).toEqual([20, 40]);
    // Long after: a second without a change is enough.
    act(() => vi.advanceTimersByTime(10_000));
    act(() => result.current.onVisibleEntries(100, 120));
    act(() => vi.advanceTimersByTime(SETTLE_MS));
    expect(result.current.entriesInView).toEqual([100, 120]);
  });

  it("counts the first report of another view or listing at once", () => {
    const { result, rerender } = setup();
    act(() => result.current.onVisibleEntries(0, 20));
    act(() => result.current.onVisibleEntries(500, 520));
    // The grid is shown at the same place in the same listing.
    rerender({ listKey: "a", viewKey: "grid" });
    act(() => result.current.onVisibleEntries(495, 524));
    expect(result.current.entriesInView).toEqual([495, 524]);
    // Another folder: nothing known until its views report.
    rerender({ listKey: "b", viewKey: "grid" });
    expect(result.current.entriesInView).toBeNull();
    act(() => result.current.onVisibleEntries(0, 29));
    expect(result.current.entriesInView).toEqual([0, 29]);
  });
});
