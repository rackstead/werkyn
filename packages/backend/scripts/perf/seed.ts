// Performance fixture: fills an empty, disposable database with a realistic
// multi-workspace data set (about 100k tasks, 200k chat messages, 20k wiki
// pages, 50k files, plus time entries, notifications and activity) for query
// profiling. See docs/remediation/p02a.md.
//
//   PERF_SEED_CONFIRM=<database name> DATABASE_URL=... pnpm --dir packages/backend perf:seed
//
// It only inserts rows, always the same ones for the same PERF_SEED_SCALE and
// PERF_SEED_RANDOM (dates are relative to the day it runs), and refuses to run
// unless PERF_SEED_CONFIRM names the connected database and that database has
// no users or workspaces yet. Every account gets an unusable random password;
// scripts/perf/bench.ts signs access tokens instead of logging in.

import { randomBytes } from "node:crypto";
import bcrypt from "bcrypt";
import { Prisma, PrismaClient } from "@prisma/client";

const SCALE = Number(process.env.PERF_SEED_SCALE ?? "1");
const RANDOM_SEED = Number(process.env.PERF_SEED_RANDOM ?? "20261030");
const DAY = 86_400_000;
const NOW = Date.now();

if (!(SCALE > 0 && SCALE <= 10)) throw new Error("PERF_SEED_SCALE must be in (0, 10]");

// ─── Deterministic randomness ───────────────────────────────

