import { Button } from "@/components/ui/button";
import { apiUrl } from "@/lib/api-url";
import { whenLoggedOut } from "@/stores/auth-store";

interface SsoConnectorInfo {
  connectorId: string;
  name: string;
  type: string;
}

interface SsoButtonsProps {
  connectors: SsoConnectorInfo[];
  returnUrl?: string;
}

const CONNECTOR_ICONS: Record<string, string> = {
  github: "GitHub",
  google: "Google",
  microsoft: "Microsoft",
  oidc: "SSO",
  saml: "SAML",
  ldap: "LDAP",
};

/** Where the browser goes to start single sign-on with a connector. */
export function ssoLoginUrl(connectorId: string, returnUrl?: string) {
  const params = new URLSearchParams();
  params.set("connector_id", connectorId);
  if (returnUrl) {
    params.set("return_url", returnUrl);
  }
  return apiUrl("auth/oidc/login", params);
}

export function SsoButtons({ connectors, returnUrl }: SsoButtonsProps) {
  const handleSsoLogin = async (connectorId: string) => {
    // Leaving the page would cancel a sign-out still revoking its session.
    await whenLoggedOut();
    window.location.href = ssoLoginUrl(connectorId, returnUrl);
  };

  return (
    <div className="space-y-2">
      {connectors.map((connector) => (
        <Button
          key={connector.connectorId}
          variant="outline"
          className="w-full"
          onClick={() => void handleSsoLogin(connector.connectorId)}
        >
          Sign in with {connector.name || CONNECTOR_ICONS[connector.type] || connector.type}
        </Button>
      ))}
    </div>
  );
}
