import { useState } from "react";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DriveFile } from "../api";
import { FileGridView } from "./file-grid-view";
import { FileListView } from "./file-list-view";

vi.mock("../api", () => ({ useThumbnailUrl: () => ({ data: undefined }) }));

// Layout in these tests: the scroller shows 400 px. The list's header is
// 33 px tall and every list row 41 px; the grid's sort bar is 40 px, a line
// of five 128 px cards takes 140 px with the gap below it.
const VIEW = 400;
const HEAD = 33;
const ROW = 41;
const SORT_BAR = 40;
const LINE = 140;
// Columns of the grid as the browser lays them out (CSS media queries follow
// the window width at once, before the view renders again).
let columns = 5;

function driveFile(i: number, name = `File ${String(i).padStart(4, "0")}.txt`): DriveFile {
  return {
    id: `f${i}`,
    workspaceId: "w",
    parentId: null,
    name,
    isFolder: false,
    mimeType: "text/plain",
    size: 10,
    storagePath: null,
    uploadedById: "u",
    ownerId: "u",
    teamFolderId: null,
    thumbnailPath: null,
    trashedAt: null,
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-01T00:00:00Z",
    uploadedBy: { id: "u", displayName: "Ana", avatarUrl: null },
  };
}
const range = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => driveFile(from + i));

let scroller: HTMLDivElement | null = null;
let scrollTop = 0;
const noop = () => {};

// Content height of the scroller: header plus every row (or line) below it.
function contentHeight(): number {
  const body = scroller?.querySelector("tbody");
  if (body) return HEAD + [...body.children].reduce((sum, row) => sum + height(row), 0) + below();
  const grid = scroller?.querySelector<HTMLElement>(".grid.gap-3");
  return grid ? SORT_BAR + gridHeight(grid) + below() : 0;
}
// Below the table or grid: the next page's sentinel (32 px) and any space
// held.
function below(): number {
  const list = scroller?.querySelector("table") ?? scroller?.querySelector(".grid.gap-3");
  let sum = 0;
  for (let e = list?.nextElementSibling; e; e = e.nextElementSibling)
    sum += (e as HTMLElement).style.height ? parseFloat((e as HTMLElement).style.height) : 32;
  return sum;
}
function height(row: Element): number {
  const cell = row.querySelector<HTMLElement>("td[colspan]");
  return cell ? parseFloat(cell.style.height) : ROW;
}
// The grid's children in order: a gap spans a line, cards fill lines of five.
function gridLayout(grid: Element): Map<Element, number> {
  const tops = new Map<Element, number>();
  let y = 0;
  let column = 0;
  for (const child of grid.children) {
    if (!child.hasAttribute("data-drive-card")) {
      if (column > 0) y += LINE;
      column = 0;
      tops.set(child, y);
      y += parseFloat((child as HTMLElement).style.height) + 12;
      continue;
    }
    tops.set(child, y);
    if (++column === columns) {
      column = 0;
      y += LINE;
    }
  }
  tops.set(grid, column > 0 ? y + LINE : y);
  return tops;
}
const gridHeight = (grid: Element) => gridLayout(grid).get(grid)!;

function rect(top: number, h: number): DOMRect {
  return { x: 0, y: top, top, left: 0, right: 1200, bottom: top + h, width: 1200, height: h, toJSON: () => ({}) } as DOMRect;
}
function layoutRect(element: Element): DOMRect {
  if (element === scroller) return rect(0, VIEW);
  const offset = -scroller!.scrollTop;
  const row = element.closest("tbody > tr");
  if (row) {
    let top = HEAD;
    for (let r = row.previousElementSibling; r; r = r.previousElementSibling) top += height(r);
    return rect(offset + top, height(row));
  }
  if (element.tagName === "TBODY") return rect(offset + HEAD, contentHeight() - HEAD);
  const grid = scroller!.querySelector(".grid.gap-3");
  if (grid && grid.contains(element)) {
    const tops = gridLayout(grid);
    if (element === grid) return rect(offset + SORT_BAR, tops.get(grid)!);
    const item = [...grid.children].find((child) => child.contains(element))!;
    return rect(offset + SORT_BAR + tops.get(item)!, item.hasAttribute("data-drive-card") ? 128 : 0);
  }
  return rect(offset, 0);
}

