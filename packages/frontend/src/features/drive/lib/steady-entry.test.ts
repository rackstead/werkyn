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

  describe("a block of entries in view that sorts far away now", () => {
    // 5,000 entries; 18 in view (e2500 to e2517), 5 more listed on each side.
    const before = Array.from({ length: 5000 }, (_, i) => `e${i}`);
    const view = seen(before, ...before.slice(2500, 2518));
    const around = [...before.slice(2495, 2500), ...before.slice(2518, 2523)].map((key) => ({
      key,
      index: before.indexOf(key),
    }));
    const without = (block: string[]) => before.filter((k) => !block.includes(k));

    it("keeps the entries that stayed among their neighbours", () => {
      const block = before.slice(2500, 2514);
      const after = at(...without(block), ...block);
      expect(steadyEntry(view, after, () => true, around)).toEqual({ ...view[14], now: 2500 });
      // Sorting far above instead.
      const above = without(block);
      above.splice(100, 0, ...block);
      expect(steadyEntry(view, at(...above), () => true, around)?.key).toBe("e2514");
    });

    it("does not follow one entry that lands near its old place while entries were added above", () => {
      // 30 added above the view; the first entry in view is renamed so that
      // it sorts 30 places earlier, about where it was.
      const added = Array.from({ length: 30 }, (_, i) => `n${i}`);
      const after = [...added, ...before.filter((k) => k !== "e2500")];
      after.splice(2500, 0, "e2500");
      const kept = steadyEntry(view, at(...after), () => true, around);
      expect(kept).toEqual({ ...view[1], now: 2531 });
    });

    it("keeps the larger side of an entry added in view", () => {
      const after = [...before];
      after.splice(2503, 0, "new");
      expect(steadyEntry(view, at(...after), () => true, around)?.key).toBe("e2503");
      const late = [...before];
      late.splice(2515, 0, "new");
      expect(steadyEntry(view, at(...late), () => true, around)?.key).toBe("e2500");
    });

    it("keeps the entries that stayed when the top block sorts at the end", () => {
      const block = before.slice(2500, 2514);
      const kept = steadyEntry(view, at(...without(block), ...block));
      expect(kept).toEqual({ ...view[14], now: 2500 });
    });

    it("keeps the entries above the block when it sorts at the end", () => {
      const block = before.slice(2502, 2516);
      const kept = steadyEntry(view, at(...without(block), ...block));
      expect(kept).toEqual({ ...view[0], now: 2500 });
    });

    it("keeps the entries that stayed when the top block sorts far above", () => {
      const block = before.slice(2500, 2514);
      const after = without(block);
      after.splice(100, 0, ...block);
      expect(steadyEntry(view, at(...after))?.key).toBe("e2514");
    });

    it("keeps the entries left when the block is removed", () => {
      const block = before.slice(2500, 2514);
      expect(steadyEntry(view, at(...without(block)))).toEqual({ ...view[14], now: 2500 });
    });

    it("keeps the group that moved least when every group moved far", () => {
      // 500 added above the view, and the top block renamed to the end.
      const block = before.slice(2500, 2514);
      const added = Array.from({ length: 500 }, (_, i) => `n${i}`);
      const kept = steadyEntry(view, at(...added, ...without(block), ...block));
      expect(kept).toEqual({ ...view[14], now: 3000 });
      // 500 added above alone: the first entry seen.
      expect(steadyEntry(view, at(...added, ...before))).toEqual({ ...view[0], now: 3000 });
    });
  });

  it("prefers an entry of the group kept that is still rendered", () => {
    const before = list(10);
    const view = seen(before, "e5", "e6", "e7");
    const after = at("x", "y", ...before);
    expect(steadyEntry(view, after, (key) => key !== "e5")).toEqual({ ...view[1], now: 8 });
    // None rendered: the first of the group.
    expect(steadyEntry(view, after, () => false)).toEqual({ ...view[0], now: 7 });
  });

  it("finds nothing when no entry seen is listed", () => {
    expect(steadyEntry(seen(list(4), "e1", "e2"), at("a", "b"))).toBeUndefined();
    expect(steadyEntry([], at("a"))).toBeUndefined();
  });
});
