import { Priority } from "@prisma/client";
import { CustomFieldTypeEnum, type BackupFile } from "@pm/shared";
import { ValidationError } from "../../utils/errors.js";
import { graphLimits } from "../../utils/graph-limits.js";

type BackupProject = BackupFile["projects"][number];
type BackupWikiSpace = BackupFile["wikiSpaces"][number];

/**
 * Deepest nesting restore writes into one JSON column (wiki page content,
 * activity details, comment selections), counting every object and array.
 * Prisma's query engine refuses a deeper value in a single-row insert
 * ("recursion limit exceeded"; a batched insert holds one level less, so the
 * writer inserts such rows one by one) and reads back about 126 levels. The
 * backup.json depth limit (BACKUP_JSON_LIMITS.maxDepth, 128) already keeps
 * wiki content at or under this; the check keeps restore safe on its own.
 */
export const MAX_RESTORE_JSON_DEPTH = 123;

/** Column lengths in characters (`VarChar` in schema.prisma). */
export const RESTORE_TEXT_LIMITS = Object.freeze({
  projectName: 255,
  statusName: 100,
  labelName: 100,
  customFieldName: 100,
  taskTitle: 255,
  subtaskTitle: 255,
  commentBody: 10_000,
  channelName: 100,
  channelDescription: 500,
  reactionEmoji: 32,
  wikiSpaceName: 100,
  wikiPageTitle: 500,
  wikiCommentBody: 10_000,
  wikiCommentHighlight: 100,
});

const PRIORITIES = new Set<string>(Object.values(Priority));

/**
 * PostgreSQL text and jsonb cannot hold U+0000, and Prisma's query engine
 * rejects a string with an unpaired UTF-16 surrogate. With the `u` flag a
 * well-formed pair is one code point, so \p{Cs} only matches a lone half.
 */
const UNSTORABLE = /[\u0000\p{Cs}]/u;

export function isStorableText(value: string): boolean {
  return !UNSTORABLE.test(value);
}

/** True when `value` is longer than `limit` characters (code points, as PostgreSQL counts). */
function longerThan(value: string, limit: number): boolean {
  if (value.length <= limit) return false;
  let count = 0;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) i++;
    if (++count > limit) return true;
  }
  return false;
}

function invalid(message: string): ValidationError {
  return new ValidationError(`Invalid backup file: ${message}`);
}

function checkText(value: string | null | undefined, what: string, limit?: number) {
  if (value === null || value === undefined) return;
  if (!isStorableText(value)) throw invalid(`${what} contains a character that cannot be stored`);
  if (limit !== undefined && longerThan(value, limit))
    throw invalid(`${what} is longer than ${limit} characters`);
}

/**
 * Every string and member name of a JSON value must be storable, and the
 * value must nest at most MAX_RESTORE_JSON_DEPTH levels. Recursion is bounded
 * by that limit (checked before descending).
 */
export function checkJsonValue(value: unknown, what: string, level = 0): void {
  if (typeof value === "string") {
    if (!isStorableText(value)) throw invalid(`${what} contains a character that cannot be stored`);
    return;
  }
  if (value === null || typeof value !== "object") return;
  if (level >= MAX_RESTORE_JSON_DEPTH)
    throw invalid(`${what} is nested more than ${MAX_RESTORE_JSON_DEPTH} levels deep`);
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) checkJsonValue(value[i], what, level + 1);
    return;
  }
  const record = value as Record<string, unknown>;
  for (const key in record) {
    if (!isStorableText(key)) throw invalid(`${what} contains a character that cannot be stored`);
    checkJsonValue(record[key], what, level + 1);
  }
}

/** Timestamps are written to PostgreSQL `timestamp` columns. */
function checkTimestamp(value: string, what: string) {
  const time = Date.parse(value);
  const year = Number.isFinite(time) ? new Date(time).getUTCFullYear() : NaN;
  if (!(year >= 1 && year <= 9999)) throw invalid(`${what} is not a valid date`);
}

/**
 * IDs only need to be unique within the scope references resolve in (one
 * project, channel or wiki space). One Set is reused so that a file of many
 * small scopes does not allocate one per scope.
 */
function checkUnique(seen: Set<string>, ids: Iterable<string>, what: string) {
  seen.clear();
  for (const id of ids) {
    if (seen.has(id)) throw invalid(`${what} are not unique`);
    seen.add(id);
  }
  seen.clear();
}

