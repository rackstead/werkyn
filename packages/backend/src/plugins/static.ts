import fp from "fastify-plugin";
import fastifyStatic from "@fastify/static";
import type { FastifyInstance } from "fastify";
import path from "node:path";
import { env } from "../config/env.js";
import { authenticate } from "../middleware/authenticate.js";
import { applyUploadedMediaResponsePolicy } from "../modules/uploads/uploaded-media.js";
import { releaseStoredFile, sendStoredFile } from "../modules/uploads/stored-file-response.js";
import { MissingBlobError } from "../services/storage.js";
import { ForbiddenError, NotFoundError } from "../utils/errors.js";
import { frontendCacheControl, frontendPathname, isPublicFrontendRequest } from "./frontend-static.js";
import {
  applyUntrustedContentPolicy,
  isSafeInlineContentType,
} from "../utils/untrusted-content.js";

/**
 * The Content-Type the static file server gave each extension whose type may
 * be shown inline (mime 3, as used by @fastify/send). Every other file was,
 * and still is, sent as an application/octet-stream attachment by onSend.
 */
const INLINE_TYPES: Record<string, string> = {
  avif: "image/avif", bmp: "image/bmp", gif: "image/gif", ico: "image/vnd.microsoft.icon",
  jpe: "image/jpeg", jpeg: "image/jpeg", jpg: "image/jpeg", png: "image/png", webp: "image/webp",
  pdf: "application/pdf",
  m2a: "audio/mpeg", m3a: "audio/mpeg", mp2: "audio/mpeg", mp2a: "audio/mpeg", mp3: "audio/mpeg", mpga: "audio/mpeg",
  m4a: "audio/mp4", mp4a: "audio/mp4", oga: "audio/ogg", ogg: "audio/ogg", opus: "audio/ogg", spx: "audio/ogg",
  wav: "audio/wav", weba: "audio/webm",
  mp4: "video/mp4", mp4v: "video/mp4", mpg4: "video/mp4", ogv: "video/ogg", webm: "video/webm",
};

export function staticContentType(file: string): string {
  const extension = path.extname(file).slice(1).toLowerCase();
  return Object.hasOwn(INLINE_TYPES, extension) ? INLINE_TYPES[extension] : "application/octet-stream";
}

export default fp(async (fastify: FastifyInstance) => {
  const storageDir = path.resolve(env.STORAGE_DIR);

  const uploadRoutes = new Set([
    "/storage/avatars/*",
    "/storage/uploads/*",
    "/storage/:workspaceId/uploads/*",
    "/uploads/*",
  ]);
  fastify.addHook("onSend", async (request, reply, payload) => {
    releaseStoredFile(reply, payload);
    applyUploadedMediaResponsePolicy(reply);
    if (env.NODE_ENV === "production" && isPublicFrontendRequest(request) && reply.statusCode >= 400) {
      reply.header("Cache-Control", "no-store");
    }
    if (uploadRoutes.has(request.routeOptions.url ?? "") && reply.statusCode < 400) {
      // Static metadata is available here; setHeaders runs before MIME metadata
      // and can have its response type overwritten by the static file server.
      const type = reply.getHeader("Content-Type");
      applyUntrustedContentPolicy(reply);
      if (!isSafeInlineContentType(typeof type === "string" ? type : undefined)) {
        reply
          .type("application/octet-stream")
          .header("Content-Disposition", "attachment");
      }
    }
    return payload;
  });

  // New storage-based avatar path
  await fastify.register(fastifyStatic, {
    root: path.join(storageDir, "avatars"),
    prefix: "/storage/avatars/",
    decorateReply: true,
    serve: false,
  });

  // General uploads (wiki images, etc.)
  for (const url of ["/storage/avatars/*", "/storage/uploads/*", "/uploads/*"]) {
    fastify.route({ method: ["GET", "HEAD"], url, handler: async (_request, reply) => reply.header("Cache-Control", "no-store").code(410).send({ message: "Public uploaded media URLs have been retired" }) });
  }

  // Workspace-scoped uploads
  fastify.get<{ Params: { workspaceId: string; '*': string } }>(
    '/storage/:workspaceId/uploads/*',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const { workspaceId } = request.params;
      const subPath = request.params['*'];

      // Resolve and serve beneath the same workspace root used for authorization.
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(workspaceId)) {
        throw new ForbiddenError("Invalid workspace path");
      }
      const uploadRoot = path.resolve(storageDir, workspaceId, 'uploads');
      const resolved = path.resolve(uploadRoot, subPath);
      if (resolved !== uploadRoot && !resolved.startsWith(uploadRoot + path.sep)) {
        throw new ForbiddenError("Invalid file path");
      }
      // Only the canonical spelling (no empty, "." or ".." segments, no "\\"
      // or NUL), as the static file server enforces for paths it resolves.
      if (subPath.length > 0 && (/[\\\0]/.test(subPath) || path.posix.normalize(subPath) !== subPath)) {
        throw new ForbiddenError("Invalid file path");
      }

      // Workspace membership check
      const membership = await fastify.prisma.workspaceMember.findUnique({
        where: { userId_workspaceId: { userId: request.user!.id, workspaceId } },
      });
      if (!membership) {
        throw new ForbiddenError("Not a member of this workspace");
      }

      // A folder URL serves its index document, as the static server did.
      // The file is checked and opened by storage, which refuses links and
      // special files below the storage root (R33), and is then sent from
      // that open descriptor.
      const file = subPath === "" || subPath.endsWith("/") ? `${subPath}index.html` : subPath;
      let blob;
      try {
        blob = await request.server.storage.open(`${workspaceId}/uploads/${file}`);
      } catch (error) {
        if (error instanceof MissingBlobError) throw new NotFoundError("File not found");
        throw error;
      }
      return sendStoredFile(reply, blob, staticContentType(file));
    },
  );

  // Legacy uploads path (fallback for existing avatars)

  // Serve frontend static assets in production
  if (env.NODE_ENV === "production") {
    const frontendDist = path.resolve(process.cwd(), "packages/frontend/dist");
    await fastify.register(fastifyStatic, {
      root: frontendDist,
      prefix: "/",
      decorateReply: false,
      // Reserved/malformed paths are not frontend files, and the build-asset
      // namespace is not a document. Reject its directory URL before the
      // static server's directory fallback; actual files still serve normally.
      allowedPath: (pathname, _root, request) =>
        frontendPathname(request) !== undefined && pathname !== "/assets" && pathname !== "/assets/",
      setHeaders(reply, selectedPath) {
        // Use the selected file, not just the request URL: a directory whose
        // name looks like a chunk can still resolve to index.html, including
        // on conditional responses where entity MIME headers are absent.
        const relative = path.relative(frontendDist, selectedPath).split(path.sep).join("/");
        reply.header("Cache-Control", frontendCacheControl(`/${relative}`));
      },
    });
  }
});
