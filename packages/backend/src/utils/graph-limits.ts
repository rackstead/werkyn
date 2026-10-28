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
 *
 * The object is mutable only so integration tests can inject small budgets.
 */
export const graphLimits = {
  maxDepth: 256,
  maxNodes: 10_000,
};
