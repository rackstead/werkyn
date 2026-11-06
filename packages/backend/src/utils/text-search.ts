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

/** Clients whose database has trigram indexes they must not use. */
const avoidTrigramIndexes = new WeakSet<object>();

/** Whether withSearchPlans keeps this client's searches off trigram indexes. */
export function searchAvoidsTrigramIndexes(prisma: object): boolean {
  return avoidTrigramIndexes.has(prisma);
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

export type SearchIndexCheck = "ok" | "warned" | "failed";

/**
 * Checks the search trigram indexes, at startup, and logs one warning when
 * something is off. Never throws.
 *
 * - libc database: warns when any index is missing, invalid, or has an
 *   expected name but another definition (table, column, access method or
 *   operator class); the migration's IF NOT EXISTS would have skipped it.
 * - ICU or builtin database without trigram indexes (what the migration
 *   leaves there): warns that search reads whole tables.
 * - ICU or builtin database WITH a GIN trigram index on a searched column,
 *   whatever its name (a libc dump restored into it): pg_trgm cannot follow
 *   its case folding and the index would drop matches. Warns with
 *   schema-qualified DROP INDEX statements, and makes withSearchPlans avoid
 *   trigram indexes for this client.
 * - The catalog query fails: warns (unless `reportFailure` is false) and
 *   makes withSearchPlans avoid trigram indexes for this client until a
 *   check succeeds, since the state is unknown. Returns "failed".
 *
 * A successful check on a libc database lets the client use the indexes
 * again. `schema` is the schema of Werkyn's tables (DATABASE_URL's `schema`
 * parameter, `public` by default), not the role's current schema.
 */
export async function checkSearchIndexes(
  prisma: Pick<PrismaClient, "$queryRaw">,
  log: { warn(details: object, message: string): void },
  schema = "public",
  { reportFailure = true }: { reportFailure?: boolean } = {},
): Promise<SearchIndexCheck> {
  type Index = { name: string; table: string; valid: boolean; plain: boolean; method: string; columns: (string | null)[] };
  let indexes: Index[];
  let provider: string;
  try {
    const tables = [...new Set(SEARCH_TRIGRAM_INDEXES.map(([, table]) => table))];
    indexes = await prisma.$queryRaw<Index[]>`
      SELECT c.relname::text AS name, t.relname::text AS "table", i.indisvalid AS valid,
             (i.indexprs IS NULL AND i.indpred IS NULL) AS plain, am.amname::text AS method,
             ARRAY(SELECT a.attname::text || ':' || o.opcname::text
                   FROM unnest(i.indkey::int2[], i.indclass::oid[]) WITH ORDINALITY AS k(attnum, opclass, n)
                   LEFT JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
                   JOIN pg_opclass o ON o.oid = k.opclass
                   ORDER BY k.n) AS columns
      FROM pg_index i
      JOIN pg_class c ON c.oid = i.indexrelid
      JOIN pg_class t ON t.oid = i.indrelid
      JOIN pg_am am ON am.oid = c.relam
      WHERE t.relnamespace = to_regnamespace(${schema}) AND t.relname = ANY(${tables}::text[])`;
    const [row] = await prisma.$queryRaw<{ provider: string | null }[]>`
      SELECT to_jsonb(d) ->> 'datlocprovider' AS provider FROM pg_database d
      WHERE d.datname = current_database()`;
    provider = { c: "libc", i: "icu", b: "builtin" }[row?.provider ?? "c"] ?? String(row?.provider);
  } catch (error) {
    avoidTrigramIndexes.add(prisma);
    if (reportFailure)
      log.warn(
        { err: error instanceof Error ? error.message : String(error) },
        "Could not check the search trigram indexes; search avoids them until a check succeeds (docs/remediation/p02c.md)",
      );
    return "failed";
  }

  const quoted = (name: string) => `"${schema.replaceAll('"', '""')}"."${name.replaceAll('"', '""')}"`;
  if (provider !== "libc") {
    // Any GIN index with gin_trgm_ops on a searched column, whatever its name.
    const searched = new Set(SEARCH_TRIGRAM_INDEXES.map(([, table, column]) => `${table}.${column}:gin_trgm_ops`));
    const unsafe = indexes
      .filter((index) => index.method === "gin" && index.columns.some((column) => column !== null && searched.has(`${index.table}.${column}`)))
      .map((index) => index.name)
      .sort();
    if (unsafe.length > 0) {
      avoidTrigramIndexes.add(prisma);
      const drop = unsafe.map((name) => `DROP INDEX ${quoted(name)};`);
      log.warn(
        { collationProvider: provider, trigramIndexes: unsafe, drop },
        `Search trigram indexes exist on a database whose default collation provider is ${provider}: pg_trgm cannot follow its case folding, so they would drop matches (e.g. after restoring a libc dump). Search avoids them; run ${drop.join(" ")} (docs/remediation/p02c.md)`,
      );
    } else {
      avoidTrigramIndexes.delete(prisma);
      log.warn(
        { collationProvider: provider },
        `Search trigram indexes are not created on a database whose default collation provider is ${provider}; text search reads whole tables (docs/remediation/p02c.md)`,
      );
    }
    return "warned";
  }

  avoidTrigramIndexes.delete(prisma);
  const exact = (name: string, table: string, column: string) =>
    indexes.some((index) => index.name === name && index.table === table && index.valid && index.plain &&
      index.method === "gin" && index.columns.length === 1 && index.columns[0] === `${column}:gin_trgm_ops`);
  const missing = SEARCH_TRIGRAM_INDEXES.filter(([name, table, column]) => !exact(name, table, column)).map(([name]) => name);
  if (missing.length === 0) return "ok";
  log.warn(
    { missing, collationProvider: provider },
    "Search trigram indexes are missing, invalid or defined differently; text search reads whole tables (docs/remediation/p02c.md)",
  );
  return "warned";
}

/**
 * Runs checkSearchIndexes at startup and, while the client avoids trigram
 * indexes (the check failed, or found trigram indexes on a non-libc
 * database), again `intervalMs` after the previous check finished, until it
 * no longer does: after the indexes are dropped, or once a failed check
 * succeeds. One check runs at a time. A warning is logged only when it
 * differs from the previous one. The timer does not keep the
 * process alive; `stop` ends it.
 */
export async function startSearchIndexCheck(
  prisma: Pick<PrismaClient, "$queryRaw">,
  log: { warn(details: object, message: string): void },
  schema = "public",
  intervalMs = 60_000,
): Promise<{ result: SearchIndexCheck; stop(): void }> {
  let last: string | undefined;
  const once = {
    warn(details: object, message: string) {
      if (message === last) return;
      last = message;
      log.warn(details, message);
    },
  };
  const result = await checkSearchIndexes(prisma, once, schema);
  // One check at a time: the next is scheduled only after the previous one
  // finished and the client still avoids the indexes.
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = () => {
    if (stopped || !avoidTrigramIndexes.has(prisma)) return;
    timer = setTimeout(() => {
      timer = undefined;
      void checkSearchIndexes(prisma, once, schema, { reportFailure: false }).then(schedule);
    }, intervalMs);
    timer.unref();
  };
  schedule();
  const stop = () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = undefined;
  };
  return { result, stop };
}
