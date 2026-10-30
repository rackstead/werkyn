import { Prisma } from "@prisma/client";
import { INT32_MAX, isDateOnly, type BackupFile, type RestoreSummary } from "@pm/shared";
import { sanitizeDescription } from "../../utils/description-html.js";
import { planCustomFieldRestore } from "./custom-field-restore.js";
import { UserMapper } from "./id-mapper.js";
import { RESTORE_TEXT_LIMITS } from "./restore-validation.js";
import { toCustomFieldType, toJsonValue, toPriority } from "./backup-types.js";

/**
 * The restore plan turns a validated backup into the rows to insert, with
 * every reference resolved inside the project, channel or wiki space it
 * belongs to. Preview and restore run the same plan: preview only counts the
 * rows, restore writes them, so both report the same counts and warnings.
 */

/** Rows by table, in an order where every row only references earlier tables. */
export interface RestoreRows {
  project: Prisma.ProjectCreateManyInput;
  statusColumn: Prisma.StatusColumnCreateManyInput;
  label: Prisma.LabelCreateManyInput;
  customField: Prisma.CustomFieldCreateManyInput;
  projectMember: Prisma.ProjectMemberCreateManyInput;
  task: Prisma.TaskCreateManyInput;
  taskAssignee: Prisma.TaskAssigneeCreateManyInput;
  taskLabel: Prisma.TaskLabelCreateManyInput;
  subtask: Prisma.SubtaskCreateManyInput;
  customFieldValue: Prisma.CustomFieldValueCreateManyInput;
  comment: Prisma.CommentCreateManyInput;
  activityLog: Prisma.ActivityLogCreateManyInput;
  taskDependency: Prisma.TaskDependencyCreateManyInput;
  chatChannel: Prisma.ChatChannelCreateManyInput;
  chatChannelMember: Prisma.ChatChannelMemberCreateManyInput;
  chatMessage: Prisma.ChatMessageCreateManyInput;
  chatReaction: Prisma.ChatReactionCreateManyInput;
  wikiSpace: Prisma.WikiSpaceCreateManyInput;
  wikiPage: Prisma.WikiPageCreateManyInput;
  wikiPageComment: Prisma.WikiPageCommentCreateManyInput;
}

export type RestoreTable = keyof RestoreRows;

export const RESTORE_TABLES: readonly RestoreTable[] = [
  "project",
  "statusColumn",
  "label",
  "customField",
  "projectMember",
  "task",
  "taskAssignee",
  "taskLabel",
  "subtask",
  "customFieldValue",
  "comment",
  "activityLog",
  "taskDependency",
  "chatChannel",
  "chatChannelMember",
  "chatMessage",
  "chatReaction",
  "wikiSpace",
  "wikiPage",
  "wikiPageComment",
];

export type RestoreRow = {
  [K in RestoreTable]: { table: K; data: RestoreRows[K] & { id: string } };
}[RestoreTable];

function row<K extends RestoreTable>(table: K, data: RestoreRows[K] & { id: string }) {
  return { table, data } as RestoreRow;
}

export interface RestoreMember {
  id: string;
  email: string;
  displayName: string;
  role: string;
}

/** What the plan needs to know about the target workspace. */
export interface RestoreTarget {
  workspaceId: string;
  adminUserId: string;
  members: RestoreMember[];
  /** Wiki space slugs already used in the workspace; restored slugs are added. */
  takenSlugs: Set<string>;
  nextWikiSpacePosition: number;
  /** Stored URL of each restored asset, in archive order. */
  assetUrls: ReadonlyMap<string, string>;
}

/** Maps backup users to current workspace members by email (case-insensitive). */
export function mapUsers(
  backup: BackupFile,
  members: RestoreMember[],
  adminUserId: string,
): UserMapper {
  const mapper = new UserMapper(adminUserId);
  const byEmail = new Map(members.map((m) => [m.email.toLowerCase(), m]));
  for (const ref of backup.metadata.userRefs) {
    const match = byEmail.get(ref.email.toLowerCase());
    mapper.addMapping(
      ref.originalId,
      ref.email,
      ref.displayName,
      match?.id ?? null,
      match?.displayName ?? null,
    );
  }
  return mapper;
}

const compare = (a: number, b: number) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Positions for the items of one ordered scope (a column's tasks, a project's
 * columns or custom fields, a task's subtasks, a page's children). They are
 * kept when they are distinct integers a PostgreSQL integer column holds;
 * otherwise the scope is renumbered 0..n-1 in (position, file order), which
 * keeps the order the source showed.
 */
