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
 * settings (set_config(..., true)) before the queries run.
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
  const results = await prisma.$transaction([
    prisma.$executeRaw`SELECT set_config('plan_cache_mode', 'force_custom_plan', true)`,
    ...settings,
    ...queries,
  ]);
  return results.slice(1 + settings.length) as { -readonly [K in keyof P]: Awaited<P[K]> };
}

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
 * Logs one warning when any search trigram index is missing, invalid, or
 * has an expected name but another definition (table, column, access method
 * or operator class): the migration's IF NOT EXISTS would have skipped it.
 * The migration skips the indexes on databases whose default collation does
 * not use libc (pg_trgm cannot follow ICU case folding there), and search
 * then reads the tables as before. Returns whether it warned; never throws.
 */
export async function warnIfSearchIndexesMissing(
  prisma: Pick<PrismaClient, "$queryRaw">,
  log: { warn(details: object, message: string): void },
): Promise<boolean> {
  try {
    const expected = Prisma.join(
      SEARCH_TRIGRAM_INDEXES.map(([name, table, column]) => Prisma.sql`(${name}, ${table}, ${column})`),
    );
    const [row] = await prisma.$queryRaw<{ present: string[]; provider: string | null }[]>`
      SELECT
        ARRAY(SELECT c.relname::text FROM pg_index i
          JOIN pg_class c ON c.oid = i.indexrelid
          JOIN pg_class t ON t.oid = i.indrelid
          JOIN pg_am am ON am.oid = c.relam
          JOIN pg_opclass o ON o.oid = i.indclass[0]
          JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = i.indkey[0]
          WHERE (c.relname::text, t.relname::text, a.attname::text) IN (${expected})
            AND c.relnamespace = to_regnamespace(current_schema())
            AND i.indnatts = 1 AND i.indexprs IS NULL AND i.indpred IS NULL
            AND am.amname = 'gin' AND o.opcname = 'gin_trgm_ops' AND i.indisvalid) AS present,
        (SELECT to_jsonb(d) ->> 'datlocprovider' FROM pg_database d
          WHERE d.datname = current_database()) AS provider`;
    const missing = SEARCH_TRIGRAM_INDEXES.map(([name]) => name).filter((name) => !row.present.includes(name));
    if (missing.length === 0) return false;
    const provider = { c: "libc", i: "icu", b: "builtin" }[row.provider ?? "c"] ?? row.provider;
    log.warn(
      { missing, collationProvider: provider },
      provider === "libc"
        ? "Search trigram indexes are missing, invalid or defined differently; text search reads whole tables (docs/remediation/p02c.md)"
        : `Search trigram indexes are not created on a database whose default collation provider is ${provider}; text search reads whole tables (docs/remediation/p02c.md)`,
    );
    return true;
  } catch {
    return false;
  }
}