function Harness({
  files,
  view = "list",
  selectedIds,
  draggingId,
  hasNextPage = false,
}: {
  files: DriveFile[];
  view?: "list" | "grid";
  selectedIds?: Set<string>;
  draggingId?: string | null;
  hasNextPage?: boolean;
}) {
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const attach = (node: HTMLDivElement | null) => {
    if (node && node !== scroller) {
      scroller = node;
      // Like a browser, scrollTop stays within the content.
      Object.defineProperty(node, "scrollTop", {
        configurable: true,
        get: () => Math.max(0, Math.min(scrollTop, contentHeight() - VIEW)),
        set: (value: number) => {
          const before = scrollTop;
          scrollTop = Math.max(0, Math.min(value, contentHeight() - VIEW));
          // A browser reports a scroll position set by script with a scroll
          // event, after the change.
          if (scrollTop !== before) queueMicrotask(() => node.dispatchEvent(new Event("scroll")));
        },
      });
      Object.defineProperty(node, "clientHeight", { configurable: true, get: () => VIEW });
      // The virtualizer reads the view's size from these.
      Object.defineProperty(node, "offsetHeight", { configurable: true, get: () => VIEW });
      Object.defineProperty(node, "offsetWidth", { configurable: true, get: () => 1200 });
      Object.defineProperty(node, "scrollHeight", { configurable: true, get: () => contentHeight() });
    }
    setElement(node);
  };
  const props = {
    files,
    scrollElement: element,
    draggingId,
    hasNextPage,
    isFetchingNextPage: false,
    canEdit: true,
    selectable: true,
    selectedIds,
    anySelected: !!selectedIds?.size,
    onLoadMore: noop,
    onNavigate: noop,
    onDownload: noop,
    onRename: noop,
    onMove: noop,
    onTrash: noop,
  };
  return (
    <div ref={attach} data-testid={view}>
      {view === "list" ? <FileListView {...props} /> : <FileGridView {...props} />}
    </div>
  );
}

async function scrollTo(top: number) {
  await act(async () => {
    scroller!.scrollTop = top;
    fireEvent.scroll(scroller!);
  });
}
const rendered = () =>
  [...document.querySelectorAll<HTMLElement>("[data-anchor-key]")].map((e) => e.dataset.anchorKey);
// The entry drawn at this height of the view.
function entryAt(y: number): string | undefined {
  return [...document.querySelectorAll<HTMLElement>("[data-anchor-key]")].find((e) => {
    const r = e.getBoundingClientRect();
    return r.top <= y && r.bottom > y;
  })?.dataset.anchorKey;
}
function topOf(id: string): number {
  return document.querySelector(`[data-anchor-key="${id}"]`)!.getBoundingClientRect().top;
}

