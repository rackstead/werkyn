import { Component, type ReactNode, type RefObject } from "react";
import { steadyEntry, type SeenEntry } from "../lib/steady-entry";

interface KeepInViewProps {
  /** The element that scrolls the entries. */
  scroller: HTMLElement | null;
  /** Holds the entries, each marked with `data-anchor-key`; its top is the top of the first entry. */
  container: RefObject<HTMLElement | null>;
  /** An entry's index in the list as now rendered; undefined when it is no longer listed. */
  indexOf: (key: string) => number | undefined;
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
  children: ReactNode;
}

interface Snapshot {
  scrollTop: number;
  seen: SeenEntry[];
}

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
 * After the change, it picks one of them (see steadyEntry) and scrolls by
 * however far that entry moved in the content.
 * Both places are measured in the content, not on screen, so the browser
 * clamping the scroll position at the end of a list that got shorter is not
 * mistaken for the user scrolling, and the user's own scrolling never moves
 * an entry in the content.
 *
 * Nothing is kept while the top of the list is in view: entries added at the
 * top show there, as they do without windowing.
 */
export class KeepInView extends Component<KeepInViewProps> {
  // A scroll position to apply once the list holds the space it was short of.
  private retry: number | null = null;

  getSnapshotBeforeUpdate(previous: KeepInViewProps): Snapshot | null {
    const { scroller } = this.props;
    const container = this.props.container.current;
    if (!scroller || !container) return null;
    const view = scroller.getBoundingClientRect();
    const viewTop = view.top + scroller.clientTop;
    const viewBottom = viewTop + scroller.clientHeight;
    if (container.getBoundingClientRect().top >= viewTop) return null;
    const scrollTop = scroller.scrollTop;
    const seen: SeenEntry[] = [];
    for (const element of container.querySelectorAll<HTMLElement>("[data-anchor-key]")) {
      const { top, bottom } = element.getBoundingClientRect();
      if (bottom <= viewTop || top >= viewBottom) continue;
      const key = element.dataset.anchorKey!;
      const index = previous.indexOf(key);
      if (index !== undefined) seen.push({ key, index, top: top - viewTop + scrollTop });
    }
    return seen.length > 0 ? { scrollTop, seen } : null;
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
    const kept = steadyEntry(snapshot.seen, indexOf);
    if (!kept) return;
    const element = [...container.querySelectorAll<HTMLElement>("[data-anchor-key]")].find(
      (candidate) => candidate.dataset.anchorKey === kept.key,
    );
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
