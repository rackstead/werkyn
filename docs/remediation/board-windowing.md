# Board windowing

The project board used to load every non-archived task (`view=board` with no
page) and mount a card for each of them. On the measured project that was
10,789 tasks and 20.9 MB, and the column scrolled by moving every card.

## What changed

The board page asks for a window. Other callers of `view=board` (the List,
the Calendar, the dependency picker) do not send `perColumn` and still
receive every matching task.

- **First response.** `GET /projects/:id/tasks?view=board&perColumn=40`
  returns at most 40 tasks from each column, in board order (position,
  createdAt, id), plus each column's filtered total and its full active
  size. Filters (search, assignee, priority, label, due dates) apply, as
  they did before. Archived tasks stay excluded.
- **Further task pages.** `status`, `perColumn` (at most 100) and
  `columnOffset` return the next slice of one column. `columnOffset`
  without `status` is rejected.
- **Id pages.** `columnIds=true` with `perColumn` at most 500 returns ids
  in that same order and no task bodies. The client loads these in the
  background so a column of thousands can be anchored without shipping
  every card. A card body is fetched when its display slot is near the
  view.
- **Mounted cards.** Each column is its own scroll container. The board
  fills the height `<main>` has left under the top bar, including when an
  email or offline banner is showing, so the column and the board controls
  stay on screen. That height is the board region under the filter bar,
  never the height of every card, so the page `<main>` does not scroll the
  cards. The column mounts
  the cards in that viewport, 4 above and 4 below (`BOARD_OVERSCAN`), plus
  the dragged card and the cards next to it so keyboard drag still has a
  drop target. Scrolling the column, not the page, mounts the cards that
  were not and unmounts the ones that left. The column count is the
  filtered total, not the number mounted. A task body is requested for the
  mounted window; id pages may load for the rest of the column.
- **Move index.** `PATCH /tasks/:id/move` is unchanged: `position` is a
  0-based index into the whole active column, after the dragged task is
  removed. A drop on a card sends that card's `columnIndex` (its place in
  the whole column), including a card that was not in the mounted window.
  A drop on the column itself uses the slot under the pointer in that same
  coordinate, or the end of the column when the pointer is below the last
  card. A filtered board uses `columnIndex` rather than the index among
  the cards the filter shows.
- **Cards stay put.** When tasks are inserted, deleted or moved above the
  view, the column scrolls so a card that stayed on screen does not jump
  to a different task. A card that is not mounted is placed from the
  measured height of each card above it, not from one mounted card's
  height times how many indexes it moved. The height kept for a card is
  the tallest one measured while it was on screen. A refetch page that
  drops a card which was on screen is not followed; the card already
  chosen stays chosen until the following page brings it back.
  The choice uses `stayedEntries`
  (`lib/stayed-entries.ts`), over the column's id order, the same helper
  the List and Drive use. While that id list is still loading, only a
  uniform shift (every visible card moved by the same number of places) is
  corrected. Anchoring is off during a drag, because the drag is supposed
  to move cards.

The task-body page size is 40. The mount window is the viewport plus 8
cards, not 40: a tall column still mounts a few dozen cards after every
page has been fetched. Card heights start at 92 px (the card plus the gap
under it) and are then measured.

## Payload

Recorded by `packages/backend/tests/integration/board-window.test.mjs` on a
project with 2,000 active tasks in one column and 3 in another (one
archived task is excluded). The numbers are whatever that test prints; the
bounds below are what it asserts.

| Read | Rows | Bytes |
|---|---:|---:|
| `view=board` (previous board read) | 2,003 | 1,186,578 |
| `view=board&perColumn=40` (first paint) | 43 | 26,251 |
| one later page | 40 | `perColumn` |

The first window is about 2% of the unwindowed response (43 rows against
2,003, 26,251 bytes against 1,186,578). A column of 10,789 tasks is the
same shape: 40 bodies up front, not 10,789.

## What did not change

- `moveTask`, `columnTasks` and `writeColumnOrder`. The renumber that
  follows a move is a separate change.
- The unwindowed `view=board` read, including its sort and its search plan.
- Creating a card (it is still appended; the column scrolls to it), opening
  a card, and keyboard drag (the keyboard sensor is unchanged; the card
  under the pointer and its neighbours stay mounted).
- Quick add, filters, and the drag overlay.

## Limitations

- Find-in-page, print and a screen reader's browse mode see the mounted
  cards only. The column count is the filtered total. Search still filters
  on the server.
- Until the id pages for a column have loaded, anchoring only corrects a
  uniform shift. A block move above a half-loaded column can still move
  the cards in view; once the ids are loaded it uses the same stayed-card
  rule as the List.
- Card heights that have not been measured use 92 px, so a jump to the
  bottom can land a card or two off until those cards are measured.
- `view=board` without `perColumn` is still the whole project. The List,
  Calendar and dependency picker use that read on purpose.

`packages/backend/tests/browser/board-column-scroll.mjs` loads a column of
2,000 cards in Chromium. It fails when that column's scroller is as tall as
its cards, when the first paint asks for every task body, or when a drop
past the first window does not store the absolute column index.