let state = RANDOM_SEED >>> 0;
function rand() {
  // mulberry32
  state = (state + 0x6d2b79f5) >>> 0;
  let t = state;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const int = (min: number, max: number) => min + Math.floor(rand() * (max - min + 1));
const chance = (p: number) => rand() < p;
const pick = <T>(items: readonly T[]): T => items[Math.floor(rand() * items.length)];
function sample<T>(items: readonly T[], count: number): T[] {
  const copy = [...items];
  const n = Math.min(count, copy.length);
  for (let i = 0; i < n; i++) {
    const j = i + Math.floor(rand() * (copy.length - i));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, n);
}
function weightedIndex(weights: readonly number[], total: number) {
  let r = rand() * total;
  for (let i = 0; i < weights.length; i++) {
    r -= weights[i];
    if (r < 0) return i;
  }
  return weights.length - 1;
}
/** Splits `total` over `parts` with a Zipf-like skew, so a few containers are much larger. */
function zipfSplit(total: number, parts: number, skew = 0.8) {
  const weights = Array.from({ length: parts }, (_, k) => 1 / (k + 1) ** skew);
  const sum = weights.reduce((a, b) => a + b, 0);
  const counts = weights.map((w) => Math.floor((w / sum) * total));
  counts[0] += total - counts.reduce((a, b) => a + b, 0);
  return counts;
}

// cuid-shaped ids whose prefix follows the row's creation time, as real ones do.
let idCounter = 0;
function id(at: number) {
  idCounter = (idCounter + 1) % 1_679_616;
  let tail = "";
  while (tail.length < 8) tail += Math.floor(rand() * 36).toString(36);
  return `c${Math.floor(at).toString(36).padStart(8, "0")}${idCounter.toString(36).padStart(4, "0")}${tail}`;
}
const iso = (at: number) => new Date(at).toISOString().slice(0, 10);
/** A time between `from` and `to`. */
const between = (from: number, to: number) => from + rand() * Math.max(0, to - from);

const WORDS = [
  "invoice", "migration", "onboarding", "billing", "dashboard", "export", "login", "search",
  "report", "sync", "mobile", "upload", "calendar", "permissions", "audit", "backup", "release",
  "pricing", "checkout", "analytics", "webhook", "email", "template", "roadmap", "security",
  "performance", "cache", "deploy", "pipeline", "review", "feedback", "survey", "contract",
  "vendor", "budget", "hiring", "training", "support", "ticket", "warehouse",
];
const VERBS = ["Fix", "Update", "Design", "Review", "Plan", "Draft", "Test", "Ship", "Clean up", "Investigate"];
function phrase(min: number, max: number) {
  const n = int(min, max);
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(pick(WORDS));
  return out.join(" ");
}
function sentence(minWords: number, maxWords: number) {
  const s = phrase(minWords, maxWords);
  return s.charAt(0).toUpperCase() + s.slice(1) + ".";
}

// ─── Batched inserts ────────────────────────────────────────

const prisma = new PrismaClient();
const inserted = new Map<string, number>();

/** createMany in chunks that stay under PostgreSQL's bind-parameter limit. */
async function insert<T extends Record<string, unknown>>(model: string, rows: T[]) {
  if (rows.length === 0) return;
  const columns = rows.reduce((most, row) => Math.max(most, Object.keys(row).length), 1);
  const chunk = Math.max(1, Math.floor(30_000 / columns));
  const delegate = (prisma as unknown as Record<string, { createMany(args: { data: T[] }): Promise<unknown> }>)[model];
  for (let i = 0; i < rows.length; i += chunk) {
    await delegate.createMany({ data: rows.slice(i, i + chunk) });
  }
  inserted.set(model, (inserted.get(model) ?? 0) + rows.length);
}

// ─── Shape of the fixture ───────────────────────────────────

interface WorkspacePlan {
  slug: string;
  name: string;
  users: [number, number];
  share: number;
  projects: number;
  publicChannels: number;
  privateChannels: number;
  dms: number;
  spaces: number;
  teamFolders: number;
}

const USERS = 300;
const PLANS: WorkspacePlan[] = [
  { slug: "perf-large", name: "Perf Large", users: [0, 150], share: 0.6, projects: 25, publicChannels: 30, privateChannels: 10, dms: 150, spaces: 8, teamFolders: 6 },
  { slug: "perf-medium", name: "Perf Medium", users: [120, 200], share: 0.25, projects: 13, publicChannels: 15, privateChannels: 5, dms: 60, spaces: 5, teamFolders: 4 },
  { slug: "perf-small-a", name: "Perf Small A", users: [200, 240], share: 0.1, projects: 8, publicChannels: 8, privateChannels: 3, dms: 25, spaces: 3, teamFolders: 2 },
  { slug: "perf-small-b", name: "Perf Small B", users: [270, 300], share: 0.05, projects: 4, publicChannels: 6, privateChannels: 2, dms: 15, spaces: 2, teamFolders: 1 },
];
const TOTAL = {
  tasks: Math.round(100_000 * SCALE),
  messages: Math.round(200_000 * SCALE),
  pages: Math.round(20_000 * SCALE),
  files: Math.round(50_000 * SCALE),
  timeEntries: Math.round(120_000 * SCALE),
  notifications: Math.round(200_000 * SCALE),
};

type Role = "ADMIN" | "MEMBER" | "VIEWER";
interface Member { userId: string; role: Role }
interface ProjectInfo {
  id: string;
  members: string[];
  editors: string[];
  statuses: { id: string; done: boolean }[];
  labels: string[];
  fields: { id: string; type: string }[];
  tasks: string[];
}

async function guard() {
  if (process.env.NODE_ENV === "production") throw new Error("Refusing to seed with NODE_ENV=production");
  const [{ db }] = await prisma.$queryRaw<{ db: string }[]>`SELECT current_database() AS db`;
  if (process.env.PERF_SEED_CONFIRM !== db) {
    throw new Error(`Set PERF_SEED_CONFIRM=${db} to confirm that this disposable database may be filled`);
  }
  const [users, workspaces] = await Promise.all([prisma.user.count(), prisma.workspace.count()]);
  if (users > 0 || workspaces > 0) {
    throw new Error(`Database ${db} already has ${users} user(s) and ${workspaces} workspace(s); seed only an empty, migrated database`);
  }
  return db;
}

async function main() {
  const db = await guard();
  const started = Date.now();
  console.log(`Seeding ${db} at scale ${SCALE} (random seed ${RANDOM_SEED})`);

  // ─── Users ────────────────────────────────────────────────
  const unusable = await bcrypt.hash(randomBytes(32).toString("hex"), 10);
  const userIds: string[] = [];
  const userRows = Array.from({ length: USERS }, (_, i) => {
    const at = NOW - 800 * DAY + i * 60_000;
    const uid = id(at);
    userIds.push(uid);
    return {
      id: uid,
      email: `perf-user-${String(i).padStart(4, "0")}@perf.invalid`,
      passwordHash: unusable,
      displayName: `Perf User ${String(i).padStart(4, "0")}`,
      emailVerified: true,
      isInstanceAdmin: i === 0,
      createdAt: new Date(at),
      updatedAt: new Date(at),
    };
  });
  await insert("user", userRows);
  await insert(
    "notificationPreference",
    userIds.filter(() => chance(0.3)).map((userId) => ({
      id: id(NOW - 400 * DAY),
      userId,
      dueDateReminderTiming: pick(["same_day", "1_day_before", "3_days_before", "1_week_before"]),
      chatDmMessage: chance(0.9),
    })),
  );

  for (const plan of PLANS) {
    await seedWorkspace(plan, userIds);
  }

  console.log("Analyzing");
  await prisma.$executeRawUnsafe("VACUUM ANALYZE");
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`Done in ${seconds}s`);
  for (const [model, count] of [...inserted].sort()) console.log(`  ${model.padEnd(24)} ${count}`);
}

