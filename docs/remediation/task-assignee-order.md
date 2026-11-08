# Task assignee order

Every task response lists assignees by `TaskAssignee.id` ascending. That row
has no `createdAt`. The id is a cuid assigned at insert, so the first
assignee is the earliest assignment.

The calendar colours an event from that first assignee. The colour follows
the earliest assignment and does not change between requests. Assignees are
not ordered by display name or user id, and who is assigned does not change.

Every read of a task's assignees uses `orderBy: { id: "asc" }`, including
the project task list the calendar loads. A list built in JavaScript is
sorted the same way. A bulk update keeps the rows of people who remain
assigned, so sending the same users in another order does not change the
colour. Someone removed and added again is a new assignment.

Two processes that assign different people in the same millisecond can
mint ids whose sort order does not match wall-clock order. The colour for
a given set of rows does not change between requests.
