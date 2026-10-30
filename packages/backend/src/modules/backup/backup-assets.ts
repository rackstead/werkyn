/**
 * Helpers for extracting and rewriting storage URLs in wiki page content (BlockNote JSON).
 */

const STORAGE_URL_RE = /\/storage\/[^\s"']+/g;

/**
 * Recursively walk an unknown JSON value and collect all `/storage/...` URLs.
 */
export function extractStorageUrls(content: unknown): string[] {
  const urls = new Set<string>();

  function walk(node: unknown): void {
    if (typeof node === "string") {
      for (const match of node.matchAll(STORAGE_URL_RE)) {
        urls.add(match[0]);
      }
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (node !== null && typeof node === "object") {
      for (const value of Object.values(node as Record<string, unknown>)) {
        walk(value);
      }
    }
  }

  walk(content);
  return Array.from(urls);
}

/** Export replaces complete reference tokens only; denied/missing suffixes stay intact. */
export function rewriteStorageUrls(
  content: unknown,
  urlMap: Map<string, string>,
): unknown {
  if (typeof content === "string") {
    return content.replace(STORAGE_URL_RE, (url) => urlMap.get(url) ?? url);
  }
  if (Array.isArray(content)) {
    return content.map((item) => rewriteStorageUrls(item, urlMap));
  }
  if (content !== null && typeof content === "object") {
    return Object.fromEntries(
      Object.entries(content).map(([key, value]) => [
        key,
        rewriteStorageUrls(value, urlMap),
      ]),
    );
  }
  return content;
}
