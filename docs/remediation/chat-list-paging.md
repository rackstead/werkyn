# Channel and DM list paging

`GET /api/chat/:wid/channels` and `GET /api/chat/:wid/dms` each return one page. The default page size is 50 (`CHAT_LIST_PAGE_DEFAULT`) and the maximum `limit` is 100. Omitting `cursor` returns that first page, not every row. `nextCursor` is the last row's id, or `null` on the last page. Pass it as `cursor` to continue. A cursor that is not in the caller's list, including an unknown id, returns an empty page.

Both lists are ordered by name ascending, with a missing name last, then id. Equal names therefore have one position and a page boundary inside them does not skip or repeat a row. The page query asks for `limit + 1` rows. Name is nullable, so the "rows after this cursor" condition is written out and PostgreSQL applies the LIMIT.

The channel list is still every public channel in the workspace plus private channels and DMs the caller belongs to. A private channel or DM the caller is not in stays out. The DM list is only DMs the caller belongs to. Each row keeps the fields it had, including `_count.members`. The channel list still attaches the first ten members (a DM's preview is complete). The DM list still includes every member. Unread counts are unchanged and stay on `GET /api/chat/:wid/unread`. Messages inside a channel are not part of this paging.

The web client follows `nextCursor` until the channel list is complete, so the sidebar, the unread widget and the backup channel picker still show every visible channel. It stops if a cursor repeats or after 200 pages.
