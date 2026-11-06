import { Component, type ReactNode, type RefObject } from "react";
import { steadyEntry, type AroundEntry, type SeenEntry } from "../lib/steady-entry";

// Entries listed just above and just below the view that are remembered
// with the entries in view (see steadyEntry).
const AROUND = 5;

interface KeepInViewProps {
  /** The element that scrolls the entries. */
  scroller: HTMLElement | null;
  /** Holds the entries, each marked with `data-anchor-key`; its top is the top of the first entry. */
  container: RefObject<HTMLElement | null>;
  /** An entry's index in the list as now rendered; undefined when it is no longer listed. */
  indexOf: (key: string) => number | undefined;
  /** The key of the entry at this index in the list as now rendered. */
  keyAt: (index: number) => string | undefined;
  /** The top of the entry at this index below the container's top, for an entry that is not rendered. */
  offsetOf: (index: number) => number;
  /** Called after the view was scrolled to keep the entries in place. */
  onCorrected?: (scrollTop: number) => void;
  /**
   * Given while more entries are on their way below the list (its next
   * page): called when the list now ends too soon below the entries in view
   * to keep them in place, with the height missing. The list then holds that
   * much space below its entries until it changes again, and the view is
   * kept in place on the next render.
   */
  onShort?: (height: number) => void;
  /**
   * Changes when the layout itself changes (the grid's column count): the
   * view is then kept by the caller, not by the entries' places, which the
   * browser has already reflowed.
   */
  layoutKey?: unknown;
  children: ReactNode;
}

interface Snapshot {
  scrollTop: number;
  seen: SeenEntry[];
  around: AroundEntry[];
  // The list before the change, to find entries above the view that are
  // still listed when none of the entries seen is.
  listTop: number;
  keyAt: (index: number) => string | undefined;
  offsetOf: (index: number) => number;
}

// How many entries still listed above the view are compared when none of
// the entries seen is listed any more.
const SURVIVORS = 11;

/** An element's top in the scroller's content (independent of its scroll position). */
function contentTop(element: Element, scroller: HTMLElement): number {
  return (
    element.getBoundingClientRect().top -
    scroller.getBoundingClientRect().top -
    scroller.clientTop +
    scroller.scrollTop
  );
}

/**
 * Keeps the entries in view where they are on screen when the list changes
 * above them: entries created, deleted or moved by a refresh of the folder
 * or by the user's own bulk action. Without it, a windowed list moves the
 * entries in view by the height of what changed above, and a click made
 * just then lands on another file.
 *
 * Right before React applies a change to the DOM, it records the entries in
 * view with their place in the scroller's content and the scroll position.
 * After the change, it picks one of them (see steadyEntry: one that moved
 * with the entries listed just around the view, never one that sorts far
 * away now, however many moved with it) and scrolls by however far that
 * entry moved in the content.
 * Both places are measured in the content, not on screen, so the browser
 * clamping the scroll position at the end of a list that got shorter is not
 * mistaken for the user scrolling, and the user's own scrolling never moves
 * an entry in the content.
 *
 * Nothing is kept while the top of the list is in view: entries added at the
 * top show there, as they do without windowing.
 */
/**
 * When none of the entries seen is listed now (at the end of the list, a
 * refresh can leave every one of them, and many above them, for the next
 * page), an entry above the view that is still listed keeps its place
 * instead, at the place its index gave it before the change: of the
 * nearest such entries, one that moved as most of them did (so not one
 * renamed to sort elsewhere), the nearest.
 */
function survivorAbove(
  snapshot: Snapshot,
  indexOf: (key: string) => number | undefined,
): (SeenEntry & { now: number }) | undefined {
  const first = Math.min(...snapshot.seen.map((entry) => entry.index));
  const survivors: Array<SeenEntry & { now: number }> = [];
  for (let index = first - 1; index >= 0 && survivors.length < SURVIVORS; index--) {
    const key = snapshot.keyAt(index);
    const now = key === undefined ? undefined : indexOf(key);
    if (key !== undefined && now !== undefined)
      survivors.push({ key, index, now, top: snapshot.listTop + snapshot.offsetOf(index) });
  }
  const counts = new Map<number, number>();
  for (const entry of survivors) counts.set(entry.now - entry.index, (counts.get(entry.now - entry.index) ?? 0) + 1);
  let shift: number | undefined;
  for (const [candidate, count] of counts) if (shift === undefined || count > counts.get(shift)!) shift = candidate;
  return survivors.find((entry) => entry.now - entry.index === shift);
}

