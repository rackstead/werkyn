import type { FastifyRequest, FastifyReply } from "fastify";
import path from "node:path";
import crypto from "node:crypto";
import { fileTypeFromBuffer } from "file-type";
import {
  AppError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "../../utils/errors.js";
import { env } from "../../config/env.js";

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
  const data = await request.file({
    limits: { fileSize: Math.min(env.MAX_FILE_SIZE, WIKI_MAX_BYTES) },
  });

  if (!data) {
    throw new ValidationError("No file uploaded");
  }

  const workspaceId = (data.fields.workspaceId as { value?: string })?.value;
  if (typeof workspaceId !== "string" || !SAFE_ID.test(workspaceId)) {
    throw new ValidationError("A valid workspaceId is required");
  }

  const purpose = (data.fields.purpose as { value?: string })?.value;
  if (purpose !== "avatar" && purpose !== "wiki") {
    throw new ValidationError("purpose must be avatar or wiki");
  }
  const spaceId = (data.fields.spaceId as { value?: string })?.value;
  if (
    spaceId !== undefined &&
    (typeof spaceId !== "string" || !SAFE_ID.test(spaceId))
  ) {
    throw new ValidationError("A valid spaceId is required");
  }

  // Check permissions before buffering or writing uploaded content.
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

  const maxBytes = Math.min(
    env.MAX_FILE_SIZE,
    purpose === "avatar" ? AVATAR_MAX_BYTES : WIKI_MAX_BYTES,
  );
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of data.file) {
    totalBytes += chunk.length;
    if (totalBytes > maxBytes) {
      throw new AppError(
        413,
        "Payload Too Large",
        `Upload exceeds ${maxBytes} bytes`,
      );
    }
    chunks.push(chunk);
  }
  if (data.file.truncated) {
    throw new AppError(
      413,
      "Payload Too Large",
      `Upload exceeds ${maxBytes} bytes`,
    );
  }
  const buffer = Buffer.concat(chunks, totalBytes);
  let ext = path.extname(data.filename) || ".bin";
  const fileId = crypto.randomUUID();

  if (purpose === "avatar") {
    const detected = await fileTypeFromBuffer(buffer);
    if (!detected || !ALLOWED_AVATAR_TYPES.includes(detected.mime)) {
      throw new ValidationError(
        "Avatar must be a JPEG, PNG, GIF, or WebP image",
      );
    }
    // Static serving must use the detected image type, not an HTML/JS filename.
    ext = `.${detected.ext}`;
  }

  const storagePath = await request.server.storage.save(
    `${workspaceId}/uploads`,
    scopeId,
    fileId,
    ext,
    buffer,
  );

  const url = `/storage/${storagePath}`;

  return reply.status(201).send({ data: { url } });
}
