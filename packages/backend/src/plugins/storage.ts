import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { env } from "../config/env.js";
import { LocalStorageProvider } from "../services/storage.js";
import type { StorageProvider } from "../services/storage.js";

declare module "fastify" {
  interface FastifyInstance {
    storage: StorageProvider;
  }
}

/** How many top-level links the startup warning names. */
const LISTED_LINKS = 20;

export default fp(async (fastify: FastifyInstance) => {
  const storage = new LocalStorageProvider(env.STORAGE_DIR, { log: fastify.log });
  // STORAGE_DIR may be a link or mount point (storage moved to another
  // disk). It is resolved once here; below it no link is followed (R33).
  const root = await storage.init();
  const access = await storage.accessMode();
  fastify.log.info(
    { storageDir: env.STORAGE_DIR, storageRoot: root, access },
    root === path.resolve(env.STORAGE_DIR)
      ? "Storage root resolved"
      : "Storage root resolved through a link or relative path",
  );
  if (access === "path") {
    fastify.log.warn(
      { storageRoot: root },
      "/proc/self/fd is not available: storage refuses links by checking paths, and a link swapped in during an access can still be followed. Run on Linux with /proc mounted for race-free checks.",
    );
  }
  // A workspace folder moved to another disk with a link would now be
  // refused. Name such links at the top level, the cheap and likely case;
  // the storage-link report walks the whole tree.
  const links = (await readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isSymbolicLink())
    .map((entry) => entry.name);
  if (links.length > 0) {
    fastify.log.warn(
      { storageRoot: root, links: links.slice(0, LISTED_LINKS), count: links.length },
      "Storage contains symbolic links, which are refused for reads, writes and deletes; run packages/backend/dist/scripts/storage-link-report.js to list every one (docs/remediation/r33-storage-symlinks.md)",
    );
  }
  fastify.decorate("storage", storage);
});