async function seedWorkspace(plan: WorkspacePlan, allUsers: string[]) {
  const t0 = Date.now();
  const createdAt = NOW - 760 * DAY;
  const workspaceId = id(createdAt);
  await insert("workspace", [{ id: workspaceId, name: plan.name, slug: plan.slug, createdAt: new Date(createdAt), updatedAt: new Date(createdAt) }]);
  await insert("workspaceSettings", [{ id: id(createdAt), workspaceId }]);

  const users = allUsers.slice(plan.users[0], plan.users[1]);
  const members: Member[] = users.map((userId, i) => ({
    userId,
    role: i === 0 || chance(0.04) ? "ADMIN" : chance(0.15) ? "VIEWER" : "MEMBER",
  }));
  await insert(
    "workspaceMember",
    members.map((m) => ({ id: id(createdAt), userId: m.userId, workspaceId, role: m.role, joinedAt: new Date(between(createdAt, NOW - 300 * DAY)) })),
  );
  const writers = members.filter((m) => m.role !== "VIEWER").map((m) => m.userId);
  const admins = new Set(members.filter((m) => m.role === "ADMIN").map((m) => m.userId));

  // Groups
  const groups = Array.from({ length: 3 }, (_, g) => ({ id: id(createdAt), workspaceId, name: `Group ${g + 1}`, members: sample(users, int(5, 20)) }));
  await insert("group", groups.map(({ members: _m, ...g }) => g));
  await insert("groupMember", groups.flatMap((g) => g.members.map((userId) => ({ id: id(createdAt), groupId: g.id, userId }))));

  const projects = await seedProjects(plan, workspaceId, members, writers, admins);
  await seedTasks(plan, projects);
  await seedTimeEntries(plan, workspaceId, projects, members);
  const chat = await seedChat(plan, workspaceId, members);
  await seedWiki(plan, workspaceId, writers);
  const files = await seedFiles(plan, workspaceId, members, writers, groups);
  await seedNotifications(plan, workspaceId, members, projects, chat, files);
  await insert(
    "dashboardPreference",
    sample(users, Math.ceil(users.length / 3)).map((userId) => ({
      id: id(NOW - 30 * DAY),
      userId,
      workspaceId,
      widgetOrder: ["my-tasks", "activity-feed", "unread-chats", "upcoming-dates", "recent-files"],
    })),
  );
  console.log(`  ${plan.slug}: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

// ─── Projects and tasks ─────────────────────────────────────

const STATUS_NAMES = ["Backlog", "To Do", "In Progress", "Review", "Done"];
const STATUS_WEIGHTS = [0.15, 0.2, 0.15, 0.1, 0.4];
const PRIORITIES = ["NONE", "LOW", "MEDIUM", "HIGH", "URGENT"] as const;

async function seedProjects(plan: WorkspacePlan, workspaceId: string, members: Member[], writers: string[], admins: Set<string>) {
  const projects: ProjectInfo[] = [];
  const projectRows = [];
  const memberRows = [];
  const statusRows = [];
  const labelRows = [];
  const fieldRows = [];
  const templateRows = [];
  const recurringRows = [];
  for (let p = 0; p < plan.projects; p++) {
    const at = NOW - 740 * DAY + p * DAY;
    const pid = id(at);
    projectRows.push({
      id: pid,
      workspaceId,
      name: `${plan.name} Project ${String(p + 1).padStart(2, "0")} ${pick(WORDS)}`,
      color: pick(["#6366f1", "#f59e0b", "#10b981", "#ef4444", "#3b82f6"]),
      archived: p === plan.projects - 1 && plan.projects > 4,
      createdAt: new Date(at),
      updatedAt: new Date(at),
    });
    // Members join a share of the projects; the first non-admin users join most.
    const joined = members.filter((m, i) => !admins.has(m.userId) && chance(i < 10 ? 0.8 : 0.35)).map((m) => m.userId);
    for (const userId of joined) memberRows.push({ id: id(at), projectId: pid, userId, addedAt: new Date(at) });
    const statuses = STATUS_NAMES.map((name, position) => ({ id: id(at), projectId: pid, name, position, isCompletion: name === "Done" }));
    statusRows.push(...statuses);
    for (let l = 0; l < 10; l++) labelRows.push({ id: id(at), projectId: pid, name: `${WORDS[(p + l * 3) % WORDS.length]}-${l}`, color: "#6366f1" });
    fieldRows.push(
      { id: id(at), projectId: pid, name: "Notes", type: "TEXT" as const, position: 0, createdAt: new Date(at), updatedAt: new Date(at) },
      { id: id(at), projectId: pid, name: "Estimate", type: "NUMBER" as const, position: 1, createdAt: new Date(at), updatedAt: new Date(at) },
      {
        id: id(at), projectId: pid, name: "Team", type: "SELECT" as const, position: 2, createdAt: new Date(at), updatedAt: new Date(at),
        options: ["Platform", "Growth", "Design", "Ops", "Sales"].map((value) => ({ value })),
      },
      { id: id(at), projectId: pid, name: "Target", type: "DATE" as const, position: 3, createdAt: new Date(at), updatedAt: new Date(at) },
    );
    const editors = [...new Set([...joined.filter((u) => writers.includes(u)), ...admins])];
    for (let t = 0; t < 2; t++) {
      const templateId = id(at);
      templateRows.push({ id: templateId, projectId: pid, name: `Template ${t}`, title: `Recurring ${pick(WORDS)}`, statusId: statuses[1].id, createdAt: new Date(at), updatedAt: new Date(at) });
      const frequency = pick(["DAILY", "WEEKLY", "BIWEEKLY", "MONTHLY"] as const);
      recurringRows.push({
        id: id(at), projectId: pid, templateId, frequency,
        dayOfWeek: frequency === "WEEKLY" || frequency === "BIWEEKLY" ? int(0, 6) : null,
        dayOfMonth: frequency === "MONTHLY" ? int(1, 28) : null,
        startDate: iso(at), nextRunDate: iso(NOW + int(-1, 10) * DAY), lastRunDate: iso(NOW - DAY),
        isActive: chance(0.8), createdAt: new Date(at), updatedAt: new Date(at),
      });
    }
    projects.push({
      id: pid,
      members: joined,
      editors,
      statuses: statuses.map((s) => ({ id: s.id, done: s.isCompletion })),
      labels: labelRows.filter((l) => l.projectId === pid).map((l) => l.id),
      fields: fieldRows.filter((f) => f.projectId === pid).map((f) => ({ id: f.id, type: f.type })),
      tasks: [],
    });
  }
  await insert("project", projectRows);
  await insert("projectMember", memberRows);
  await insert("statusColumn", statusRows);
  await insert("label", labelRows);
  await insert("customField", fieldRows);
  await insert("taskTemplate", templateRows);
  await insert("recurringTaskConfig", recurringRows);
  return projects;
}

async function seedTasks(plan: WorkspacePlan, projects: ProjectInfo[]) {
  const counts = zipfSplit(Math.round(TOTAL.tasks * plan.share), projects.length);
  for (const [p, project] of projects.entries()) {
    const n = counts[p];
    const { labels, fields } = project;
    const assignable = project.editors.length ? project.editors : project.members;
    const positions = new Map<string, number>();
    const tasks = [];
    const assignees = [];
    const taskLabels = [];
    const values = [];
    const dependencies = [];
    const subtasks = [];
    const comments = [];
    const activity = [];
    const reminders = [];
    const start = NOW - 720 * DAY;
    for (let i = 0; i < n; i++) {
      const at = start + ((NOW - start) * (i + rand())) / n;
      const taskId = id(at);
      const status = project.statuses[weightedIndex(STATUS_WEIGHTS, 1)];
      const archived = chance(0.08);
      const key = status.id;
      let position: number;
      if (archived) position = int(0, 50);
      else {
        position = positions.get(key) ?? 0;
        positions.set(key, position + 1);
      }
      const due = chance(0.55) ? iso(between(at, NOW + 120 * DAY)) : null;
      const updated = between(at, NOW);
      tasks.push({
        id: taskId,
        projectId: project.id,
        statusId: status.id,
        title: `${pick(VERBS)} ${phrase(1, 3)} #${i + 1}`,
        description: chance(0.4) ? `<p>${sentence(15, 80)}</p>` : null,
        priority: pick(PRIORITIES),
        position,
        dueDate: due,
        startDate: chance(0.25) ? iso(between(at - 10 * DAY, at + 20 * DAY)) : null,
        reminder: chance(0.05) ? pick(["same_day", "1_day_before", "3_days_before"]) : null,
        archived,
        createdAt: new Date(at),
        updatedAt: new Date(updated),
      });
      project.tasks.push(taskId);
      const people = sample(assignable, pick([0, 1, 1, 1, 1, 2, 2, 3]));
      for (const userId of people) {
        assignees.push({ id: id(at), taskId, userId });
        if (due && chance(0.1)) reminders.push({ id: id(at), taskId, userId, dueDate: due, sentAt: new Date(updated) });
      }
      for (const labelId of sample(labels, pick([0, 0, 1, 1, 1, 2, 2, 3]))) taskLabels.push({ id: id(at), taskId, labelId });
      for (const field of fields) {
        if (!chance(0.45)) continue;
        const value =
          field.type === "TEXT" ? sentence(2, 6)
          : field.type === "NUMBER" ? int(1, 40)
          : field.type === "SELECT" ? pick(["Platform", "Growth", "Design", "Ops", "Sales"])
          : iso(between(at, NOW + 90 * DAY));
        values.push({ id: id(at), taskId, fieldId: field.id, value });
      }
      // Blockers always come from earlier tasks, so the graph stays acyclic.
      if (i > 10 && chance(0.1)) {
        const blocking = project.tasks[int(Math.max(0, i - 500), i - 1)];
        dependencies.push({ id: id(at), blockedTaskId: taskId, blockingTaskId: blocking });
      }
      if (chance(0.2)) {
        const k = int(1, 5);
        for (let s = 0; s < k; s++) {
          subtasks.push({ id: id(at), taskId, title: phrase(2, 5), completed: chance(0.5), position: s, createdAt: new Date(at), updatedAt: new Date(at) });
        }
      }
      if (chance(0.25) && project.members.length) {
        const k = int(1, 4);
        for (let c = 0; c < k; c++) {
          const when = between(at, NOW);
          comments.push({ id: id(when), taskId, authorId: pick(project.members), body: sentence(5, 40), createdAt: new Date(when), updatedAt: new Date(when) });
        }
      }
      const actor = assignable.length ? pick(assignable) : null;
      activity.push({ id: id(at), taskId, action: "created", actorId: actor, createdAt: new Date(at) });
      if (chance(0.5)) {
        const when = between(at, updated);
        activity.push({ id: id(when), taskId, action: "status_changed", details: { from: project.statuses[0].id, to: status.id }, actorId: actor, createdAt: new Date(when) });
      }
      if (chance(0.2)) {
        const when = between(at, updated);
        activity.push({ id: id(when), taskId, action: "updated", details: { field: "title" }, actorId: actor, createdAt: new Date(when) });
      }
    }
    await insert("task", tasks);
    await insert("taskAssignee", assignees);
    await insert("taskLabel", taskLabels);
    await insert("customFieldValue", values);
    await insert("taskDependency", dependencies);
    await insert("subtask", subtasks);
    await insert("comment", comments);
    await insert("activityLog", activity);
    await insert("taskReminderSent", dedupe(reminders, (r) => `${r.taskId}:${r.userId}:${r.dueDate}`));
  }
}

