import { useState, useCallback, useEffect } from "react";
import { useAuthStore } from "@/stores/auth-store";

export interface RecentFileEntry {
  id: string;
  name: string;
  mimeType: string | null;
  isFolder: boolean;
  size: number | null;
  teamFolderId?: string | null;
  uploadedById: string;
  uploadedBy: { id: string; displayName: string; avatarUrl: string | null };
  updatedAt: string;
  accessedAt: number;
}

const MAX_RECENT = 10;

// Recents hold file names and uploaders, so they are kept per account and
// workspace: another account signed in to the same browser and workspace
// cannot see them.
function getStorageKey(userId: string, wid: string) {
  return `drive-recent:${userId}:${wid}`;
}

// Earlier builds stored recents per workspace only, whoever was signed in.
// They have no owner, so they are removed rather than shown to anyone.
const LEGACY_KEY_PREFIX = "drive-recent-";
try {
  for (let index = localStorage.length - 1; index >= 0; index--) {
    const key = localStorage.key(index);
    if (key?.startsWith(LEGACY_KEY_PREFIX)) localStorage.removeItem(key);
  }
} catch {
  // Storage unavailable
}

function readRecents(userId: string, wid: string): RecentFileEntry[] {
  if (!userId) return [];
  try {
    const raw = localStorage.getItem(getStorageKey(userId, wid));
    return raw ? (JSON.parse(raw) as RecentFileEntry[]) : [];
  } catch {
    return [];
  }
}

function writeRecents(userId: string, wid: string, entries: RecentFileEntry[]) {
  if (!userId) return;
  try {
    localStorage.setItem(getStorageKey(userId, wid), JSON.stringify(entries));
  } catch {
    // Storage full — ignore
  }
}

interface AddRecentInput {
  id: string;
  name: string;
  mimeType: string | null;
  isFolder: boolean;
  size: number | null;
  teamFolderId?: string | null;
  uploadedById: string;
  uploadedBy: { id: string; displayName: string; avatarUrl: string | null };
  updatedAt: string;
}

export function useRecentFiles(wid: string) {
  const userId = useAuthStore((s) => s.user?.id ?? "");
  const [recents, setRecents] = useState<RecentFileEntry[]>(() =>
    readRecents(userId, wid),
  );

  // Re-read on account or workspace change
  useEffect(() => {
    setRecents(readRecents(userId, wid));
  }, [userId, wid]);

  const addRecent = useCallback(
    (file: AddRecentInput) => {
      setRecents((prev) => {
        const entry: RecentFileEntry = {
          id: file.id,
          name: file.name,
          mimeType: file.mimeType,
          isFolder: file.isFolder,
          size: file.size,
          teamFolderId: file.teamFolderId,
          uploadedById: file.uploadedById,
          uploadedBy: file.uploadedBy,
          updatedAt: file.updatedAt,
          accessedAt: Date.now(),
        };
        const filtered = prev.filter((r) => r.id !== file.id);
        const next = [entry, ...filtered].slice(0, MAX_RECENT);
        writeRecents(userId, wid, next);
        return next;
      });
    },
    [userId, wid],
  );

  const removeRecent = useCallback(
    (id: string) => {
      setRecents((prev) => {
        const next = prev.filter((r) => r.id !== id);
        writeRecents(userId, wid, next);
        return next;
      });
    },
    [userId, wid],
  );

  return { recents, addRecent, removeRecent };
}
