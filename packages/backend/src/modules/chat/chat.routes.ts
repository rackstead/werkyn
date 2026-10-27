import type { FastifyInstance } from "fastify";
import { authenticate } from "../../middleware/authenticate.js";
import { authorizeChat as authorize } from "./chat-authorize.js";
import { validate, validateQuery } from "../../middleware/validate.js";
import {
  CreateChannelSchema,
  UpdateChannelSchema,
  SendMessageSchema,
  UpdateMessageSchema,
  CreateDmSchema,
  AddMembersSchema,
  ChatMessageQuerySchema,
  ToggleReactionSchema,
  PinMessageSchema,
  ArchiveChannelSchema,
  SearchMessagesSchema,
} from "@pm/shared";
import {
  listChannelsHandler,
  getChannelHandler,
  createChannelHandler,
  updateChannelHandler,
  deleteChannelHandler,
  joinChannelHandler,
  leaveChannelHandler,
  listMembersHandler,
  addMembersHandler,
  removeMemberHandler,
  listMessagesHandler,
  sendMessageHandler,
  updateMessageHandler,
  deleteMessageHandler,
  getThreadRepliesHandler,
  markReadHandler,
  getUnreadCountsHandler,
  findOrCreateDmHandler,
  typingHandler,
  toggleReactionHandler,
  togglePinHandler,
  listPinnedHandler,
  toggleBookmarkHandler,
  listBookmarksHandler,
  getThreadSubscriptionHandler,
  subscribeThreadHandler,
  unsubscribeThreadHandler,
  archiveChannelHandler,
  searchMessagesHandler,
  searchChannelMessagesHandler,
  getPresenceHandler,
} from "./chat.controller.js";

