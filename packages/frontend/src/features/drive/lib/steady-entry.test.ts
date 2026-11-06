import { describe, expect, it } from "vitest";
import { stayedEntries, steadyEntry, type ListChange } from "./steady-entry";

const list = (n: number, prefix = "e") => Array.from({ length: n }, (_, i) => `${prefix}${i}`);
// Entries seen in view, listed at these indexes before the change.
const seen = (before: readonly string[], ...keys: string[]) =>
  keys.map((key, i) => ({ key, top: 100 + i * 41, index: before.indexOf(key) }));
// The change from `before` to `after`; `changed` names the entries whose
// own data changed (renamed), when that is known.
function change(before: readonly string[], after: readonly string[], changed?: Iterable<string>): ListChange {
  const at = new Map(after.map((key, i) => [key, i]));
  const edited = changed ? new Set(changed) : undefined;
  return { before, indexOf: (key) => at.get(key), changed: edited && ((key) => edited.has(key)) };
}
const without = (keys: readonly string[], gone: readonly string[]) => keys.filter((k) => !gone.includes(k));
const kept = (before: readonly string[], view: string[], after: readonly string[], changed?: Iterable<string>) =>
  steadyEntry(seen(before, ...view), change(before, after, changed));

describe("stayedEntries", () => {
  it("keeps every entry still listed when entries were only added or removed", () => {
    const before = list(6);
    const stayed = stayedEntries(change(before, ["x", "e0", "e2", "e3", "y", "e5"]));
    expect([...stayed]).toEqual([1, 0, 1, 1, 0, 1]);
  });

  it("keeps the longest run in order, never a moved batch over the entries left", () => {
    const before = list(1000);
    // 100 entries in a row moved to the end: the other 900 stayed.
    const batch = before.slice(400, 500);
    const stayed = stayedEntries(change(before, [...without(before, batch), ...batch]));
    expect(stayed.reduce((a, b) => a + b, 0)).toBe(900);
    expect(stayed[399]).toBe(1);
    expect(stayed[450]).toBe(0);
  });

  it("prefers the entries whose data did not change, then the longest run, then the preferred", () => {
    const before = list(10);
    // e6..e9 now sort before e2..e5: as many could have moved either way
    // round. The renamed ones moved.
    const after = ["e0", "e1", "e6", "e7", "e8", "e9", "e2", "e3", "e4", "e5"];
    const renamed = ["e2", "e3", "e4", "e5"];
    expect([...stayedEntries(change(before, after, renamed))]).toEqual([1, 1, 0, 0, 0, 0, 1, 1, 1, 1]);
    // Unknown which changed: the preferred entries decide.
    const inView = new Set(["e6", "e7"]);
    expect([...stayedEntries(change(before, after), (k) => inView.has(k))]).toEqual([1, 1, 0, 0, 0, 0, 1, 1, 1, 1]);
    // Even fewer unchanged entries win over a longer run of changed ones.
    const block = ["e1", "e2", "e3", "e4", "e5", "e6"];
    const moved = ["e0", "e7", "e8", ...block, "e9"];
    expect([...stayedEntries(change(before, moved, block))]).toEqual([1, 0, 0, 0, 0, 0, 0, 1, 1, 1]);
  });

  it("takes O(n log n): 5,000 entries shuffled in a few milliseconds", () => {
    const before = list(5000);
    const after = [...before];
    let seed = 7;
    for (let i = after.length - 1; i > 0; i--) {
      seed = (seed * 16807) % 2147483647;
      const j = seed % (i + 1);
      [after[i], after[j]] = [after[j], after[i]];
    }
    const started = performance.now();
    const stayed = stayedEntries(change(before, after));
    expect(performance.now() - started).toBeLessThan(200);
    // An increasing run: the indexes now of the entries kept increase.
    const now = new Map(after.map((k, i) => [k, i]));
    const run = before.filter((_, i) => stayed[i]).map((k) => now.get(k)!);
    expect(run.every((n, i) => i === 0 || n > run[i - 1])).toBe(true);
    expect(run.length).toBeGreaterThan(100);
  });
});