export function scopePositions(positions: number[]): { positions: number[]; renumbered: boolean } {
  const seen = new Set<number>();
  for (const position of positions) {
    if (!Number.isInteger(position) || position < 0 || position > INT32_MAX || seen.has(position)) {
      const order = positions
        .map((_, index) => index)
        .sort((a, b) => compare(positions[a], positions[b]) || a - b);
      const result = new Array<number>(positions.length);
      order.forEach((index, rank) => (result[index] = rank));
      return { positions: result, renumbered: true };
    }
    seen.add(position);
  }
  return { positions, renumbered: false };
}

function withSuffix(name: string, suffix: string, limit: number) {
  const chars = Array.from(name);
  return chars.slice(0, Math.max(0, limit - suffix.length)).join("") + suffix;
}

/**
 * Names that must be unique within a project (labels, custom fields): the
 * first use keeps its name, later repeats become "Name (2)", "Name (3)"…,
 * never equal to another name in the list, within the column length.
 */
export function uniqueNames(names: string[], limit: number) {
  const taken = new Set(names);
  const used = new Set<string>();
  const renamed: Array<[string, string]> = [];
  const result = names.map((name) => {
    if (!used.has(name)) {
      used.add(name);
      return name;
    }
    let candidate = name;
    for (let n = 2; taken.has(candidate) || used.has(candidate); n++)
      candidate = withSuffix(name, ` (${n})`, limit);
    used.add(candidate);
    renamed.push([name, candidate]);
    return candidate;
  });
  return { names: result, renamed };
}

/** Same slug as the wiki's space create (wiki-spaces.service.ts). */
function slugBase(name: string) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}

/** The space's slug, or the first free "-2", "-3"… variant in the workspace. */
function uniqueSlug(name: string, taken: Set<string>) {
  const base = slugBase(name) || "space";
  let slug = base;
  for (let n = 2; taken.has(slug); n++) slug = `${base}-${n}`;
  taken.add(slug);
  return slug;
}

/** Archive paths with their URLs, and the distinct path lengths, longest first. */
export interface AssetMatcher {
  urls: ReadonlyMap<string, string>;
  lengths: number[];
}

export function assetMatcher(urls: ReadonlyMap<string, string>): AssetMatcher {
  const lengths = [...new Set([...urls.keys()].map((p) => p.length))].sort((a, b) => b - a);
  return { urls, lengths };
}

/**
 * At each "assets/" in `text`, from left to right, replaces the longest
 * archive path that starts there with its URL and continues after it, so a
 * path never consumes part of a longer one ("assets/a" in "assets/a.png").
 * Every archive path starts with "assets/" and no URL contains it.
 */
function rewriteText(text: string, matcher: AssetMatcher, hits?: Set<string>): string {
  let at = text.indexOf("assets/");
  if (at < 0) return text;
  let out = "";
  let copied = 0;
  while (at >= 0) {
    let next = at + 1;
    for (const length of matcher.lengths) {
      if (at + length > text.length) continue;
      const path = text.slice(at, at + length);
      const url = matcher.urls.get(path);
      if (url === undefined) continue;
      out += text.slice(copied, at) + url;
      copied = next = at + length;
      hits?.add(path);
      break;
    }
    at = text.indexOf("assets/", next);
  }
  return copied === 0 ? text : out + text.slice(copied);
}

/**
 * Rewrites archive asset paths in every string of a JSON value (see
 * rewriteText). Returns the same value when nothing changed, and records each
 * replaced path in `hits`. Recursion is bounded by MAX_RESTORE_JSON_DEPTH.
 */
export function rewriteAssetPaths(value: unknown, matcher: AssetMatcher, hits?: Set<string>): unknown {
  if (matcher.urls.size === 0) return value;
  if (typeof value === "string") return rewriteText(value, matcher, hits);
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    let out: unknown[] | undefined;
    value.forEach((item, index) => {
      const next = rewriteAssetPaths(item, matcher, hits);
      if (next === item) return;
      out ??= value.slice();
      out[index] = next;
    });
    return out ?? value;
  }
  let out: Record<string, unknown> | undefined;
  const record = value as Record<string, unknown>;
  for (const key in record) {
    const next = rewriteAssetPaths(record[key], matcher, hits);
    if (next === record[key]) continue;
    out ??= { ...record };
    // defineProperty keeps a "__proto__" member an ordinary property.
    Object.defineProperty(out, key, { value: next, enumerable: true, writable: true, configurable: true });
  }
  return out ?? value;
}

