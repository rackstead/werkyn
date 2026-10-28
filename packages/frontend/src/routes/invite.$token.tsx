import { createFileRoute, Link } from "@tanstack/react-router";
import {
  useInviteDetails,
  useAcceptInvite,
  useCheckInviteAdmission,
  useInviteAdmission,
} from "@/features/workspaces/api";
import { useResendVerification } from "@/features/auth/api";
import { useAuthStore } from "@/stores/auth-store";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ApiError } from "@/lib/api-client";

export const Route = createFileRoute("/invite/$token")({
  component: InvitePage,
});

function InvitePage() {
  const { token } = Route.useParams();
  const user = useAuthStore((s) => s.user);
  const { data, isLoading, isError, error } = useInviteDetails(token);
  const acceptInvite = useAcceptInvite();
  const checkAdmission = useCheckInviteAdmission();
  const admission = useInviteAdmission(token);
  const resend = useResendVerification(token);

  const invite = data?.data;

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center p-4">
        <Card className="w-full max-w-md">
          <CardContent className="py-8">
            <div className="space-y-3 animate-pulse">
              <div className="h-6 w-48 bg-muted rounded mx-auto" />
              <div className="h-4 w-32 bg-muted rounded mx-auto" />
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Accepting is a join attempt (it may create a join request); checking only
  // reports the current state and never creates or revives a request.
  const accept = () => {
    checkAdmission.reset();
    acceptInvite.mutate(token);
  };
  const check = () => {
    acceptInvite.reset();
    checkAdmission.mutate(token);
  };
  const busy = acceptInvite.isPending || checkAdmission.isPending;
  const failed = acceptInvite.isError
    ? acceptInvite.error
    : checkAdmission.isError
      ? checkAdmission.error
      : null;
  const acceptError = failed ? (
    <p role="alert" className="text-sm text-center text-destructive">
      {failed instanceof ApiError ? failed.message : "Failed to accept invite"}
    </p>
  ) : null;
  const goHome = (
    <Link to="/" className="block">
      <Button variant="outline" className="w-full">
        Go home
      </Button>
    </Link>
  );

  let signedInContent;
  if (admission?.status === "verification_required") {
    signedInContent = (
      <>
        <p className="text-sm text-center">
          Verify <span className="font-medium">{admission.email}</span> to join.
          Open the verification link we emailed you, then continue here.
        </p>
        <Button className="w-full" onClick={accept} disabled={busy}>
          {acceptInvite.isPending ? "Checking..." : "I've verified my email"}
        </Button>
        <Button
          variant="outline"
          className="w-full"
          onClick={() => resend.mutate()}
          disabled={resend.isPending}
        >
          {resend.isPending ? "Sending..." : "Resend verification email"}
        </Button>
        {acceptError}
      </>
    );
  } else if (admission?.status === "approval_pending") {
    signedInContent = (
      <>
        <p className="text-sm text-center">
          Your request to join{" "}
          <span className="font-medium">{admission.workspace.name}</span> is
          waiting for an administrator&apos;s approval. You&apos;ll have access
          once it is approved.
        </p>
        <Button className="w-full" onClick={check} disabled={busy}>
          {checkAdmission.isPending ? "Checking..." : "Check status"}
        </Button>
        {acceptError}
        {goHome}
      </>
    );
  } else if (admission?.status === "not_pending") {
    signedInContent = (
      <>
        <p className="text-sm text-center">
          Your request to join{" "}
          <span className="font-medium">{admission.workspace.name}</span> is no
          longer pending. An administrator may have declined it. You can ask
          again.
        </p>
        <Button className="w-full" onClick={accept} disabled={busy}>
          {acceptInvite.isPending ? "Sending..." : "Ask again"}
        </Button>
        {acceptError}
        {goHome}
      </>
    );
  } else if (admission?.status === "ready") {
    signedInContent = (
      <>
        <p className="text-sm text-center">
          You can join{" "}
          <span className="font-medium">{admission.workspace.name}</span> now.
          Administrator approval is not required.
        </p>
        <Button className="w-full" onClick={accept} disabled={busy}>
          {acceptInvite.isPending ? "Joining..." : "Join now"}
        </Button>
        {acceptError}
        {goHome}
      </>
    );
  } else if (
    admission?.status === "denied" ||
    admission?.status === "unavailable"
  ) {
    signedInContent = (
      <>
        <p role="alert" className="text-sm text-center text-destructive">
          {admission.message}
        </p>
        {/* Policy, capacity or the invitation may have changed since. */}
        <Button className="w-full" onClick={accept} disabled={busy}>
          {acceptInvite.isPending ? "Checking..." : "Try again"}
        </Button>
        {acceptError}
        {goHome}
      </>
    );
  } else {
    signedInContent = (
      <>
        <Button className="w-full" onClick={accept} disabled={busy}>
          {acceptInvite.isPending ? "Joining..." : "Accept invite"}
        </Button>
        {acceptError}
      </>
    );
  }

  if (isError) {
    const apiError = error instanceof ApiError ? error : null;
    const isExpired = apiError?.statusCode === 410;

    return (
      <div className="flex min-h-screen items-center justify-center p-4">
        <Card className="w-full max-w-md">
          <CardHeader className="text-center">
            <CardTitle className="text-xl">
              {isExpired ? "Invite expired" : "Invalid invite"}
            </CardTitle>
            <CardDescription>
              {isExpired
                ? "This invite link has expired or reached its usage limit."
                : "This invite link is invalid or has been revoked."}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4 text-center">
            {user ? (
              // The public preview cannot know the signed-in account. Show any
              // remembered result, and let the server answer for this account
              // (for example, an existing member is still admitted).
              admission ? (
                signedInContent
              ) : (
                <>
                  <Button className="w-full" onClick={check} disabled={busy}>
                    {checkAdmission.isPending ? "Checking..." : "Check my access"}
                  </Button>
                  {acceptError}
                  {goHome}
                </>
              )
            ) : (
              <Link to="/">
                <Button variant="outline">Go home</Button>
              </Link>
            )}
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!invite) return null;

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <CardTitle className="text-xl">
            Join {invite.workspace.name}
          </CardTitle>
          <CardDescription>
            You&apos;ve been invited to join as{" "}
            <span className="font-medium">{invite.role.toLowerCase()}</span>
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {user ? (
            <>
              <p className="text-sm text-center text-muted-foreground">
                Signed in as {user.email}
              </p>
              {signedInContent}
            </>
          ) : (
            <div className="space-y-2">
              <Link
                to="/login"
                search={{ inviteToken: token }}
                className="block"
              >
                <Button className="w-full">Log in to accept</Button>
              </Link>
              <Link
                to="/register"
                search={{ inviteToken: token }}
                className="block"
              >
                <Button variant="outline" className="w-full">
                  Create an account
                </Button>
              </Link>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
