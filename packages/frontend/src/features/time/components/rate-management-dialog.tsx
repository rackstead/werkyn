import { useId, useRef, useState } from "react";
import { SetUserRateSchema } from "@pm/shared";
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

  // The rate in force today: a future-dated rate is not yet current. Today is
  // the UTC date, which the server uses as the default effectiveFrom.
  const today = new Date().toISOString().slice(0, 10);
  const rateMap = new Map<string, UserRate>();
  for (const rate of rates) {
    if (rate.effectiveFrom > today) continue;
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
          key={`${workspaceId}:${member.id}:${member.user.id}`}
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
  const [currency, setCurrency] = useState("USD");
  const [opening, setOpening] = useState<{ rate: number; currency: string }>();
  const [error, setError] = useState("");
  const submitting = useRef(false);
  const inputId = useId();

  function startEdit() {
    setValue(currentRate ? String(currentRate.rate) : "");
    setCurrency(currentRate?.currency ?? "USD");
    setOpening(currentRate
      ? { rate: currentRate.rate, currency: currentRate.currency }
      : undefined);
    setError("");
    setEditing(true);
  }

  function handleSave(event: React.FormEvent) {
    event.preventDefault();
    if (submitting.current || setRateMutation.isPending) return;
    const parsed = SetUserRateSchema.safeParse({
      rate: value === "" ? NaN : Number(value),
      currency,
    });
    if (!parsed.success) {
      setError(parsed.error.issues.some((issue) => issue.path[0] === "currency")
        ? "Currency must contain exactly three letters."
        : "Enter a finite rate between 0 and 1,000,000,000.");
      return;
    }
    const currencyChanged = parsed.data.currency !== (opening?.currency ?? "USD");
    if (opening && parsed.data.rate === opening.rate && !currencyChanged) {
      setEditing(false);
      return;
    }
    setError("");
    submitting.current = true;
    setRateMutation.mutate(
      {
        userId,
        data: {
          rate: parsed.data.rate,
          ...(currencyChanged ? { currency: parsed.data.currency } : {}),
        },
      },
      {
        onSuccess: () => setEditing(false),
        onError: () => setError("Failed to save the rate. Please try again."),
        onSettled: () => { submitting.current = false; },
      },
    );
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (!submitting.current && !setRateMutation.isPending) setEditing(false);
    }
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
          <form
            aria-label={`Hourly rate for ${displayName}`}
            onSubmit={handleSave}
            onKeyDown={handleKeyDown}
            noValidate
            className="flex flex-wrap items-center justify-end gap-1.5"
          >
            <div>
              <label htmlFor={`${inputId}-amount`} className="sr-only">Hourly rate</label>
              <Input
                id={`${inputId}-amount`}
                type="number"
                min="0"
                max="1000000000"
                step="any"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                disabled={setRateMutation.isPending}
                aria-invalid={!!error}
                aria-describedby={error ? `${inputId}-error` : undefined}
                autoFocus
                className="h-7 w-20 text-sm"
              />
            </div>
            <div>
              <label htmlFor={`${inputId}-currency`} className="sr-only">Currency</label>
              <Input
                id={`${inputId}-currency`}
                value={currency}
                onChange={(event) => setCurrency(event.target.value)}
                disabled={setRateMutation.isPending}
                aria-invalid={!!error}
                aria-describedby={error ? `${inputId}-error` : undefined}
                className="h-7 w-16 text-sm"
              />
            </div>
            <span className="text-xs text-muted-foreground">/hr</span>
            <Button type="submit" size="sm" disabled={setRateMutation.isPending}>
              {setRateMutation.isPending ? "Saving…" : "Save"}
            </Button>
            <Button type="button" size="sm" variant="outline" disabled={setRateMutation.isPending}
              onClick={() => setEditing(false)}>Cancel</Button>
            {error && <p id={`${inputId}-error`} role="alert" className="w-full text-sm text-destructive">{error}</p>}
          </form>
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
