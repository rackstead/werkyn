import { useWorkspaceInvites, useRevokeInvite } from "../api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Copy, Trash2 } from "lucide-react";
import { toast } from "sonner";

interface InviteListProps {
  workspaceId: string;
}

export function InviteList({ workspaceId }: InviteListProps) {
  const { data, isLoading } = useWorkspaceInvites(workspaceId);
  const revokeInvite = useRevokeInvite(workspaceId);
  const invites = data?.data ?? [];

  if (isLoading) {
    return (
      <div className="space-y-2 animate-pulse">
        {Array.from({ length: 2 }).map((_, i) => (
          <div key={i} className="h-14 rounded-lg bg-muted" />
        ))}
      </div>
    );
  }

  if (invites.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">No active invites</p>
    );
  }

  const copyLink = async (token: string) => {
    await navigator.clipboard.writeText(
      `${window.location.origin}/invite/${token}`,
    );
    toast.success("Link copied");
  };

  return (
    <div className="space-y-2">
      {invites.map((invite) => (
        <div
          key={invite.id}
          className="flex items-center justify-between rounded-lg border px-3 py-2"
        >
          <div className="flex items-center gap-3 min-w-0">
            <Badge variant="outline" className="text-[10px] shrink-0">
              {invite.role}
            </Badge>
            {invite.email && (
              <span className="text-sm truncate">{invite.email}</span>
            )}
            <span className="text-xs text-muted-foreground">
              {invite.maxUses !== null
                ? `${invite.useCount}/${invite.maxUses} uses`
                : `${invite.useCount} uses`}
            </span>
            {invite.expiresAt && (
              <span className="text-xs text-muted-foreground">
                expires {new Date(invite.expiresAt).toLocaleDateString()}
              </span>
            )}
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => copyLink(invite.token)}
            >
              <Copy className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => revokeInvite.mutate(invite.id)}
              disabled={revokeInvite.isPending}
            >
              <Trash2 className="h-3.5 w-3.5 text-destructive" />
            </Button>
          </div>
        </div>
      ))}
    </div>
  );
}
