import { describe, expect, it } from "vitest";
import { steadyRows } from "./steady-row";

// Rows seen in view top to bottom as [key, index then, index now]; a row no
// longer in the List has `undefined` now.
function keep(...rows: Array<[string, number, number | undefined]>) {
  return order(...rows)[0];
}
// All the rows that stayed, in the order they would be kept.
function order(...rows: Array<[string, number, number | undefined]>) {
  const now = new Map(rows.map(([key, , index]) => [key, index]));
  return steadyRows(
    rows.map(([key, index], i) => ({ key, index, top: i * 41 })),
    (key) => now.get(key),
  ).map((row) => row.key);
}
// Rows k..k+n-1 seen at indexes from..from+n-1.
const block = (prefix: string, from: number, count: number, shift: number) =>
  Array.from({ length: count }, (_, i): [string, number, number] => [`${prefix}${i}`, from + i, from + i + shift]);

describe("steadyRows", () => {
  it("uses the whole-list order instead of following a moved row whose index was offset by inserts", () => {
    const before = Array.from({ length: 100 }, (_, i) => `r${i}`);
    const after = [...Array.from({ length: 30 }, (_, i) => `new${i}`), ...before.filter((key) => key !== "r40")];
    after.splice(40, 0, "r40");
    const now = new Map(after.map((key, index) => [key, index]));
    const seen = before.slice(40, 60).map((key, i) => ({ key, index: i + 40, top: i * 41 }));
    expect(steadyRows(seen, (key) => now.get(key), { before, changed: (key) => key === "r40" })[0].key).toBe("r41");
  });

  it("keeps the first row when rows were added or removed above the view", () => {
    expect(keep(...block("r", 100, 20, 3))).toBe("r0");
    expect(keep(...block("r", 100, 20, -2))).toBe("r0");
    // 50 rows moved in from below to above the view at once.
    expect(keep(...block("r", 100, 20, 50))).toBe("r0");
  });

  it("keeps the first row when the List got shorter at its end (deletions above)", () => {
    expect(keep(...block("r", 4980, 20, -1))).toBe("r0");
  });

  it("keeps the second row when the top row moved three places down (as with every row rendered)", () => {
    // a 100 -> 103; b, c, d move up one; e onwards stay.
    expect(keep(["a", 100, 103], ["b", 101, 100], ["c", 102, 101], ["d", 103, 102], ...block("e", 104, 16, 0))).toBe("b");
  });

  it("keeps the first row when a later row moved", () => {
    expect(keep(["a", 10, 10], ["b", 11, 14], ["c", 12, 11], ["d", 13, 12], ["e", 14, 13], ["f", 15, 15])).toBe("a");
  });

  it("keeps the rows after two that swapped places", () => {
    expect(keep(["a", 1, 2], ["b", 2, 1], ["c", 3, 3], ["d", 4, 4])).toBe("c");
    expect(keep(["a", 1, 1], ["b", 2, 2], ["c", 3, 4], ["d", 4, 3], ["e", 5, 5])).toBe("a");
  });

  it("keeps the next row when the top row in view was deleted and the one after moved down", () => {
    // p stays, x deleted, y moved down 3, the rest move up.
    expect(keep(["p", 200, 200], ["x", 201, undefined], ["y", 202, 204], ["z", 203, 201], ["w", 204, 202], ["v", 205, 203], ["u", 206, 205])).toBe("p");
  });

  it("keeps the top row when rows below it moved to other groups", () => {
    // r1 moved to the top of the first group (far above), r4 to the top of the last (far below).
    expect(keep(["r0", 2000, 2001], ["r1", 2001, 10], ["r2", 2002, 2002], ["r3", 2003, 2003], ["r4", 2004, 4100], ["r5", 2005, 2004], ["r6", 2006, 2005])).toBe("r0");
  });

  it("keeps the rows that stayed when the top block of the view moved far below (H3)", () => {
    // The top 14 rows moved to the last group; the 6 below them move up by 14.
    const moved = Array.from({ length: 14 }, (_, i): [string, number, number] => [`m${i}`, 3490 + i, 4900 + i]);
    expect(keep(...moved, ...block("s", 3504, 6, -14))).toBe("s0");
    // The same with an unmoved row above the block.
    expect(keep(["top", 3489, 3489], ...moved, ...block("s", 3504, 6, -14))).toBe("top");
  });

  it("keeps the rows that stayed when the top block of the view moved far above", () => {
    // The top 14 rows moved to the first group: still in order with the rows below them.
    const moved = Array.from({ length: 14 }, (_, i): [string, number, number] => [`m${i}`, 3490 + i, 5 + i]);
    expect(keep(...moved, ...block("s", 3504, 6, 0))).toBe("s0");
  });

  it("keeps the rows above a block that left the middle of the view", () => {
    // Rows above and below the block both stayed; one side has to move, and
    // as with the browser's anchoring the rows above are kept. (The List
    // only counts rows at least half in view, so a sliver of a row above a
    // block at the top of the view is not kept: see task-table.)
    const moved = Array.from({ length: 14 }, (_, i): [string, number, number] => [`m${i}`, 100 + i, 4990 + i]);
    expect(keep(["t", 99, 99], ...moved, ...block("s", 114, 6, -14))).toBe("t");
  });

  it("lists the other rows that stayed after the first, so a rendered one can be kept", () => {
    // Nothing moved: every row, in order.
    expect(order(...block("r", 100, 4, 0))).toEqual(["r0", "r1", "r2", "r3"]);
    // A swap at the top: the rows after the pair, then the pair.
    expect(order(["a", 1, 2], ["b", 2, 1], ["c", 3, 3], ["d", 4, 4])).toEqual(["c", "d", "a", "b"]);
    // The top block moved far below: only the rows that stayed.
    const moved = Array.from({ length: 4 }, (_, i): [string, number, number] => [`m${i}`, 10 + i, 900 + i]);
    expect(order(...moved, ...block("s", 14, 3, -4))).toEqual(["s0", "s1", "s2"]);
  });

  it("skips rows that are no longer in the List", () => {
    expect(keep(["a", 7, undefined], ["b", 8, 7], ["c", 9, 8])).toBe("b");
    expect(keep(["a", 7, undefined], ["b", 8, undefined])).toBeUndefined();
  });
});
