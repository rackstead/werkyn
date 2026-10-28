import { Button } from "@/components/ui/button";
import {
  useAdmissionRequests,
  useApproveAdmissionRequest,
  useRejectAdmissionRequest,
} from "@/features/workspaces/api";
import { Loader2 } from "lucide-react";

interface AdmissionRequestsProps {
  workspaceId: string;
}

// Pending join requests created while the workspace requires admin approval.
// Approval is rechecked on the server against current policy and invitation.
export function AdmissionRequests({ workspaceId }: AdmissionRequestsProps) {
  const { data, isLoading, isError } = useAdmissionRequests(workspaceId);
  const approve = useApproveAdmissionRequest(workspaceId);
  const reject = useRejectAdmissionRequest(workspaceId);
  const requests = data?.data ?? [];
  const busy = approve.isPending || reject.isPending;

  // Refusals (for example a full workspace) surface through the app-wide
  // mutation error toast with the server's message.
  const decide = (
    mutation: typeof approve | typeof reject,
    requestId: string,
  ) => mutation.mutate(requestId);

  return (
    <section className="space-y-3" aria-labelledby="join-requests-heading">
      <h2 id="join-requests-heading" className="text-lg font-semibold">
        Join requests ({requests.length})
      </h2>
      {isLoading ? (
        <div className="flex justify-center py-4">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : isError ? (
        <p className="text-sm text-destructive py-2">
          Join requests could not be loaded.
        </p>
      ) : requests.length === 0 ? (
        <p className="text-sm text-muted-foreground py-4 text-center border rounded-md">
          No pending join requests
        </p>
      ) : (
        <ul className="border rounded-md divide-y">
          {requests.map((request) => (
            <li key={request.id} className="flex items-center gap-3 px-4 py-3">
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium truncate">
                  {request.user.displayName}{" "}
                  <span className="text-muted-foreground font-normal">
                    {request.user.email}
                  </span>
                </div>
                <div className="text-xs text-muted-foreground">
                  Invite role: {request.invite.role}
                  {request.user.emailVerified ? "" : " · Email not verified"}
                  {` · Requested ${new Date(request.createdAt).toLocaleDateString()}`}
                </div>
              </div>
              <Button
                size="sm"
                disabled={busy}
                onClick={() => decide(approve, request.id)}
                aria-label={`Approve ${request.user.email}`}
              >
                Approve
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => decide(reject, request.id)}
                aria-label={`Reject ${request.user.email}`}
              >
                Reject
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
