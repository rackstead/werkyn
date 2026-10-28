import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";

// src/plugins and dist/plugins both sit two levels below packages/backend.
const DEFAULT_MIGRATIONS_DIR = fileURLToPath(new URL("../../prisma/migrations", import.meta.url));

export interface HealthOptions {
  migrationsDir?: string;
  timeoutMs?: number;
}

type CheckState = "ok" | "unavailable" | "pending" | "failed" | "unknown";

interface MigrationRow {
  migration_name: string;
  finished_at: Date | null;
  rolled_back_at: Date | null;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

async function listMigrations(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
}

/**
 * GET /api/health — liveness: the process is serving requests. It does not
 * touch the database, so a database outage does not get the process restarted.
 * GET /api/ready — readiness: the database answers and every migration shipped
 * with this build has been applied. Failure details are logged, not returned.
 */
export default fp(async (fastify: FastifyInstance, options: HealthOptions) => {
  const migrationsDir = options.migrationsDir ?? DEFAULT_MIGRATIONS_DIR;
  const timeoutMs = options.timeoutMs ?? 3000;
  let expected: Promise<string[]> | undefined;

  // Probes are frequent and come from orchestrators, not users.
  const probe = { config: { rateLimit: false } } as const;

  fastify.get("/api/health", probe, async (_request, reply) => {
    reply.header("Cache-Control", "no-store");
    return { status: "ok", timestamp: new Date().toISOString() };
  });

  fastify.get("/api/ready", probe, async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const checks: { database: CheckState; migrations: CheckState } = {
      database: "ok",
      migrations: "ok",
    };

    try {
      await withTimeout(fastify.prisma.$queryRaw`SELECT 1`, timeoutMs);
    } catch (err) {
      request.log.warn({ err }, "Readiness: database unavailable");
      checks.database = "unavailable";
      checks.migrations = "unknown";
    }

    if (checks.database === "ok") {
      try {
        expected ??= listMigrations(migrationsDir).catch((err) => {
          expected = undefined;
          throw err;
        });
        const [names, rows] = await Promise.all([
          expected,
          withTimeout(
            fastify.prisma.$queryRaw<MigrationRow[]>`
              SELECT migration_name, finished_at, rolled_back_at FROM "_prisma_migrations"`,
            timeoutMs,
          ),
        ]);
        const applied = new Set(
          rows.filter((row) => row.finished_at && !row.rolled_back_at).map((row) => row.migration_name),
        );
        const failed = rows.filter(
          (row) => !row.finished_at && !row.rolled_back_at && !applied.has(row.migration_name),
        );
        const pending = names.filter((name) => !applied.has(name));
        if (failed.length > 0) {
          checks.migrations = "failed";
          request.log.warn(
            { migrations: failed.map((row) => row.migration_name) },
            "Readiness: failed database migrations",
          );
        } else if (pending.length > 0) {
          checks.migrations = "pending";
          request.log.warn({ migrations: pending }, "Readiness: migrations not applied");
        }
      } catch (err) {
        request.log.warn({ err, migrationsDir: path.basename(migrationsDir) }, "Readiness: cannot verify migrations");
        checks.migrations = "unknown";
      }
    }

    const ready = checks.database === "ok" && checks.migrations === "ok";
    return reply.code(ready ? 200 : 503).send({
      status: ready ? "ready" : "not_ready",
      checks,
      timestamp: new Date().toISOString(),
    });
  });
});
