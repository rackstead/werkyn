import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { ForgotPasswordSchema, type ForgotPasswordInput } from "@pm/shared";
import { useForgotPassword } from "../api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Link } from "@tanstack/react-router";
import { ApiError } from "@/lib/api-client";
import { retryWait, useRetryCountdown } from "@/hooks/use-retry-countdown";

export function ForgotPasswordForm() {
  const forgotPassword = useForgotPassword();
  // A 429 (route limit or the server's reset budget) carries Retry-After.
  const wait = useRetryCountdown(forgotPassword.error);
  const timedRefusal = retryWait(forgotPassword.error) > 0;
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<ForgotPasswordInput>({
    resolver: zodResolver(ForgotPasswordSchema),
    defaultValues: { email: "" },
  });

  const onSubmit = handleSubmit((data) => {
    if (wait > 0) return;
    forgotPassword.mutate(data);
  });

  if (forgotPassword.isSuccess) {
    return (
      <div className="space-y-4 text-center">
        <h2 className="text-lg font-semibold">Check your inbox</h2>
        <p className="text-sm text-muted-foreground">
          If an account exists with that email, we&apos;ve sent a password reset
          link.
        </p>
        <Link to="/login" className="text-sm text-primary hover:underline">
          Back to login
        </Link>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="email">Email</Label>
        <Input
          id="email"
          type="email"
          placeholder="you@example.com"
          {...register("email")}
        />
        {errors.email && (
          <p className="text-sm text-destructive">{errors.email.message}</p>
        )}
      </div>

      {forgotPassword.isError && wait > 0 && (
        <p className="text-sm text-destructive">
          Too many requests. Try again in {wait}{" "}
          {wait === 1 ? "second" : "seconds"}.
        </p>
      )}
      {forgotPassword.isError && !timedRefusal && (
        <p className="text-sm text-destructive">
          {forgotPassword.error instanceof ApiError
            ? forgotPassword.error.message
            : "The reset link could not be requested. Try again."}
        </p>
      )}

      <Button
        type="submit"
        className="w-full"
        disabled={forgotPassword.isPending || wait > 0}
      >
        {forgotPassword.isPending ? "Sending..." : "Send reset link"}
      </Button>

      <p className="text-center text-sm text-muted-foreground">
        <Link to="/login" className="text-primary hover:underline">
          Back to login
        </Link>
      </p>
    </form>
  );
}
