import { describe, expect, it } from "vitest";
import { steadyEntry } from "./steady-entry";

// Entries seen in view, listed at these indexes before the change.
const seen = (before: string[], ...keys: string[]) =>
  keys.map((key, i) => ({ key, top: 100 + i * 41, index: before.indexOf(key) }));
const at = (...keys: string[]) => (key: string) => {
  const index = keys.indexOf(key);
  return index === -1 ? undefined : index;
};
const list = (n: number) => Array.from({ length: n }, (_, i) => `e${i}`);

describe("steadyEntry", () => {
  it("keeps the first entry in view when entries are added or removed above", () => {
    const before = list(10);
    const view = seen(before, "e5", "e6", "e7");
    expect(steadyEntry(view, at("x", "y", ...before))).toEqual({ ...view[0], now: 7 });
    expect(steadyEntry(view, at(...before.slice(3)))).toEqual({ ...view[0], now: 2 });
  });

  it("skips an entry that is no longer listed", () => {
    const before = list(10);
    const view = seen(before, "e5", "e6", "e7");
    expect(steadyEntry(view, at(...before.filter((k) => k !== "e5")))).toEqual({ ...view[1], now: 5 });
  });

  it("does not keep an entry that moved on its own", () => {
    const before = list(10);
    const view = seen(before, "e5", "e6", "e7", "e8");
    // e5 was renamed and now sorts at the top.
    const renamed = ["e5", ...before.filter((k) => k !== "e5")];
    expect(steadyEntry(view, at(...renamed))?.key).toBe("e6");
    // e5 moved two places down, still in view: e8 and the rest stay.
    const longer = list(12);
    const down = ["e0", "e1", "e2", "e3", "e4", "e6", "e7", "e5", "e8", "e9", "e10", "e11"];
    const all = seen(longer, "e5", "e6", "e7", "e8", "e9", "e10", "e11");
    expect(steadyEntry(all, at(...down))?.key).toBe("e8");
  });

  it("keeps the side with more entries when one in view is added or removed", () => {
    const before = list(10);
    const view = seen(before, "e3", "e4", "e5", "e6", "e7");
    // Removed near the bottom of the view: the entries above it stay.
    expect(steadyEntry(view, at(...before.filter((k) => k !== "e6")))?.key).toBe("e3");
    // Added near its top: the entries below it stay.
    const added = ["e0", "e1", "e2", "e3", "new", "e4", "e5", "e6", "e7", "e8", "e9"];
    expect(steadyEntry(view, at(...added))?.key).toBe("e4");
    // A tie goes to the top.
    expect(steadyEntry(seen(before, "e3", "e4"), at("e0", "e1", "e2", "e3", "new", "e4"))?.key).toBe("e3");
  });

  it("finds nothing when no entry seen is listed", () => {
    expect(steadyEntry(seen(list(4), "e1", "e2"), at("a", "b"))).toBeUndefined();
    expect(steadyEntry([], at("a"))).toBeUndefined();
  });
});
