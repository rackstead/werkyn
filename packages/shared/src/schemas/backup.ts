import { z } from "zod";

// ─── Export Request ─────────────────────────────────────

export const BackupProjectOptionsSchema = z.object({
  projectId: z.string().min(1),
  includeTasks: z.boolean().default(true),
  includeComments: z.boolean().default(true),
  includeLabels: z.boolean().default(true),
  includeCustomFields: z.boolean().default(true),
  includeStatuses: z.boolean().default(true),
  includeActivityLogs: z.boolean().default(false),
  includeMembers: z.boolean().default(true),
});
export type BackupProjectOptions = z.infer<typeof BackupProjectOptionsSchema>;

export const BackupChannelOptionsSchema = z.object({
  channelId: z.string().min(1),
  includeMessages: z.boolean().default(true),
  includeReactions: z.boolean().default(true),
  includeMembers: z.boolean().default(true),
});
export type BackupChannelOptions = z.infer<typeof BackupChannelOptionsSchema>;

export const BackupWikiSpaceOptionsSchema = z.object({
  spaceId: z.string().min(1),
  includeComments: z.boolean().default(true),
});
export type BackupWikiSpaceOptions = z.infer<typeof BackupWikiSpaceOptionsSchema>;

export const BackupExportRequestSchema = z.object({
  projects: z.array(BackupProjectOptionsSchema).default([]),
  channels: z.array(BackupChannelOptionsSchema).default([]),
  wikiSpaces: z.array(BackupWikiSpaceOptionsSchema).default([]),
  includeFiles: z.boolean().default(true),
});
export type BackupExportRequest = z.infer<typeof BackupExportRequestSchema>;

// ─── Backup Scope ───────────────────────────────────────

/**
 * A backup is a selective content export, not a disaster-recovery copy of
 * the workspace. Exports record this scope and both lists below in
 * `metadata`, and the backup page shows them.
 */
export const BACKUP_SCOPE = "content-export";

export interface BackupContentItem {
  key: string;
  label: string;
}

/** What an export can hold, for the projects, channels and spaces selected. */
export const BACKUP_INCLUDED_CONTENT: readonly BackupContentItem[] = [
  { key: "projects", label: "Projects: name, description, color and icon" },
  { key: "statuses", label: "Statuses" },
  { key: "labels", label: "Labels" },
  { key: "custom-fields", label: "Custom fields and their task values" },
  { key: "project-members", label: "Project members" },
  {
    key: "tasks",
    label: "Tasks: title, description, priority, order, start and due dates, status, assignees, labels and dependencies",
  },
  { key: "subtasks", label: "Subtasks" },
  { key: "task-comments", label: "Task comments" },
  { key: "task-activity", label: "Task activity history, when selected" },
  { key: "chat-channels", label: "Public and private chat channels with their members" },
  { key: "chat-messages", label: "Chat messages, thread replies and reactions" },
  { key: "wiki", label: "Wiki spaces, pages and page comments" },
  { key: "wiki-images", label: "Images embedded in wiki pages, when files are included" },
  { key: "user-references", label: "The email and name of each user referenced, to match users on restore" },
];

/** What no export holds; restoring a backup never brings these back. */
export const BACKUP_OMITTED_CONTENT: readonly BackupContentItem[] = [
  { key: "attachments", label: "File attachments on tasks and other items" },
  { key: "drive-files", label: "Drive files, folders, team folders and sharing" },
  { key: "user-accounts", label: "User accounts, passwords, profiles and avatars" },
  { key: "workspace-membership", label: "Workspace members, roles, groups and invitations" },
  { key: "time-tracking", label: "Time entries and billing rates" },
  { key: "workspace-settings", label: "Workspace settings, modules, email and sign-in configuration" },
  { key: "task-templates", label: "Task templates" },
  { key: "recurring-tasks", label: "Recurring task schedules" },
  { key: "task-reminders", label: "Task reminders" },
  { key: "archived-state", label: "Whether projects, tasks and channels are archived" },
  { key: "wiki-history", label: "Wiki page versions, edit locks and public share links" },
  { key: "chat-extras", label: "Direct messages, deleted messages, pins, edits, bookmarks and thread subscriptions" },
  { key: "timestamps", label: "Creation and update times, except for comments, messages and activity" },
  { key: "notifications", label: "Notifications and notification preferences" },
  { key: "personal-preferences", label: "Dashboards and starred files" },
  { key: "api-keys", label: "API keys" },
  { key: "sessions", label: "Sign-in sessions" },
];

// ─── Backup File Format ─────────────────────────────────

const UserRefSchema = z.object({
  originalId: z.string(),
  email: z.string(),
  displayName: z.string(),
});

const MetadataSchema = z.object({
  version: z.enum(["1.0", "1.1"]),
  exportedAt: z.string(),
  // Written by exports since the scope was recorded; older files lack them.
  scope: z.string().optional(),
  included: z.array(z.string()).optional(),
  omitted: z.array(z.string()).optional(),
  sourceWorkspace: z.object({
    name: z.string(),
    slug: z.string(),
  }),
  userRefs: z.array(UserRefSchema),
});

const BackupStatusSchema = z.object({
  _originalId: z.string(),
  name: z.string(),
  color: z.string().nullable().optional(),
  position: z.number(),
  isCompletion: z.boolean(),
});

const BackupLabelSchema = z.object({
  _originalId: z.string(),
  name: z.string(),
  color: z.string(),
});

