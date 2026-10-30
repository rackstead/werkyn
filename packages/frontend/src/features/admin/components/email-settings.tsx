import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import type { z } from "zod";
import { UpdateEmailConfigSchema, type UpdateEmailConfigInput } from "@pm/shared";
import { useEmailConfig, useUpdateEmailConfig, useSendTestEmail } from "../email-api";
import { ApiError } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { Send } from "lucide-react";

export function EmailSettings() {
  const { data: configRes, isLoading } = useEmailConfig();
  const updateConfig = useUpdateEmailConfig();
  const sendTest = useSendTestEmail();
  const config = configRes?.data;

  // The port field is coerced, so the form holds Zod 4's `unknown` input type
  // and submits the parsed values.
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isDirty },
  } = useForm<z.input<typeof UpdateEmailConfigSchema>, unknown, UpdateEmailConfigInput>({
    resolver: zodResolver(UpdateEmailConfigSchema),
    defaultValues: {
      host: "",
      port: 587,
      secure: false,
      user: "",
      pass: "",
      fromAddress: "",
    },
  });

  useEffect(() => {
    if (config) {
      reset({
        host: config.host,
        port: config.port,
        secure: config.secure,
        user: config.user,
        pass: config.pass,
        fromAddress: config.fromAddress,
      });
    }
  }, [config, reset]);

  const onSubmit = handleSubmit((data) => {
    updateConfig.mutate(data, {
      onSuccess: () => toast.success("Email settings saved"),
      onError: () => toast.error("Failed to save email settings"),
    });
  });

  const handleSendTest = () => {
    sendTest.mutate(undefined, {
      onSuccess: (res) => toast.success(res.data.message),
      onError: (err) =>
        toast.error(
          err instanceof ApiError
            ? err.message
            : "Failed to send test email",
        ),
    });
  };

  if (isLoading) {
    return <p className="text-sm text-muted-foreground">Loading...</p>;
  }

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-medium">Email Settings</h3>
        <p className="text-sm text-muted-foreground">
          Configure the SMTP server used for sending emails (verification, password resets, etc.).
        </p>
      </div>

      <form onSubmit={onSubmit} className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label htmlFor="smtp-host">SMTP Host</Label>
            <Input
              id="smtp-host"
              placeholder="smtp.example.com"
              {...register("host")}
            />
            {errors.host && (
              <p className="text-sm text-destructive">{errors.host.message}</p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="smtp-port">Port</Label>
            <Input
              id="smtp-port"
              type="number"
              placeholder="587"
              {...register("port", { valueAsNumber: true })}
            />
            {errors.port && (
              <p className="text-sm text-destructive">{errors.port.message}</p>
            )}
          </div>
        </div>

        <label className="flex items-center gap-3 cursor-pointer">
          <input
            type="checkbox"
            className="rounded"
            {...register("secure")}
          />
          <div>
            <p className="text-sm font-medium">Use TLS/SSL</p>
            <p className="text-xs text-muted-foreground">
              Enable for port 465, disable for STARTTLS on port 587.
            </p>
          </div>
        </label>

        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label htmlFor="smtp-user">Username</Label>
            <Input
              id="smtp-user"
              placeholder="username"
              autoComplete="off"
              {...register("user")}
            />
            {errors.user && (
              <p className="text-sm text-destructive">{errors.user.message}</p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="smtp-pass">Password</Label>
            <Input
              id="smtp-pass"
              type="password"
              placeholder="password"
              autoComplete="off"
              {...register("pass")}
            />
            {errors.pass && (
              <p className="text-sm text-destructive">{errors.pass.message}</p>
            )}
          </div>
        </div>

        <div className="space-y-2">
          <Label htmlFor="smtp-from">From Address</Label>
          <Input
            id="smtp-from"
            type="email"
            placeholder="noreply@example.com"
            {...register("fromAddress")}
          />
          {errors.fromAddress && (
            <p className="text-sm text-destructive">{errors.fromAddress.message}</p>
          )}
        </div>

        <div className="flex items-center gap-3 pt-2">
          <Button
            type="submit"
            disabled={updateConfig.isPending}
          >
            {updateConfig.isPending ? "Saving..." : "Save"}
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={handleSendTest}
            disabled={sendTest.isPending}
          >
            <Send className="h-4 w-4 mr-1" />
            {sendTest.isPending ? "Sending..." : "Send Test Email"}
          </Button>
          <span className="text-xs text-muted-foreground">
            Sends to your account email
          </span>
        </div>
      </form>
    </div>
  );
}
