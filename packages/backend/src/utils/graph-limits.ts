/**
 * Budgets for every relational parent/child traversal (wiki page and Drive
 * file trees). Parent foreign keys reference a single id, so the database does
 * not prevent legacy cycles, cross-space/cross-workspace edges or arbitrarily
 * deep chains; readers and writers stop at these limits with a controlled
 * error instead of looping or partially mutating a tree.
 *
 * - maxDepth: ancestor hops or descendant levels walked from one node. Each
 *   level costs one query, so this also bounds the query count.
 * - maxNodes: rows collected from one subtree before a move, delete or archive.
 *   A larger tree is refused with 409; it can still be removed or moved in
 *   smaller parts (its subfolders or subpages first).
 *
 * With the "parentId" indexes, a locked move or delete of about 50,000 rows
 * took 2-3 s on a local PostgreSQL 16 (100,000 unrelated rows present), well
 * inside the 10 s workspace-lock transaction timeout.
 *
 * The object is mutable only so integration tests can inject small budgets.
 */
export const graphLimits = {
  maxDepth: 256,
  maxNodes: 50_000,
};

/** Keeps every `IN (...)` list far below PostgreSQL's bind-parameter limit. */
export const GRAPH_QUERY_BATCH = 5_000;

export function batches<T>(items: T[], size = GRAPH_QUERY_BATCH): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < items.length; i += size)
    result.push(items.slice(i, i + size));
  return result;
}