/** A nullable JSON column: SQL NULL for a missing or null value. */
function json(value: unknown): Prisma.InputJsonValue | typeof Prisma.DbNull {
  return value === null || value === undefined ? Prisma.DbNull : toJsonValue(value);
}

function validDate(value: string | null | undefined, invalid: { count: number }) {
  if (value === null || value === undefined) return null;
  if (isDateOnly(value)) return value;
  invalid.count++;
  return null;
}

type BackupProject = BackupFile["projects"][number];

/**
 * Yields every row to insert, parents before the rows that reference them,
 * and appends warnings for what is skipped or changed. `newId` names each
 * row. Policies (docs/remediation/backup-restore.md):
 *
 * - references resolve only inside their own project, channel or wiki space;
 *   a reference to anything else (missing, or another project's row) is
 *   dropped with a warning, except a task's column, which falls back to the
 *   project's first column, as the A10 repair does;
 * - assignees must have access to the restored project (a workspace admin or
 *   a restored project member);
 * - repeated references are written once; repeated label or custom-field
 *   names get a numbered suffix; repeated or invalid positions are renumbered;
 * - a project keeps at most one completion column (the first).
 */
export function* planRestore(
  backup: BackupFile,
  target: RestoreTarget,
  users: UserMapper,
  newId: () => string,
  warnings: string[],
): Generator<RestoreRow> {
  const { workspaceId, adminUserId } = target;
  const memberIds = new Set(target.members.map((m) => m.id));
  const admins = new Set(target.members.filter((m) => m.role === "ADMIN").map((m) => m.id));
  const assets = assetMatcher(target.assetUrls);

  // Field references by project, to tell another project's field from one
  // left out of the export.
  const fieldProjects = new Map<string, Set<number>>();
  backup.projects.forEach((entry, index) => {
    for (const field of entry.customFields) {
      const projects = fieldProjects.get(field._originalId) ?? new Set<number>();
      projects.add(index);
      fieldProjects.set(field._originalId, projects);
    }
  });

  for (const [index, entry] of backup.projects.entries()) {
    yield* planProject(entry, index);
  }
  for (const entry of backup.channels) yield* planChannel(entry);
  let spacePosition = target.nextWikiSpacePosition;
  for (const entry of backup.wikiSpaces) yield* planWikiSpace(entry, spacePosition++);

  function* planProject(entry: BackupProject, index: number): Generator<RestoreRow> {
    const name = entry.project.name;
    const projectWarnings: string[] = [];
    const note = (count: number, message: string) => {
      if (count > 0) projectWarnings.push(`Project "${name}": ${message.replace("#", String(count))}`);
    };
    const projectId = newId();
    yield row("project", {
      id: projectId,
      workspaceId,
      name,
      description: entry.project.description,
      color: entry.project.color,
      icon: entry.project.icon,
    });

    // Columns: one completion column at most, kept in position order.
    const statusPositions = scopePositions(entry.statuses.map((s) => s.position));
    note(Number(statusPositions.renumbered), "renumbered status columns with repeated or invalid positions");
    const byPosition = entry.statuses
      .map((_, i) => i)
      .sort((a, b) => statusPositions.positions[a] - statusPositions.positions[b]);
    const completion = byPosition.find((i) => entry.statuses[i].isCompletion);
    note(
      entry.statuses.filter((s, i) => s.isCompletion && i !== completion).length,
      "# extra completion column(s) were restored as regular columns",
    );
    const statusIds = new Map<string, string>();
    const columnIds = entry.statuses.map(() => newId());
    for (const [i, s] of entry.statuses.entries()) {
      statusIds.set(s._originalId, columnIds[i]);
      yield row("statusColumn", {
        id: columnIds[i],
        projectId,
        name: s.name,
        color: s.color,
        position: statusPositions.positions[i],
        isCompletion: i === completion,
      });
    }
    const firstColumn = byPosition.length > 0 ? columnIds[byPosition[0]] : undefined;

    const labelNames = uniqueNames(entry.labels.map((l) => l.name), RESTORE_TEXT_LIMITS.labelName);
    note(
      labelNames.renamed.length,
      `# repeated label name(s) were restored with a numbered suffix, such as "${labelNames.renamed[0]?.[1]}"`,
    );
    const labelIds = new Map<string, string>();
    for (const [i, l] of entry.labels.entries()) {
      const id = newId();
      labelIds.set(l._originalId, id);
      yield row("label", { id, projectId, name: labelNames.names[i], color: l.color });
    }

    const fieldPlan = planCustomFieldRestore(entry, (ref) => {
      const projects = fieldProjects.get(ref);
      return !!projects && !projects.has(index);
    });
    for (const warning of fieldPlan.warnings) warnings.push(warning);
    const fieldNames = uniqueNames(
      fieldPlan.fields.map((f) => f.name),
      RESTORE_TEXT_LIMITS.customFieldName,
    );
    note(
      fieldNames.renamed.length,
      `# repeated custom field name(s) were restored with a numbered suffix, such as "${fieldNames.renamed[0]?.[1]}"`,
    );
    const fieldPositions = scopePositions(fieldPlan.fields.map((f) => f.position));
    note(Number(fieldPositions.renumbered), "renumbered custom fields with repeated or invalid positions");
    const fieldIds = new Map<string, string>();
    for (const [i, f] of fieldPlan.fields.entries()) {
      const id = newId();
      fieldIds.set(f.originalId, id);
      yield row("customField", {
        id,
        projectId,
        name: fieldNames.names[i],
        type: toCustomFieldType(f.type),
        options: f.options ?? Prisma.DbNull,
        required: f.required,
        position: fieldPositions.positions[i],
      });
    }

    // Members must be current workspace members (mapped by email).
    const projectMembers = new Set<string>();
    for (const m of entry.members) {
      const userId = users.resolveOptional(m.userRef);
      if (!userId || !memberIds.has(userId) || projectMembers.has(userId)) continue;
      projectMembers.add(userId);
      yield row("projectMember", { id: newId(), projectId, userId });
    }
    const hasAccess = (userId: string) => admins.has(userId) || projectMembers.has(userId);

    // Tasks: the column (own, else the first one), then positions per column.
    const taskColumns = entry.tasks.map((t) => statusIds.get(t.statusRef) ?? firstColumn);
    note(
      firstColumn ? entry.tasks.filter((t) => !statusIds.has(t.statusRef)).length : 0,
      `# task(s) refer to a status column that is not in the project and were placed in the first column`,
    );
    note(
      firstColumn ? 0 : entry.tasks.length,
      "skipped # task(s) because the project has no status columns",
    );
    const taskPositions = new Array<number>(entry.tasks.length);
    const byColumn = new Map<string, number[]>();
    taskColumns.forEach((column, i) => {
      if (!column) return;
      const list = byColumn.get(column) ?? [];
      list.push(i);
      byColumn.set(column, list);
    });
    let renumberedColumns = 0;
    for (const indexes of byColumn.values()) {
      const scoped = scopePositions(indexes.map((i) => entry.tasks[i].position));
      if (scoped.renumbered) renumberedColumns++;
      indexes.forEach((taskIndex, k) => (taskPositions[taskIndex] = scoped.positions[k]));
    }
    note(renumberedColumns, "renumbered tasks in # column(s) with repeated or invalid positions");

    const taskIds = new Map<string, string>();
    const invalidDates = { count: 0 };
    let droppedAssignees = 0;
    let droppedLabels = 0;
    let clearedSubtaskAssignees = 0;
    let renumberedSubtasks = 0;
    for (const [i, t] of entry.tasks.entries()) {
      const statusId = taskColumns[i];
      if (!statusId) continue;
      const taskId = newId();
      taskIds.set(t._originalId, taskId);
      yield row("task", {
        id: taskId,
        projectId,
        statusId,
        title: t.title,
        description: sanitizeDescription(t.description),
        priority: toPriority(t.priority),
        position: taskPositions[i],
        dueDate: validDate(t.dueDate, invalidDates),
        startDate: validDate(t.startDate, invalidDates),
      });

      const assigned = new Set<string>();
      for (const ref of t.assignees) {
        const userId = users.resolveOptional(ref);
        if (!userId || assigned.has(userId)) continue;
        if (!hasAccess(userId)) {
          droppedAssignees++;
          continue;
        }
        assigned.add(userId);
        yield row("taskAssignee", { id: newId(), taskId, userId });
      }

      const labelled = new Set<string>();
      for (const ref of t.labels) {
        const labelId = labelIds.get(ref);
        if (!labelId) {
          droppedLabels++;
          continue;
        }
        if (labelled.has(labelId)) continue;
        labelled.add(labelId);
        yield row("taskLabel", { id: newId(), taskId, labelId });
      }

      const subtaskPositions = scopePositions(t.subtasks.map((s) => s.position));
      if (subtaskPositions.renumbered) renumberedSubtasks++;
      for (const [k, s] of t.subtasks.entries()) {
        let assigneeId = users.resolveOptional(s.assigneeRef);
        if (assigneeId && !hasAccess(assigneeId)) {
          clearedSubtaskAssignees++;
          assigneeId = null;
        }
        yield row("subtask", {
          id: newId(),
          taskId,
          title: s.title,
          completed: s.completed,
          position: subtaskPositions.positions[k],
          assigneeId,
          dueDate: validDate(s.dueDate, invalidDates),
        });
      }

      for (const v of fieldPlan.values.get(t) ?? []) {
        const fieldId = fieldIds.get(v.fieldRef);
        if (!fieldId) continue;
        yield row("customFieldValue", { id: newId(), taskId, fieldId, value: v.value });
      }

      for (const c of t.comments) {
        yield row("comment", {
          id: newId(),
          taskId,
          authorId: users.resolveOptional(c.authorRef),
          body: c.body,
          createdAt: new Date(c.createdAt),
        });
      }

      for (const a of t.activityLogs) {
        yield row("activityLog", {
          id: newId(),
          taskId,
          action: a.action,
          details: json(a.details),
          actorId: users.resolveOptional(a.actorRef),
          createdAt: new Date(a.createdAt),
        });
      }
    }
    note(droppedAssignees, "skipped # assignment(s) of users who would have no access to the project");
    note(droppedLabels, "skipped # task label(s) that are not labels of the project");
    note(clearedSubtaskAssignees, "cleared # subtask assignee(s) who would have no access to the project");
    note(renumberedSubtasks, "renumbered the subtasks of # task(s) with repeated or invalid positions");
    note(invalidDates.count, "skipped # due or start date(s) that are not valid YYYY-MM-DD dates");

    // Dependencies only link restored tasks of this project (the validation
    // already refused cycles and self-dependencies).
    let droppedDependencies = 0;
    for (const t of entry.tasks) {
      const blockedTaskId = taskIds.get(t._originalId);
      if (!blockedTaskId) continue;
      const linked = new Set<string>();
      for (const dep of t.dependencies) {
        const blockingTaskId = taskIds.get(dep.blockingTaskRef);
        if (!blockingTaskId) {
          droppedDependencies++;
          continue;
        }
        if (linked.has(blockingTaskId)) continue;
        linked.add(blockingTaskId);
        yield row("taskDependency", { id: newId(), blockedTaskId, blockingTaskId });
      }
    }
    note(droppedDependencies, "skipped # dependenc(ies) on tasks that are not in the project");
    note(
      entry.attachments.length,
      "# attachment record(s) were not restored; backup restore does not include attachments",
    );
    for (const warning of projectWarnings) warnings.push(warning);
  }

  function* planChannel(entry: BackupFile["channels"][number]): Generator<RestoreRow> {
    const channelId = newId();
    yield row("chatChannel", {
      id: channelId,
      workspaceId,
      name: entry.channel.name,
      description: entry.channel.description,
      type: entry.channel.type,
      createdById: adminUserId,
    });

    const members = new Set<string>();
    for (const m of entry.members) {
      const userId = users.resolveOptional(m.userRef);
      if (!userId || !memberIds.has(userId) || members.has(userId)) continue;
      members.add(userId);
      yield row("chatChannelMember", { id: newId(), channelId, userId });
    }
    if (!members.has(adminUserId))
      yield row("chatChannelMember", { id: newId(), channelId, userId: adminUserId });

    // A reply keeps its parent only when the parent is an earlier message of
    // the same channel (exports list messages oldest first).
    const messageIds = new Map<string, string>();
    let detached = 0;
    for (const m of entry.messages) {
      const parentId = m.parentRef ? messageIds.get(m.parentRef) : undefined;
      if (m.parentRef && !parentId) detached++;
      const messageId = newId();
      yield row("chatMessage", {
        id: messageId,
        channelId,
        userId: users.resolve(m.userRef),
        content: m.content,
        parentId,
        createdAt: new Date(m.createdAt),
      });
      messageIds.set(m._originalId, messageId);

      const reacted = new Set<string>();
      for (const r of m.reactions) {
        const userId = users.resolveOptional(r.userRef);
        if (!userId) continue;
        const key = `${userId}\u0000${r.emoji}`;
        if (reacted.has(key)) continue;
        reacted.add(key);
        yield row("chatReaction", { id: newId(), messageId, userId, emoji: r.emoji });
      }
    }
    if (detached > 0)
      warnings.push(
        `Channel "${entry.channel.name ?? ""}": restored ${detached} repl(ies) without their thread because the parent message is not an earlier message of the channel`,
      );
  }

  function* planWikiSpace(
    entry: BackupFile["wikiSpaces"][number],
    position: number,
  ): Generator<RestoreRow> {
    const spaceId = newId();
    yield row("wikiSpace", {
      id: spaceId,
      workspaceId,
      name: entry.space.name,
      slug: uniqueSlug(entry.space.name, target.takenSlugs),
      description: entry.space.description,
      icon: entry.space.icon,
      position,
    });

    // Parents resolve only to pages of this space (validated: no cycles, no
    // other space). A parent missing from the backup makes the page a root.
    const present = new Set(entry.pages.map((p) => p._originalId));
    const parentOf = entry.pages.map((p) => {
      if (!p.parentRef) return null;
      if (present.has(p.parentRef)) return p.parentRef;
      warnings.push(
        `Skipped parent link for wiki page "${p.title}" — parent ref ${p.parentRef} not found`,
      );
      return null;
    });
    const children = new Map<string | null, number[]>();
    parentOf.forEach((parent, i) => {
      const list = children.get(parent) ?? [];
      list.push(i);
      children.set(parent, list);
    });
    const pagePositions = new Array<number>(entry.pages.length);
    let renumbered = 0;
    for (const siblings of children.values()) {
      const scoped = scopePositions(siblings.map((i) => entry.pages[i].position));
      if (scoped.renumbered) renumbered++;
      siblings.forEach((pageIndex, k) => (pagePositions[pageIndex] = scoped.positions[k]));
    }
    if (renumbered > 0)
      warnings.push(
        `Wiki space "${entry.space.name}": renumbered the pages of ${renumbered} parent(s) with repeated or invalid positions`,
      );

    // Parents are written before their children.
    const pageIds = new Map<string, string>();
    const queue = [...(children.get(null) ?? [])];
    for (let next = 0; next < queue.length; next++) {
      const i = queue[next];
      const p = entry.pages[i];
      const pageId = newId();
      pageIds.set(p._originalId, pageId);
      for (const child of children.get(p._originalId) ?? []) queue.push(child);
      yield row("wikiPage", {
        id: pageId,
        spaceId,
        parentId: parentOf[i] === null ? null : pageIds.get(parentOf[i]!)!,
        title: p.title,
        content: json(rewriteAssetPaths(p.content, assets)),
        icon: p.icon,
        position: pagePositions[i],
        createdById: users.resolve(p.createdByRef ?? ""),
      });
      for (const c of p.comments) {
        yield row("wikiPageComment", {
          id: newId(),
          pageId,
          authorId: users.resolve(c.authorRef ?? ""),
          body: c.body,
          resolved: c.resolved,
          highlightId: c.highlightId,
          selectionStart: json(c.selectionStart),
          selectionEnd: json(c.selectionEnd),
          createdAt: new Date(c.createdAt),
        });
      }
    }
  }
}

export type RestoreCounts = Record<RestoreTable, number>;

export function emptyCounts(): RestoreCounts {
  return Object.fromEntries(RESTORE_TABLES.map((table) => [table, 0])) as RestoreCounts;
}

export function restoreSummary(
  counts: RestoreCounts,
  images: number,
  users: UserMapper,
  warnings: string[],
): RestoreSummary {
  return {
    projects: counts.project,
    statuses: counts.statusColumn,
    labels: counts.label,
    customFields: counts.customField,
    tasks: counts.task,
    subtasks: counts.subtask,
    comments: counts.comment,
    activityLogs: counts.activityLog,
    channels: counts.chatChannel,
    messages: counts.chatMessage,
    reactions: counts.chatReaction,
    wikiSpaces: counts.wikiSpace,
    wikiPages: counts.wikiPage,
    wikiComments: counts.wikiPageComment,
    images,
    userMappings: users.getMappings().map((m) => ({
      originalEmail: m.originalEmail,
      originalName: m.originalName,
      mappedUserId: m.resolvedId,
      mappedName: m.resolvedName,
    })),
    warnings,
  };
}
