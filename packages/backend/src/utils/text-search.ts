import type { Prisma, PrismaClient } from "@prisma/client";

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

/** The indexes of migration 20261105180000_search_trigram_indexes. */
export const SEARCH_TRIGRAM_INDEXES = [
  "Task_title_trgm_idx",
  "Task_description_trgm_idx",
  "ChatMessage_content_trgm_idx",
  "WikiPage_title_trgm_idx",
  "File_name_trgm_idx",
] as const;

/**
 * Logs one warning when the search trigram indexes are not all present and
 * valid. The migration skips them on databases whose default collation does
 * not use libc (pg_trgm cannot follow ICU case folding there), and search
 * then reads the tables as before. Never throws.
 */
export async function warnIfSearchIndexesMissing(
  prisma: PrismaClient,
  log: { warn(details: object, message: string): void },
): Promise<boolean> {
  try {
    const [row] = await prisma.$queryRaw<{ present: number; provider: string | null }[]>`
      SELECT
        (SELECT count(*)::int FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
          WHERE c.relname = ANY(${[...SEARCH_TRIGRAM_INDEXES]}::text[])
            AND c.relnamespace = to_regnamespace(current_schema()) AND i.indisvalid) AS present,
        (SELECT to_jsonb(d) ->> 'datlocprovider' FROM pg_database d
          WHERE d.datname = current_database()) AS provider`;
    if (row.present === SEARCH_TRIGRAM_INDEXES.length) return false;
    const provider = { c: "libc", i: "icu", b: "builtin" }[row.provider ?? "c"] ?? row.provider;
    log.warn(
      { present: row.present, expected: SEARCH_TRIGRAM_INDEXES.length, collationProvider: provider },
      provider === "libc"
        ? "Search trigram indexes are missing or invalid; text search reads whole tables (docs/remediation/p02c.md)"
        : `Search trigram indexes are not created on a database whose default collation provider is ${provider}; text search reads whole tables (docs/remediation/p02c.md)`,
    );
    return true;
  } catch {
    return false;
  }
}
