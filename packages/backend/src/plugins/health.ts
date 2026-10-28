import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";

// src/plugins and dist/plugins both sit two levels below packages/backend.
const DEFAULT_MIGRATIONS_DIR = fileURLToPath(new URL("../../prisma/migrations", import.meta.url));

export interface HealthOptions {
  migrationsDir?: string;
  /** Overall deadline for one readiness evaluation, including every query. */
  timeoutMs?: number;
  /** How long a finished evaluation is reused by later probes. */
  cacheMs?: number;
}

type CheckState = "ok" | "unavailable" | "pending" | "failed" | "unknown";
type Checks = { database: CheckState; migrations: CheckState };

interface MigrationRow {
  migration_name: string;
  finished_at: Date | null;
  rolled_back_at: Date | null;
}

function deadline(ms: number): { promise: Promise<never>; clear: () => void } {
  let timer: NodeJS.Timeout | undefined;
  const promise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
  });
  return { promise, clear: () => clearTimeout(timer) };
}

async function listMigrations(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
}

/**
 * GET /api/live — liveness: the process is serving requests; no database work.
 * GET /api/health — kept for existing monitors: the database answers.
 * GET /api/ready — readiness: the database answers and every migration shipped
 * with this build has been applied.
 *
 * /api/live and /api/ready are exempt from the client rate limit, so database
 * work is bounded instead: concurrent probes share one evaluation with a single
 * overall deadline, and its result is reused briefly. Details are logged, not
 * returned.
 */
export default fp(async (fastify: FastifyInstance, options: HealthOptions) => {
  const migrationsDir = options.migrationsDir ?? DEFAULT_MIGRATIONS_DIR;
  const timeoutMs = options.timeoutMs ?? 3000;
  const cacheMs = options.cacheMs ?? 1000;
  let expected: Promise<string[]> | undefined;
  let inflight: Promise<Checks> | undefined;
  let cached: { at: number; checks: Checks } | undefined;

  async function evaluate(): Promise<Checks> {
    const checks: Checks = { database: "unavailable", migrations: "unknown" };
    const work = (async () => {
      await fastify.prisma.$queryRaw`SELECT 1`;
      checks.database = "ok";

      expected ??= listMigrations(migrationsDir).catch((err) => {
        expected = undefined;
        throw err;
      });
      const [names, rows] = await Promise.all([
        expected,
        fastify.prisma.$queryRaw<MigrationRow[]>`
          SELECT migration_name, finished_at, rolled_back_at FROM "_prisma_migrations"`,
      ]);
      const applied = new Set(
        rows.filter((row) => row.finished_at && !row.rolled_back_at).map((row) => row.migration_name),
      );
      const failed = rows
        .filter((row) => !row.finished_at && !row.rolled_back_at && !applied.has(row.migration_name))
        .map((row) => row.migration_name);
      const pending = names.filter((name) => !applied.has(name));
      if (failed.length > 0) {
        checks.migrations = "failed";
        fastify.log.warn({ migrations: failed }, "Readiness: failed database migrations");
      } else if (pending.length > 0) {
        checks.migrations = "pending";
        fastify.log.warn({ migrations: pending }, "Readiness: migrations not applied");
      } else {
        checks.migrations = "ok";
      }
    })();

    const limit = deadline(timeoutMs);
    try {
      await Promise.race([work, limit.promise]);
    } catch (err) {
      work.catch(() => {});
      fastify.log.warn(
        { err },
        checks.database === "ok"
          ? "Readiness: cannot verify migrations"
          : "Readiness: database unavailable",
      );
    } finally {
      limit.clear();
    }
    // Snapshot: work abandoned at the deadline must not change this result.
    return { ...checks };
  }

  function currentChecks(): Promise<Checks> {
    if (cached && Date.now() - cached.at < cacheMs) return Promise.resolve(cached.checks);
    inflight ??= evaluate()
      .then((checks) => {
        cached = { at: Date.now(), checks };
        return checks;
      })
      .finally(() => {
        inflight = undefined;
      });
    return inflight;
  }

  // Probes are frequent and come from orchestrators, not users.
  const probe = { config: { rateLimit: false } } as const;

  fastify.get("/api/live", probe, async (_request, reply) => {
    reply.header("Cache-Control", "no-store");
    return { status: "ok", timestamp: new Date().toISOString() };
  });

  // The pre-existing route keeps the normal client rate limit it always had.
  fastify.get("/api/health", async (_request, reply) => {
    reply.header("Cache-Control", "no-store");
    const { database } = await currentChecks();
    return reply.code(database === "ok" ? 200 : 503).send({
      status: database === "ok" ? "ok" : "unavailable",
      timestamp: new Date().toISOString(),
    });
  });

  fastify.get("/api/ready", probe, async (_request, reply) => {
    reply.header("Cache-Control", "no-store");
    const checks = await currentChecks();
    const ready = checks.database === "ok" && checks.migrations === "ok";
    return reply.code(ready ? 200 : 503).send({
      status: ready ? "ready" : "not_ready",
      checks,
      timestamp: new Date().toISOString(),
    });
  });
});
