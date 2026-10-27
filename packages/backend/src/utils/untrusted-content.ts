import type { FastifyReply } from "fastify";

// Uploaded documents never receive the application's script privileges.
const SAFE_INLINE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/avif",
  "image/bmp",
  "image/x-icon",
  "image/vnd.microsoft.icon",
  "application/pdf",
  "video/mp4",
  "video/webm",
  "video/ogg",
  "audio/mpeg",
  "audio/mp4",
  "audio/ogg",
  "audio/wav",
  "audio/webm",
]);

export function isSafeInlineContentType(
  mimeType: string | null | undefined,
): boolean {
  return SAFE_INLINE_TYPES.has(
    (mimeType ?? "").split(";", 1)[0].trim().toLowerCase(),
  );
}

export function applyUntrustedContentPolicy(reply: FastifyReply): void {
  reply.header(
    "Content-Security-Policy",
    "sandbox; default-src 'none'; base-uri 'none'; form-action 'none'",
  );
  reply.header("X-Content-Type-Options", "nosniff");
  reply.header("Cache-Control", "private, no-store");
}