beforeEach(() => {
  scroller = null;
  scrollTop = 0;
  columns = 5;
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    return layoutRect(this);
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("windowed Drive list", { timeout: 30_000 }, () => {
  it("renders only the rows near the view, with gaps holding the others' height", async () => {
    render(<Harness files={range(0, 1000)} />);
    await scrollTo(HEAD + 500 * ROW);
    const ids = rendered();
    expect(ids.length).toBeLessThan(40);
    expect(ids).toContain("f500");
    // The first and last rows stay rendered.
    expect(ids[0]).toBe("f0");
    expect(ids.at(-1)).toBe("f999");
    expect(contentHeight()).toBe(HEAD + 1000 * ROW);
    expect(entryAt(1)).toBe("f500");
    // Rows sit where their index puts them.
    expect(topOf("f510")).toBe(10 * ROW);
  });

  it("keeps the rows in view still when entries are added or removed above them", async () => {
    const files = range(0, 1000);
    const { rerender } = render(<Harness files={files} />);
    await scrollTo(HEAD + 500 * ROW + 7);
    const under = entryAt(200)!;
    const top = topOf(under);

    // Three added above the view (a refresh, or an upload).
    const added = [driveFile(-3), driveFile(-2), driveFile(-1), ...files];
    rerender(<Harness files={added} />);
    expect(scroller!.scrollTop).toBe(HEAD + 503 * ROW + 7);
    expect(entryAt(200)).toBe(under);
    expect(topOf(under)).toBe(top);

    // Two removed above it.
    const removed = added.filter((f) => f.id !== "f10" && f.id !== "f11");
    rerender(<Harness files={removed} />);
    expect(scroller!.scrollTop).toBe(HEAD + 501 * ROW + 7);
    expect(topOf(under)).toBe(top);

    // So many removed above that the rows in view were not rendered after
    // the change: the view still lands on the same entry, and its rows are
    // rendered before the next paint.
    const bulk = removed.slice(400);
    rerender(<Harness files={bulk} />);
    expect(entryAt(200)).toBe(under);
    expect(topOf(under)).toBe(top);
  });

  it("keeps the rows in view still at the end of the list, where the scroll position is clamped", async () => {
    const files = range(0, 1000);
    const { rerender } = render(<Harness files={[...files]} />);
    for (const fromEnd of [0, 20]) {
      await scrollTo(contentHeight() - VIEW - fromEnd);
      const under = entryAt(200)!;
      const top = topOf(under);
      // Two removed above the view: the list gets shorter, and a browser
      // moves scrollTop to the new end, which is not the user scrolling.
      files.splice(100, 2);
      rerender(<Harness files={[...files]} />);
      expect(entryAt(200)).toBe(under);
      expect(topOf(under)).toBe(top);
      expect(scroller!.scrollTop).toBe(contentHeight() - VIEW - fromEnd);
    }
  });

  it("holds space at the end of the list while a refresh left its last entries for the next page", async () => {
    const files = range(0, 1000);
    const { rerender } = render(<Harness files={files} />);
    await scrollTo(contentHeight() - VIEW - 20);
    const under = entryAt(200)!;
    const top = topOf(under);
    // Three added above the view; the refreshed pages hold 1,000 entries, so
    // the last three are on the next page.
    const refreshed = [...range(-3, 0), ...files.slice(0, 997)];
    rerender(<Harness files={refreshed} hasNextPage />);
    expect(topOf(under)).toBe(top);
    expect(entryAt(200)).toBe(under);
    // The next page's sentinel is at the end of the content, in view.
    const sentinel = scroller!.querySelector("table ~ .py-4")!;
    expect(sentinel.nextElementSibling).toBeNull();
    // The next page arrives: the space held goes, nothing moves.
    rerender(<Harness files={[...range(-3, 0), ...files]} />);
    expect(topOf(under)).toBe(top);
    expect(contentHeight()).toBe(HEAD + 1003 * ROW);
  });

  it("keeps the view at the end when a refresh leaves every entry in view for the next page", async () => {
    const files = range(0, 1000);
    const { rerender } = render(<Harness files={files} />);
    await scrollTo(contentHeight() - VIEW);
    const under = entryAt(200)!;
    const top = topOf(under);
    // 30 added above the view; the refreshed pages hold 1,000 entries, so
    // the last 30 (all those in view) are on the next page.
    rerender(<Harness files={[...range(-30, 0), ...files.slice(0, 970)]} hasNextPage />);
    // The next page arrives: the entries are back where they were.
    rerender(<Harness files={[...range(-30, 0), ...files]} />);
    expect(topOf(under)).toBe(top);
    expect(entryAt(200)).toBe(under);
  });

  it("keeps the view at the end through a refresh that adds many above it, or renames the entry just above", async () => {
    const files = range(0, 1000);
    const { rerender } = render(<Harness files={files} />);
    await scrollTo(contentHeight() - VIEW);
    const under = entryAt(200)!;
    const top = topOf(under);
    // The entry just above the view is renamed to sort at the top, and 30
    // are added above: the view's entries wait for the next page.
    const renamed = files[985];
    const rest = files.filter((f) => f !== renamed);
    rerender(<Harness files={[renamed, ...range(-30, 0), ...rest.slice(0, 969)]} hasNextPage />);
    rerender(<Harness files={[renamed, ...range(-30, 0), ...rest]} />);
    expect(topOf(under)).toBe(top);
    // 600 added above: every entry within 500 places of the view waits too.
    const now = [renamed, ...range(-30, 0), ...rest];
    rerender(<Harness files={[...range(-700, -100), ...now.slice(0, now.length - 600)]} hasNextPage />);
    rerender(<Harness files={[...range(-700, -100), ...now]} />);
    expect(topOf(under)).toBe(top);
  });

  it("does not move the view for an entry renamed out of it, nor at the top of the list", async () => {
    const files = range(0, 1000);
    const { rerender } = render(<Harness files={files} />);
    await scrollTo(HEAD + 500 * ROW);
    const first = entryAt(1)!;
    const second = files[files.findIndex((f) => f.id === first) + 1].id;
    const top = topOf(second);
    // The first entry in view is renamed and now sorts at the top: the rows
    // after it move up into its place, but nothing else.
    const moved = files.find((f) => f.id === first)!;
    rerender(<Harness files={[moved, ...files.filter((f) => f !== moved)]} />);
    expect(topOf(second)).toBe(top);

    // At the top, an added entry shows at the top.
    await scrollTo(0);
    rerender(<Harness files={[driveFile(-1), ...files]} />);
    expect(scroller!.scrollTop).toBe(0);
    expect(entryAt(HEAD + 1)).toBe("f-1");
  });

  it("does not follow a block of entries in view that now sorts far away", async () => {
    const files = range(0, 1000);
    const { rerender } = render(<Harness files={files} />);
    await scrollTo(HEAD + 500 * ROW);
    // About 10 rows in view: the top 7 are renamed so that they sort at the
    // end (more entries moved together than stayed).
    const block = files.slice(500, 507);
    const stayed = files[507].id;
    const top = topOf(stayed);
    const at = scrollTop;
    rerender(<Harness files={[...files.filter((f) => !block.includes(f)), ...block]} />);
    expect(topOf(stayed)).toBe(top);
    expect(Math.abs(scroller!.scrollTop - at)).toBeLessThan(VIEW);
    // The same block sorting far above the view.
    rerender(<Harness files={files} />);
    await scrollTo(HEAD + 500 * ROW);
    const above = [...files.slice(0, 100), ...block, ...files.slice(100).filter((f) => !block.includes(f))];
    rerender(<Harness files={above} />);
    expect(topOf(stayed)).toBe(top);
  });

  it("keeps the focused row and its neighbours rendered, and arrow keys move through rows", async () => {
    render(<Harness files={range(0, 1000)} />);
    await scrollTo(HEAD + 300 * ROW);
    const row = document.querySelector<HTMLElement>('[data-anchor-key="f305"]')!;
    act(() => row.focus());
    fireEvent.keyDown(row, { key: "ArrowDown" });
    expect((document.activeElement as HTMLElement).dataset.anchorKey).toBe("f306");
    fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" });
    fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" });
    expect((document.activeElement as HTMLElement).dataset.anchorKey).toBe("f304");

    await scrollTo(HEAD + 800 * ROW);
    expect(rendered()).toEqual(expect.arrayContaining(["f303", "f304", "f305", "f800"]));
    expect((document.activeElement as HTMLElement).dataset.anchorKey).toBe("f304");
    fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" });
    expect((document.activeElement as HTMLElement).dataset.anchorKey).toBe("f303");
  });

  it("keeps the dragged row rendered, and shows selection on rows rendered later", async () => {
    const { rerender } = render(
      <Harness files={range(0, 1000)} draggingId="f20" selectedIds={new Set(["f20", "f900"])} />,
    );
    await scrollTo(HEAD + 600 * ROW);
    expect(rendered()).toContain("f20");
    expect(rendered()).not.toContain("f900");
    await scrollTo(HEAD + 890 * ROW);
    const box = document.querySelector('[data-anchor-key="f900"] input[type="checkbox"]') as HTMLInputElement;
    expect(box.checked).toBe(true);
    rerender(<Harness files={range(0, 1000)} draggingId={null} selectedIds={new Set(["f20", "f900"])} />);
    expect(rendered()).not.toContain("f20");
  });

  it("renders the first rows while the view has no size", () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => rect(0, 0));
    render(<Harness files={range(0, 1000)} />);
    const ids = rendered();
    expect(ids.slice(0, 3)).toEqual(["f0", "f1", "f2"]);
    expect(ids.length).toBeLessThanOrEqual(61);
  });
});

