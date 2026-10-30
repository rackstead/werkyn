import type { FastifyRequest, FastifyReply } from "fastify";
import path from "node:path";
import crypto from "node:crypto";
import { fileTypeFromBuffer } from "file-type";
import {
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "../../utils/errors.js";
import { env } from "../../config/env.js";
import {
  receiveUpload,
  UploadTooLargeError,
  type ReceivedUpload,
} from "../../utils/upload-stream.js";

const ALLOWED_AVATAR_TYPES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
];

const SAFE_ID = /^[A-Za-z0-9_-]{1,100}$/;
const AVATAR_MAX_BYTES = 5 * 1024 * 1024;
const WIKI_MAX_BYTES = 25 * 1024 * 1024;

export async function uploadHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  // The purpose (and with it the avatar limit) is only known once the fields
  // before the file have been read, so the stream is bounded by the larger
  // wiki limit and avatars are checked again below.
  const upload = await receiveUpload(request, reply, {
    maxBytes: Math.min(env.MAX_FILE_SIZE, WIKI_MAX_BYTES),
    idleTimeoutMs: request.server.requestLimits.uploadIdleTimeoutMs,
  });
  try {
    return await storeUpload(request, reply, upload);
  } finally {
    // Refused before its bytes were read: stop waiting for them.
    upload.stream.destroy();
  }
}

async function storeUpload(
  request: FastifyRequest,
  reply: FastifyReply,
  upload: ReceivedUpload,
) {
  const workspaceId = (upload.fields.workspaceId as { value?: string })?.value;
  if (typeof workspaceId !== "string" || !SAFE_ID.test(workspaceId)) {
    throw new ValidationError("A valid workspaceId is required");
  }

  const purpose = (upload.fields.purpose as { value?: string })?.value;
  if (purpose !== "avatar" && purpose !== "wiki") {
    throw new ValidationError("purpose must be avatar or wiki");
  }
  const spaceId = (upload.fields.spaceId as { value?: string })?.value;
  if (
    spaceId !== undefined &&
    (typeof spaceId !== "string" || !SAFE_ID.test(spaceId))
  ) {
    throw new ValidationError("A valid spaceId is required");
  }

  // Check permissions before reading or writing uploaded content.
  const member = await request.server.prisma.workspaceMember.findUnique({
    where: {
      userId_workspaceId: { userId: request.user!.id, workspaceId },
    },
    select: { role: true },
  });
  if (!member) throw new ForbiddenError("Not a member of this workspace");

  let scopeId: string;
  if (purpose === "avatar") {
    // Profile editing is available to every member, including workspace viewers.
    scopeId = `avatars/${request.user!.id}`;
  } else {
    if (member.role === "VIEWER") {
      throw new ForbiddenError("Viewers cannot upload wiki content");
    }
    if (!spaceId)
      throw new ValidationError("spaceId is required for wiki uploads");
    const space = await request.server.prisma.wikiSpace.findFirst({
      where: { id: spaceId, workspaceId },
      select: { id: true },
    });
    if (!space)
      throw new NotFoundError("Wiki space not found in this workspace");
    scopeId = `wiki/${space.id}`;
  }

  const fileId = crypto.randomUUID();
  let storagePath: string;
  if (purpose === "avatar") {
    // Type detection reads the whole file, so an avatar (at most
    // AVATAR_MAX_BYTES) is held in memory; nothing is written unless it is
    // a supported image.
    const maxBytes = Math.min(env.MAX_FILE_SIZE, AVATAR_MAX_BYTES);
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    for await (const chunk of upload.stream) {
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) throw new UploadTooLargeError(maxBytes);
      chunks.push(chunk);
    }
    const buffer = Buffer.concat(chunks, totalBytes);
    const detected = await fileTypeFromBuffer(buffer);
    if (!detected || !ALLOWED_AVATAR_TYPES.includes(detected.mime)) {
      throw new ValidationError(
        "Avatar must be a JPEG, PNG, GIF, or WebP image",
      );
    }
    // Static serving must use the detected image type, not an HTML/JS filename.
    storagePath = await request.server.storage.save(
      `${workspaceId}/uploads`,
      scopeId,
      fileId,
      `.${detected.ext}`,
      buffer,
    );
  } else {
    // Wiki media is streamed to storage; a failed or refused upload removes
    // its partial file.
    ({ storagePath } = await request.server.storage.saveStream(
      `${workspaceId}/uploads`,
      scopeId,
      fileId,
      path.extname(upload.filename) || ".bin",
      upload.stream,
    ));
  }

  const url = `/storage/${storagePath}`;

  return reply.status(201).send({ data: { url } });
}
