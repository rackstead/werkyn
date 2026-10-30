import { z } from "zod";

// ─── Connector config schemas (per-type) ────────────────

export const OidcConnectorConfigSchema = z.object({
  issuer: z.string().url(),
  clientID: z.string().min(1),
  clientSecret: z.string().min(1),
  redirectURI: z.string().url().optional(),
  scopes: z.array(z.string()).optional(),
});
export type OidcConnectorConfig = z.infer<typeof OidcConnectorConfigSchema>;

export const SamlConnectorConfigSchema = z.object({
  ssoURL: z.string().url(),
  ca: z.string().min(1),
  redirectURI: z.string().url().optional(),
  entityIssuer: z.string().optional(),
  ssoIssuer: z.string().optional(),
  nameIDPolicyFormat: z.string().optional(),
});
export type SamlConnectorConfig = z.infer<typeof SamlConnectorConfigSchema>;

export const LdapConnectorConfigSchema = z.object({
  host: z.string().min(1),
  bindDN: z.string().min(1),
  bindPW: z.string().min(1),
  userSearch: z.object({
    baseDN: z.string().min(1),
    filter: z.string().optional(),
    username: z.string().default("uid"),
    idAttr: z.string().default("uid"),
    emailAttr: z.string().default("mail"),
    nameAttr: z.string().default("cn"),
  }),
  insecureNoSSL: z.boolean().optional(),
  insecureSkipVerify: z.boolean().optional(),
});
export type LdapConnectorConfig = z.infer<typeof LdapConnectorConfigSchema>;

export const GitHubConnectorConfigSchema = z.object({
  clientID: z.string().min(1),
  clientSecret: z.string().min(1),
  redirectURI: z.string().url().optional(),
  orgs: z
    .array(z.object({ name: z.string(), teams: z.array(z.string()).optional() }))
    .optional(),
  loadAllGroups: z.boolean().optional(),
});
export type GitHubConnectorConfig = z.infer<typeof GitHubConnectorConfigSchema>;

export const GoogleConnectorConfigSchema = z.object({
  clientID: z.string().min(1),
  clientSecret: z.string().min(1),
  redirectURI: z.string().url().optional(),
  hostedDomains: z.array(z.string()).optional(),
});
export type GoogleConnectorConfig = z.infer<typeof GoogleConnectorConfigSchema>;

export const MicrosoftConnectorConfigSchema = z.object({
  clientID: z.string().min(1),
  clientSecret: z.string().min(1),
  redirectURI: z.string().url().optional(),
  tenant: z.string().optional(),
  onlySecurityGroups: z.boolean().optional(),
});
export type MicrosoftConnectorConfig = z.infer<
  typeof MicrosoftConnectorConfigSchema
>;

export const ConnectorConfigByType = {
  oidc: OidcConnectorConfigSchema,
  saml: SamlConnectorConfigSchema,
  ldap: LdapConnectorConfigSchema,
  github: GitHubConnectorConfigSchema,
  google: GoogleConnectorConfigSchema,
  microsoft: MicrosoftConnectorConfigSchema,
  zitadel: OidcConnectorConfigSchema,
  authentik: OidcConnectorConfigSchema,
  keycloak: OidcConnectorConfigSchema,
  pocketid: OidcConnectorConfigSchema,
} as const;

export const SsoConnectorType = z.enum([
  "oidc",
  "saml",
  "ldap",
  "github",
  "google",
  "microsoft",
  "zitadel",
  "authentik",
  "keycloak",
  "pocketid",
]);

/** Maps UI connector types to the underlying Dex connector type */
export const DexConnectorTypeMap: Record<string, string> = {
  zitadel: "oidc",
  authentik: "oidc",
  keycloak: "oidc",
  pocketid: "oidc",
};
export type SsoConnectorType = z.infer<typeof SsoConnectorType>;

// ─── SSO Config schemas ─────────────────────────────────

export const UpdateSsoConfigSchema = z.object({
  enabled: z.boolean().optional(),
  passwordLoginEnabled: z.boolean().optional(),
  autoLinkByEmail: z.boolean().optional(),
});
export type UpdateSsoConfigInput = z.infer<typeof UpdateSsoConfigSchema>;

// ─── Connector CRUD schemas ─────────────────────────────

export const CreateSsoConnectorSchema = z.object({
  connectorId: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-z0-9-]+$/, "Must be lowercase alphanumeric with dashes"),
  name: z.string().min(1).max(100),
  type: SsoConnectorType,
  config: z.record(z.string(), z.unknown()),
  enabled: z.boolean().optional(),
  position: z.number().int().optional(),
});
export type CreateSsoConnectorInput = z.infer<
  typeof CreateSsoConnectorSchema
>;

export const UpdateSsoConnectorSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  enabled: z.boolean().optional(),
  position: z.number().int().optional(),
});
export type UpdateSsoConnectorInput = z.infer<
  typeof UpdateSsoConnectorSchema
>;
