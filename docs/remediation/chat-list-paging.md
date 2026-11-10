# Channel and DM list paging

`GET /api/chat/:wid/channels` and `GET /api/chat/:wid/dms` each return one page. The default page size is 50 (`CHAT_LIST_PAGE_DEFAULT`) and the maximum `limit` is 100. Omitting `cursor` returns that first page, not every row. `nextCursor` is the last row's id, or `null` on the last page. Pass it as `cursor` to continue. A cursor that is not in the caller's list, including an unknown id, returns an empty page.

The channel list keeps main's order: `createdAt` ascending, then id. The DM list's first page keeps main's order, `updatedAt` descending, then id descending. A newer message still puts that DM first on a new request. The DM cursor carries the remaining ids in that order, so a message sent while the caller is still paging cannot skip or repeat a DM. Names are not part of either order. The channel page asks for `limit + 1` rows.

The channel list is still every public channel in the workspace plus private channels and DMs the caller belongs to. A private channel or DM the caller is not in stays out. The DM list is only DMs the caller belongs to. Each row keeps the fields it had, including `_count.members`. That count is taken for the page's channels only, and the number is the full membership. The channel list still attaches the first ten members (a DM's preview is complete). The DM list still includes every member, and its count is that list's length. Unread counts are unchanged and stay on `GET /api/chat/:wid/unread`. Messages inside a channel are not part of this paging.

The web client follows `nextCursor` until the channel list is complete, so the sidebar, the unread widget and the backup channel picker still show every visible channel. It stops if a cursor repeats. If a page is still outstanding after 200 requests, the query fails instead of showing a short list as the full set. Cancelling the query aborts the walk.

`ChatChannel` has indexes on `(workspaceId, createdAt, id)` and `(workspaceId, type, updatedAt, id)` so a page can be read in that order. The older `(workspaceId, type)` index remains.
