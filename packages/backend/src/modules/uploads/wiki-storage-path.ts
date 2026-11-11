// Wiki half of an uploaded media URL. The "/storage" prefix matches in any
// case, as on the media route, and the bytes live at the exact path after
// it. wiki_media_storage_paths in the wiki media migration extracts the same
// shape from page and version JSON.
const WIKI_STORAGE_PATH =
  /^\/[sS][tT][oO][rR][aA][gG][eE]\/([A-Za-z0-9_-]{1,128}\/uploads\/wiki\/[A-Za-z0-9_-]{1,128}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:\.[^"\\\s/?#]{1,255})?)$/;

export function wikiStoragePath(url: unknown): string | null {
  if (typeof url !== "string" || url.length > 2048) return null;
  return WIKI_STORAGE_PATH.exec(url)?.[1] ?? null;
}
