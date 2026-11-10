// Avatar half of parseUploadedMedia. Wiki uploads are a different kind and
// are not paths this helper names. The stored path keeps the URL's own
// casing; only a URL that is exactly `/storage/` plus that path matches.
const AVATAR_URL =
  /^\/storage\/([A-Za-z0-9_-]{1,128})\/uploads\/(avatars)\/([A-Za-z0-9_-]{1,128})\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}(?:\.[^/]+)?)$/i;

export function avatarStoragePath(url: unknown): string | null {
  if (
    typeof url !== "string" ||
    url.length > 2048 ||
    /[\\\x00-\x20?#]/.test(url)
  ) {
    return null;
  }
  const match = AVATAR_URL.exec(url);
  if (!match || Buffer.byteLength(match[4]) > 255) return null;
  return `${match[1]}/uploads/${match[2]}/${match[3]}/${match[4]}`;
}
