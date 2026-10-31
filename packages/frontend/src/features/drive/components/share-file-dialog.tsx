import { useState, useEffect, useMemo } from "react";
import {
  useFileShares,
  useFileShareLinks,
  useCreateFileShares,
  useRemoveFileShare,
  useCreateFileShareLink,
  useUpdateFileShareLink,
  useDeleteFileShareLink,
} from "../api";
import { useWorkspaceMembers } from "@/features/workspaces/api";
import { UserAvatar } from "@/components/shared/user-avatar";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Calendar,
  Check,
  Copy,
  ExternalLink,
  Link2,
  Search,
  Share2,
  Trash2,
  Users,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { copyToClipboard } from "@/lib/copy-to-clipboard";
import { toast } from "sonner";
import { formatDateISO } from "@/features/time/utils";

interface ShareFileDialogProps {
  open: boolean;
  onClose: () => void;
  workspaceId: string;
  fileIds: string[];
  fileName: string;
}

type Tab = "people" | "link";

export function ShareFileDialog({
  open,
  onClose,
  workspaceId,
  fileIds,
  fileName,
}: ShareFileDialogProps) {
  const [activeTab, setActiveTab] = useState<Tab>("people");

  useEffect(() => {
    if (open) setActiveTab("people");
  }, [open]);

  const singleFileId = fileIds.length === 1 ? fileIds[0] : null;

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Share2 className="h-4 w-4" />
            Share {fileIds.length > 1 ? `${fileIds.length} files` : fileName}
          </DialogTitle>
        </DialogHeader>

        {/* Tab buttons */}
        <div className="flex gap-1 border-b">
          <button
            onClick={() => setActiveTab("people")}
            className={cn(
              "flex items-center gap-1.5 px-3 py-2 text-sm transition-colors border-b-2 -mb-px",
              activeTab === "people"
                ? "border-primary text-foreground font-medium"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            <Users className="h-3.5 w-3.5" />
            People
          </button>
          <button
            onClick={() => setActiveTab("link")}
            className={cn(
              "flex items-center gap-1.5 px-3 py-2 text-sm transition-colors border-b-2 -mb-px",
              activeTab === "link"
                ? "border-primary text-foreground font-medium"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            <Link2 className="h-3.5 w-3.5" />
            Link
          </button>
        </div>

        {activeTab === "people" ? (
          <PeopleTab
            workspaceId={workspaceId}
            fileIds={fileIds}
            singleFileId={singleFileId}
          />
        ) : (
          <LinkTab
            workspaceId={workspaceId}
            fileIds={fileIds}
            singleFileId={singleFileId}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

// ─── People Tab ─────────────────────────────────────────

function PeopleTab({
  workspaceId,
  fileIds,
  singleFileId,
}: {
  workspaceId: string;
  fileIds: string[];
  singleFileId: string | null;
}) {
  const [search, setSearch] = useState("");
  const [selectedUserIds, setSelectedUserIds] = useState<string[]>([]);

  const { data: membersData } = useWorkspaceMembers(workspaceId);
  const members = membersData?.data ?? [];

  const { data: sharesData } = useFileShares(workspaceId, singleFileId);
  const currentShares = sharesData?.data ?? [];
  const sharedUserIds = new Set(currentShares.map((s) => s.sharedWith.id));

  const createShares = useCreateFileShares(workspaceId);
  const removeShare = useRemoveFileShare(workspaceId);

  const filteredMembers = useMemo(() => {
    const q = search.toLowerCase();
    return members.filter(
      (m) =>
        !sharedUserIds.has(m.user.id) &&
        !selectedUserIds.includes(m.user.id) &&
        (m.user.displayName.toLowerCase().includes(q) ||
          m.user.email.toLowerCase().includes(q)),
    );
  }, [members, search, sharedUserIds, selectedUserIds]);

  const handleShare = () => {
    if (selectedUserIds.length === 0) return;
    createShares.mutate(
      { fileIds, userIds: selectedUserIds },
      {
        onSuccess: () => {
          setSelectedUserIds([]);
          setSearch("");
          toast.success("Shared successfully");
        },
        onError: (err) => toast.error(err.message || "Failed to share"),
      },
    );
  };

  const handleRemoveShare = (userId: string) => {
    if (!singleFileId) return;
    removeShare.mutate(
      { fileId: singleFileId, userId },
      {
        onSuccess: () => toast.success("Share removed"),
        onError: (err) => toast.error(err.message || "Failed to remove share"),
      },
    );
  };

  return (
    <div className="space-y-4 py-1">
      {/* User search + select */}
      <div className="space-y-2">
        <div className="relative">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search members..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-8"
          />
        </div>

        {/* Selected chips */}
        {selectedUserIds.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {selectedUserIds.map((uid) => {
              const m = members.find((m) => m.user.id === uid);
              if (!m) return null;
              return (
                <span
                  key={uid}
                  className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-xs"
                >
                  {m.user.displayName}
                  <button
                    onClick={() =>
                      setSelectedUserIds((prev) => prev.filter((id) => id !== uid))
                    }
                    className="rounded-full hover:bg-primary/20"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              );
            })}
          </div>
        )}

        {/* Member list */}
        {search && filteredMembers.length > 0 && (
          <div className="max-h-32 overflow-y-auto rounded-md border divide-y">
            {filteredMembers.slice(0, 8).map((m) => (
              <button
                key={m.user.id}
                onClick={() => {
                  setSelectedUserIds((prev) => [...prev, m.user.id]);
                  setSearch("");
                }}
                className="flex w-full items-center gap-2 px-3 py-2 text-sm hover:bg-accent transition-colors"
              >
                <UserAvatar
                  displayName={m.user.displayName}
                  avatarUrl={m.user.avatarUrl}
                  size="sm"
                />
                <div className="text-left min-w-0">
                  <div className="truncate">{m.user.displayName}</div>
                  <div className="truncate text-xs text-muted-foreground">
                    {m.user.email}
                  </div>
                </div>
              </button>
            ))}
          </div>
        )}

        {selectedUserIds.length > 0 && (
          <Button
            size="sm"
            onClick={handleShare}
            disabled={createShares.isPending}
            className="w-full"
          >
            {createShares.isPending
              ? "Sharing..."
              : `Share with ${selectedUserIds.length} user${selectedUserIds.length !== 1 ? "s" : ""}`}
          </Button>
        )}
      </div>

      {/* Current shares */}
      {singleFileId && currentShares.length > 0 && (
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground">Shared with</Label>
          <div className="max-h-40 overflow-y-auto divide-y rounded-md border">
            {currentShares.map((share) => (
              <div
                key={share.id}
                className="flex items-center justify-between px-3 py-2"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <UserAvatar
                    displayName={share.sharedWith.displayName}
                    avatarUrl={share.sharedWith.avatarUrl}
                    size="sm"
                  />
                  <div className="min-w-0">
                    <div className="text-sm truncate">
                      {share.sharedWith.displayName}
                    </div>
                    <div className="text-xs text-muted-foreground truncate">
                      {share.sharedWith.email}
                    </div>
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => handleRemoveShare(share.sharedWith.id)}
                  disabled={removeShare.isPending}
                  className="shrink-0"
                >
                  <X className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Link Tab ───────────────────────────────────────────

function LinkTab({
  workspaceId,
  fileIds,
  singleFileId,
}: {
  workspaceId: string;
  fileIds: string[];
  singleFileId: string | null;
}) {
  const { data: linksData, isLoading } = useFileShareLinks(
    workspaceId,
    singleFileId,
  );
  const queryLinks = linksData?.data ?? [];

  // For multi-file shares, the query is disabled (no singleFileId).
  // Track links created in this session so they display immediately.
  const [localLinks, setLocalLinks] = useState<typeof queryLinks>([]);
  const links = singleFileId ? queryLinks : localLinks;

  const createLink = useCreateFileShareLink(workspaceId);
  const updateLink = useUpdateFileShareLink(workspaceId);
  const deleteLink = useDeleteFileShareLink(workspaceId);

  const [password, setPassword] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [showPasswordField, setShowPasswordField] = useState<string | null>(null);
  const [showExpirationField, setShowExpirationField] = useState<string | null>(null);
  const [copiedLinkId, setCopiedLinkId] = useState<string | null>(null);

  const handleCreate = () => {
    createLink.mutate(
      {
        fileIds,
        password: password.trim() || undefined,
        expiresAt: expiresAt ? new Date(expiresAt + "T23:59:59").toISOString() : undefined,
      },
      {
        onSuccess: (res) => {
          setPassword("");
          setExpiresAt("");
          if (!singleFileId) {
            setLocalLinks((prev) => [res.data, ...prev]);
          }
          toast.success("Share link created");
        },
        onError: (err) => toast.error(err.message || "Failed to create link"),
      },
    );
  };

  const handleCopyLink = (linkId: string, token: string) => {
    const url = `${window.location.origin}/share/files/${token}`;
    copyToClipboard(url);
    setCopiedLinkId(linkId);
    toast.success("Link copied to clipboard");
    setTimeout(() => setCopiedLinkId(null), 2000);
  };

  const handleToggleEnabled = (linkId: string, currentEnabled: boolean) => {
    updateLink.mutate({ linkId, enabled: !currentEnabled });
  };

  const handleSetPassword = (linkId: string) => {
    updateLink.mutate(
      { linkId, password: password.trim() || null },
      {
        onSuccess: () => {
          setPassword("");
          setShowPasswordField(null);
          toast.success(password.trim() ? "Password set" : "Password removed");
        },
      },
    );
  };

  const handleSetExpiration = (linkId: string) => {
    updateLink.mutate(
      { linkId, expiresAt: expiresAt ? new Date(expiresAt + "T23:59:59").toISOString() : null },
      {
        onSuccess: () => {
          setExpiresAt("");
          setShowExpirationField(null);
          toast.success(expiresAt ? "Expiration set" : "Expiration removed");
        },
      },
    );
  };

  const handleDelete = (linkId: string) => {
    deleteLink.mutate(linkId, {
      onSuccess: () => {
        if (!singleFileId) {
          setLocalLinks((prev) => prev.filter((l) => l.id !== linkId));
        }
        toast.success("Link deleted");
      },
    });
  };

  if (isLoading) {
    return (
      <div className="py-8 text-center text-sm text-muted-foreground">
        Loading...
      </div>
    );
  }

  return (
    <div className="space-y-4 py-1">
      {links.length === 0 ? (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Create a public link to share {fileIds.length > 1 ? "these files" : "this file"} with
            anyone. They won&apos;t need to sign in.
          </p>
          <div className="space-y-2">
            <Label htmlFor="link-password">Password protection (optional)</Label>
            <Input
              id="link-password"
              type="password"
              placeholder="Leave empty for no password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="link-expiration">Expiration date (optional)</Label>
            <Input
              id="link-expiration"
              type="date"
              value={expiresAt}
              min={formatDateISO(new Date())}
              onChange={(e) => setExpiresAt(e.target.value)}
            />
          </div>
          <Button
            onClick={handleCreate}
            disabled={createLink.isPending}
            className="w-full"
          >
            {createLink.isPending ? "Creating..." : "Create link"}
          </Button>
        </div>
      ) : (
        <div className="space-y-3">
          {links.map((link) => {
            const shareUrl = `${window.location.origin}/share/files/${link.token}`;

            return (
              <div key={link.id} className="space-y-3 rounded-md border p-3">
                {/* Link + copy */}
                <div className="flex items-center gap-2">
                  <Input
                    readOnly
                    value={shareUrl}
                    className="text-xs font-mono"
                  />
                  <Button
                    size="icon"
                    variant="outline"
                    onClick={() => handleCopyLink(link.id, link.token)}
                    title="Copy link"
                  >
                    {copiedLinkId === link.id ? (
                      <Check className="h-4 w-4 text-green-500" />
                    ) : (
                      <Copy className="h-4 w-4" />
                    )}
                  </Button>
                  <Button
                    size="icon"
                    variant="outline"
                    onClick={() => window.open(shareUrl, "_blank")}
                    title="Open in new tab"
                  >
                    <ExternalLink className="h-4 w-4" />
                  </Button>
                </div>

                {/* Toggle enabled */}
                <div className="flex items-center justify-between">
                  <Label className="text-sm">Sharing enabled</Label>
                  <Button
                    size="sm"
                    variant={link.enabled ? "default" : "outline"}
                    onClick={() => handleToggleEnabled(link.id, link.enabled)}
                    disabled={updateLink.isPending}
                  >
                    {link.enabled ? "Enabled" : "Disabled"}
                  </Button>
                </div>

                {/* Password */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label className="text-sm">
                      Password {link.hasPassword ? "(set)" : "(none)"}
                    </Label>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        setShowPasswordField(
                          showPasswordField === link.id ? null : link.id,
                        )
                      }
                    >
                      {showPasswordField === link.id ? "Cancel" : "Change"}
                    </Button>
                  </div>
                  {showPasswordField === link.id && (
                    <div className="flex items-center gap-2">
                      <Input
                        type="password"
                        placeholder="New password (empty to remove)"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                      />
                      <Button
                        size="sm"
                        onClick={() => handleSetPassword(link.id)}
                        disabled={updateLink.isPending}
                      >
                        Save
                      </Button>
                    </div>
                  )}
                </div>

                {/* Expiration */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label className="text-sm">
                      <span className="flex items-center gap-1.5">
                        <Calendar className="h-3.5 w-3.5" />
                        Expires {link.expiresAt ? new Date(link.expiresAt).toLocaleDateString() : "(never)"}
                      </span>
                    </Label>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        setShowExpirationField(
                          showExpirationField === link.id ? null : link.id,
                        )
                      }
                    >
                      {showExpirationField === link.id ? "Cancel" : "Change"}
                    </Button>
                  </div>
                  {showExpirationField === link.id && (
                    <div className="flex items-center gap-2">
                      <Input
                        type="date"
                        min={formatDateISO(new Date())}
                        value={expiresAt}
                        onChange={(e) => setExpiresAt(e.target.value)}
                      />
                      <Button
                        size="sm"
                        onClick={() => handleSetExpiration(link.id)}
                        disabled={updateLink.isPending}
                      >
                        Save
                      </Button>
                    </div>
                  )}
                </div>

                {/* Delete */}
                <div className="border-t pt-2">
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={() => handleDelete(link.id)}
                    disabled={deleteLink.isPending}
                  >
                    <Trash2 className="h-3.5 w-3.5 mr-1" />
                    Remove link
                  </Button>
                </div>
              </div>
            );
          })}

          {/* Create another link */}
          <Button
            variant="outline"
            size="sm"
            onClick={handleCreate}
            disabled={createLink.isPending}
            className="w-full"
          >
            {createLink.isPending ? "Creating..." : "Create another link"}
          </Button>
        </div>
      )}
    </div>
  );
}
