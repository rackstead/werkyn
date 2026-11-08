# Task assignee order

Every task response lists assignees by `TaskAssignee.id` ascending. That row
has no `createdAt`. The id is a cuid assigned at insert, so the first
assignee is the earliest assignment.

The calendar colours an event from that first assignee. The colour follows
the earliest assignment and does not change between requests. Assignees are
not ordered by display name or user id, and who is assigned does not change.

Every read of a task's assignees uses `orderBy: { id: "asc" }`, including
the project task list the calendar loads. A list built in JavaScript is
sorted the same way.
