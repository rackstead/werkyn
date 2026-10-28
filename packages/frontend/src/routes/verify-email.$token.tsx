import { createFileRoute, Link } from "@tanstack/react-router";
import { useVerifyEmail } from "@/features/auth/api";
import { useEffect } from "react";
import { z } from "zod";
import { Button } from "@/components/ui/button";

// The only continuation is the fixed invite route for an invitation token;
// malformed values are ignored rather than used as a redirect target.
const searchSchema = z.object({
  invite: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,200}$/)
    .optional()
    .catch(undefined),
});

export const Route = createFileRoute("/verify-email/$token")({
  validateSearch: searchSchema,
  component: VerifyEmailPage,
});

function VerifyEmailPage() {
  const { token } = Route.useParams();
  const { invite } = Route.useSearch();
  const verifyEmail = useVerifyEmail();

  useEffect(() => {
    verifyEmail.mutate({ token });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const continueToInvite = invite ? (
    <Button asChild>
      <Link to="/invite/$token" params={{ token: invite }}>
        Continue to invitation
      </Link>
    </Button>
  ) : null;

  if (verifyEmail.isPending) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="text-center space-y-3">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent mx-auto" />
          <p className="text-sm text-muted-foreground">
            Verifying your email...
          </p>
        </div>
      </div>
    );
  }

  if (verifyEmail.isError) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="text-center space-y-3">
          <h1 className="text-2xl font-bold">Verification failed</h1>
          <p className="text-sm text-muted-foreground">
            This link may be expired or invalid.
            {invite && " You can request a new link from the invitation."}
          </p>
          <div className="flex justify-center gap-2">
            {continueToInvite}
            <Button asChild variant={invite ? "outline" : "default"}>
              <Link to="/">Go to dashboard</Link>
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center">
      <div className="text-center space-y-3">
        <h1 className="text-2xl font-bold">Email verified</h1>
        <p className="text-sm text-muted-foreground">
          Your email has been verified successfully.
          {invite &&
            " Continue to the invitation and sign in with the verified account to join."}
        </p>
        <div className="flex justify-center gap-2">
          {continueToInvite}
          <Button asChild variant={invite ? "outline" : "default"}>
            <Link to="/">Go to dashboard</Link>
          </Button>
        </div>
      </div>
    </div>
  );
}
