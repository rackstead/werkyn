import { describe, expect, it } from "vitest";
import { steadyRow } from "./steady-row";

// Rows seen in view top to bottom as [key, index then, index now]; a row no
// longer in the List has `undefined` now.
function keep(...rows: Array<[string, number, number | undefined]>) {
  const now = new Map(rows.map(([key, , index]) => [key, index]));
  return steadyRow(
    rows.map(([key, index], i) => ({ key, index, top: i * 41 })),
    (key) => now.get(key),
  )?.key;
}
// Rows k..k+n-1 seen at indexes from..from+n-1.
const block = (prefix: string, from: number, count: number, shift: number) =>
  Array.from({ length: count }, (_, i): [string, number, number] => [`${prefix}${i}`, from + i, from + i + shift]);

describe("steadyRow", () => {
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

  it("skips rows that are no longer in the List", () => {
    expect(keep(["a", 7, undefined], ["b", 8, 7], ["c", 9, 8])).toBe("b");
    expect(keep(["a", 7, undefined], ["b", 8, undefined])).toBeUndefined();
  });
});
