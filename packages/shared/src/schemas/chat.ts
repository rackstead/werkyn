import { z } from "zod";

export const CreateChannelSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  type: z.enum(["PUBLIC", "PRIVATE"]),
});
export type CreateChannelInput = z.infer<typeof CreateChannelSchema>;

export const UpdateChannelSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).optional(),
});
export type UpdateChannelInput = z.infer<typeof UpdateChannelSchema>;

export const SendMessageSchema = z.object({
  content: z.string().min(1).max(4000),
  parentId: z.string().optional(),
});
export type SendMessageInput = z.infer<typeof SendMessageSchema>;

export const UpdateMessageSchema = z.object({
  content: z.string().min(1).max(4000),
});
export type UpdateMessageInput = z.infer<typeof UpdateMessageSchema>;

export const CreateDmSchema = z.object({
  userIds: z.array(z.string()).min(1).max(7),
});
export type CreateDmInput = z.infer<typeof CreateDmSchema>;

export const AddMembersSchema = z.object({
  userIds: z.array(z.string()).min(1).max(50),
});
export type AddMembersInput = z.infer<typeof AddMembersSchema>;

export const ChatMessageQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type ChatMessageQueryInput = z.infer<typeof ChatMessageQuerySchema>;

export const ChatBookmarkQuerySchema = ChatMessageQuerySchema.extend({
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type ChatBookmarkQueryInput = z.infer<typeof ChatBookmarkQuerySchema>;

export const ToggleReactionSchema = z.object({
  emoji: z.string().min(1).max(32),
});
export type ToggleReactionInput = z.infer<typeof ToggleReactionSchema>;

export const PinMessageSchema = z.object({
  pinned: z.boolean(),
});
export type PinMessageInput = z.infer<typeof PinMessageSchema>;

export const BookmarkMessageSchema = z.object({});
export type BookmarkMessageInput = z.infer<typeof BookmarkMessageSchema>;

export const ArchiveChannelSchema = z.object({
  archived: z.boolean(),
});
export type ArchiveChannelInput = z.infer<typeof ArchiveChannelSchema>;

export const SearchMessagesSchema = z.object({
  q: z.string().min(1).max(200),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
export type SearchMessagesInput = z.infer<typeof SearchMessagesSchema>;
