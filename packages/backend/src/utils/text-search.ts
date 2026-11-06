import { Prisma, type PrismaClient } from "@prisma/client";

/**
 * Runs text-search queries, those that filter with `contains` and mode
 * "insensitive" (ILIKE '%term%'), in one transaction whose statements are
 * always planned for their own search term.
 *
 * The trigram indexes of migration 20261105180000_search_trigram_indexes
 * serve terms that yield trigrams. A term that yields none (one or two
 * letters, or only wildcards) matches every index entry, so its plan must
 * scan the table instead. Prisma prepares its statements, and after
 * five executions of one statement PostgreSQL may keep a generic plan made
 * without the term. With these indexes that plan reads the trigram index for
 * every term: on the P02 fixture a two-letter chat search then took 1.9 s
 * instead of 48 ms (docs/remediation/p02c.md). `plan_cache_mode` set to
 * `force_custom_plan` for this transaction only keeps a plan per term for
 * these statements; every other statement keeps PostgreSQL's default.
 *
 * `settings` are statements that set further transaction-local planner
 * settings (set_config(..., true)) before the queries run. For a client that
 * checkSearchIndexes found on a non-libc database with trigram indexes (a
 * libc dump restored into an ICU database), bitmap scans are also off, so
 * the queries cannot read those indexes and miss rows.
 *
 * Results are in query order. The queries run one after another on one
 * connection, inside a transaction at the default isolation level, so each
 * statement reads its own snapshot as it would outside one.
 */
export async function withSearchPlans<const P extends readonly Prisma.PrismaPromise<unknown>[]>(
  prisma: PrismaClient,
  queries: P,
  settings: readonly Prisma.PrismaPromise<unknown>[] = [],
): Promise<{ -readonly [K in keyof P]: Awaited<P[K]> }> {
  const before = [
    prisma.$executeRaw`SELECT set_config('plan_cache_mode', 'force_custom_plan', true)`,
    ...(avoidTrigramIndexes.has(prisma)
      ? [prisma.$executeRaw`SELECT set_config('enable_bitmapscan', 'off', true)`]
      : []),
    ...settings,
  ];
  const results = await prisma.$transaction([...before, ...queries]);
  return results.slice(before.length) as { -readonly [K in keyof P]: Awaited<P[K]> };
}

/** Clients whose database has trigram indexes it must not use. */
const avoidTrigramIndexes = new WeakSet<object>();

/**
 * The indexes of migration 20261105180000_search_trigram_indexes: name,
 * table and column. Each is a single-column GIN index with gin_trgm_ops.
 */
export const SEARCH_TRIGRAM_INDEXES = [
  ["Task_title_trgm_idx", "Task", "title"],
  ["Task_description_trgm_idx", "Task", "description"],
  ["ChatMessage_content_trgm_idx", "ChatMessage", "content"],
  ["WikiPage_title_trgm_idx", "WikiPage", "title"],
  ["File_name_trgm_idx", "File", "name"],
] as const;

/**
 * Checks the search trigram indexes once, at startup, and logs one warning
 * when something is off. Never throws; returns whether it warned.
 *
 * - libc database: warns when any index is missing, invalid, or has an
 *   expected name but another definition (table, column, access method or
 *   operator class); the migration's IF NOT EXISTS would have skipped it.
 * - ICU or builtin database without the indexes (what the migration leaves
 *   there): warns that search reads whole tables.
 * - ICU or builtin database WITH trigram indexes (a libc dump restored into
 *   it): pg_trgm cannot follow its case folding and the indexes would drop
 *   matches. Warns with the DROP INDEX statements, and makes withSearchPlans
 *   avoid the indexes for this client until they are dropped and the server
 *   restarted.
 *
 * `schema` is the schema of Werkyn's tables (DATABASE_URL's `schema`
 * parameter, `public` by default), not the role's current schema.
 */
export async function checkSearchIndexes(
  prisma: PrismaClient,
  log: { warn(details: object, message: string): void },
  schema = "public",
): Promise<boolean> {
  try {
    const expected = Prisma.join(
      SEARCH_TRIGRAM_INDEXES.map(([name, table, column]) => Prisma.sql`(${name}, ${table}, ${column})`),
    );
    const [row] = await prisma.$queryRaw<{ valid: string[]; trigram: string[]; provider: string | null }[]>`
      WITH found AS (
        SELECT c.relname::text AS name,
               i.indisvalid AND i.indnatts = 1 AND i.indexprs IS NULL AND i.indpred IS NULL
                 AND (c.relname::text, t.relname::text, a.attname::text) IN (${expected}) AS exact,
               o.opcname = 'gin_trgm_ops' AS trigram
        FROM pg_index i
        JOIN pg_class c ON c.oid = i.indexrelid
        JOIN pg_class t ON t.oid = i.indrelid
        JOIN pg_am am ON am.oid = c.relam
        JOIN pg_opclass o ON o.oid = ANY(i.indclass)
        LEFT JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = i.indkey[0]
        WHERE c.relnamespace = to_regnamespace(${schema}) AND am.amname = 'gin'
          AND c.relname = ANY(${SEARCH_TRIGRAM_INDEXES.map(([name]) => name)}::text[])
      )
      SELECT
        ARRAY(SELECT DISTINCT name FROM found WHERE exact AND trigram) AS valid,
        ARRAY(SELECT DISTINCT name FROM found WHERE trigram) AS trigram,
        (SELECT to_jsonb(d) ->> 'datlocprovider' FROM pg_database d
          WHERE d.datname = current_database()) AS provider`;
    const provider = { c: "libc", i: "icu", b: "builtin" }[row.provider ?? "c"] ?? row.provider;
    const quoted = (name: string) => `"${schema.replaceAll('"', '""')}"."${name}"`;
    if (provider !== "libc") {
      if (row.trigram.length > 0) {
        avoidTrigramIndexes.add(prisma);
        const drops = row.trigram.map((name) => `DROP INDEX ${quoted(name)};`);
        log.warn(
          { collationProvider: provider, trigramIndexes: row.trigram, drop: drops },
          `Search trigram indexes exist on a database whose default collation provider is ${provider}: pg_trgm cannot follow its case folding, so they would drop matches (e.g. after restoring a libc dump). Search avoids them until they are dropped; run ${drops.join(" ")} and restart (docs/remediation/p02c.md)`,
        );
      } else {
        log.warn(
          { collationProvider: provider },
          `Search trigram indexes are not created on a database whose default collation provider is ${provider}; text search reads whole tables (docs/remediation/p02c.md)`,
        );
      }
      return true;
    }
    const missing = SEARCH_TRIGRAM_INDEXES.map(([name]) => name).filter((name) => !row.valid.includes(name));
    if (missing.length === 0) return false;
    log.warn(
      { missing, collationProvider: provider },
      "Search trigram indexes are missing, invalid or defined differently; text search reads whole tables (docs/remediation/p02c.md)",
    );
    return true;
  } catch {
    return false;
  }
}
