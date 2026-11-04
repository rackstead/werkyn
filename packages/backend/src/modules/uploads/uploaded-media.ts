import type { FastifyReply, FastifyRequest } from "fastify";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import { fileTypeFromBuffer } from "file-type";
import { env } from "../../config/env.js";
import { ForbiddenError, NotFoundError, ValidationError } from "../../utils/errors.js";
import { applyUntrustedContentPolicy } from "../../utils/untrusted-content.js";
import { hasShareGrant, shareGrantCookieName } from "../../utils/share-grants.js";

const MAX_BYTES = 25 * 1024 * 1024;
const SAFE_MEDIA = new Set([
  "image/jpeg", "image/png", "image/gif", "image/webp", "image/avif",
  "image/bmp", "image/x-icon", "image/vnd.microsoft.icon",
  "video/mp4", "video/webm", "video/ogg", "audio/mpeg", "audio/mp4",
  "audio/ogg", "audio/wav", "audio/webm",
]);
const responsePolicy = new WeakMap<FastifyReply, { mime: string; filename: string; download: boolean }>();

export function parseUploadedMedia(url: unknown) {
  // The query parser decodes the wire value once. The UUID+extension leaf is
  // opaque: literal percent spellings must never be decoded into separators.
  if (typeof url !== "string" || url.length > 2048 || /[\\\x00-\x20?#]/.test(url)) return null;
  const match = /^\/storage\/([A-Za-z0-9_-]{1,128})\/uploads\/(avatars|wiki)\/([A-Za-z0-9_-]{1,128})\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}(?:\.[^/]+)?)$/i.exec(url);
  if (!match || Buffer.byteLength(match[4]) > 255) return null;
  return { url, workspaceId: match[1], kind: match[2].toLowerCase(), scopeId: match[3], filename: match[4], relative: `${match[2]}/${match[3]}/${match[4]}` };
}

// Only these structural media properties grant access. Text/captions, sibling
// pages, historical versions and arbitrary JSON strings do not grant access.
export function referencesUploadedMedia(content: unknown, url: string): boolean {
  if (!Array.isArray(content) || content.length > 10000) return false;
  const pending: unknown[] = [...content];
  let visited = 0;
  while (pending.length) {
    if (++visited > 10000) return false;
    const block = pending.pop();
    if (!block || typeof block !== "object") continue;
    const value = block as { type?: unknown; props?: { url?: unknown }; children?: unknown };
    if (["image", "audio", "video", "file"].includes(String(value.type)) && value.props?.url === url) return true;
    if (Array.isArray(value.children)) {
      if (value.children.length + pending.length + visited > 10000) return false;
      for (const child of value.children) pending.push(child);
    }
  }
  return false;
}

// sendFile supplies HEAD/ranges/streaming. Its final MIME headers are replaced
// in onSend, after extension-derived metadata, with the bounded byte sniff.
export function applyUploadedMediaResponsePolicy(reply: FastifyReply) {
  const policy = responsePolicy.get(reply);
  if (!policy) return;
  applyUntrustedContentPolicy(reply);
  reply.type(policy.mime);
  reply.header("Content-Disposition", `${policy.download ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(policy.filename).replace(/['()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`);
}

async function serve(request: FastifyRequest, reply: FastifyReply, media: NonNullable<ReturnType<typeof parseUploadedMedia>>, download: boolean) {
  const root = path.resolve(env.STORAGE_DIR, media.workspaceId, "uploads");
  const filename = path.resolve(root, media.relative);
  if (!filename.startsWith(root + path.sep)) throw new ForbiddenError("Invalid uploaded media path");
  let file;
  try {
    file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await file.stat();
    if (!stat.isFile()) throw new NotFoundError("Uploaded media not found");
    if (stat.size > MAX_BYTES) throw new ValidationError("Uploaded media exceeds the rendering limit");
    const prefix = Buffer.alloc(Math.min(stat.size, 8192));
    const { bytesRead } = await file.read(prefix, 0, prefix.length, 0);
    const detected = await fileTypeFromBuffer(prefix.subarray(0, bytesRead)).catch(() => undefined);
    const extension = path.extname(media.filename).slice(1).toLowerCase();
    const matchesExtension = detected && (extension === detected.ext || (detected.ext === "jpg" && extension === "jpeg"));
    const safe = detected && matchesExtension && SAFE_MEDIA.has(detected.mime);
    responsePolicy.set(reply, { mime: !download && safe ? detected.mime : "application/octet-stream", filename: media.filename, download: download || !safe });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ELOOP") throw new NotFoundError("Uploaded media not found");
    throw error;
  } finally {
    await file?.close();
  }
  return reply.sendFile(media.relative, root);
}

type MediaQuery = { url?: string; download?: string };
function queryMedia(query: MediaQuery) {
  const media = parseUploadedMedia(query.url);
  if (!media || (query.download !== undefined && query.download !== "1")) throw new ValidationError("A canonical uploaded media URL is required");
  return media;
}

export async function authenticatedMediaHandler(request: FastifyRequest<{ Querystring: MediaQuery }>, reply: FastifyReply) {
  const media = queryMedia(request.query);
  const member = await request.server.prisma.workspaceMember.findUnique({ where: { userId_workspaceId: { userId: request.user!.id, workspaceId: media.workspaceId } }, select: { userId: true } });
  if (!member) throw new ForbiddenError("Not a member of this workspace");
  return serve(request, reply, media, request.query.download === "1");
}

export async function sharedMediaHandler(request: FastifyRequest<{ Params: { token: string }; Querystring: MediaQuery }>, reply: FastifyReply) {
  const media = queryMedia(request.query);
  const share = await request.server.prisma.wikiPageShare.findUnique({ where: { token: request.params.token } });
  if (!share?.enabled || (share.passwordHash && !hasShareGrant(request.cookies[shareGrantCookieName("wiki", request.params.token)], "wiki", share))) throw new NotFoundError("Shared media not found");
  const current = await request.server.prisma.wikiPageShare.findUnique({
    where: { id: share.id, updatedAt: share.updatedAt, enabled: true },
    select: { page: { select: { content: true, space: { select: { workspaceId: true } } } } },
  });
  if (!current || current.page.space.workspaceId !== media.workspaceId || !referencesUploadedMedia(current.page.content, media.url)) throw new NotFoundError("Shared media not found");
  return serve(request, reply, media, request.query.download === "1");
}
