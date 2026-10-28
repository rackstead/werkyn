import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import { queryKeys } from "@/lib/query-keys";
import { useAuthStore } from "@/stores/auth-store";
import { toast } from "sonner";
import type {
  CreateWikiSpaceInput,
  UpdateWikiSpaceInput,
  CreateWikiPageInput,
  UpdateWikiPageInput,
  MoveWikiPageInput,
  CreateNamedVersionInput,
  CreateWikiCommentInput,
  UpdateWikiCommentInput,
  CreateWikiShareInput,
  UpdateWikiShareInput,
} from "@pm/shared";

// ─── Types ──────────────────────────────────────────────

export interface WikiSpace {
  id: string;
  workspaceId: string;
  name: string;
  slug: string;
  description: string | null;
  icon: string | null;
  position: number;
  createdAt: string;
  updatedAt: string;
  _count: { pages: number };
}

export interface WikiPageTreeItem {
  id: string;
  spaceId: string;
  parentId: string | null;
  title: string;
  icon: string | null;
  position: number;
  createdById: string;
  lastEditedById: string | null;
  createdAt: string;
  updatedAt: string;
  createdBy: { id: string; displayName: string; avatarUrl: string | null };
  lastEditedBy: { id: string; displayName: string; avatarUrl: string | null } | null;
  _count: { children: number };
}

export interface WikiPage {
  id: string;
  spaceId: string;
  parentId: string | null;
  title: string;
  content: unknown;
  icon: string | null;
  position: number;
  createdById: string;
  lastEditedById: string | null;
  createdAt: string;
  updatedAt: string;
  createdBy: { id: string; displayName: string; avatarUrl: string | null };
  lastEditedBy: { id: string; displayName: string; avatarUrl: string | null } | null;
}

export interface WikiBreadcrumb {
  id: string;
  title: string;
  icon: string | null;
}

export interface WikiPageVersion {
  id: string;
  pageId: string;
  title: string;
  content: unknown;
  versionNumber: number;
  name: string | null;
  isAutoSave: boolean;
  createdById: string;
  createdAt: string;
  createdBy: { id: string; displayName: string; avatarUrl: string | null };
}

export interface WikiPageLock {
  id: string;
  pageId: string;
  userId: string;
  lockedAt: string;
  expiresAt: string;
  heartbeat: string;
  user: { id: string; displayName: string; avatarUrl: string | null };
}

export interface WikiShare {
  id: string;
  pageId: string;
  token: string;
  hasPassword: boolean;
  enabled: boolean;
  createdById: string;
  createdAt: string;
  updatedAt: string;
}

interface WikiSharedPageContent {
  page: {
    id: string;
    title: string;
    content: unknown;
    icon: string | null;
    updatedAt: string;
    createdBy: { displayName: string };
    lastEditedBy: { displayName: string } | null;
  };
}

export type WikiPublicPage = { hasPassword: boolean } & (
  | { authorized: false; page: null }
  | ({ authorized: true } & WikiSharedPageContent)
);

export interface WikiComment {
  id: string;
  pageId: string;
  authorId: string;
  body: string;
  resolved: boolean;
  resolvedById: string | null;
  resolvedAt: string | null;
  highlightId: string;
  selectionStart: unknown;
  selectionEnd: unknown;
  createdAt: string;
  updatedAt: string;
  author: { id: string; displayName: string; avatarUrl: string | null };
  resolvedBy: { id: string; displayName: string; avatarUrl: string | null } | null;
}

// ─── Space Queries ──────────────────────────────────────

export function useWikiSpaces(wid: string) {
  return useQuery({
    queryKey: queryKeys.wikiSpaces(wid),
    queryFn: () =>
      api
        .get(`workspaces/${wid}/wiki/spaces`)
        .json<{ data: WikiSpace[] }>(),
    enabled: !!wid,
  });
}

export function useWikiSpace(sid: string) {
  return useQuery({
    queryKey: queryKeys.wikiSpace(sid),
    queryFn: () =>
      api.get(`wiki/spaces/${sid}`).json<{ data: WikiSpace }>(),
    enabled: !!sid,
  });
}

