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
 * Results are in query order. The queries run one after another on one
 * connection, inside a transaction at the default isolation level, so each
 * statement reads its own snapshot as it would outside one.
 */
export async function withSearchPlans<const P extends readonly Prisma.PrismaPromise<unknown>[]>(
  prisma: PrismaClient,
  queries: P,
): Promise<{ -readonly [K in keyof P]: Awaited<P[K]> }> {
  const [, ...results] = await prisma.$transaction([
    prisma.$executeRaw`SELECT set_config('plan_cache_mode', 'force_custom_plan', true)`,
    ...queries,
  ]);
  return results as { -readonly [K in keyof P]: Awaited<P[K]> };
}
