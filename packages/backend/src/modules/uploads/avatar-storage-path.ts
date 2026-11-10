// Avatar half of parseUploadedMedia. The prefix match is case-insensitive,
// as on the media route, but the bytes live at the path after that prefix.
// Uploads store a lowercase `/storage/` prefix. Wiki uploads are not named.
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

// The spelling uploads write and the sweep looks up. A `/Storage/` prefix
// names this same blob on the media route; it is not a different file.
export function canonicalAvatarUrl(url: unknown): string | null {
  const storagePath = avatarStoragePath(url);
  return storagePath === null ? null : `/storage/${storagePath}`;
}