// ─── Space Mutations ────────────────────────────────────

export function useCreateWikiSpace(wid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: CreateWikiSpaceInput) =>
      api
        .post(`workspaces/${wid}/wiki/spaces`, { json: data })
        .json<{ data: WikiSpace }>(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.wikiSpaces(wid) });
      toast.success("Space created");
    },
    onError: () => {
      toast.error("Failed to create space");
    },
  });
}

export function useUpdateWikiSpace(sid: string, wid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: UpdateWikiSpaceInput) =>
      api
        .patch(`wiki/spaces/${sid}`, { json: data })
        .json<{ data: WikiSpace }>(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.wikiSpaces(wid) });
      qc.invalidateQueries({ queryKey: queryKeys.wikiSpace(sid) });
    },
    onError: () => {
      toast.error("Failed to update space");
    },
  });
}

export function useDeleteWikiSpace(wid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (sid: string) =>
      api.delete(`wiki/spaces/${sid}`).then(() => {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.wikiSpaces(wid) });
      toast.success("Space deleted");
    },
    onError: () => {
      toast.error("Failed to delete space");
    },
  });
}

// ─── Page Queries ───────────────────────────────────────

export function useWikiPageTree(sid: string, parentId?: string) {
  return useQuery({
    queryKey: queryKeys.wikiPageTree(sid, parentId),
    queryFn: () => {
      const params = new URLSearchParams();
      if (parentId) params.set("parentId", parentId);
      const qs = params.toString();
      return api
        .get(`wiki/spaces/${sid}/pages/tree${qs ? `?${qs}` : ""}`)
        .json<{ data: WikiPageTreeItem[] }>();
    },
    enabled: !!sid,
  });
}

export function useWikiPage(pgid: string | undefined) {
  return useQuery({
    queryKey: queryKeys.wikiPage(pgid!),
    queryFn: () =>
      api.get(`wiki/pages/${pgid}`).json<{ data: WikiPage }>(),
    enabled: !!pgid,
  });
}

export function useWikiPageBreadcrumbs(pgid: string | undefined) {
  return useQuery({
    queryKey: queryKeys.wikiPageBreadcrumbs(pgid!),
    queryFn: () =>
      api
        .get(`wiki/pages/${pgid}/breadcrumbs`)
        .json<{ data: WikiBreadcrumb[] }>(),
    enabled: !!pgid,
  });
}

// ─── Page Mutations ─────────────────────────────────────

export function useCreateWikiPage(sid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: CreateWikiPageInput) =>
      api
        .post(`wiki/spaces/${sid}/pages`, { json: data })
        .json<{ data: WikiPage }>(),
    onSuccess: (_, variables) => {
      qc.invalidateQueries({
        queryKey: queryKeys.wikiPageTree(sid, variables.parentId),
      });
      // Also invalidate parent tree for child count
      if (variables.parentId) {
        qc.invalidateQueries({
          queryKey: queryKeys.wikiPageTree(sid),
        });
      }
    },
    onError: () => {
      toast.error("Failed to create page");
    },
  });
}

export function useUpdateWikiPage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ pageId, expectedUserId, ...data }: UpdateWikiPageInput & { pageId: string; expectedUserId?: string }) => {
      if (expectedUserId && useAuthStore.getState().user?.id !== expectedUserId) {
        throw new Error("Sign in as the author to save these changes");
      }
      return api
        .patch(`wiki/pages/${pageId}`, { json: data, ...(expectedUserId ? { context: { expectedUserId } } : {}) })
        .json<{ data: WikiPage }>();
    },
    onSuccess: async (result, { pageId, expectedUserId, ...data }) => {
      if (expectedUserId && useAuthStore.getState().user?.id !== expectedUserId) return;
      // PATCH returns the full page. Prevent an older GET from replacing it.
      await qc.cancelQueries({ queryKey: queryKeys.wikiPage(pageId) });
      if (expectedUserId && useAuthStore.getState().user?.id !== expectedUserId) return;
      qc.setQueryData(queryKeys.wikiPage(pageId), result);
      // A content save is already in the cache; a new title or icon also
      // shows in the page tree and breadcrumbs.
      if ("title" in data || "icon" in data)
        qc.invalidateQueries({ queryKey: ["wiki-pages"] });
    },
    onError: (error, { expectedUserId }) => {
      // Editor autosaves report failures through their own retry notice.
      if (expectedUserId) return;
      toast.error(error.message || "Something went wrong");
    },
  });
}

