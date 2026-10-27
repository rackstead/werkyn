import { useState } from "react";
import { DollarSign } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogTrigger,
} from "@/components/ui/dialog";
import { UserAvatar } from "@/components/shared/user-avatar";
import { useWorkspaceMembers } from "@/features/workspaces/api";
import { useUserRates, useSetUserRate, type UserRate } from "../api";
import { formatMoney } from "../money";

interface RateManagementDialogProps {
  workspaceId: string;
}

export function RateManagementDialog({
  workspaceId,
}: RateManagementDialogProps) {
  const [open, setOpen] = useState(false);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          <DollarSign className="h-4 w-4 mr-1" />
          Manage Rates
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Hourly Rates</DialogTitle>
          <DialogDescription>
            Set hourly rates for team members. Time reports price each entry at
            the rate in effect on its date.
          </DialogDescription>
        </DialogHeader>
        {open && <RatesList workspaceId={workspaceId} />}
      </DialogContent>
    </Dialog>
  );
}

function RatesList({ workspaceId }: { workspaceId: string }) {
  const { data: membersData } = useWorkspaceMembers(workspaceId);
  const { data: rates = [] } = useUserRates(workspaceId);
  const members = membersData?.data ?? [];

  const rateMap = new Map<string, UserRate>();
  for (const rate of rates) {
    const existing = rateMap.get(rate.userId);
    if (!existing || rate.effectiveFrom > existing.effectiveFrom) {
      rateMap.set(rate.userId, rate);
    }
  }

  if (members.length === 0) {
    return (
      <div className="py-6 text-center text-sm text-muted-foreground">
        No members found.
      </div>
    );
  }

  return (
    <div className="space-y-1 max-h-80 overflow-y-auto">
      {members.map((member) => (
        <MemberRateRow
          key={member.id}
          workspaceId={workspaceId}
          userId={member.user.id}
          displayName={member.user.displayName}
          avatarUrl={member.user.avatarUrl}
          role={member.role}
          currentRate={rateMap.get(member.user.id)}
        />
      ))}
    </div>
  );
}

function MemberRateRow({
  workspaceId,
  userId,
  displayName,
  avatarUrl,
  role,
  currentRate,
}: {
  workspaceId: string;
  userId: string;
  displayName: string;
  avatarUrl: string | null;
  role: string;
  currentRate?: UserRate;
}) {
  const setRateMutation = useSetUserRate(workspaceId);
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");

  function startEdit() {
    setValue(currentRate ? String(currentRate.rate) : "");
    setEditing(true);
  }

  function handleSave() {
    const parsed = parseFloat(value);
    if (isNaN(parsed) || parsed < 0) {
      setEditing(false);
      return;
    }
    if (parsed === (currentRate?.rate ?? 0)) {
      setEditing(false);
      return;
    }
    setRateMutation.mutate(
      { userId, data: { rate: parsed } },
      { onSuccess: () => setEditing(false) },
    );
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter") handleSave();
    if (e.key === "Escape") setEditing(false);
  }

  return (
    <div className="flex items-center gap-3 px-2 py-2 rounded-md hover:bg-accent/50 transition-colors">
      <UserAvatar
        displayName={displayName}
        avatarUrl={avatarUrl}
        size="sm"
      />
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium truncate">{displayName}</div>
        <div className="text-xs text-muted-foreground">{role}</div>
      </div>
      <div className="flex items-center gap-1.5">
        {editing ? (
          <>
            <div className="flex items-center">
              <span className="text-sm text-muted-foreground mr-1">
                {currentRate?.currency ?? "USD"}
              </span>
              <Input
                type="number"
                min="0"
                step="0.01"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                onKeyDown={handleKeyDown}
                onBlur={handleSave}
                autoFocus
                className="h-7 w-20 text-sm"
              />
            </div>
            <span className="text-xs text-muted-foreground">/hr</span>
          </>
        ) : (
          <button
            type="button"
            onClick={startEdit}
            className="flex items-center gap-1 px-2 py-1 rounded-md text-sm hover:bg-accent transition-colors cursor-pointer"
          >
            <span className="font-medium">
              {currentRate && currentRate.rate > 0
                ? `${formatMoney(currentRate.rate, currentRate.currency)}/hr`
                : "Set rate"}
            </span>
            {(!currentRate || currentRate.rate === 0) && (
              <span className="text-xs text-muted-foreground">–</span>
            )}
          </button>
        )}
      </div>
    </div>
  );
}