function dedupe<T>(rows: T[], key: (row: T) => string) {
  const seen = new Set<string>();
  return rows.filter((row) => {
    const k = key(row);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

async function seedTimeEntries(plan: WorkspacePlan, workspaceId: string, projects: ProjectInfo[], members: Member[]) {
  const total = Math.round(TOTAL.timeEntries * plan.share);
  const entries = [];
  const withMembers = projects.filter((p) => p.members.length > 0);
  for (let i = 0; i < total; i++) {
    const project = pick(withMembers);
    const at = between(NOW - 365 * DAY, NOW);
    entries.push({
      id: id(at),
      workspaceId,
      userId: pick(project.members),
      projectId: project.id,
      taskId: chance(0.7) ? pick(project.tasks) : null,
      date: iso(at),
      hours: pick([0.25, 0.5, 1, 1.5, 2, 3, 4, 6, 8]),
      description: chance(0.5) ? sentence(3, 10) : null,
      billable: chance(0.8),
      createdAt: new Date(at),
      updatedAt: new Date(at),
    });
  }
  entries.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  await insert("timeEntry", entries);
  const rates = [];
  for (const m of members) {
    rates.push({ id: id(NOW - 500 * DAY), workspaceId, userId: m.userId, rate: int(40, 150), currency: "USD", effectiveFrom: iso(NOW - 500 * DAY) });
    if (chance(0.4)) rates.push({ id: id(NOW - 100 * DAY), workspaceId, userId: m.userId, rate: int(60, 180), currency: "USD", effectiveFrom: iso(NOW - 100 * DAY) });
  }
  await insert("userRate", rates);
}

// ─── Chat ───────────────────────────────────────────────────

interface ChatInfo { channels: { id: string; members: string[]; type: string }[]; messageIds: string[] }

async function seedChat(plan: WorkspacePlan, workspaceId: string, members: Member[]): Promise<ChatInfo> {
  const users = members.map((m) => m.userId);
  const created = NOW - 400 * DAY;
  const channels: ChatInfo["channels"] = [];
  const channelRows = [];
  for (let c = 0; c < plan.publicChannels; c++) {
    const cid = id(created + c * DAY);
    const channelMembers = c === 0 ? users : users.filter(() => chance(0.5));
    channels.push({ id: cid, members: channelMembers, type: "PUBLIC" });
    channelRows.push({ id: cid, workspaceId, name: c === 0 ? "general" : `${pick(WORDS)}-${c}`, type: "PUBLIC" as const, createdById: users[0], createdAt: new Date(created + c * DAY), updatedAt: new Date(NOW - int(0, 30) * DAY) });
  }
  for (let c = 0; c < plan.privateChannels; c++) {
    const cid = id(created + c * DAY);
    const channelMembers = sample(users, int(5, 15));
    channels.push({ id: cid, members: channelMembers, type: "PRIVATE" });
    channelRows.push({ id: cid, workspaceId, name: `private-${pick(WORDS)}-${c}`, type: "PRIVATE" as const, createdById: channelMembers[0], createdAt: new Date(created + c * DAY), updatedAt: new Date(NOW - int(0, 30) * DAY) });
  }
  const pairs = new Set<string>();
  for (let c = 0; c < plan.dms; c++) {
    const pair = sample(users, 2).sort();
    if (pairs.has(pair.join(":"))) continue;
    pairs.add(pair.join(":"));
    const cid = id(created + c * 3_600_000);
    channels.push({ id: cid, members: pair, type: "DM" });
    channelRows.push({ id: cid, workspaceId, name: null, type: "DM" as const, createdById: pair[0], createdAt: new Date(created), updatedAt: new Date(NOW - int(0, 60) * DAY) });
  }
  await insert("chatChannel", channelRows);
  const memberRows = [];
  for (const channel of channels) {
    for (const userId of channel.members) {
      // Most members read recently; some never opened the channel since joining.
      const lastRead = chance(0.2) ? created : NOW - Math.floor(-Math.log(1 - rand()) * 3 * DAY);
      memberRows.push({ id: id(created), channelId: channel.id, userId, joinedAt: new Date(created), lastReadAt: new Date(lastRead) });
    }
  }
  await insert("chatChannelMember", memberRows);

  const total = Math.round(TOTAL.messages * plan.share);
  // Busy channels first: general, then other public channels, private ones, DMs.
  const counts = zipfSplit(total, channels.length, 0.9);
  const messageIds: string[] = [];
  const bookmarks = [];
  for (const [c, channel] of channels.entries()) {
    const n = counts[c];
    const rows = [];
    const reactions = [];
    const subscriptions = [];
    const topLevel: { id: string; userId: string }[] = [];
    const start = Math.max(created, NOW - 365 * DAY);
    for (let i = 0; i < n; i++) {
      const at = start + ((NOW - start) * (i + rand())) / n;
      const mid = id(at);
      const userId = pick(channel.members);
      const parent = topLevel.length > 5 && chance(0.12) ? topLevel[Math.max(0, topLevel.length - 1 - int(0, 200))] : null;
      const pinned = chance(0.002);
      rows.push({
        id: mid,
        channelId: channel.id,
        userId,
        content: sentence(3, 30),
        parentId: parent?.id ?? null,
        editedAt: chance(0.05) ? new Date(at + 60_000) : null,
        deletedAt: chance(0.02) ? new Date(at + 120_000) : null,
        pinnedAt: pinned ? new Date(at) : null,
        pinnedById: pinned ? userId : null,
        createdAt: new Date(at),
      });
      if (parent) {
        subscriptions.push({ id: id(at), messageId: parent.id, userId }, { id: id(at), messageId: parent.id, userId: parent.userId });
      } else {
        topLevel.push({ id: mid, userId });
      }
      if (chance(0.08)) {
        for (const reactor of sample(channel.members, int(1, 3))) {
          reactions.push({ id: id(at), messageId: mid, userId: reactor, emoji: pick(["👍", "🎉", "👀", "✅"]), createdAt: new Date(at) });
        }
      }
      if (i % 20 === 0) messageIds.push(mid);
      if (chance(0.01)) bookmarks.push({ id: id(at), userId: pick(channel.members), messageId: mid, createdAt: new Date(between(at, NOW)) });
    }
    await insert("chatMessage", rows);
    await insert("chatReaction", dedupe(reactions, (r) => `${r.messageId}:${r.userId}:${r.emoji}`));
    await insert("chatThreadSubscription", dedupe(subscriptions, (s) => `${s.messageId}:${s.userId}`));
  }
  await insert("chatBookmark", dedupe(bookmarks, (b) => `${b.userId}:${b.messageId}`));
  return { channels, messageIds };
}

// ─── Wiki ───────────────────────────────────────────────────

function wikiDoc(paragraphs: number) {
  return {
    type: "doc",
    content: Array.from({ length: paragraphs }, () => ({ type: "paragraph", content: [{ type: "text", text: sentence(10, 40) }] })),
  };
}

async function seedWiki(plan: WorkspacePlan, workspaceId: string, writers: string[]) {
  const created = NOW - 600 * DAY;
  const spaces = Array.from({ length: plan.spaces }, (_, s) => ({
    id: id(created + s * DAY), workspaceId, name: `Space ${s + 1}`, slug: `space-${s + 1}`, position: s,
    createdAt: new Date(created + s * DAY), updatedAt: new Date(created + s * DAY),
  }));
  await insert("wikiSpace", spaces);
  const counts = zipfSplit(Math.round(TOTAL.pages * plan.share), spaces.length, 0.7);
  for (const [s, space] of spaces.entries()) {
    const pages = [];
    const versions = [];
    const childCount = new Map<string | null, number>();
    const byDepth: string[][] = [[], [], [], []];
    for (let i = 0; i < counts[s]; i++) {
      const at = created + ((NOW - created) * (i + rand())) / counts[s];
      const pid = id(at);
      let parentId: string | null = null;
      let depth = 0;
      if (i >= 8 && !chance(0.06)) {
        depth = weightedIndex([0, 0.45, 0.35, 0.2], 1);
        while (depth > 0 && byDepth[depth - 1].length === 0) depth--;
        parentId = depth > 0 ? pick(byDepth[depth - 1]) : null;
      }
      byDepth[depth].push(pid);
      const position = childCount.get(parentId) ?? 0;
      childCount.set(parentId, position + 1);
      const author = pick(writers);
      const edited = between(at, NOW);
      pages.push({
        id: pid, spaceId: space.id, parentId, title: `${sentence(2, 6).slice(0, -1)} ${i + 1}`,
        content: wikiDoc(int(2, 8)), position, createdById: author, lastEditedById: pick(writers),
        createdAt: new Date(at), updatedAt: new Date(edited),
      });
      if (chance(0.3)) {
        const k = int(1, 3);
        for (let v = 0; v < k; v++) {
          versions.push({ id: id(at), pageId: pid, title: `Version ${v + 1}`, content: wikiDoc(2), versionNumber: v + 1, isAutoSave: chance(0.8), createdById: author, createdAt: new Date(between(at, edited)) });
        }
      }
    }
    await insert("wikiPage", pages);
    await insert("wikiPageVersion", versions);
  }
}

// ─── Files ──────────────────────────────────────────────────

interface FileInfo { ids: string[]; shared: { fileId: string; userId: string }[] }
const MIME = ["application/pdf", "image/png", "image/jpeg", "text/plain", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "text/csv"];

async function seedFiles(plan: WorkspacePlan, workspaceId: string, members: Member[], writers: string[], groups: { id: string; members: string[] }[]): Promise<FileInfo> {
  const created = NOW - 700 * DAY;
  const users = members.map((m) => m.userId);
  const total = Math.round(TOTAL.files * plan.share);
  const rows: Record<string, unknown>[] = [];
  const teamRows = [];
  const teamMembers = [];
  const teamGroups = [];
  // Folders a new item can be placed in, by scope ("team:<id>" or "user:<id>").
  const folders = new Map<string, { id: string; teamFolderId: string | null; ownerId: string | null }[]>();
  const addFolder = (scope: string, folder: { id: string; teamFolderId: string | null; ownerId: string | null }) => {
    const list = folders.get(scope) ?? [];
    list.push(folder);
    folders.set(scope, list);
  };
  for (let t = 0; t < plan.teamFolders; t++) {
    const at = created + t * DAY;
    const rootId = id(at);
    const teamId = id(at);
    rows.push({ id: rootId, workspaceId, parentId: null, name: `Team ${t + 1}`, isFolder: true, uploadedById: users[0], ownerId: null, teamFolderId: null, createdAt: new Date(at), updatedAt: new Date(at) });
    teamRows.push({ id: teamId, workspaceId, folderId: rootId, name: `Team ${t + 1}`, createdAt: new Date(at), updatedAt: new Date(at) });
    for (const userId of users.filter(() => chance(0.3))) teamMembers.push({ id: id(at), teamFolderId: teamId, userId });
    if (t < groups.length) teamGroups.push({ id: id(at), teamFolderId: teamId, groupId: groups[t].id });
    addFolder(`team:${teamId}`, { id: rootId, teamFolderId: teamId, ownerId: null });
  }
  // Team roots first: TeamFolder references its root, and team files reference the TeamFolder.
  await insert("file", rows.splice(0));
  await insert("teamFolder", teamRows);
  await insert("teamFolderMember", teamMembers);
  await insert("teamFolderGroup", teamGroups);
  const teamIds = teamRows.map((t) => t.id);
  const fileIds: string[] = [];
  const personal: { id: string; ownerId: string; isFolder: boolean }[] = [];
  for (let i = 0; i < total - plan.teamFolders; i++) {
    const at = created + ((NOW - created) * (i + rand())) / total;
    const fid = id(at);
    const isFolder = chance(0.12);
    const team = teamIds.length && chance(0.4) ? pick(teamIds) : null;
    const owner = team ? null : pick(writers);
    const scope = team ? `team:${team}` : `user:${owner}`;
    const candidates = folders.get(scope) ?? [];
    // Personal items start at the root a third of the time; team items always sit under the team root.
    const parent = candidates.length && (team || chance(0.66)) ? candidates[Math.max(0, candidates.length - 1 - int(0, 30))] : null;
    const uploader = team ? pick(writers) : owner!;
    const trashed = !isFolder && chance(0.03) ? new Date(between(NOW - 60 * DAY, NOW)) : null;
    const mimeType = isFolder ? null : pick(MIME);
    rows.push({
      id: fid, workspaceId, parentId: parent?.id ?? null, name: `${phrase(1, 3)} ${i + 1}${isFolder ? "" : ".dat"}`,
      mimeType, size: isFolder ? null : BigInt(int(1_000, 50_000_000)),
      storagePath: isFolder ? null : `${team ? `groupfolders/${team}` : owner}/${fid}`,
      thumbnailPath: mimeType?.startsWith("image/") && chance(0.7) ? `thumbnails/${fid}.webp` : null,
      isFolder, uploadedById: uploader, ownerId: owner, teamFolderId: team, trashedAt: trashed,
      createdAt: new Date(at), updatedAt: new Date(between(at, NOW)),
    });
    if (isFolder && !trashed) addFolder(scope, { id: fid, teamFolderId: team, ownerId: owner });
    if (!trashed) fileIds.push(fid);
    if (owner && !trashed) personal.push({ id: fid, ownerId: owner, isFolder });
  }
  await insert("file", rows);

  // Owners share personal items (a tenth of them folders) with other members.
  const shares = [];
  const shareCount = Math.round(total * 0.06);
  for (let s = 0; s < shareCount; s++) {
    const file = pick(personal);
    const target = pick(users);
    if (target === file.ownerId) continue;
    shares.push({ id: id(NOW - int(1, 300) * DAY), workspaceId, fileId: file.id, sharedById: file.ownerId, sharedWithId: target, createdAt: new Date(NOW - int(1, 300) * DAY) });
  }
  const uniqueShares = dedupe(shares, (s) => `${s.fileId}:${s.sharedWithId}`);
  await insert("fileShare", uniqueShares);
  const links = [];
  const linkFiles = [];
  for (let l = 0; l < Math.round(total * 0.01); l++) {
    const file = pick(personal);
    const at = NOW - int(1, 300) * DAY;
    const lid = id(at);
    links.push({ id: lid, workspaceId, token: randomBytes(16).toString("hex"), createdById: file.ownerId, createdAt: new Date(at), updatedAt: new Date(at) });
    linkFiles.push({ id: id(at), shareLinkId: lid, fileId: file.id });
  }
  await insert("fileShareLink", links);
  await insert("fileShareLinkFile", linkFiles);
  // Owners star their own items; recipients star items shared with them.
  const stars = Array.from({ length: Math.round(total * 0.04) }, () => {
    const shared = uniqueShares.length && chance(0.3) ? pick(uniqueShares) : null;
    const own = pick(personal);
    return { id: id(NOW - 50 * DAY), userId: shared?.sharedWithId ?? own.ownerId, fileId: shared?.fileId ?? own.id, createdAt: new Date(NOW - int(1, 200) * DAY) };
  });
  await insert("starredFile", dedupe(stars, (s) => `${s.userId}:${s.fileId}`));
  return { ids: fileIds, shared: uniqueShares.map((s) => ({ fileId: s.fileId, userId: s.sharedWithId })) };
}

// ─── Notifications ──────────────────────────────────────────

async function seedNotifications(plan: WorkspacePlan, workspaceId: string, members: Member[], projects: ProjectInfo[], chat: ChatInfo, files: FileInfo) {
  const total = Math.round(TOTAL.notifications * plan.share);
  const projectsOf = new Map<string, ProjectInfo[]>();
  for (const project of projects) {
    for (const userId of project.members) projectsOf.set(userId, [...(projectsOf.get(userId) ?? []), project]);
  }
  const channelsOf = new Map<string, string[]>();
  for (const channel of chat.channels) {
    for (const userId of channel.members) channelsOf.set(userId, [...(channelsOf.get(userId) ?? []), channel.id]);
  }
  const rows = [];
  const types = ["TASK_ASSIGNED", "TASK_STATUS_CHANGED", "COMMENT_ADDED", "COMMENT_MENTION", "CHAT_MENTION", "CHAT_DM_MESSAGE", "TASK_DUE_SOON", "FILE_SHARED"] as const;
  const weights = [0.3, 0.25, 0.15, 0.05, 0.08, 0.1, 0.05, 0.02];
  const recipients = members.map((m) => m.userId);
  for (let i = 0; i < total; i++) {
    const at = NOW - 180 * DAY + (180 * DAY * (i + rand())) / total;
    const userId = pick(recipients);
    const type = types[weightedIndex(weights, 1)];
    let data: Prisma.InputJsonValue = {};
    if (type.startsWith("TASK") || type.startsWith("COMMENT")) {
      const project = projectsOf.get(userId)?.length ? pick(projectsOf.get(userId)!) : pick(projects);
      const taskId = pick(project.tasks);
      data = type === "TASK_DUE_SOON" ? { taskId, workspaceId } : { taskId, projectId: project.id, actorId: pick(recipients) };
    } else if (type.startsWith("CHAT")) {
      const channelId = channelsOf.get(userId)?.length ? pick(channelsOf.get(userId)!) : pick(chat.channels).id;
      data = { channelId, messageId: pick(chat.messageIds) };
    } else {
      data = { fileId: pick(files.ids), workspaceId };
    }
    rows.push({
      id: id(at), userId, type, title: `${type.toLowerCase().replace(/_/g, " ")}: ${phrase(2, 4)}`,
      body: chance(0.6) ? sentence(4, 12) : null,
      read: at < NOW - 7 * DAY ? chance(0.92) : chance(0.3),
      data, createdAt: new Date(at),
    });
  }
  await insert("notification", rows);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