describe("steadyEntry", () => {
  it("keeps the first entry in view when entries are added or removed above", () => {
    const before = list(10);
    expect(kept(before, ["e5", "e6", "e7"], ["x", "y", ...before])).toMatchObject({ key: "e5", now: 7, top: 100 });
    expect(kept(before, ["e5", "e6", "e7"], before.slice(3))).toMatchObject({ key: "e5", now: 2 });
  });

  it("skips an entry that is no longer listed", () => {
    const before = list(10);
    expect(kept(before, ["e5", "e6", "e7"], without(before, ["e5"]))).toMatchObject({ key: "e6", now: 5, top: 141 });
  });

  it("does not keep an entry that moved on its own", () => {
    const before = list(10);
    // e5 was renamed and now sorts at the top.
    expect(kept(before, ["e5", "e6", "e7", "e8"], ["e5", ...without(before, ["e5"])], ["e5"])?.key).toBe("e6");
    // e5 moved two places down, still in view: e8 and the rest stay.
    const longer = list(12);
    const down = ["e0", "e1", "e2", "e3", "e4", "e6", "e7", "e5", "e8", "e9", "e10", "e11"];
    const view = ["e5", "e6", "e7", "e8", "e9", "e10", "e11"];
    expect(kept(longer, view, down, ["e5"])).toMatchObject({ key: "e8", now: 8 });
    // The same without knowing which entry changed.
    expect(kept(longer, view, down)?.key).toBe("e8");
  });

  it("keeps the others when two entries in view swap places", () => {
    const before = list(20);
    const after = [...before];
    [after[8], after[12]] = [after[12], after[8]];
    const view = before.slice(6, 16);
    expect(kept(before, view, after, ["e8", "e12"])).toMatchObject({ key: "e6", now: 6 });
    expect(kept(before, view, after)).toMatchObject({ key: "e6", now: 6 });
  });

  it("keeps the side with more entries when one in view is added or removed", () => {
    const before = list(10);
    const view = ["e3", "e4", "e5", "e6", "e7"];
    // Removed near the bottom of the view: the entries above it stay.
    expect(kept(before, view, without(before, ["e6"]))?.key).toBe("e3");
    // Added near its top: the entries below it stay.
    expect(kept(before, view, ["e0", "e1", "e2", "e3", "new", "e4", "e5", "e6", "e7", "e8", "e9"])?.key).toBe("e4");
    // A tie goes to the top.
    expect(kept(before, ["e3", "e4"], ["e0", "e1", "e2", "e3", "new", "e4"])?.key).toBe("e3");
  });

  it("prefers an entry of the side kept that is still rendered", () => {
    const before = list(10);
    const view = seen(before, "e5", "e6", "e7");
    const after = change(before, ["x", "y", ...before]);
    expect(steadyEntry(view, after, (key) => key !== "e5")).toMatchObject({ key: "e6", now: 8 });
    // None rendered: the first of the side.
    expect(steadyEntry(view, after, () => false)).toMatchObject({ key: "e5", now: 7 });
  });

  it("finds nothing when no entry stayed", () => {
    expect(kept(list(4), ["e1", "e2"], ["a", "b"])).toBeUndefined();
    expect(steadyEntry([], change(list(4), list(4)))).toBeUndefined();
  });

  describe("in a long folder", () => {
    // 5,000 entries; 18 in view (e2500 to e2517).
    const before = list(5000);
    const view = before.slice(2500, 2518);
    const far = (block: readonly string[], after = without(before, block)) => [...after, ...block];

    it("keeps the entries left when the top block of the view sorts at the end (R0)", () => {
      const block = before.slice(2500, 2514);
      expect(kept(before, view, far(block), block)).toMatchObject({ key: "e2514", now: 2500, top: 100 + 14 * 41 });
      expect(kept(before, view, far(block))).toMatchObject({ key: "e2514", now: 2500 });
    });

    it("keeps the entries left when the top block sorts far above (R0)", () => {
      const block = before.slice(2500, 2514);
      const after = without(before, block);
      after.splice(100, 0, ...block);
      expect(kept(before, view, after, block)).toMatchObject({ key: "e2514", now: 2514 });
    });

    it("keeps the entries above a block below them that sorts at the end (R0)", () => {
      const block = before.slice(2502, 2516);
      expect(kept(before, view, far(block), block)).toMatchObject({ key: "e2500", now: 2500 });
    });

    it("keeps the entries left when the block is removed, moved out or trashed (R0)", () => {
      const block = before.slice(2500, 2514);
      expect(kept(before, view, without(before, block))).toMatchObject({ key: "e2514", now: 2500 });
    });

    it("keeps the entries left when the block and the 5 above it sort far below (R1 spanAbove)", () => {
      const block = before.slice(2495, 2514);
      expect(kept(before, view, far(block), block)).toMatchObject({ key: "e2514", now: 2495 });
      expect(kept(before, view, far(block))).toMatchObject({ key: "e2514", now: 2495 });
    });

    it("keeps the entries left when 8 above and half the view sort far below (R1 spanAboveHalf)", () => {
      const block = before.slice(2492, 2509);
      expect(kept(before, view, far(block), block)).toMatchObject({ key: "e2509", now: 2492 });
    });

    it("keeps the top of the view when its bottom and the 5 below sort far below (R1 spanBelow)", () => {
      const block = before.slice(2504, 2523);
      expect(kept(before, view, far(block), block)).toMatchObject({ key: "e2500", now: 2500 });
      expect(kept(before, view, far(block))).toMatchObject({ key: "e2500", now: 2500 });
    });

    it("keeps the entries left when the neighbours on both sides move too (R1 neighboursMove)", () => {
      const up = before.slice(2495, 2500);
      const down = before.slice(2518, 2523);
      const block = before.slice(2500, 2514);
      const after = [...up, ...without(before, [...up, ...down, ...block]), ...down, ...block];
      expect(kept(before, view, after, [...up, ...down, ...block])).toMatchObject({ key: "e2514", now: 2500 });
    });

    it("keeps the entries left through renames, trashes and creates in one refresh (R1 mixed)", () => {
      const trashed = [...before.slice(2460, 2463), before[2516]];
      const block = before.slice(2495, 2514);
      const after = ["n0", "n1", ...without(before, [...trashed, ...block]), ...block];
      // 3 trashed and 2 created above: 1 place up; 5 above renamed away: 5 more.
      expect(kept(before, view, after, block)).toMatchObject({ key: "e2514", now: 2514 - 1 - 5 - 14 });
    });

    it("keeps the entries left when a 7-entry block and the 5 above sort far below (R1 span7)", () => {
      const block = before.slice(2495, 2507);
      expect(kept(before, view, far(block), block)).toMatchObject({ key: "e2507", now: 2495 });
    });

    it("does not follow one entry that lands near its old place while entries were added above", () => {
      // 30 added above the view; the first entry in view is renamed so that
      // it sorts 30 places earlier, about where it was.
      const added = list(30, "n");
      const after = [...added, ...without(before, ["e2500"])];
      after.splice(2500, 0, "e2500");
      expect(kept(before, view, after, ["e2500"])).toMatchObject({ key: "e2501", now: 2531 });
      expect(kept(before, view, after)).toMatchObject({ key: "e2501", now: 2531 });
    });

    it("keeps the larger side of an entry added in view", () => {
      const early = [...before];
      early.splice(2503, 0, "new");
      expect(kept(before, view, early)?.key).toBe("e2503");
      const late = [...before];
      late.splice(2515, 0, "new");
      expect(kept(before, view, late)?.key).toBe("e2500");
    });

    it("keeps the entries left when 500 were added above and the top block sorts at the end", () => {
      const block = before.slice(2500, 2514);
      const added = list(500, "n");
      expect(kept(before, view, [...added, ...without(before, block), ...block], block)).toMatchObject({
        key: "e2514",
        now: 3000,
      });
      expect(kept(before, view, [...added, ...before])).toMatchObject({ key: "e2500", now: 3000 });
    });
  });

  describe("at the end of the list", () => {
    it("keeps the 4 entries left when the top 14 in view sort last in a 40-entry folder (R1 small)", () => {
      const before = list(40);
      const view = before.slice(22, 40);
      const block = before.slice(22, 36);
      const after = [...without(before, block), ...block];
      // The renamed entries moved 4 places, those left 14: the renamed ones moved.
      expect(kept(before, view, after, block)).toMatchObject({ key: "e36", now: 22 });
      // With the 5 above the view in the block too.
      const wider = before.slice(17, 36);
      expect(kept(before, view, [...without(before, wider), ...wider], wider)).toMatchObject({ key: "e36", now: 17 });
      // Without knowing which entries changed, the order alone cannot tell:
      // the larger group is taken to have stayed.
      expect(kept(before, view, after)?.key).toBe("e22");
    });

    it("keeps the entry nearest above the view when every entry seen went to the next page", () => {
      // 30 added above the end of a 100-entry list of 2 pages; the list
      // still holds 100 entries, so the 30 last went to the next page.
      const before = list(100);
      const view = before.slice(82, 100);
      const after = [...list(30, "n"), ...before].slice(0, 100);
      expect(kept(before, view, after)).toEqual({ key: "e69", index: 69, now: 99 });
      // The nearest one that stayed: one renamed to sort at the top is passed over.
      const renamed = [...list(30, "n"), "e69", ...without(before, ["e69"])].slice(0, 100);
      expect(kept(before, view, renamed, ["e69"])).toEqual({ key: "e68", index: 68, now: 99 });
    });

    it("keeps the entries left when the next page brings entries pushed out of view", () => {
      // The bottom 5 of the view were pushed to the next page by 5 added above.
      const before = list(60);
      const view = before.slice(42, 60);
      const after = [...list(5, "n"), ...before].slice(0, 60);
      expect(kept(before, view, after)).toMatchObject({ key: "e42", now: 47 });
    });
  });
});