export class KeepInView extends Component<KeepInViewProps> {
  // A scroll position to apply once the list holds the space it was short of.
  private retry: number | null = null;

  getSnapshotBeforeUpdate(previous: KeepInViewProps): Snapshot | null {
    const { scroller } = this.props;
    const container = this.props.container.current;
    if (!scroller || !container || previous.layoutKey !== this.props.layoutKey) return null;
    const view = scroller.getBoundingClientRect();
    const viewTop = view.top + scroller.clientTop;
    const viewBottom = viewTop + scroller.clientHeight;
    const listTop = container.getBoundingClientRect().top;
    if (listTop >= viewTop) return null;
    const scrollTop = scroller.scrollTop;
    const seen: SeenEntry[] = [];
    for (const element of container.querySelectorAll<HTMLElement>("[data-anchor-key]")) {
      const { top, bottom } = element.getBoundingClientRect();
      if (bottom <= viewTop || top >= viewBottom) continue;
      const key = element.dataset.anchorKey!;
      const index = previous.indexOf(key);
      if (index !== undefined) seen.push({ key, index, top: top - viewTop + scrollTop });
    }
    if (seen.length === 0) return null;
    const first = Math.min(...seen.map((entry) => entry.index));
    const last = Math.max(...seen.map((entry) => entry.index));
    const around: AroundEntry[] = [];
    for (let index = first - AROUND; index <= last + AROUND; index++) {
      if (index >= first && index <= last) continue;
      const key = index >= 0 ? previous.keyAt(index) : undefined;
      if (key !== undefined) around.push({ key, index });
    }
    return {
      scrollTop,
      seen,
      around,
      listTop: listTop - viewTop + scrollTop,
      keyAt: previous.keyAt,
      offsetOf: previous.offsetOf,
    };
  }

  componentDidUpdate(_props: KeepInViewProps, _state: unknown, snapshot: Snapshot | null) {
    const { scroller, indexOf, offsetOf, onCorrected, onShort } = this.props;
    const container = this.props.container.current;
    if (this.retry !== null && scroller) {
      const want = this.retry;
      this.retry = null;
      if (Math.abs(scroller.scrollTop - want) >= 0.5) {
        scroller.scrollTop = want;
        onCorrected?.(scroller.scrollTop);
      }
      return;
    }
    if (!snapshot || !scroller || !container) return;
    const rendered = new Map<string, HTMLElement>();
    for (const element of container.querySelectorAll<HTMLElement>("[data-anchor-key]"))
      rendered.set(element.dataset.anchorKey!, element);
    const kept =
      steadyEntry(snapshot.seen, indexOf, (key) => rendered.has(key), snapshot.around) ??
      survivorAbove(snapshot, indexOf);
    if (!kept) return;
    const element = rendered.get(kept.key);
    const top = element
      ? contentTop(element, scroller)
      : // Not rendered now: so much changed above that the rendered range
        // holds other entries. Every entry has the same height, so its place
        // follows from its index.
        contentTop(container, scroller) + offsetOf(kept.now);
    const want = snapshot.scrollTop + (top - kept.top);
    if (!Number.isFinite(want) || Math.abs(scroller.scrollTop - want) < 0.5) return;
    scroller.scrollTop = want;
    // At the end of the list, the browser stops the scroll position at the
    // end. When the list got shorter below the view only because a refresh
    // left its last entries for the next page, space is held for them.
    const short = want - scroller.scrollTop;
    if (onShort && short >= 0.5) {
      this.retry = want;
      onShort(short);
    }
    onCorrected?.(scroller.scrollTop);
  }

  render() {
    return this.props.children;
  }
}
