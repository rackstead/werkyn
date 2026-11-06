import type { DriveFile } from "../api";

/**
 * What a folder listing's order depends on for one entry: folders first,
 * then the sort column (name, size, modified, uploaded by), then the ID.
 * Two versions of an entry that give the same string sort the same against
 * the other entries; any change saved on the server also changes
 * `updatedAt`.
 */
export function fileVersion(file: DriveFile): string {
  return [file.isFolder, file.name, file.size, file.updatedAt, file.uploadedBy?.displayName].join("\u0000");
}
