import { useState, useEffect, useMemo } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { UserAvatar } from "@/components/shared/user-avatar";
import { Trash2, UserPlus } from "lucide-react";
import { ConfirmDialog } from "@/components/shared/confirm-dialog";
import { LoadMoreButton } from "@/components/shared/load-more-button";
import {
  useUpdateChannel,
  useDeleteChannel,
  useChannelMembers,
  useAddMembers,
  useRemoveMember,
  type ChatChannel,
} from "../api";
import { toast } from "sonner";

interface ChannelSettingsDialogProps {
  open: boolean;
  onClose: () => void;
  workspaceId: string;
  channel: ChatChannel;
  currentUserId: string;
  isAdmin?: boolean;
  workspaceMembers?: Array<{
    id: string;
    displayName: string;
    email: string;
    avatarUrl: string | null;
  }>;
  onDeleted?: () => void;
  onArchive?: (archived: boolean) => void;
  isArchived?: boolean;
}

export function ChannelSettingsDialog({
  open,
  onClose,
  workspaceId,
  channel,
  currentUserId,
  isAdmin,
  workspaceMembers = [],
  onDeleted,
  onArchive,
  isArchived,
}: ChannelSettingsDialogProps) {
  const [name, setName] = useState(channel.name ?? "");
  const [description, setDescription] = useState(channel.description ?? "");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [memberSearch, setMemberSearch] = useState("");

  const updateChannel = useUpdateChannel(workspaceId, channel.id);
  const deleteChannel = useDeleteChannel(workspaceId, channel.id);
  const {
    members,
    hasNextPage: hasMoreMembers,
    isFetchingNextPage: loadingMoreMembers,
    fetchNextPage: loadMoreMembers,
  } = useChannelMembers(workspaceId, channel.id);
  const addMembers = useAddMembers(workspaceId, channel.id);
  const removeMember = useRemoveMember(workspaceId, channel.id);
  const canEdit = channel.createdById === currentUserId || isAdmin;

  const memberIds = useMemo(
    () => new Set(members.map((m) => m.userId)),
    [members],
  );

  const addableMembers = useMemo(() => {
    const search = memberSearch.toLowerCase();
    return workspaceMembers.filter(
      (wm) =>
        !memberIds.has(wm.id) &&
        (wm.displayName.toLowerCase().includes(search) ||
          wm.email.toLowerCase().includes(search)),
    );
  }, [workspaceMembers, memberIds, memberSearch]);

  useEffect(() => {
    setName(channel.name ?? "");
    setDescription(channel.description ?? "");
  }, [channel]);

  useEffect(() => {
    if (!open) setMemberSearch("");
  }, [open]);

  const handleSave = (e: React.FormEvent) => {
    e.preventDefault();
    updateChannel.mutate(
      { name: name.trim() || undefined, description: description.trim() || undefined },
      {
        onSuccess: () => {
          toast.success("Channel updated");
          onClose();
        },
        onError: (err) => toast.error(err.message),
      },
    );
  };

  const handleDelete = () => {
    deleteChannel.mutate(undefined, {
      onSuccess: () => {
        toast.success("Channel deleted");
        onClose();
        onDeleted?.();
      },
      onError: (err) => toast.error(err.message),
    });
  };

  const handleAddMember = (userId: string) => {
    addMembers.mutate(
      { userIds: [userId] },
      {
        onSuccess: () => toast.success("Member added"),
        onError: (err) => toast.error(err.message),
      },
    );
  };

  return (
    <>
      <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
        <DialogContent className="sm:max-w-lg max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Channel settings</DialogTitle>
          </DialogHeader>

          <form onSubmit={handleSave}>
            <div className="space-y-4 mt-2">
              <div className="space-y-2">
                <Label htmlFor="edit-name">Name</Label>
                <Input
                  id="edit-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  disabled={!canEdit}
                  maxLength={100}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="edit-desc">Description</Label>
                <Textarea
                  id="edit-desc"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  disabled={!canEdit}
                  maxLength={500}
                  className="min-h-[60px] resize-none"
                />
              </div>
            </div>

            {/* Members */}
            <div className="mt-6">
              <Label>Members ({channel._count?.members ?? members.length})</Label>
              <div className="mt-2 space-y-1 max-h-40 overflow-y-auto">
                {members.map((m) => (
                  <div key={m.id} className="flex items-center gap-2 py-1 px-1">
                    <UserAvatar
                      displayName={m.user.displayName}
                      avatarUrl={m.user.avatarUrl}
                      size="sm"
                    />
                    <span className="text-sm flex-1 truncate">
                      {m.user.displayName}
                    </span>
                    {canEdit && m.userId !== currentUserId && (
                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        className="h-6 w-6 text-destructive hover:text-destructive"
                        onClick={() => removeMember.mutate(m.userId)}
                      >
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    )}
                  </div>
                ))}
                {hasMoreMembers && (
                  <LoadMoreButton
                    className="px-1"
                    label="Load more members"
                    loading={loadingMoreMembers}
                    onClick={() => void loadMoreMembers()}
                  />
                )}
              </div>
            </div>

            {/* Add members */}
            {canEdit && (
              <div className="mt-4">
                <Label htmlFor="add-member-search">Add members</Label>
                <Input
                  id="add-member-search"
                  placeholder="Search by name or email..."
                  value={memberSearch}
                  onChange={(e) => setMemberSearch(e.target.value)}
                  className="mt-2"
                />
                {memberSearch && (
                  <div className="mt-1 max-h-32 overflow-y-auto rounded-md border">
                    {addableMembers.length === 0 ? (
                      <p className="px-3 py-2 text-sm text-muted-foreground">
                        No matching members
                      </p>
                    ) : (
                      addableMembers.map((wm) => (
                        <button
                          key={wm.id}
                          type="button"
                          className="flex w-full items-center gap-2 px-3 py-2 text-sm hover:bg-accent transition-colors"
                          onClick={() => {
                            handleAddMember(wm.id);
                            setMemberSearch("");
                          }}
                        >
                          <UserAvatar
                            displayName={wm.displayName}
                            avatarUrl={wm.avatarUrl}
                            size="sm"
                          />
                          <span className="truncate">{wm.displayName}</span>
                          <span className="text-xs text-muted-foreground truncate">
                            {wm.email}
                          </span>
                          <UserPlus className="h-3.5 w-3.5 ml-auto shrink-0 text-muted-foreground" />
                        </button>
                      ))
                    )}
                  </div>
                )}
              </div>
            )}

            <DialogFooter className="mt-6">
              {canEdit && (
                <div className="flex gap-2 mr-auto">
                  <Button
                    type="button"
                    variant="destructive"
                    onClick={() => setConfirmDelete(true)}
                  >
                    Delete
                  </Button>
                  {onArchive && (
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => onArchive(!isArchived)}
                    >
                      {isArchived ? "Unarchive" : "Archive"}
                    </Button>
                  )}
                </div>
              )}
              <Button type="button" variant="outline" onClick={onClose}>
                Cancel
              </Button>
              {canEdit && (
                <Button type="submit" disabled={updateChannel.isPending}>
                  {updateChannel.isPending ? "Saving..." : "Save"}
                </Button>
              )}
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        onConfirm={handleDelete}
        title="Delete channel?"
        description="This will permanently delete the channel and all its messages."
        confirmLabel="Delete"
        variant="destructive"
        loading={deleteChannel.isPending}
      />
    </>
  );
}
