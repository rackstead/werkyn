import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAuthStore } from "@/stores/auth-store";
import { useUpdateWorkspace } from "@/features/workspaces/api";
import {
  useWorkspaceSettings,
  useUpdateWorkspaceSettings,
} from "../api";
import { toast } from "sonner";
import { Loader2, X } from "lucide-react";

interface GeneralSettingsProps {
  workspaceId: string;
}

export function GeneralSettings({ workspaceId }: GeneralSettingsProps) {
  const workspaces = useAuthStore((s) => s.workspaces);
  const ws = workspaces.find((w) => w.workspace.id === workspaceId);
  const workspace = ws?.workspace;

  const [name, setName] = useState(workspace?.name ?? "");
  const [slug, setSlug] = useState(workspace?.slug ?? "");

  const updateWorkspace = useUpdateWorkspace(workspaceId);

  const { data: settingsData, isLoading: settingsLoading } =
    useWorkspaceSettings(workspaceId);
  const settings = settingsData?.data;

  const [defaultRole, setDefaultRole] = useState<string>("MEMBER");
  const [invitesEnabled, setInvitesEnabled] = useState(true);
  const [requireAdminApproval, setRequireAdminApproval] = useState(false);
  const [allowedDomains, setAllowedDomains] = useState<string[]>([]);
  const [domainInput, setDomainInput] = useState("");
  const [maxMembers, setMaxMembers] = useState("");

  const updateSettings = useUpdateWorkspaceSettings(workspaceId);

  useEffect(() => {
    if (settings) {
      setDefaultRole(settings.defaultRole);
      setInvitesEnabled(settings.invitesEnabled);
      setRequireAdminApproval(settings.requireAdminApproval);
      setAllowedDomains(settings.allowedEmailDomains);
      setMaxMembers(settings.maxMembers?.toString() ?? "");
    }
  }, [settings]);

  const handleSaveProfile = () => {
    updateWorkspace.mutate(
      { name, slug },
      { onError: (err) => toast.error(err.message) },
    );
  };

  const handleSaveSettings = () => {
    updateSettings.mutate(
      {
        defaultRole: defaultRole as "ADMIN" | "MEMBER" | "VIEWER",
        invitesEnabled,
        requireAdminApproval,
        allowedEmailDomains: allowedDomains,
        maxMembers: maxMembers ? parseInt(maxMembers, 10) : null,
      },
      {
        onSuccess: () => toast.success("Settings saved"),
        onError: (err) => toast.error(err.message),
      },
    );
  };

  const handleAddDomain = () => {
    const d = domainInput.trim().toLowerCase();
    if (d && !allowedDomains.includes(d)) {
      setAllowedDomains([...allowedDomains, d]);
      setDomainInput("");
    }
  };

  const handleRemoveDomain = (domain: string) => {
    setAllowedDomains(allowedDomains.filter((d) => d !== domain));
  };

  return (
    <div className="space-y-8">
      {/* Workspace Profile */}
      <section className="space-y-4">
        <h2 className="text-lg font-semibold">Workspace Profile</h2>
        <div className="grid gap-4 max-w-md">
          <div className="space-y-2">
            <Label htmlFor="ws-name">Name</Label>
            <Input
              id="ws-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="ws-slug">Slug</Label>
            <Input
              id="ws-slug"
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
            />
          </div>
          <Button
            onClick={handleSaveProfile}
            disabled={updateWorkspace.isPending}
            className="w-fit"
          >
            {updateWorkspace.isPending ? "Saving..." : "Save Profile"}
          </Button>
        </div>
      </section>

      {/* Governance Settings */}
      <section className="space-y-4">
        <h2 className="text-lg font-semibold">Governance</h2>

        {settingsLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading settings...
          </div>
        ) : (
          <div className="grid gap-4 max-w-md">
            <div className="space-y-2">
              <Label>Default Role for New Members</Label>
              <Select value={defaultRole} onValueChange={setDefaultRole}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ADMIN">Admin</SelectItem>
                  <SelectItem value="MEMBER">Member</SelectItem>
                  <SelectItem value="VIEWER">Viewer</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="flex items-center gap-3">
              <input
                type="checkbox"
                id="invites-enabled"
                checked={invitesEnabled}
                onChange={(e) => setInvitesEnabled(e.target.checked)}
                className="h-4 w-4 rounded border-input"
              />
              <Label htmlFor="invites-enabled" className="mb-0">
                Invites enabled
              </Label>
            </div>

            <div className="flex items-center gap-3">
              <input
                type="checkbox"
                id="require-approval"
                checked={requireAdminApproval}
                onChange={(e) => setRequireAdminApproval(e.target.checked)}
                className="h-4 w-4 rounded border-input"
              />
              <Label htmlFor="require-approval" className="mb-0">
                Require admin approval for new members
              </Label>
            </div>
            {requireAdminApproval && (
              <p className="text-xs text-muted-foreground -mt-2">
                People who use an invite wait under Invites → Join requests
                until an admin approves them.
              </p>
            )}

            <div className="space-y-2">
              <Label>Allowed Email Domains</Label>
              <p className="text-xs text-muted-foreground">
                Leave empty to allow all domains
              </p>
              <div className="flex gap-2">
                <Input
                  placeholder="example.com"
                  value={domainInput}
                  onChange={(e) => setDomainInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      handleAddDomain();
                    }
                  }}
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={handleAddDomain}
                >
                  Add
                </Button>
              </div>
              {allowedDomains.length > 0 && (
                <div className="flex flex-wrap gap-1 mt-1">
                  {allowedDomains.map((d) => (
                    <span
                      key={d}
                      className="inline-flex items-center gap-1 rounded-md bg-accent px-2 py-0.5 text-xs"
                    >
                      {d}
                      <button
                        type="button"
                        onClick={() => handleRemoveDomain(d)}
                        className="hover:text-destructive"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </span>
                  ))}
                </div>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="max-members">Max Members</Label>
              <Input
                id="max-members"
                type="number"
                min={1}
                placeholder="Unlimited"
                value={maxMembers}
                onChange={(e) => setMaxMembers(e.target.value)}
              />
            </div>

            <Button
              onClick={handleSaveSettings}
              disabled={updateSettings.isPending}
              className="w-fit"
            >
              {updateSettings.isPending ? "Saving..." : "Save Settings"}
            </Button>
          </div>
        )}
      </section>
    </div>
  );
}