export function useDeleteWikiPage(sid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (pgid: string) =>
      api.delete(`wiki/pages/${pgid}`).then(() => {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["wiki-pages"] });
      toast.success("Page deleted");
    },
    onError: () => {
      toast.error("Failed to delete page");
    },
  });
}

export function useMoveWikiPage(sid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ pgid, ...data }: MoveWikiPageInput & { pgid: string }) =>
      api
        .patch(`wiki/pages/${pgid}/move`, { json: data })
        .json<{ data: WikiPage }>(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["wiki-pages"] });
    },
    onError: () => {
      toast.error("Failed to move page");
    },
  });
}

// ─── Version Queries ────────────────────────────────────

export function useWikiPageVersions(pgid: string | undefined) {
  return useQuery({
    queryKey: ["wiki-versions", pgid],
    queryFn: () =>
      api
        .get(`wiki/pages/${pgid}/versions`)
        .json<{ data: WikiPageVersion[]; nextCursor: string | null }>(),
    enabled: !!pgid,
  });
}

export function useWikiVersion(vid: string | undefined) {
  return useQuery({
    queryKey: ["wiki-versions", "detail", vid],
    queryFn: () =>
      api.get(`wiki/versions/${vid}`).json<{ data: WikiPageVersion }>(),
    enabled: !!vid,
  });
}

// ─── Version Mutations ──────────────────────────────────

export function useCreateNamedVersion(pgid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: CreateNamedVersionInput) =>
      api
        .post(`wiki/pages/${pgid}/versions`, { json: data })
        .json<{ data: WikiPageVersion }>(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["wiki-versions", pgid] });
      toast.success("Version saved");
    },
    onError: () => {
      toast.error("Failed to save version");
    },
  });
}

export function useRestoreVersion(pgid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vid: string) =>
      api
        .post(`wiki/versions/${vid}/restore`)
        .json<{ data: WikiPage }>(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.wikiPage(pgid) });
      qc.invalidateQueries({ queryKey: ["wiki-versions", pgid] });
      toast.success("Version restored");
    },
    onError: () => {
      toast.error("Failed to restore version");
    },
  });
}

// ─── Lock Queries ───────────────────────────────────────

export function useWikiPageLock(pgid: string | undefined) {
  return useQuery({
    queryKey: ["wiki-lock", pgid],
    queryFn: () =>
      api.get(`wiki/pages/${pgid}/lock`).json<{ data: WikiPageLock | null }>(),
    enabled: !!pgid,
    refetchInterval: 30000,
  });
}

// ─── Lock Mutations ─────────────────────────────────────

export function useAcquireWikiLock() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ pageId, expectedUserId }: { pageId: string; expectedUserId?: string }) =>
      api.post(`wiki/pages/${pageId}/lock`, { context: { expectedUserId } }).json<{ data: WikiPageLock }>(),
    onSuccess: (_, { pageId }) => {
      qc.invalidateQueries({ queryKey: ["wiki-lock", pageId] });
    },
  });
}

export function useReleaseWikiLock() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ pageId, expectedUserId }: { pageId: string; expectedUserId?: string }) =>
      api.delete(`wiki/pages/${pageId}/lock`, { context: { expectedUserId } }).then(() => {}),
    onSuccess: (_, { pageId }) => {
      qc.invalidateQueries({ queryKey: ["wiki-lock", pageId] });
    },
  });
}

