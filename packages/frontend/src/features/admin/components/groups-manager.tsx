import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { UserAvatar } from "@/components/shared/user-avatar";
import { useWorkspaceMembers } from "@/features/workspaces/api";
import {
  useGroups,
  useGroup,
  useCreateGroup,
  useUpdateGroup,
  useDeleteGroup,
  useAddGroupMember,
  useRemoveGroupMember,
  type GroupSummary,
} from "../api";
import { toast } from "sonner";
import { Loader2, Plus, Pencil, Trash2, X, Users, ChevronRight } from "lucide-react";

interface GroupsManagerProps {
  workspaceId: string;
}

export function GroupsManager({ workspaceId }: GroupsManagerProps) {
  const { data: groupsData, isLoading } = useGroups(workspaceId);
  const groups = groupsData?.data ?? [];

  const [createOpen, setCreateOpen] = useState(false);
  const [editGroup, setEditGroup] = useState<GroupSummary | null>(null);
  const [detailGroupId, setDetailGroupId] = useState<string | null>(null);

  if (isLoading) {
    return (
      <div className="flex justify-center py-8">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Groups ({groups.length})</h2>
        <Button size="sm" onClick={() => setCreateOpen(true)}>
          <Plus className="mr-1.5 h-4 w-4" />
          Create Group
        </Button>
      </div>

      {groups.length === 0 ? (
        <p className="text-sm text-muted-foreground py-4 text-center border rounded-md">
          No groups yet. Create one to manage team access.
        </p>
      ) : (
        <div className="border rounded-md divide-y">
          {groups.map((g) => (
            <div
              key={g.id}
              className="flex items-center gap-3 px-4 py-3 hover:bg-accent/50 transition-colors cursor-pointer"
              onClick={() => setDetailGroupId(g.id)}
            >
              <div
                className="h-3 w-3 rounded-full shrink-0"
                style={{ backgroundColor: g.color ?? "#6366f1" }}
              />
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium truncate">{g.name}</div>
                {g.description && (
                  <div className="text-xs text-muted-foreground truncate">
                    {g.description}
                  </div>
                )}
              </div>
              <div className="flex items-center gap-1 text-xs text-muted-foreground">
                <Users className="h-3.5 w-3.5" />
                {g._count.members}
              </div>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setEditGroup(g);
                }}
                className="rounded p-1 hover:bg-accent transition-colors text-muted-foreground"
                title="Edit group"
              >
                <Pencil className="h-3.5 w-3.5" />
              </button>
              <ChevronRight className="h-4 w-4 text-muted-foreground" />
            </div>
          ))}
        </div>
      )}

      <CreateGroupDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        workspaceId={workspaceId}
      />

      {editGroup && (
        <EditGroupDialog
          open
          onClose={() => setEditGroup(null)}
          workspaceId={workspaceId}
          group={editGroup}
        />
      )}

      {detailGroupId && (
        <GroupDetailDialog
          open
          onClose={() => setDetailGroupId(null)}
          workspaceId={workspaceId}
          groupId={detailGroupId}
        />
      )}
    </div>
  );
}

// ─── Create Group Dialog ───

