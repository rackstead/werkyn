import { describe, expect, it } from "vitest";
import { steadyRow, type SeenRow } from "./steady-row";

const seen = (...keys: string[]): SeenRow[] => keys.map((key, i) => ({ key, top: i * 41 }));
const indexes = (map: Record<string, number>) => (key: string) => map[key];

describe("steadyRow", () => {
  it("keeps the first row when rows were added or removed above the view", () => {
    // Three rows added above: every seen row moved down by three.
    expect(steadyRow(seen("a", "b", "c"), indexes({ a: 13, b: 14, c: 15 }))).toEqual({
      key: "a", top: 0, index: 13,
    });
  });

  it("skips the first row when it was moved down within the view", () => {
    // a moved three places down: b, c, d each moved up by one.
    const row = steadyRow(seen("a", "b", "c", "d", "e"), indexes({ a: 13, b: 10, c: 11, d: 12, e: 14 }));
    expect(row?.key).toBe("b");
    expect(row?.index).toBe(10);
  });

  it("keeps the first row when a later row was moved", () => {
    // b moved three places down: a stays, c, d, e move up by one.
    expect(steadyRow(seen("a", "b", "c", "d", "e", "f"), indexes({ a: 10, b: 14, c: 11, d: 12, e: 13, f: 15 }))?.key).toBe("a");
  });

  it("skips rows that are no longer in the List", () => {
    expect(steadyRow(seen("a", "b", "c"), indexes({ b: 7, c: 8 }))?.key).toBe("b");
    expect(steadyRow(seen("a", "b"), indexes({}))).toBeUndefined();
  });

  it("keeps the first row when a row was moved up into the view from below", () => {
    // A row from below moved to between b and c: c and later moved down by one.
    expect(steadyRow(seen("a", "b", "c", "d"), indexes({ a: 5, b: 6, c: 8, d: 9 }))?.key).toBe("a");
  });
});