function* flatMapIds<T>(items: T[], children: (item: T) => Array<{ _originalId: string }>) {
  for (const item of items) for (const child of children(item)) yield child._originalId;
}

/**
 * Refuses a dependency cycle (including a task blocked by itself) among the
 * dependencies inside one project. Dependencies on tasks outside the project
 * are never restored, so they cannot close a cycle. Iterative DFS, linear in
 * tasks and dependencies.
 */
function checkDependencyGraph(entry: BackupProject, where: string) {
  if (!entry.tasks.some((task) => task.dependencies.length > 0)) return;
  const byId = new Map(entry.tasks.map((task) => [task._originalId, task]));
  const VISITING = 1;
  const DONE = 2;
  const state = new Map<string, number>();
  for (const root of entry.tasks) {
    if (state.has(root._originalId)) continue;
    state.set(root._originalId, VISITING);
    const stack: Array<{ id: string; next: number }> = [{ id: root._originalId, next: 0 }];
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      const deps = byId.get(frame.id)!.dependencies;
      if (frame.next >= deps.length) {
        state.set(frame.id, DONE);
        stack.pop();
        continue;
      }
      const target = deps[frame.next++].blockingTaskRef;
      if (!byId.has(target)) continue;
      const seen = state.get(target);
      if (seen === VISITING) throw invalid(`task dependencies in ${where} form a cycle`);
      if (seen === undefined) {
        state.set(target, VISITING);
        stack.push({ id: target, next: 0 });
      }
    }
  }
}

/**
 * Preview and restore share this check, so an invalid page hierarchy is
 * rejected before any asset or database write. A parent must be another page
 * of the same space, the parent chain must end at a root, and no page may sit
 * deeper than the wiki's tree budget (graphLimits.maxDepth pages from the
 * root, which breadcrumbs and moves walk). A parent that is absent from the
 * whole backup keeps the existing skip-with-warning behavior (the page is
 * restored at the root).
 */
function checkWikiGraph(backup: BackupFile, seen: Set<string>) {
  const spaceOf = new Map<string, number>();
  backup.wikiSpaces.forEach((ws, index) => {
    for (const p of ws.pages) spaceOf.set(p._originalId, index);
  });
  backup.wikiSpaces.forEach((ws: BackupWikiSpace, index) => {
    const where = `wiki space ${index + 1}`;
    const parents = new Map<string, string | null>();
    for (const p of ws.pages) {
      if (parents.has(p._originalId)) throw invalid("duplicate wiki page id");
      parents.set(p._originalId, p.parentRef ?? null);
    }
    checkUnique(seen, flatMapIds(ws.pages, (p) => p.comments), `wiki comment ids in ${where}`);
    for (const p of ws.pages) {
      if (!p.parentRef) continue;
      if (!parents.has(p.parentRef) && spaceOf.has(p.parentRef))
        throw invalid("wiki page parent is in another space");
    }
    // Ancestor count of each page. Every chain is walked once, so this is
    // linear; a chain that returns to a page on it is a cycle.
    const depth = new Map<string, number>();
    const path: string[] = [];
    const onPath = new Set<string>();
    for (const start of parents.keys()) {
      path.length = 0;
      onPath.clear();
      let current: string | null | undefined = start;
      let base = -1;
      while (current && parents.has(current)) {
        const known = depth.get(current);
        if (known !== undefined) {
          base = known;
          break;
        }
        if (onPath.has(current)) throw invalid("wiki page hierarchy contains a cycle");
        onPath.add(current);
        path.push(current);
        current = parents.get(current);
      }
      for (let i = path.length - 1; i >= 0; i--) {
        base++;
        if (base >= graphLimits.maxDepth)
          throw invalid(`wiki pages in ${where} are nested more than ${graphLimits.maxDepth} levels deep`);
        depth.set(path[i], base);
      }
    }
  });
}

/**
 * Everything that makes restore refuse a backup, checked before any asset or
 * database write and shared by preview and restore. The first problem found
 * is reported; messages name a position in the file, never its content.
 *
 * Refused: IDs repeated within the scope they resolve in, text that a column
 * cannot hold (too long, U+0000, an unpaired surrogate), JSON nested deeper
 * than MAX_RESTORE_JSON_DEPTH, timestamps PostgreSQL cannot store, an unknown
 * priority or custom-field type, dependency cycles and invalid wiki trees.
 * Problems restore can repair without guessing (references outside their
 * project, missing users, repeated names, positions, invalid dates) are
 * handled in the restore plan with a warning instead.
 */