function CreateGroupDialog({
  open,
  onClose,
  workspaceId,
}: {
  open: boolean;
  onClose: () => void;
  workspaceId: string;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [color, setColor] = useState("#6366f1");

  const createGroup = useCreateGroup(workspaceId);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    createGroup.mutate(
      {
        name,
        description: description || undefined,
        color,
      },
      {
        onSuccess: () => {
          toast.success("Group created");
          setName("");
          setDescription("");
          setColor("#6366f1");
          onClose();
        },
        onError: (err) => toast.error(err.message),
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Create Group</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="group-name">Name</Label>
            <Input
              id="group-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Engineering"
              required
              maxLength={100}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="group-desc">Description</Label>
            <Input
              id="group-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optional description"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="group-color">Color</Label>
            <div className="flex items-center gap-2">
              <input
                id="group-color"
                type="color"
                value={color}
                onChange={(e) => setColor(e.target.value)}
                className="h-9 w-9 rounded border cursor-pointer"
              />
              <Input
                aria-label="Color hex value"
                value={color}
                onChange={(e) => setColor(e.target.value)}
                className="flex-1"
                maxLength={7}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" type="button" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={createGroup.isPending}>
              {createGroup.isPending ? "Creating..." : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ─── Edit Group Dialog ───

function EditGroupDialog({
  open,
  onClose,
  workspaceId,
  group,
}: {
  open: boolean;
  onClose: () => void;
  workspaceId: string;
  group: GroupSummary;
}) {
  const [name, setName] = useState(group.name);
  const [description, setDescription] = useState(group.description ?? "");
  const [color, setColor] = useState(group.color ?? "#6366f1");

  const updateGroup = useUpdateGroup(workspaceId);
  const deleteGroup = useDeleteGroup(workspaceId);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    updateGroup.mutate(
      {
        gid: group.id,
        name,
        description: description || null,
        color,
      },
      {
        onSuccess: () => {
          toast.success("Group updated");
          onClose();
        },
        onError: (err) => toast.error(err.message),
      },
    );
  };

  const handleDelete = () => {
    if (!confirm(`Delete group "${group.name}"? This cannot be undone.`)) return;
    deleteGroup.mutate(group.id, {
      onSuccess: () => {
        toast.success("Group deleted");
        onClose();
      },
      onError: (err) => toast.error(err.message),
    });
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Edit Group</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="edit-group-name">Name</Label>
            <Input
              id="edit-group-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              maxLength={100}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="edit-group-desc">Description</Label>
            <Input
              id="edit-group-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="edit-group-color">Color</Label>
            <div className="flex items-center gap-2">
              <input
                id="edit-group-color"
                type="color"
                value={color}
                onChange={(e) => setColor(e.target.value)}
                className="h-9 w-9 rounded border cursor-pointer"
              />
              <Input
                aria-label="Color hex value"
                value={color}
                onChange={(e) => setColor(e.target.value)}
                className="flex-1"
                maxLength={7}
              />
            </div>
          </div>
          <DialogFooter className="flex justify-between">
            <Button
              type="button"
              variant="destructive"
              size="sm"
              onClick={handleDelete}
              disabled={deleteGroup.isPending}
            >
              <Trash2 className="mr-1.5 h-3.5 w-3.5" />
              Delete
            </Button>
            <div className="flex gap-2">
              <Button variant="outline" type="button" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" disabled={updateGroup.isPending}>
                {updateGroup.isPending ? "Saving..." : "Save"}
              </Button>
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ─── Group Detail Dialog ───

function GroupDetailDialog({
  open,
  onClose,
  workspaceId,
  groupId,
}: {
  open: boolean;
  onClose: () => void;
  workspaceId: string;
  groupId: string;
}) {
  const [showAddPicker, setShowAddPicker] = useState(false);

  const { data: groupData, isLoading } = useGroup(workspaceId, groupId);
  const group = groupData?.data;

  const { data: wsData } = useWorkspaceMembers(workspaceId);
  const allMembers = wsData?.data ?? [];

  const addMember = useAddGroupMember(workspaceId, groupId);
  const removeMember = useRemoveGroupMember(workspaceId, groupId);

  const currentMemberIds = new Set(group?.members.map((m) => m.userId) ?? []);
  const availableMembers = allMembers.filter(
    (m) => !currentMemberIds.has(m.user.id),
  );

  const handleAdd = (userId: string) => {
    addMember.mutate(userId, {
      onSuccess: () => {
        toast.success("Member added to group");
        setShowAddPicker(false);
      },
      onError: (err) => toast.error(err.message),
    });
  };

  const handleRemove = (userId: string) => {
    removeMember.mutate(userId, {
      onSuccess: () => toast.success("Member removed from group"),
      onError: (err) => toast.error(err.message),
    });
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {group && (
              <div
                className="h-3 w-3 rounded-full"
                style={{ backgroundColor: group.color ?? "#6366f1" }}
              />
            )}
            {group?.name ?? "Group"}
          </DialogTitle>
        </DialogHeader>

        {isLoading ? (
          <div className="flex justify-center py-6">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="space-y-4">
            {group?.description && (
              <p className="text-sm text-muted-foreground">
                {group.description}
              </p>
            )}

            {/* Team Folders */}
            {group?.teamFolderGroups && group.teamFolderGroups.length > 0 && (
              <div>
                <div className="text-xs font-medium text-muted-foreground mb-1">
                  Assigned Team Folders
                </div>
                <div className="flex flex-wrap gap-1">
                  {group.teamFolderGroups.map((tfg) => (
                    <span
                      key={tfg.id}
                      className="inline-flex items-center rounded-md bg-accent px-2 py-0.5 text-xs"
                    >
                      {tfg.teamFolder.name}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* Members */}
            <div>
              <div className="text-xs font-medium text-muted-foreground mb-2">
                Members ({group?.members.length ?? 0})
              </div>
              <div className="max-h-60 overflow-y-auto border rounded-md">
                {group?.members.length === 0 ? (
                  <p className="px-3 py-4 text-sm text-muted-foreground text-center">
                    No members yet
                  </p>
                ) : (
                  group?.members.map((m) => (
                    <div
                      key={m.userId}
                      className="flex items-center gap-2 px-3 py-2 hover:bg-accent/50 transition-colors"
                    >
                      <UserAvatar
                        displayName={m.user.displayName}
                        avatarUrl={m.user.avatarUrl}
                        size="sm"
                      />
                      <div className="flex-1 min-w-0">
                        <div className="text-sm truncate">
                          {m.user.displayName}
                        </div>
                        <div className="text-xs text-muted-foreground truncate">
                          {m.user.email}
                        </div>
                      </div>
                      <button
                        onClick={() => handleRemove(m.userId)}
                        className="rounded p-1 hover:bg-accent transition-colors text-muted-foreground hover:text-destructive"
                        title="Remove member"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ))
                )}
              </div>
            </div>

            {/* Add member */}
            {showAddPicker ? (
              <div className="border rounded-md">
                <div className="px-3 py-2 border-b text-xs font-medium text-muted-foreground">
                  Add a member
                </div>
                <div className="max-h-48 overflow-y-auto">
                  {availableMembers.length === 0 ? (
                    <p className="px-3 py-4 text-sm text-muted-foreground text-center">
                      All workspace members are already in this group
                    </p>
                  ) : (
                    availableMembers.map((m) => (
                      <button
                        key={m.user.id}
                        onClick={() => handleAdd(m.user.id)}
                        disabled={addMember.isPending}
                        className="flex w-full items-center gap-2 px-3 py-2 text-sm hover:bg-accent transition-colors text-left disabled:opacity-50"
                      >
                        <UserAvatar
                          displayName={m.user.displayName}
                          avatarUrl={m.user.avatarUrl}
                          size="sm"
                        />
                        <div className="flex-1 min-w-0">
                          <div className="truncate">{m.user.displayName}</div>
                          <div className="text-xs text-muted-foreground truncate">
                            {m.user.email}
                          </div>
                        </div>
                        <Plus className="h-4 w-4 text-muted-foreground shrink-0" />
                      </button>
                    ))
                  )}
                </div>
                <div className="px-3 py-2 border-t">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setShowAddPicker(false)}
                  >
                    Done
                  </Button>
                </div>
              </div>
            ) : (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowAddPicker(true)}
                className="w-full"
              >
                <Plus className="mr-1.5 h-4 w-4" />
                Add Member
              </Button>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
