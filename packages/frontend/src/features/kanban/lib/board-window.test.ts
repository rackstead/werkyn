import { describe, expect, it } from "vitest";
import {
  columnIndexAt,
  dropPositionFromOver,
  indexAtOffset,
  keptBoardCards,
  movePosition,
  previewBoardMove,
  resolveBoardDrop,
  type BoardDropColumn,
} from "./board-window";
import { assembleBoardColumns, type BoardWindowResponse } from "./use-board-columns";
import type { Task } from "@/features/tasks/api";

function ids(count: number, prefix = "t") {
  return Array.from({ length: count }, (_, index) => `${prefix}${index}`);
}

function column(
  statusId: string,
  order: readonly string[],
  columnIndex = new Map(order.map((id, index) => [id, index])),
  aligned = true,
  size = aligned ? order.length : columnIndex.size,
): BoardDropColumn {
  return { statusId, size, order, columnIndex, aligned };
}

function task(id: string, statusId: string, columnIndex: number): Task & { columnIndex: number } {
  return {
    id,
    projectId: "p",
    statusId,
    title: id,
    description: null,
    priority: "NONE",
    dueDate: null,
    startDate: null,
    position: columnIndex,
    archived: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    assignees: [],
    labels: [],
    status: { id: statusId, name: statusId, color: null, isCompletion: false },
    customFieldValues: [],
    _count: { subtasks: 0, blockedBy: 0 },
    columnIndex,
  };
}

describe("board drop index", () => {
  it("uses the card's index in the whole column, not its place in the mounted window", () => {
    const order = ids(200);
    const mounted = order.slice(0, 24);
    expect(mounted).not.toContain("t80");
    // Dragging the first card onto a card that is not mounted.
    const drop = dropPositionFromOver([column("open", order)], "t0", "t80");
    expect(drop).toEqual({ statusId: "open", position: 80 });
    // A window-local index (t80 is the 0th mounted card of a window around it,
    // or "not found, so append at the mounted length") would not be 80.
    expect(drop?.position).not.toBe(mounted.length);
  });

  it("maps a pointer past the mounted window to that absolute slot", () => {
    const order = ids(2000);
    const slot = indexAtOffset(80 * 92 + 10, order.length, 92);
    expect(slot).toBe(80);
    const drop = dropPositionFromOver(
      [column("open", order)],
      "t3",
      "open",
      { statusId: "open", slot },
    );
    expect(drop).toEqual({ statusId: "open", position: 80 });
  });

  it("appends at the end of the whole column", () => {
    const order = ids(50);
    const drop = dropPositionFromOver(
      [column("open", order)],
      "t1",
      "open",
      { statusId: "open", slot: order.length },
    );
    expect(drop?.position).toBe(49);
  });

  it("inserts into another column at that column's index", () => {
    const open = column("open", ids(10));
    const done = column("done", ids(6, "d"));
    const drop = dropPositionFromOver([open, done], "t2", "d4");
    expect(drop).toEqual({ statusId: "done", position: 4 });
    expect(movePosition({ statusId: "open", columnIndex: 2 }, "done", 6, 6)).toBe(6);
  });

  it("uses columnIndex when a filter hides tasks between the visible cards", () => {
    const open = column(
      "open",
      ["a", "c"],
      new Map([["a", 0], ["c", 50]]),
      false,
      100,
    );
    // c is the second visible card. Its move index is 50, not 1.
    expect(columnIndexAt(open, 1, "a")).toBe(50);
    expect(dropPositionFromOver([open], "a", "c")).toEqual({ statusId: "open", position: 50 });
  });

  it("does not move a card dropped on itself", () => {
    expect(dropPositionFromOver([column("open", ids(5))], "t1", "t1")).toBeNull();
  });

  it("saves a reorder when the pointer is on the dragged card", () => {
    const open = column("open", ids(5));
    const live = new Map([["open", ["t0", "t2", "t3", "t1", "t4"]]]);
    expect(resolveBoardDrop([open], live, "t1", "t1")).toEqual({ statusId: "open", position: 3 });
    expect(resolveBoardDrop([open], new Map([["open", open.order]]), "t1", "t1")).toBeNull();
  });

  it("saves a cross-column drag when the pointer is on the dragged card", () => {
    const open = column("open", ["a", "b"]);
    const done = column("done", ["d0", "d1"]);
    const live = new Map<string, readonly string[]>([
      ["open", ["a"]],
      ["done", ["d0", "b", "d1"]],
    ]);
    expect(resolveBoardDrop([open, done], live, "b", "b")).toEqual({ statusId: "done", position: 1 });
  });
});

