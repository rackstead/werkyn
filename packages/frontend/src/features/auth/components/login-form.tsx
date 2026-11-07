import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { LoginSchema, type LoginInput } from "@pm/shared";
import { useLogin } from "../api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Link } from "@tanstack/react-router";
import { ApiError } from "@/lib/api-client";
import { retryWait, useRetryCountdown } from "@/hooks/use-retry-countdown";

interface LoginFormProps {
  inviteToken?: string;
}

export function LoginForm({ inviteToken }: LoginFormProps) {
  const login = useLogin(inviteToken);
  // Repeated failed sign-ins are answered 429 with Retry-After: count the
  // wait down and keep the form from sending until it has passed.
  const wait = useRetryCountdown(login.error);
  const timedRefusal = retryWait(login.error) > 0;
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<LoginInput>({
    resolver: zodResolver(LoginSchema),
    defaultValues: { email: "", password: "" },
  });

  const onSubmit = handleSubmit((data) => {
    if (wait > 0) return;
    login.mutate(data);
  });

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

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label htmlFor="password">Password</Label>
          <Link
            to="/forgot-password"
            className="text-sm text-muted-foreground hover:text-primary"
          >
            Forgot password?
          </Link>
        </div>
        <Input
          id="password"
          type="password"
          {...register("password")}
        />
        {errors.password && (
          <p className="text-sm text-destructive">{errors.password.message}</p>
        )}
      </div>

      {login.isError && wait > 0 && (
        <p className="text-sm text-destructive">
          Too many sign-in attempts. Try again in {wait}{" "}
          {wait === 1 ? "second" : "seconds"}.
        </p>
      )}
      {login.isError && !timedRefusal && (
        <p className="text-sm text-destructive">
          {login.error instanceof ApiError
            ? login.error.message
            : "Login failed"}
        </p>
      )}

      <Button
        type="submit"
        className="w-full"
        disabled={login.isPending || wait > 0}
      >
        {login.isPending ? "Signing in..." : "Sign in"}
      </Button>

      <p className="text-center text-sm text-muted-foreground">
        Don&apos;t have an account?{" "}
        <Link
          to="/register"
          search={{ inviteToken }}
          className="text-primary hover:underline"
        >
          Sign up
        </Link>
      </p>
    </form>
  );
}