const BackupCustomFieldSchema = z.object({
  _originalId: z.string(),
  name: z.string(),
  type: z.string(),
  options: z.unknown().nullable().optional(),
  required: z.boolean(),
  position: z.number(),
});

const BackupCustomFieldValueSchema = z.object({
  fieldRef: z.string(),
  value: z.unknown(),
});

const BackupCommentSchema = z.object({
  _originalId: z.string(),
  body: z.string(),
  authorRef: z.string().nullable().optional(),
  createdAt: z.string(),
});

const BackupActivityLogSchema = z.object({
  _originalId: z.string(),
  action: z.string(),
  details: z.unknown().nullable().optional(),
  actorRef: z.string().nullable().optional(),
  createdAt: z.string(),
});

const BackupSubtaskSchema = z.object({
  _originalId: z.string(),
  title: z.string(),
  completed: z.boolean(),
  position: z.number(),
  assigneeRef: z.string().nullable().optional(),
  dueDate: z.string().nullable().optional(),
});

const BackupDependencySchema = z.object({
  blockingTaskRef: z.string(),
  type: z.string().default("blocks"),
});

const BackupTaskSchema = z.object({
  _originalId: z.string(),
  title: z.string(),
  description: z.string().nullable().optional(),
  priority: z.string(),
  position: z.number(),
  dueDate: z.string().nullable().optional(),
  startDate: z.string().nullable().optional(),
  statusRef: z.string(),
  createdByRef: z.string().nullable().optional(),
  assignees: z.array(z.string()).default([]),
  labels: z.array(z.string()).default([]),
  subtasks: z.array(BackupSubtaskSchema).default([]),
  customFieldValues: z.array(BackupCustomFieldValueSchema).default([]),
  dependencies: z.array(BackupDependencySchema).default([]),
  comments: z.array(BackupCommentSchema).default([]),
  activityLogs: z.array(BackupActivityLogSchema).default([]),
});

const BackupMemberSchema = z.object({
  userRef: z.string(),
});

const BackupAttachmentSchema = z.object({
  _originalId: z.string(),
  entityType: z.string(),
  entityRef: z.string(),
  name: z.string(),
  mimeType: z.string(),
  size: z.number(),
  assetPath: z.string(),
  uploadedByRef: z.string().nullable().optional(),
});

const BackupProjectSchema = z.object({
  project: z.object({
    name: z.string(),
    description: z.string().nullable().optional(),
    color: z.string().nullable().optional(),
    icon: z.string().nullable().optional(),
  }),
  statuses: z.array(BackupStatusSchema).default([]),
  labels: z.array(BackupLabelSchema).default([]),
  customFields: z.array(BackupCustomFieldSchema).default([]),
  members: z.array(BackupMemberSchema).default([]),
  tasks: z.array(BackupTaskSchema).default([]),
  attachments: z.array(BackupAttachmentSchema).default([]),
});

const BackupReactionSchema = z.object({
  userRef: z.string(),
  emoji: z.string(),
});

const BackupMessageSchema = z.object({
  _originalId: z.string(),
  content: z.string(),
  userRef: z.string(),
  parentRef: z.string().nullable().optional(),
  createdAt: z.string(),
  reactions: z.array(BackupReactionSchema).default([]),
});

const BackupChannelSchema = z.object({
  channel: z.object({
    name: z.string().nullable().optional(),
    description: z.string().nullable().optional(),
    type: z.enum(["PUBLIC", "PRIVATE"]),
  }),
  members: z.array(BackupMemberSchema).default([]),
  messages: z.array(BackupMessageSchema).default([]),
});

const BackupWikiCommentSchema = z.object({
  _originalId: z.string(),
  body: z.string(),
  authorRef: z.string().nullable().optional(),
  resolved: z.boolean().default(false),
  highlightId: z.string(),
  selectionStart: z.unknown().nullable().optional(),
  selectionEnd: z.unknown().nullable().optional(),
  createdAt: z.string(),
});

const BackupWikiPageSchema = z.object({
  _originalId: z.string(),
  title: z.string(),
  content: z.unknown().nullable().optional(),
  icon: z.string().nullable().optional(),
  position: z.number(),
  parentRef: z.string().nullable().optional(),
  createdByRef: z.string().nullable().optional(),
  comments: z.array(BackupWikiCommentSchema).default([]),
});

const BackupWikiSpaceSchema = z.object({
  space: z.object({
    name: z.string(),
    description: z.string().nullable().optional(),
    icon: z.string().nullable().optional(),
  }),
  pages: z.array(BackupWikiPageSchema).default([]),
});

export const BackupFileSchema = z.object({
  metadata: MetadataSchema,
  projects: z.array(BackupProjectSchema).default([]),
  channels: z.array(BackupChannelSchema).default([]),
  wikiSpaces: z.array(BackupWikiSpaceSchema).default([]),
});
export type BackupFile = z.infer<typeof BackupFileSchema>;

// ─── Restore Preview / Summary ──────────────────────────

export interface RestoreUserMapping {
  originalEmail: string;
  originalName: string;
  mappedUserId: string | null;
  mappedName: string | null;
}

export interface RestoreSummary {
  projects: number;
  statuses: number;
  labels: number;
  customFields: number;
  tasks: number;
  subtasks: number;
  comments: number;
  activityLogs: number;
  channels: number;
  messages: number;
  reactions: number;
  wikiSpaces: number;
  wikiPages: number;
  wikiComments: number;
  images: number;
  userMappings: RestoreUserMapping[];
  warnings: string[];
}
