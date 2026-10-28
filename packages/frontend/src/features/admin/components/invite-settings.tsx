import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  useWorkspaceInvites,
  useRevokeInvite,
} from "@/features/workspaces/api";
import { InviteDialog } from "@/features/workspaces/components/invite-dialog";
import { AdmissionRequests } from "./admission-requests";
import { Loader2, Plus, Trash2, Copy, Check } from "lucide-react";
import { toast } from "sonner";

interface InviteSettingsProps {
  workspaceId: string;
}

export function InviteSettings({ workspaceId }: InviteSettingsProps) {
  const { data, isLoading } = useWorkspaceInvites(workspaceId);
  const invites = data?.data ?? [];

  const revokeInvite = useRevokeInvite(workspaceId);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const handleRevoke = (inviteId: string) => {
    if (!confirm("Revoke this invite?")) return;
    revokeInvite.mutate(inviteId, {
      onError: (err) => toast.error(err.message),
    });
  };

  const handleCopyLink = async (token: string, inviteId: string) => {
    const link = `${window.location.origin}/invite/${token}`;
    await navigator.clipboard.writeText(link);
    setCopiedId(inviteId);
    toast.success("Link copied");
    setTimeout(() => setCopiedId(null), 2000);
  };

  if (isLoading) {
    return (
      <div className="flex justify-center py-8">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <AdmissionRequests workspaceId={workspaceId} />

      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">
          Invites ({invites.length})
        </h2>
        <Button size="sm" onClick={() => setInviteOpen(true)}>
          <Plus className="mr-1.5 h-4 w-4" />
          Create Invite
        </Button>
      </div>

      {invites.length === 0 ? (
        <p className="text-sm text-muted-foreground py-4 text-center border rounded-md">
          No active invites
        </p>
      ) : (
        <div className="border rounded-md divide-y">
          {invites.map((inv) => (
            <div
              key={inv.id}
              className="flex items-center gap-3 px-4 py-3"
            >
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium truncate">
                  {inv.email || "Open invite (any email)"}
                </div>
                <div className="text-xs text-muted-foreground">
                  Role: {inv.role}
                  {inv.maxUses !== null &&
                    ` · Uses: ${inv.useCount}/${inv.maxUses}`}
                  {inv.expiresAt &&
                    ` · Expires: ${new Date(inv.expiresAt).toLocaleDateString()}`}
                </div>
              </div>
              <button
                onClick={() => handleCopyLink(inv.token, inv.id)}
                className="rounded p-1.5 hover:bg-accent transition-colors text-muted-foreground"
                title="Copy invite link"
              >
                {copiedId === inv.id ? (
                  <Check className="h-4 w-4" />
                ) : (
                  <Copy className="h-4 w-4" />
                )}
              </button>
              <button
                onClick={() => handleRevoke(inv.id)}
                className="rounded p-1.5 hover:bg-accent transition-colors text-muted-foreground hover:text-destructive"
                title="Revoke invite"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          ))}
        </div>
      )}

      <InviteDialog
        open={inviteOpen}
        onClose={() => setInviteOpen(false)}
        workspaceId={workspaceId}
      />
    </div>
  );
}