export function validateBackup(backup: BackupFile): void {
  const L = RESTORE_TEXT_LIMITS;
  const seen = new Set<string>();
  checkUnique(seen, backup.metadata.userRefs.map((ref) => ref.originalId), "user reference ids");

  backup.projects.forEach((entry, index) => {
    const where = `project ${index + 1}`;
    const { project } = entry;
    checkText(project.name, `the name of ${where}`, L.projectName);
    checkText(project.description, `the description of ${where}`);
    checkText(project.color, `the color of ${where}`);
    checkText(project.icon, `the icon of ${where}`);

    checkUnique(seen, entry.statuses.map((s) => s._originalId), `status ids in ${where}`);
    checkUnique(seen, entry.labels.map((l) => l._originalId), `label ids in ${where}`);
    checkUnique(seen, entry.customFields.map((f) => f._originalId), `custom field ids in ${where}`);
    checkUnique(seen, entry.tasks.map((t) => t._originalId), `task ids in ${where}`);
    checkUnique(seen, flatMapIds(entry.tasks, (t) => t.subtasks), `subtask ids in ${where}`);
    checkUnique(seen, flatMapIds(entry.tasks, (t) => t.comments), `comment ids in ${where}`);
    checkUnique(seen, flatMapIds(entry.tasks, (t) => t.activityLogs), `activity ids in ${where}`);

    for (const s of entry.statuses) {
      checkText(s.name, `a status name in ${where}`, L.statusName);
      checkText(s.color, `a status color in ${where}`);
    }
    for (const l of entry.labels) {
      checkText(l.name, `a label name in ${where}`, L.labelName);
      checkText(l.color, `a label color in ${where}`);
    }
    for (const f of entry.customFields) {
      checkText(f.name, `a custom field name in ${where}`, L.customFieldName);
      if (!CustomFieldTypeEnum.safeParse(f.type).success)
        throw invalid(`a custom field in ${where} has an unknown type`);
    }
    for (const t of entry.tasks) {
      checkText(t.title, `a task title in ${where}`, L.taskTitle);
      checkText(t.description, `a task description in ${where}`);
      if (!PRIORITIES.has(t.priority)) throw invalid(`a task priority in ${where} is not valid`);
      for (const s of t.subtasks) checkText(s.title, `a subtask title in ${where}`, L.subtaskTitle);
      for (const c of t.comments) {
        checkText(c.body, `a comment in ${where}`, L.commentBody);
        checkTimestamp(c.createdAt, `a comment date in ${where}`);
      }
      for (const a of t.activityLogs) {
        checkText(a.action, `an activity entry in ${where}`);
        checkJsonValue(a.details, `an activity entry in ${where}`);
        checkTimestamp(a.createdAt, `an activity date in ${where}`);
      }
    }
    checkDependencyGraph(entry, where);
  });

  backup.channels.forEach((entry, index) => {
    const where = `channel ${index + 1}`;
    checkText(entry.channel.name, `the name of ${where}`, L.channelName);
    checkText(entry.channel.description, `the description of ${where}`, L.channelDescription);
    checkUnique(seen, entry.messages.map((m) => m._originalId), `message ids in ${where}`);
    for (const m of entry.messages) {
      checkText(m.content, `a message in ${where}`);
      checkTimestamp(m.createdAt, `a message date in ${where}`);
      for (const r of m.reactions) checkText(r.emoji, `a reaction in ${where}`, L.reactionEmoji);
    }
  });

  backup.wikiSpaces.forEach((entry, index) => {
    const where = `wiki space ${index + 1}`;
    checkText(entry.space.name, `the name of ${where}`, L.wikiSpaceName);
    checkText(entry.space.description, `the description of ${where}`);
    checkText(entry.space.icon, `the icon of ${where}`);
    for (const p of entry.pages) {
      checkText(p.title, `a page title in ${where}`, L.wikiPageTitle);
      checkText(p.icon, `a page icon in ${where}`);
      checkJsonValue(p.content, `the content of a page in ${where}`);
      for (const c of p.comments) {
        checkText(c.body, `a page comment in ${where}`, L.wikiCommentBody);
        checkText(c.highlightId, `a page comment in ${where}`, L.wikiCommentHighlight);
        checkJsonValue(c.selectionStart, `a page comment in ${where}`);
        checkJsonValue(c.selectionEnd, `a page comment in ${where}`);
        checkTimestamp(c.createdAt, `a page comment date in ${where}`);
      }
    }
  });
  checkWikiGraph(backup, seen);
}
