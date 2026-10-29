import type { FastifyRequest, FastifyReply } from "fastify";
import type { BackupExportRequest } from "@pm/shared";
import { exportBackup } from "./backup.service.js";
import { previewRestore, executeRestore } from "./restore.service.js";
import {
  BackupArchiveError,
  readBackupArchive,
  type BackupArchiveContents,
} from "./backup-archive.js";
import { ValidationError } from "../../utils/errors.js";
import { formatContentDisposition } from "../../utils/content-disposition.js";

export async function exportHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const { wid } = request.params as { wid: string };
  const body = request.body as BackupExportRequest;

  if (body.projects.length === 0 && body.channels.length === 0 && body.wikiSpaces.length === 0) {
    throw new ValidationError("Select at least one project, channel, or wiki space to export");
  }

  const { zipBuffer, filename } = await exportBackup(
    request.server.prisma,
    wid,
    body,
    request.server.storage,
    request.user!.id,
  );

  return reply
    .header("Content-Type", "application/zip")
    .header("Content-Disposition", formatContentDisposition(filename))
    .send(zipBuffer);
}

/** Consume the uploaded file and return the raw buffer + original filename. */
async function consumeFileBuffer(
  request: FastifyRequest,
): Promise<{ buffer: Buffer; filename: string }> {
  const file = await request.file();
  if (!file) {
    throw new ValidationError("No file uploaded");
  }
  if (!file.filename.endsWith(".json") && !file.filename.endsWith(".zip")) {
    throw new ValidationError("Only .json and .zip files are accepted");
  }
  const chunks: Buffer[] = [];
  for await (const chunk of file.file) {
    chunks.push(chunk);
  }
  return { buffer: Buffer.concat(chunks), filename: file.filename };
}

/**
 * Parse the uploaded file into a JSON buffer and optional asset map.
 * Supports both legacy .json files and .zip archives.
 */
function parseUploadedBackup(
  request: FastifyRequest,
  buffer: Buffer,
  filename: string,
): BackupArchiveContents {
  if (filename.endsWith(".zip") || isZipBuffer(buffer)) {
    try {
      return readBackupArchive(buffer);
    } catch (error) {
      if (error instanceof BackupArchiveError) {
        request.log.warn({ reason: error.reason }, "Rejected backup archive");
      }
      throw error;
    }
  }

  // Legacy plain JSON
  return { jsonBuffer: buffer, assets: new Map() };
}

/** Quick check: ZIP files start with PK\x03\x04 */
function isZipBuffer(buffer: Buffer): boolean {
  return (
    buffer.length >= 4 &&
    buffer[0] === 0x50 &&
    buffer[1] === 0x4b &&
    buffer[2] === 0x03 &&
    buffer[3] === 0x04
  );
}

export async function previewHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const { wid } = request.params as { wid: string };
  const { buffer, filename } = await consumeFileBuffer(request);
  const { jsonBuffer, assets } = parseUploadedBackup(request, buffer, filename);

  const summary = await previewRestore(
    request.server.prisma,
    wid,
    request.user!.id,
    jsonBuffer,
    assets,
  );

  return reply.send({ data: summary });
}

export async function restoreHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const { wid } = request.params as { wid: string };
  const { buffer, filename } = await consumeFileBuffer(request);
  const { jsonBuffer, assets } = parseUploadedBackup(request, buffer, filename);

  const summary = await executeRestore(
    request.server.prisma,
    wid,
    request.user!.id,
    jsonBuffer,
    assets,
    request.server.storage,
  );

  return reply.send({ data: summary });
}
