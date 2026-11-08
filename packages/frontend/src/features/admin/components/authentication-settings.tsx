import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
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
import { toast } from "sonner";
import { Trash2, Plus, Shield, Power, PowerOff, Copy, Check, Pencil } from "lucide-react";
import { CreateSsoConnectorSchema, type CreateSsoConnectorInput, type UpdateSsoConnectorInput } from "@pm/shared";
import {
  useSsoConfig,
  useUpdateSsoConfig,
  useSsoConnectors,
  useCreateSsoConnector,
  useUpdateSsoConnector,
  useDeleteSsoConnector,
  type SsoConnector,
} from "../sso-api";
import {
  useRegistrationConfig,
  useUpdateRegistrationConfig,
} from "../registration-api";

const CONNECTOR_TYPES = [
  { value: "oidc", label: "OIDC (Generic)" },
  { value: "saml", label: "SAML 2.0" },
  { value: "ldap", label: "LDAP" },
  { value: "github", label: "GitHub" },
  { value: "google", label: "Google" },
  { value: "microsoft", label: "Microsoft (Azure AD)" },
  { value: "zitadel", label: "Zitadel" },
  { value: "authentik", label: "Authentik" },
  { value: "keycloak", label: "Keycloak" },
  { value: "pocketid", label: "PocketID" },
];

const CONNECTOR_FIELDS: Record<string, Array<{ key: string; label: string; type?: string; required?: boolean }>> = {
  oidc: [
    { key: "issuer", label: "Issuer URL", required: true },
    { key: "clientID", label: "Client ID", required: true },
    { key: "clientSecret", label: "Client Secret", type: "password", required: true },
  ],
  saml: [
    { key: "ssoURL", label: "SSO URL", required: true },
    { key: "ca", label: "CA Certificate (PEM)", required: true },
    { key: "entityIssuer", label: "Entity Issuer" },
    { key: "ssoIssuer", label: "SSO Issuer" },
  ],
  ldap: [
    { key: "host", label: "Host (host:port)", required: true },
    { key: "bindDN", label: "Bind DN", required: true },
    { key: "bindPW", label: "Bind Password", type: "password", required: true },
    { key: "userSearch.baseDN", label: "User Search Base DN", required: true },
    { key: "userSearch.filter", label: "User Search Filter" },
    { key: "userSearch.username", label: "Username Attribute" },
    { key: "userSearch.emailAttr", label: "Email Attribute" },
    { key: "userSearch.nameAttr", label: "Name Attribute" },
  ],
  github: [
    { key: "clientID", label: "Client ID", required: true },
    { key: "clientSecret", label: "Client Secret", type: "password", required: true },
  ],
  google: [
    { key: "clientID", label: "Client ID", required: true },
    { key: "clientSecret", label: "Client Secret", type: "password", required: true },
  ],
  microsoft: [
    { key: "clientID", label: "Client ID", required: true },
    { key: "clientSecret", label: "Client Secret", type: "password", required: true },
    { key: "tenant", label: "Tenant ID" },
  ],
  zitadel: [
    { key: "issuer", label: "Issuer URL", required: true },
    { key: "clientID", label: "Client ID", required: true },
    { key: "clientSecret", label: "Client Secret", type: "password", required: true },
  ],
  authentik: [
    { key: "issuer", label: "Issuer URL", required: true },
    { key: "clientID", label: "Client ID", required: true },
    { key: "clientSecret", label: "Client Secret", type: "password", required: true },
  ],
  keycloak: [
    { key: "issuer", label: "Issuer URL", required: true },
    { key: "clientID", label: "Client ID", required: true },
    { key: "clientSecret", label: "Client Secret", type: "password", required: true },
  ],
  pocketid: [
    { key: "issuer", label: "Issuer URL", required: true },
    { key: "clientID", label: "Client ID", required: true },
    { key: "clientSecret", label: "Client Secret", type: "password", required: true },
  ],
};

function RegistrationPrivacySetting() {
  const { data } = useRegistrationConfig();
  const update = useUpdateRegistrationConfig();
  const config = data?.data;
  // The config route is instance-admin only. Hide the control when this
  // session cannot read it (a workspace admin who is not an instance admin).
  if (!config) return null;

  return (
    <div className="space-y-3">
      <div>
        <h3 className="text-lg font-medium">Registration</h3>
        <p className="text-sm text-muted-foreground">
          Off by default. A new account can sign in immediately, and an
          address that is already registered is reported as in use. Leave this
          off when the host has no email delivery.
        </p>
      </div>
      <label className="flex items-center gap-3 cursor-pointer">
        <input
          id="privacy-preserving-registration"
          type="checkbox"
          checked={config.privacyPreserving}
          disabled={update.isPending}
          onChange={() =>
            update.mutate(
              { privacyPreserving: !config.privacyPreserving },
              {
                onSuccess: () => toast.success("Registration settings updated"),
                onError: (err) => toast.error(err.message),
              },
            )
          }
          className="rounded"
        />
        <div>
          <p className="text-sm font-medium">
            Require email verification before sign-in
          </p>
          <p className="text-xs text-muted-foreground">
            When on, new and existing addresses get the same response. A new
            account is not signed in until the address is verified, and an
            existing account is left unchanged. Configure email delivery
            before turning this on.
          </p>
        </div>
      </label>
    </div>
  );
}