export function useHeartbeatWikiLock() {
  return useMutation({
    mutationFn: ({ pageId, expectedUserId }: { pageId: string; expectedUserId?: string }) =>
      api.patch(`wiki/pages/${pageId}/lock/heartbeat`, { context: { expectedUserId } }).then(() => {}),
  });
}

// ─── Comment Queries ────────────────────────────────────

export function useWikiComments(pgid: string | undefined, resolved?: boolean) {
  return useQuery({
    queryKey: ["wiki-comments", pgid, { resolved }],
    queryFn: () => {
      const params = new URLSearchParams();
      if (resolved !== undefined) params.set("resolved", String(resolved));
      const qs = params.toString();
      return api
        .get(`wiki/pages/${pgid}/comments${qs ? `?${qs}` : ""}`)
        .json<{ data: WikiComment[] }>();
    },
    enabled: !!pgid,
  });
}

// ─── Comment Mutations ──────────────────────────────────

export function useCreateWikiComment(pgid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: CreateWikiCommentInput) =>
      api
        .post(`wiki/pages/${pgid}/comments`, { json: data })
        .json<{ data: WikiComment }>(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["wiki-comments", pgid] });
    },
    onError: () => {
      toast.error("Failed to add comment");
    },
  });
}

export function useUpdateWikiComment(pgid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ cid, ...data }: UpdateWikiCommentInput & { cid: string }) =>
      api
        .patch(`wiki/comments/${cid}`, { json: data })
        .json<{ data: WikiComment }>(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["wiki-comments", pgid] });
    },
  });
}

export function useResolveWikiComment(pgid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (cid: string) =>
      api
        .patch(`wiki/comments/${cid}/resolve`)
        .json<{ data: WikiComment }>(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["wiki-comments", pgid] });
      toast.success("Comment resolved");
    },
  });
}

export function useDeleteWikiComment(pgid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (cid: string) =>
      api.delete(`wiki/comments/${cid}`).then(() => {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["wiki-comments", pgid] });
    },
  });
}

// ─── Share Queries ──────────────────────────────────────

export function useWikiPageShare(pgid: string | undefined) {
  return useQuery({
    queryKey: ["wiki-share", pgid],
    queryFn: () =>
      api
        .get(`wiki/pages/${pgid}/share`)
        .json<{ data: WikiShare | null }>(),
    enabled: !!pgid,
  });
}

// ─── Share Mutations ────────────────────────────────────

export function useCreateWikiShare(pgid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: CreateWikiShareInput) =>
      api
        .post(`wiki/pages/${pgid}/share`, { json: data })
        .json<{ data: WikiShare }>(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["wiki-share", pgid] });
      toast.success("Share link created");
    },
    onError: () => {
      toast.error("Failed to create share link");
    },
  });
}

export function useUpdateWikiShare(pgid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ shid, ...data }: UpdateWikiShareInput & { shid: string }) =>
      api
        .patch(`wiki/shares/${shid}`, { json: data })
        .json<{ data: WikiShare }>(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["wiki-share", pgid] });
    },
    onError: () => {
      toast.error("Failed to update share settings");
    },
  });
}

export function useDeleteWikiShare(pgid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (shid: string) =>
      api.delete(`wiki/shares/${shid}`).then(() => {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["wiki-share", pgid] });
      toast.success("Share link removed");
    },
    onError: () => {
      toast.error("Failed to remove share link");
    },
  });
}

// ─── Public Page (unauthenticated) ──────────────────────

export function usePublicWikiPage(token: string) {
  return useQuery({
    queryKey: ["wiki-public", token],
    queryFn: () =>
      api
        .get(`public/wiki/${token}`)
        .json<{ data: WikiPublicPage }>(),
    enabled: !!token,
    retry: false,
    staleTime: 0,
    gcTime: 0,
    refetchOnMount: "always",
  });
}

export function useValidateWikiShare() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ token, password }: { token: string; password: string }) =>
      api
        .post(`public/wiki/${token}/validate`, { json: { password } })
        .json<{ data: { valid: boolean } }>(),
    onSuccess: (_result, { token }) => qc.invalidateQueries({ queryKey: ["wiki-public", token] }),
  });
}
