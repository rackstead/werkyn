import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useApiKeys, useCreateApiKey, useRevokeApiKey } from "../api-keys";

export function ApiKeySettings() {
  const { data, isLoading, isError, refetch } = useApiKeys();
  const createKey = useCreateApiKey();
  const revokeKey = useRevokeApiKey();
  const [name, setName] = useState("");
  const [expiration, setExpiration] = useState("30");
  const [createdKey, setCreatedKey] = useState<string | null>(null);

  async function handleCreate(event: React.FormEvent) {
    event.preventDefault();
    try {
      const result = await createKey.mutateAsync({
        name: name.trim(),
        expiresInDays: expiration === "never" ? null : Number(expiration),
      });
      setCreatedKey(result.data.key);
      setName("");
      createKey.reset();
      toast.success("API key created");
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to create API key",
      );
    }
  }

  async function handleCopy() {
    if (!createdKey) return;
    try {
      await navigator.clipboard.writeText(createdKey);
      toast.success("API key copied");
    } catch {
      toast.error("Could not copy. Select and copy the API key manually.");
    }
  }

  return (
    <section className="space-y-6" aria-label="API keys">
      <div className="space-y-2">
        <h2 className="text-lg font-semibold">API keys</h2>
        <p className="text-sm text-muted-foreground">
          Create a personal key for scripts and integrations. Keys have your
          account's permissions across all your workspaces. Revoking a key stops
          its access immediately.
        </p>
      </div>

      {createdKey && (
        <div className="space-y-3 rounded-md border p-4" role="status">
          <p className="text-sm font-medium">
            Copy your API key now. It will only be shown once.
          </p>
          <Input
            aria-label="Your new API key"
            value={createdKey}
            readOnly
            onFocus={(event) => event.target.select()}
          />
          <div className="flex gap-2">
            <Button variant="outline" onClick={handleCopy}>
              Copy API key
            </Button>
            <Button variant="ghost" onClick={() => setCreatedKey(null)}>
              Done
            </Button>
          </div>
        </div>
      )}

      <form onSubmit={handleCreate} className="space-y-4 rounded-md border p-4">
        <div className="space-y-2">
          <Label htmlFor="api-key-name">Key name</Label>
          <Input
            id="api-key-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="e.g. CI pipeline"
            required
            maxLength={100}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="api-key-expiration">Expires after</Label>
          <select
            id="api-key-expiration"
            value={expiration}
            onChange={(event) => setExpiration(event.target.value)}
            className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm"
          >
            <option value="1">1 day</option>
            <option value="7">7 days</option>
            <option value="30">30 days</option>
            <option value="90">90 days</option>
            <option value="365">1 year</option>
            <option value="never">Never expires</option>
          </select>
        </div>
        <Button
          type="submit"
          disabled={!name.trim() || createKey.isPending || !!createdKey}
        >
          {createKey.isPending ? "Creating…" : "Create API key"}
        </Button>
      </form>

      <div className="space-y-3">
        <h3 className="font-medium">Your keys</h3>
        {isLoading && (
          <p className="text-sm text-muted-foreground">Loading API keys…</p>
        )}
        {isError && (
          <div role="alert" className="space-y-2">
            <p className="text-sm text-destructive">Could not load API keys.</p>
            <Button variant="outline" onClick={() => refetch()}>
              Try again
            </Button>
          </div>
        )}
        {data?.data.length === 0 && (
          <p className="text-sm text-muted-foreground">No API keys yet.</p>
        )}
        {data?.data.map((key) => {
          const expired =
            key.expiresAt && new Date(key.expiresAt) <= new Date();
          return (
            <div
              key={key.id}
              className="flex items-center justify-between gap-3 rounded-md border p-4"
            >
              <div className="min-w-0 space-y-1">
                <p className="truncate text-sm font-medium">{key.name}</p>
                <p className="text-xs text-muted-foreground">
                  <code>{key.prefix}…</code>
                  {key.revokedAt
                    ? " · Revoked"
                    : expired
                      ? " · Expired"
                      : " · Active"}
                </p>
                <p className="text-xs text-muted-foreground">
                  {key.expiresAt
                    ? `Expires ${new Date(key.expiresAt).toLocaleString()}`
                    : "Never expires"}
                  {" · "}
                  {key.lastUsedAt
                    ? `Last used ${new Date(key.lastUsedAt).toLocaleString()}`
                    : "Never used"}
                </p>
              </div>
              {!key.revokedAt && (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={revokeKey.isPending}
                  aria-label={`Revoke ${key.name}`}
                  onClick={() => {
                    if (
                      !window.confirm(
                        `Revoke "${key.name}"? Integrations using this key will lose access.`,
                      )
                    )
                      return;
                    revokeKey.mutate(key.id, {
                      onSuccess: () => toast.success("API key revoked"),
                      onError: (error) => toast.error(error.message),
                    });
                  }}
                >
                  Revoke
                </Button>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