export function AuthenticationSettings() {
  const { data: configData } = useSsoConfig();
  const { data: connectorsData } = useSsoConnectors();
  const updateConfig = useUpdateSsoConfig();
  const createConnector = useCreateSsoConnector();
  const updateConnector = useUpdateSsoConnector();
  const deleteConnector = useDeleteSsoConnector();
  const [showAddForm, setShowAddForm] = useState(false);
  const [editingConnectorId, setEditingConnectorId] = useState<string | null>(null);

  const config = configData?.data;
  const connectors = connectorsData?.data ?? [];

  const handleToggleEnabled = () => {
    if (!config) return;
    updateConfig.mutate(
      { enabled: !config.enabled },
      { onSuccess: () => toast.success("SSO settings updated") },
    );
  };

  const handleTogglePasswordLogin = () => {
    if (!config) return;
    updateConfig.mutate(
      { passwordLoginEnabled: !config.passwordLoginEnabled },
      { onSuccess: () => toast.success("Password login setting updated") },
    );
  };

  const handleToggleAutoLink = () => {
    if (!config) return;
    updateConfig.mutate(
      { autoLinkByEmail: !config.autoLinkByEmail },
      { onSuccess: () => toast.success("Auto-link setting updated") },
    );
  };

  const handleToggleConnector = (c: SsoConnector) => {
    updateConnector.mutate(
      { connectorId: c.connectorId, enabled: !c.enabled },
      { onSuccess: () => toast.success(`Connector ${c.enabled ? "disabled" : "enabled"}`) },
    );
  };

  const handleDeleteConnector = (connectorId: string) => {
    if (!confirm("Delete this connector?")) return;
    deleteConnector.mutate(connectorId, {
      onSuccess: () => toast.success("Connector deleted"),
    });
  };

  return (
    <div className="space-y-8">
      <RegistrationPrivacySetting />
      {/* SSO Toggle & Settings */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-lg font-medium">Single Sign-On (SSO)</h3>
            <p className="text-sm text-muted-foreground">
              Enable SSO to allow users to authenticate via external identity providers.
            </p>
          </div>
          <Button
            variant={config?.enabled ? "default" : "outline"}
            size="sm"
            onClick={handleToggleEnabled}
            disabled={updateConfig.isPending}
          >
            <Shield className="h-4 w-4 mr-1" />
            {config?.enabled ? "Enabled" : "Disabled"}
          </Button>
        </div>

        {config?.enabled && (
          <div className="space-y-3 pl-4 border-l-2 border-muted">
            <label className="flex items-center gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={config.passwordLoginEnabled}
                onChange={handleTogglePasswordLogin}
                className="rounded"
              />
              <div>
                <p className="text-sm font-medium">Allow password login</p>
                <p className="text-xs text-muted-foreground">
                  When disabled, only SSO authentication is allowed.
                </p>
              </div>
            </label>

            <label className="flex items-center gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={config.autoLinkByEmail}
                onChange={handleToggleAutoLink}
                className="rounded"
              />
              <div>
                <p className="text-sm font-medium">Auto-link by email</p>
                <p className="text-xs text-muted-foreground">
                  Automatically link SSO accounts to existing users with the same verified email.
                </p>
              </div>
            </label>
          </div>
        )}
      </div>

      {/* Connectors List */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-medium">Identity Providers</h3>
          <Button size="sm" onClick={() => setShowAddForm(true)}>
            <Plus className="h-4 w-4 mr-1" />
            Add Provider
          </Button>
        </div>

        {connectors.length === 0 && !showAddForm && (
          <p className="text-sm text-muted-foreground py-4 text-center border rounded-md">
            No identity providers configured yet.
          </p>
        )}

        {connectors.map((c) => (
          <div key={c.id} className="space-y-0">
            <div className="flex items-center justify-between p-3 border rounded-md">
              <div className="flex items-center gap-3">
                {c.enabled ? (
                  <Power className="h-4 w-4 text-green-500" />
                ) : (
                  <PowerOff className="h-4 w-4 text-muted-foreground" />
                )}
                <div>
                  <p className="text-sm font-medium">{c.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {c.type.toUpperCase()} &middot; {c.connectorId}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => handleToggleConnector(c)}
                >
                  {c.enabled ? "Disable" : "Enable"}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    setEditingConnectorId(
                      editingConnectorId === c.connectorId ? null : c.connectorId,
                    )
                  }
                >
                  <Pencil className="h-4 w-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => handleDeleteConnector(c.connectorId)}
                >
                  <Trash2 className="h-4 w-4 text-destructive" />
                </Button>
              </div>
            </div>
            {editingConnectorId === c.connectorId && (
              <EditConnectorForm
                connector={c}
                onClose={() => setEditingConnectorId(null)}
                onSubmit={(data) => {
                  updateConnector.mutate(
                    { connectorId: c.connectorId, ...data },
                    {
                      onSuccess: () => {
                        toast.success("Connector updated");
                        setEditingConnectorId(null);
                      },
                      onError: (err) => {
                        toast.error(
                          err instanceof Error ? err.message : "Failed to update connector",
                        );
                      },
                    },
                  );
                }}
                isPending={updateConnector.isPending}
              />
            )}
          </div>
        ))}

        {showAddForm && (
          <AddConnectorForm
            onClose={() => setShowAddForm(false)}
            onSubmit={(data) => {
              createConnector.mutate(data, {
                onSuccess: () => {
                  toast.success("Connector created");
                  setShowAddForm(false);
                },
                onError: (err) => {
                  toast.error(err instanceof Error ? err.message : "Failed to create connector");
                },
              });
            }}
            isPending={createConnector.isPending}
          />
        )}
      </div>
    </div>
  );
}

function AddConnectorForm({
  onClose,
  onSubmit,
  isPending,
}: {
  onClose: () => void;
  onSubmit: (data: CreateSsoConnectorInput) => void;
  isPending: boolean;
}) {
  const [selectedType, setSelectedType] = useState("oidc");
  const [copied, setCopied] = useState(false);
  const callbackUrl = `${window.location.origin}/dex/callback`;
  const {
    register,
    handleSubmit,
    formState: { errors },
    setValue,
  } = useForm<CreateSsoConnectorInput>({
    resolver: zodResolver(CreateSsoConnectorSchema),
    defaultValues: {
      connectorId: "",
      name: "",
      type: "oidc",
      config: {},
    },
  });

  const fields = CONNECTOR_FIELDS[selectedType] ?? [];

  const onFormSubmit = handleSubmit((data) => {
    // Build nested config from flat fields
    const config: Record<string, unknown> = {};
    for (const field of fields) {
      const inputEl = document.getElementById(`config-${field.key}`) as HTMLInputElement;
      if (inputEl?.value) {
        const keys = field.key.split(".");
        if (keys.length === 2) {
          if (!config[keys[0]]) config[keys[0]] = {};
          (config[keys[0]] as Record<string, unknown>)[keys[1]] = inputEl.value;
        } else {
          config[field.key] = inputEl.value;
        }
      }
    }
    onSubmit({ ...data, config });
  });

  return (
    <div className="border rounded-md p-4 space-y-4">
      <h4 className="font-medium">Add Identity Provider</h4>

      <form onSubmit={onFormSubmit} className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <Label htmlFor="connectorId">Connector ID</Label>
            <Input
              id="connectorId"
              placeholder="e.g. okta-main"
              {...register("connectorId")}
            />
            {errors.connectorId && (
              <p className="text-xs text-destructive">{errors.connectorId.message}</p>
            )}
          </div>
          <div className="space-y-1">
            <Label htmlFor="name">Display Name</Label>
            <Input
              id="name"
              placeholder="e.g. Okta"
              {...register("name")}
            />
            {errors.name && (
              <p className="text-xs text-destructive">{errors.name.message}</p>
            )}
          </div>
        </div>

        <div className="space-y-1">
          <Label>Type</Label>
          <Select
            value={selectedType}
            onValueChange={(v) => {
              setSelectedType(v);
              setValue("type", v as CreateSsoConnectorInput["type"]);
            }}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CONNECTOR_TYPES.map((t) => (
                <SelectItem key={t.value} value={t.value}>
                  {t.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-2">
          <Label className="text-sm text-muted-foreground">
            Configuration
          </Label>
          <div className="space-y-1">
            <Label htmlFor="callback-url" className="text-xs">
              Callback URL
            </Label>
            <div className="flex gap-2">
              <Input
                id="callback-url"
                value={callbackUrl}
                readOnly
                className="bg-muted text-muted-foreground"
              />
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="shrink-0"
                onClick={() => {
                  const el = document.getElementById("callback-url") as HTMLInputElement;
                  if (navigator.clipboard?.writeText) {
                    navigator.clipboard.writeText(callbackUrl).then(
                      () => {
                        setCopied(true);
                        toast.success("Copied to clipboard");
                        setTimeout(() => setCopied(false), 2000);
                      },
                      () => {
                        el?.select();
                        document.execCommand("copy");
                        setCopied(true);
                        toast.success("Copied to clipboard");
                        setTimeout(() => setCopied(false), 2000);
                      },
                    );
                  } else {
                    el?.select();
                    document.execCommand("copy");
                    setCopied(true);
                    toast.success("Copied to clipboard");
                    setTimeout(() => setCopied(false), 2000);
                  }
                }}
              >
                {copied ? (
                  <Check className="h-4 w-4 text-green-500" />
                ) : (
                  <Copy className="h-4 w-4" />
                )}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Add this URL as the redirect/callback URI in your identity provider.
            </p>
          </div>
          {fields.map((field) => (
            <div key={field.key} className="space-y-1">
              <Label htmlFor={`config-${field.key}`} className="text-xs">
                {field.label}
                {field.required && <span className="text-destructive"> *</span>}
              </Label>
              <Input
                id={`config-${field.key}`}
                type={field.type || "text"}
                placeholder={field.label}
              />
            </div>
          ))}
        </div>

        <div className="flex gap-2 justify-end">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={isPending}>
            {isPending ? "Creating..." : "Create"}
          </Button>
        </div>
      </form>
    </div>
  );
}

function EditConnectorForm({
  connector,
  onClose,
  onSubmit,
  isPending,
}: {
  connector: SsoConnector;
  onClose: () => void;
  onSubmit: (data: UpdateSsoConnectorInput) => void;
  isPending: boolean;
}) {
  const [name, setName] = useState(connector.name);
  const [copied, setCopied] = useState(false);
  const callbackUrl = `${window.location.origin}/dex/callback`;
  const fields = CONNECTOR_FIELDS[connector.type] ?? [];
  const existingConfig = connector.config as Record<string, unknown>;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const config: Record<string, unknown> = {};
    for (const field of fields) {
      const inputEl = document.getElementById(`edit-config-${field.key}`) as HTMLInputElement;
      if (inputEl?.value) {
        const keys = field.key.split(".");
        if (keys.length === 2) {
          if (!config[keys[0]]) config[keys[0]] = {};
          (config[keys[0]] as Record<string, unknown>)[keys[1]] = inputEl.value;
        } else {
          config[field.key] = inputEl.value;
        }
      }
    }
    onSubmit({ name, config });
  };

  function getNestedValue(obj: Record<string, unknown>, key: string): string {
    const keys = key.split(".");
    if (keys.length === 2) {
      const nested = obj[keys[0]] as Record<string, unknown> | undefined;
      return (nested?.[keys[1]] as string) ?? "";
    }
    return (obj[key] as string) ?? "";
  }

  return (
    <div className="border border-t-0 rounded-b-md p-4 space-y-3">
      <form onSubmit={handleSubmit} className="space-y-3">
        <div className="space-y-1">
          <Label htmlFor="edit-callback-url" className="text-xs">
            Callback URL
          </Label>
          <div className="flex gap-2">
            <Input
              id="edit-callback-url"
              value={callbackUrl}
              readOnly
              className="bg-muted text-muted-foreground"
            />
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="shrink-0"
              onClick={() => {
                const el = document.getElementById("edit-callback-url") as HTMLInputElement;
                if (navigator.clipboard?.writeText) {
                  navigator.clipboard.writeText(callbackUrl).then(
                    () => {
                      setCopied(true);
                      toast.success("Copied to clipboard");
                      setTimeout(() => setCopied(false), 2000);
                    },
                    () => {
                      el?.select();
                      document.execCommand("copy");
                      setCopied(true);
                      toast.success("Copied to clipboard");
                      setTimeout(() => setCopied(false), 2000);
                    },
                  );
                } else {
                  el?.select();
                  document.execCommand("copy");
                  setCopied(true);
                  toast.success("Copied to clipboard");
                  setTimeout(() => setCopied(false), 2000);
                }
              }}
            >
              {copied ? (
                <Check className="h-4 w-4 text-green-500" />
              ) : (
                <Copy className="h-4 w-4" />
              )}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Add this URL as the redirect/callback URI in your identity provider.
          </p>
        </div>

        <div className="space-y-1">
          <Label htmlFor="edit-name" className="text-xs">
            Display Name
          </Label>
          <Input
            id="edit-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>

        {fields.map((field) => (
          <div key={field.key} className="space-y-1">
            <Label htmlFor={`edit-config-${field.key}`} className="text-xs">
              {field.label}
              {field.required && <span className="text-destructive"> *</span>}
            </Label>
            <Input
              id={`edit-config-${field.key}`}
              type={field.type || "text"}
              defaultValue={getNestedValue(existingConfig, field.key)}
              placeholder={field.label}
            />
          </div>
        ))}

        <div className="flex gap-2 justify-end">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={isPending}>
            {isPending ? "Saving..." : "Save"}
          </Button>
        </div>
      </form>
    </div>
  );
}
