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

// ─── Backup File Format ─────────────────────────────────

const UserRefSchema = z.object({
  originalId: z.string(),
  email: z.string(),
  displayName: z.string(),
});

const MetadataSchema = z.object({
  version: z.enum(["1.0", "1.1"]),
  exportedAt: z.string(),
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
  // Zod 4 requires an object key whose schema is a bare z.unknown(); Zod 3 did
  // not. A missing value is restored as empty, as before.
  value: z.unknown().optional(),
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
