import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { LoginForm } from "@/features/auth/components/login-form";
import { RegisterForm } from "@/features/auth/components/register-form";
import { SsoButtons } from "@/features/auth/components/sso-buttons";
import { useSsoInfo } from "@/features/auth/api";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

const loginSearchSchema = z.object({
  inviteToken: z.string().optional(),
  sso_error: z.string().optional(),
});

export const Route = createFileRoute("/login")({
  validateSearch: loginSearchSchema,
  component: LoginPage,
});

function LoginPage() {
  const { inviteToken, sso_error } = Route.useSearch();
  const { data: ssoInfo } = useSsoInfo();

  const ssoEnabled = ssoInfo?.data.enabled && ssoInfo.data.connectors.length > 0;
  const passwordEnabled = ssoInfo?.data.passwordLoginEnabled ?? true;
  const hasUsers = ssoInfo?.data.hasUsers ?? true;

  // First-user setup: show registration form
  const isFirstUserSetup = ssoInfo !== undefined && !hasUsers;

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <div className="w-full max-w-md space-y-8">
        <div className="flex justify-center">
          <img
            src="/werkyn_logo.svg"
            alt="Werkyn"
            className="h-10 w-auto dark:brightness-0 dark:invert"
          />
        </div>
        <Card>
          <CardHeader className="text-center">
            <CardTitle className="text-2xl font-heading">
              {isFirstUserSetup ? "Create Admin Account" : "Welcome back"}
            </CardTitle>
          <CardDescription>
            {isFirstUserSetup
              ? "Set up the first account for your Werkyn instance"
              : inviteToken
                ? "Sign in to accept your workspace invite"
                : "Sign in to your account"}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {sso_error && (
            <p className="text-sm text-destructive text-center">
              {sso_error}
            </p>
          )}

          {isFirstUserSetup ? (
            <RegisterForm inviteToken={inviteToken} />
          ) : (
            <>
              {ssoEnabled && (
                <SsoButtons
                  connectors={ssoInfo!.data.connectors}
                  // Existing sanitized OIDC return flow back to the invitation.
                  returnUrl={
                    inviteToken
                      ? `/invite/${encodeURIComponent(inviteToken)}`
                      : undefined
                  }
                />
              )}

              {ssoEnabled && passwordEnabled && (
                <div className="relative">
                  <div className="absolute inset-0 flex items-center">
                    <span className="w-full border-t" />
                  </div>
                  <div className="relative flex justify-center text-xs uppercase">
                    <span className="bg-card px-2 text-muted-foreground">
                      Or continue with email
                    </span>
                  </div>
                </div>
              )}

              {passwordEnabled ? (
                <LoginForm inviteToken={inviteToken} />
              ) : ssoEnabled ? (
                <p className="text-center text-sm text-muted-foreground">
                  Password login is disabled. Use SSO to sign in.
                </p>
              ) : (
                <LoginForm inviteToken={inviteToken} />
              )}
            </>
          )}
        </CardContent>
        </Card>
      </div>
    </div>
  );
}