// Each card renders its menus; a few dozen of them render slowly in jsdom.
describe("windowed Drive grid", { timeout: 30_000 }, () => {
  it("renders only the lines of cards near the view", async () => {
    render(<Harness view="grid" files={range(0, 1000)} />);
    await scrollTo(SORT_BAR + 100 * LINE);
    const ids = rendered();
    expect(ids.length).toBeLessThan(100);
    expect(ids).toContain("f500");
    expect(contentHeight()).toBe(SORT_BAR + 200 * LINE);
    expect(entryAt(1)).toBe("f500");
    // A card keeps its column: cards of a line share its top.
    expect(topOf("f504")).toBe(topOf("f500"));
    expect(topOf("f505")).toBe(topOf("f500") + LINE);
  });

  it("keeps the first line in view in place when the window crosses a column breakpoint", async () => {
    // Tailwind's sm, md and lg breakpoints, as useGridColumns asks for them.
    let width = 1200;
    const listeners = new Set<() => void>();
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: width >= Number(/([\d.]+)rem/.exec(query)![1]) * 16,
      addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
      removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
    }));
    const resize = (to: number) =>
      act(() => {
        width = to;
        columns = to >= 1024 ? 5 : to >= 768 ? 4 : to >= 640 ? 3 : 2;
        for (const listener of listeners) listener();
      });
    const files = range(0, 1000);
    const { rerender } = render(<Harness view="grid" files={files} />);
    await scrollTo(SORT_BAR + 100 * LINE + 30);
    expect(entryAt(1)).toBe("f500");
    expect(topOf("f500")).toBe(-30);
    for (const [to, first] of [
      [900, "f500"], // 4 columns: f500 starts line 125
      [700, "f498"], // 3 columns: the first line in view starts with f498
      [560, "f498"], // 2 columns: line 249
      [1440, "f495"], // 5 columns again: line 99
    ] as const) {
      await resize(to);
      // The first line in view starts with the same entry as before, or the
      // one that starts its line now, at the same place.
      expect(topOf(first)).toBe(-30);
      expect(entryAt(1)).toBe(first);
    }
    // A refresh adding 3 entries at the top arrives with a column change:
    // the first entry in view is followed by its id, not its old index.
    width = 900;
    columns = 4;
    act(() => {
      for (const listener of listeners) listener();
      rerender(<Harness view="grid" files={[...range(-3, 0), ...files]} />);
    });
    expect(topOf("f495")).toBe(-30);
  });

  it("keeps the cards in view still when a line of entries is added or removed above them", async () => {
    const files = range(0, 1000);
    const { rerender } = render(<Harness view="grid" files={files} />);
    await scrollTo(SORT_BAR + 100 * LINE + 30);
    const under = entryAt(200)!;
    const top = topOf(under);
    rerender(<Harness view="grid" files={[...range(-5, 0), ...files]} />);
    expect(topOf(under)).toBe(top);
    expect(scroller!.scrollTop).toBe(SORT_BAR + 101 * LINE + 30);
    rerender(<Harness view="grid" files={files.slice(10)} />);
    expect(topOf(under)).toBe(top);
    expect(scroller!.scrollTop).toBe(SORT_BAR + 98 * LINE + 30);

    // A card that moves to the next line keeps its element (and focus).
    await scrollTo(SORT_BAR + 100 * LINE);
    const card = document.querySelector<HTMLElement>('[data-anchor-key="f504"]')!;
    act(() => card.focus());
    rerender(<Harness view="grid" files={[driveFile(-1), ...files.slice(10)]} />);
    expect(document.querySelector('[data-anchor-key="f504"]')).toBe(card);
    expect(document.activeElement).toBe(card);
    rerender(<Harness view="grid" files={files.slice(10)} />);

    // At the end: 30 added above and the refreshed pages leave every card
    // in view for the next page; when it arrives they are where they were.
    await scrollTo(contentHeight() - VIEW);
    const end = entryAt(200)!;
    const endTop = topOf(end);
    const rest = files.slice(10);
    rerender(<Harness view="grid" files={[...range(-30, 0), ...rest.slice(0, rest.length - 30)]} hasNextPage />);
    rerender(<Harness view="grid" files={[...range(-30, 0), ...rest]} />);
    expect(topOf(end)).toBe(endTop);
    rerender(<Harness view="grid" files={rest} />);

    // At the end, where the scroll position is clamped.
    await scrollTo(contentHeight() - VIEW);
    const last = entryAt(200)!;
    const lastTop = topOf(last);
    rerender(<Harness view="grid" files={files.slice(15)} />);
    expect(topOf(last)).toBe(lastTop);
  });
});