describe("kept board cards", () => {
  it("keeps the card on screen when tasks are inserted above it", () => {
    const before = ids(100);
    const after = ["n0", "n1", "n2", ...before];
    const seen = before.slice(40, 46).map((key, index) => ({ key, top: index * 92, index: 40 + index }));
    const kept = keptBoardCards(seen, before, (key) => {
      const index = after.indexOf(key);
      return index < 0 ? undefined : index;
    });
    expect(kept[0]?.key).toBe("t40");
    expect(kept[0]?.index).toBe(43);
  });

  it("does not follow a block that moved out of the view", () => {
    const before = ids(100);
    const moved = before.slice(40, 54);
    const after = [...before.slice(0, 40), ...before.slice(54), ...moved];
    const seen = before.slice(40, 58).map((key, index) => ({ key, top: index * 92, index: 40 + index }));
    const kept = keptBoardCards(seen, before, (key) => {
      const index = after.indexOf(key);
      return index < 0 ? undefined : index;
    });
    expect(kept.map((row) => row.key)).toEqual(["t54", "t55", "t56", "t57"]);
    expect(kept.some((row) => row.key === "t40")).toBe(false);
  });
});

describe("preview reorder", () => {
  it("moves a card down past the hovered card and up in front of it", () => {
    const orders = new Map([["open", ["a", "b", "c", "d", "e"]]]);
    const down = previewBoardMove(orders, "b", "d", new Set(["open"]));
    expect(down?.get("open")).toEqual(["a", "c", "d", "b", "e"]);
    expect(previewBoardMove(orders, "b", "d", new Set(["open"]))?.get("open")).toEqual(down?.get("open"));
    const up = previewBoardMove(orders, "d", "b", new Set(["open"]));
    expect(up?.get("open")).toEqual(["a", "d", "b", "c", "e"]);
  });
});

describe("assembleBoardColumns", () => {
  it("merges a later page behind the first window and keeps column indexes", () => {
    const first: BoardWindowResponse = {
      aligned: true,
      columns: [
        { statusId: "open", total: 100, size: 100, offset: 0 },
        { statusId: "done", total: 2, size: 2, offset: 0 },
      ],
      data: [task("t0", "open", 0), task("t1", "open", 1), task("d0", "done", 0)],
    };
    const next: BoardWindowResponse = {
      aligned: true,
      columns: [{ statusId: "open", total: 100, size: 100, offset: 40 }],
      data: [task("t40", "open", 40), task("t41", "open", 41)],
    };
    const ids: BoardWindowResponse = {
      aligned: true,
      columns: [{ statusId: "open", total: 100, size: 100, offset: 0, ids: idsRange(100) }],
      data: [],
    };
    const columns = assembleBoardColumns([first, next, ids]);
    const open = columns.get("open")!;
    expect(open.order[0]).toBe("t0");
    expect(open.order[40]).toBe("t40");
    expect(open.order[99]).toBe("t99");
    expect(open.complete).toBe(true);
    expect(open.tasks.get("t40")?.columnIndex).toBe(40);
    expect(open.tasks.has("t99")).toBe(false);
    expect(columns.get("done")?.order).toEqual(["d0", ""]);
  });

  it("drops an id from its old slot when a later page places it elsewhere", () => {
    const first: BoardWindowResponse = {
      aligned: true,
      columns: [{ statusId: "open", total: 4, size: 4, offset: 0 }],
      data: [task("t0", "open", 0), task("t1", "open", 1)],
    };
    const moved: BoardWindowResponse = {
      aligned: true,
      columns: [{ statusId: "open", total: 4, size: 4, offset: 2, ids: ["t1", "t2"] }],
      data: [],
    };
    const open = assembleBoardColumns([first, moved]).get("open")!;
    expect(open.order.filter((id) => id === "t1")).toEqual(["t1"]);
    expect(open.order[2]).toBe("t1");
    expect(open.order[1]).toBe("");
  });
});

function idsRange(count: number) {
  return Array.from({ length: count }, (_, index) => `t${index}`);
}
