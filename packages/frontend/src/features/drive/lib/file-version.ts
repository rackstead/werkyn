import type { DriveFile, SortBy } from "../api";

/**
 * What a folder listing's order depends on for one entry: folders first,
 * then the sort column (name, size, modified, uploaded by), then the ID.
 * A change to an inactive column cannot move the entry. In particular, a
 * thumbnail update or uploader rename must not mark an entry as moved when
 * the folder is sorted by name. The JSON tuple preserves nulls and separators.
 */
export function fileVersion(file: DriveFile, sortBy: SortBy = "name"): string {
  const value = sortBy === "uploadedBy" ? file.uploadedBy?.displayName ?? null : file[sortBy];
  return JSON.stringify([file.isFolder, sortBy, value, file.id]);
}