export default async function chatRoutes(fastify: FastifyInstance) {
  // ─── Channels ──────────────────────────────────────

  fastify.route({
    method: "GET",
    url: "/:wid/channels",
    preHandler: [authenticate, authorize("ADMIN", "MEMBER", "VIEWER")],
    handler: listChannelsHandler,
  });

  fastify.route({
    method: "POST",
    url: "/:wid/channels",
    preHandler: [
      authenticate,
      authorize("ADMIN", "MEMBER"),
      validate(CreateChannelSchema),
    ],
    handler: createChannelHandler,
  });

  fastify.route({
    method: "GET",
    url: "/:wid/channels/:channelId",
    preHandler: [authenticate, authorize("ADMIN", "MEMBER", "VIEWER")],
    handler: getChannelHandler,
  });

  fastify.route({
    method: "PATCH",
    url: "/:wid/channels/:channelId",
    preHandler: [
      authenticate,
      authorize("ADMIN", "MEMBER"),
      validate(UpdateChannelSchema),
    ],
    handler: updateChannelHandler,
  });

  fastify.route({
    method: "DELETE",
    url: "/:wid/channels/:channelId",
    preHandler: [authenticate, authorize("ADMIN", "MEMBER")],
    handler: deleteChannelHandler,
  });

  // ─── Join / Leave ──────────────────────────────────

  fastify.route({
    method: "POST",
    url: "/:wid/channels/:channelId/join",
    preHandler: [authenticate, authorize("ADMIN", "MEMBER", "VIEWER")],
    handler: joinChannelHandler,
  });

  fastify.route({
    method: "POST",
    url: "/:wid/channels/:channelId/leave",
    preHandler: [authenticate, authorize("ADMIN", "MEMBER", "VIEWER")],
    handler: leaveChannelHandler,
  });

  // ─── Members ───────────────────────────────────────

  fastify.route({
    method: "GET",
    url: "/:wid/channels/:channelId/members",
    preHandler: [authenticate, authorize("ADMIN", "MEMBER", "VIEWER")],
    handler: listMembersHandler,
  });

  fastify.route({
    method: "POST",
    url: "/:wid/channels/:channelId/members",
    preHandler: [
      authenticate,
      authorize("ADMIN", "MEMBER"),
      validate(AddMembersSchema),
    ],
    handler: addMembersHandler,
  });

  fastify.route({
    method: "DELETE",
    url: "/:wid/channels/:channelId/members/:userId",
    preHandler: [authenticate, authorize("ADMIN", "MEMBER")],
    handler: removeMemberHandler,
  });

  // ─── Messages ──────────────────────────────────────

  fastify.route({
    method: "GET",
    url: "/:wid/channels/:channelId/messages",
    preHandler: [
      authenticate,
      authorize("ADMIN", "MEMBER", "VIEWER"),
      validateQuery(ChatMessageQuerySchema),
    ],
    handler: listMessagesHandler,
  });

  fastify.route({
    method: "POST",
    url: "/:wid/channels/:channelId/messages",
    preHandler: [
      authenticate,
      authorize("ADMIN", "MEMBER"),
      validate(SendMessageSchema),
    ],
    handler: sendMessageHandler,
  });

  fastify.route({
    method: "PATCH",
    url: "/:wid/messages/:messageId",
    preHandler: [
      authenticate,
      authorize("ADMIN", "MEMBER"),
      validate(UpdateMessageSchema),
    ],
    handler: updateMessageHandler,
  });

  fastify.route({
    method: "DELETE",
    url: "/:wid/messages/:messageId",
    preHandler: [authenticate, authorize("ADMIN", "MEMBER")],
    handler: deleteMessageHandler,
  });

  // ─── Threads ───────────────────────────────────────

  fastify.route({
    method: "GET",
    url: "/:wid/messages/:messageId/thread",
    preHandler: [
      authenticate,
      authorize("ADMIN", "MEMBER", "VIEWER"),
      validateQuery(ChatMessageQuerySchema),
    ],
    handler: getThreadRepliesHandler,
  });

  // ─── Unread ────────────────────────────────────────

  fastify.route({
    method: "POST",
    url: "/:wid/channels/:channelId/read",
    preHandler: [authenticate, authorize("ADMIN", "MEMBER", "VIEWER")],
    handler: markReadHandler,
  });

  fastify.route({
    method: "GET",
    url: "/:wid/unread",
    preHandler: [authenticate, authorize("ADMIN", "MEMBER", "VIEWER")],
    handler: getUnreadCountsHandler,
  });

  // ─── DMs ───────────────────────────────────────────

  fastify.route({
    method: "POST",
    url: "/:wid/dm",
    preHandler: [
      authenticate,
      authorize("ADMIN", "MEMBER"),
      validate(CreateDmSchema),
    ],
    handler: findOrCreateDmHandler,
  });

  // ─── Typing ────────────────────────────────────────

  fastify.route({
    method: "POST",
    url: "/:wid/channels/:channelId/typing",
    preHandler: [authenticate, authorize("ADMIN", "MEMBER", "VIEWER")],
    handler: typingHandler,
  });

  // ─── Reactions ────────────────────────────────────

  fastify.route({
    method: "POST",
    url: "/:wid/messages/:messageId/reactions",
    preHandler: [
      authenticate,
      authorize("ADMIN", "MEMBER"),
      validate(ToggleReactionSchema),
    ],
    handler: toggleReactionHandler,
  });

  // ─── Pins ───────────────────────────────────────

  fastify.route({
    method: "POST",
    url: "/:wid/messages/:messageId/pin",
    preHandler: [
      authenticate,
      authorize("ADMIN", "MEMBER"),
      validate(PinMessageSchema),
    ],
    handler: togglePinHandler,
  });

  fastify.route({
    method: "GET",
    url: "/:wid/channels/:channelId/pins",
    preHandler: [authenticate, authorize("ADMIN", "MEMBER", "VIEWER")],
    handler: listPinnedHandler,
  });

  // ─── Bookmarks ──────────────────────────────────

  fastify.route({
    method: "POST",
    url: "/:wid/messages/:messageId/bookmark",
    preHandler: [authenticate, authorize("ADMIN", "MEMBER", "VIEWER")],
    handler: toggleBookmarkHandler,
  });

  fastify.route({
    method: "GET",
    url: "/:wid/bookmarks",
    preHandler: [authenticate, authorize("ADMIN", "MEMBER", "VIEWER")],
    handler: listBookmarksHandler,
  });

  // ─── Thread Subscriptions ───────────────────────

  fastify.route({
    method: "GET",
    url: "/:wid/messages/:messageId/subscription",
    preHandler: [authenticate, authorize("ADMIN", "MEMBER", "VIEWER")],
    handler: getThreadSubscriptionHandler,
  });

  fastify.route({
    method: "POST",
    url: "/:wid/messages/:messageId/subscription",
    preHandler: [authenticate, authorize("ADMIN", "MEMBER", "VIEWER")],
    handler: subscribeThreadHandler,
  });

  fastify.route({
    method: "DELETE",
    url: "/:wid/messages/:messageId/subscription",
    preHandler: [authenticate, authorize("ADMIN", "MEMBER", "VIEWER")],
    handler: unsubscribeThreadHandler,
  });

  // ─── Channel Archiving ──────────────────────────

  fastify.route({
    method: "POST",
    url: "/:wid/channels/:channelId/archive",
    preHandler: [
      authenticate,
      authorize("ADMIN", "MEMBER"),
      validate(ArchiveChannelSchema),
    ],
    handler: archiveChannelHandler,
  });

  // ─── Search ─────────────────────────────────────

  fastify.route({
    method: "GET",
    url: "/:wid/messages/search",
    preHandler: [
      authenticate,
      authorize("ADMIN", "MEMBER", "VIEWER"),
      validateQuery(SearchMessagesSchema),
    ],
    handler: searchMessagesHandler,
  });

  fastify.route({
    method: "GET",
    url: "/:wid/channels/:channelId/messages/search",
    preHandler: [
      authenticate,
      authorize("ADMIN", "MEMBER", "VIEWER"),
      validateQuery(SearchMessagesSchema),
    ],
    handler: searchChannelMessagesHandler,
  });

  // ─── Presence ───────────────────────────────────

  fastify.route({
    method: "GET",
    url: "/:wid/presence",
    preHandler: [authenticate, authorize("ADMIN", "MEMBER", "VIEWER")],
    handler: getPresenceHandler,
  });
}
