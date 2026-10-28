import { createFileRoute } from "@tanstack/react-router";
import { RegisterForm } from "@/features/auth/components/register-form";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { z } from "zod";

const searchSchema = z.object({
  inviteToken: z.string().optional(),
});

export const Route = createFileRoute("/register")({
  validateSearch: searchSchema,
  component: RegisterPage,
});

function RegisterPage() {
  const { inviteToken } = Route.useSearch();

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
            <CardTitle className="text-2xl font-heading">Create account</CardTitle>
            <CardDescription>
              {inviteToken
                ? "Create an account to accept your workspace invite"
                : "Sign up for a new account"}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <RegisterForm inviteToken={inviteToken} />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
