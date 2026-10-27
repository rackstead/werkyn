import fp from "fastify-plugin";
import fastifyStatic from "@fastify/static";
import type { FastifyInstance } from "fastify";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { env } from "../config/env.js";
import { authenticate } from "../middleware/authenticate.js";
import { ForbiddenError } from "../utils/errors.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default fp(async (fastify: FastifyInstance) => {
  const storageDir = path.resolve(env.STORAGE_DIR);

  // New storage-based avatar path
  await fastify.register(fastifyStatic, {
    root: path.join(storageDir, "avatars"),
    prefix: "/storage/avatars/",
    decorateReply: true,
  });

  // General uploads (wiki images, etc.)
  await fastify.register(fastifyStatic, {
    root: path.join(storageDir, "uploads"),
    prefix: "/storage/uploads/",
    decorateReply: false,
  });

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

      // Workspace membership check
      const membership = await fastify.prisma.workspaceMember.findUnique({
        where: { userId_workspaceId: { userId: request.user!.id, workspaceId } },
      });
      if (!membership) {
        throw new ForbiddenError("Not a member of this workspace");
      }

      return reply.sendFile(
        subPath,
        uploadRoot,
      );
    },
  );

  // Legacy uploads path (fallback for existing avatars)
  const legacyUploadsDir = path.join(__dirname, "../../uploads");
  await fastify.register(fastifyStatic, {
    root: legacyUploadsDir,
    prefix: "/uploads/",
    decorateReply: false,
  });

  // Serve frontend static assets in production
  if (env.NODE_ENV === "production") {
    const frontendDist = path.resolve(process.cwd(), "packages/frontend/dist");
    await fastify.register(fastifyStatic, {
      root: frontendDist,
      prefix: "/",
      decorateReply: false,
    });
  }
});
