import crypto from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import { z } from "zod";
import { UnauthorizedError } from "../../../utils/errors.js";

const userSelect = {
  id: true,
  email: true,
  displayName: true,
  avatarUrl: true,
  jobTitle: true,
  phone: true,
  timezone: true,
  emailVerified: true,
} satisfies Prisma.UserSelect;

export interface OidcIdentity {
  issuer: string;
  subject: string;
  connectorId: string;
  email?: string;
  emailVerified: boolean;
  displayName?: string;
}

// The caller must first validate the ID token's signature, issuer, audience,
// nonce, and timestamps. Email is an optional attribute, never the subject ID.
export function readOidcIdentity(
  claims: Record<string, unknown>,
  expectedIssuer: string,
): OidcIdentity {
  if (
    claims.iss !== expectedIssuer ||
    typeof claims.sub !== "string" ||
    claims.sub.length === 0 ||
    claims.sub.length > 255
  ) {
    throw new UnauthorizedError("Invalid OIDC identity claims");
  }
  if (
    (claims.email !== undefined && typeof claims.email !== "string") ||
    (claims.email_verified !== undefined &&
      typeof claims.email_verified !== "boolean") ||
    (claims.name !== undefined && typeof claims.name !== "string")
  ) {
    throw new UnauthorizedError("Invalid OIDC profile claims");
  }

  // Dex's federated:id scope supplies the actual upstream connector in signed
  // claims. A browser's optional connector_id hint is not proof of which one
  // authenticated the user (and must not bypass a disabled connector).
  const federated = claims.federated_claims;
  if (
    !federated ||
    typeof federated !== "object" ||
    Array.isArray(federated) ||
    !("connector_id" in federated) ||
    typeof federated.connector_id !== "string" ||
    federated.connector_id.length === 0 ||
    federated.connector_id.length > 100 ||
    ("user_id" in federated && typeof federated.user_id !== "string")
  ) {
    throw new UnauthorizedError("Invalid OIDC connector claims");
  }

  let email: string | undefined;
  if (typeof claims.email === "string") {
    const parsed = z
      .string()
      .email()
      .max(255)
      .safeParse(claims.email.trim().toLowerCase());
    if (!parsed.success)
      throw new UnauthorizedError("Invalid OIDC email claim");
    email = parsed.data;
  }

  return {
    issuer: expectedIssuer,
    subject: claims.sub,
    connectorId: federated.connector_id,
    email,
    emailVerified: claims.email_verified === true,
    displayName:
      typeof claims.name === "string"
        ? claims.name.trim().slice(0, 100) || undefined
        : undefined,
  };
}

// Keep raw subjects in providerSub and namespace the provider instead. Encoding
// both new and legacy identities in providerSub would let a raw subject collide
// with another identity's new encoded key. 48 characters fits the existing column.
export function oidcProviderNamespace(issuer: string): string {
  return `oidc:${crypto.createHash("sha256").update(issuer).digest("base64url")}`;
}

export async function assertSsoEnabled(
  prisma:
    | Pick<PrismaClient, "ssoConfig" | "ssoConnector">
    | Prisma.TransactionClient,
  connectorId?: string | null,
) {
  const config = await prisma.ssoConfig.findUnique({
    where: { id: "singleton" },
  });
  if (!config?.enabled) throw new UnauthorizedError("SSO is not enabled");
  if (connectorId) {
    const connector = await prisma.ssoConnector.findFirst({
      where: { connectorId, ssoConfigId: config.id, enabled: true },
      select: { id: true },
    });
    if (!connector) throw new UnauthorizedError("SSO connector is not enabled");
  }
  return config;
}

function assertConnectorBinding(
  existingConnectorId: string | null,
  requestedConnectorId: string | null,
) {
  if (
    existingConnectorId &&
    requestedConnectorId &&
    existingConnectorId !== requestedConnectorId
  ) {
    throw new UnauthorizedError(
      "OIDC connector does not match the linked identity",
    );
  }
}

// Only validated identities from this installation's embedded Dex issuer enter
// here. Existing legacy bindings are upgraded without treating email or the
// auto-link setting as a substitute for their already-linked subject identity.
export async function resolveOidcUser(
  prisma: PrismaClient,
  identity: OidcIdentity,
  connectorId: string | null,
) {
  if (!identity.connectorId) {
    throw new UnauthorizedError("Missing OIDC connector identity");
  }
  assertConnectorBinding(identity.connectorId, connectorId);
  const actualConnectorId = identity.connectorId;
  const provider = oidcProviderNamespace(identity.issuer);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await prisma.$transaction(
        async (tx) => {
          const config = await assertSsoEnabled(tx, actualConnectorId);
          const current = await tx.authProvider.findUnique({
            where: {
              provider_providerSub: { provider, providerSub: identity.subject },
            },
            include: { user: { select: userSelect } },
          });
          if (current) {
            assertConnectorBinding(current.connectorId, actualConnectorId);
            if (current.connectorId)
              await assertSsoEnabled(tx, current.connectorId);
            return current.user;
          }

          const legacy = await tx.authProvider.findUnique({
            where: {
              provider_providerSub: {
                provider: "oidc",
                providerSub: identity.subject,
              },
            },
            include: { user: { select: userSelect } },
          });
          if (legacy) {
            assertConnectorBinding(legacy.connectorId, actualConnectorId);
            if (legacy.connectorId)
              await assertSsoEnabled(tx, legacy.connectorId);
            await tx.authProvider.update({
              where: { id: legacy.id },
              data: {
                provider,
                connectorId: legacy.connectorId ?? actualConnectorId,
              },
            });
            return legacy.user;
          }

          if (!identity.email || !identity.emailVerified) {
            throw new UnauthorizedError(
              "SSO requires a verified email address to create or link an account",
            );
          }
          const existing = await tx.user.findUnique({
            where: { email: identity.email },
            select: userSelect,
          });
          if (existing) {
            if (!config.autoLinkByEmail) {
              throw new UnauthorizedError(
                "Automatic account linking is disabled. Sign in to your existing account.",
              );
            }
            if (!existing.emailVerified) {
              // Auto-verifying an unverified local account would activate a password
              // chosen by whoever pre-registered the email address.
              throw new UnauthorizedError(
                "Verify the existing account before linking it with SSO",
              );
            }
            await tx.authProvider.create({
              data: {
                userId: existing.id,
                provider,
                providerSub: identity.subject,
                connectorId: actualConnectorId,
                email: identity.email,
              },
            });
            return existing;
          }

          return tx.user.create({
            data: {
              email: identity.email,
              displayName: identity.displayName ?? identity.email.slice(0, 100),
              passwordHash: null,
              emailVerified: true,
              authProviders: {
                create: {
                  provider,
                  providerSub: identity.subject,
                  connectorId: actualConnectorId,
                  email: identity.email,
                },
              },
            },
            select: userSelect,
          });
        },
        { isolationLevel: "Serializable" },
      );
    } catch (error) {
      const code =
        error && typeof error === "object" && "code" in error
          ? error.code
          : undefined;
      if (code !== "P2034" && code !== "P2002") throw error;
      if (attempt === 2)
        throw new UnauthorizedError(
          "Concurrent SSO sign-in. Please try again.",
        );
    }
  }
  throw new UnauthorizedError("SSO sign-in failed");
}
