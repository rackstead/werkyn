import * as oauth from "oauth4webapi";
import { allowInsecureRequests } from "oauth4webapi";
import crypto from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { env } from "../../../config/env.js";
import { UnauthorizedError } from "../../../utils/errors.js";
import { signAccessToken } from "../../../utils/tokens.js";
import { startRefreshSession } from "../refresh-sessions.js";
import {
  assertSsoEnabled,
  readOidcIdentity,
  resolveOidcUser,
} from "./oidc-identity.js";
import { consumeOidcState, OIDC_STATE_TTL_SECONDS } from "./oidc-state.js";

const CLIENT_ID = "werkyn";
const REDIRECT_URI = () => `${env.FRONTEND_URL}/api/auth/oidc/callback`;

// Talk directly to Dex on the internal port for backend-to-backend calls
// (discovery, token exchange, JWKS). Only the authorization_endpoint uses
// the external URL since the browser navigates there.
const DEX_INTERNAL_BASE = () => `http://127.0.0.1:${env.DEX_INTERNAL_PORT}/dex`;

let cachedAuthServer: oauth.AuthorizationServer | null = null;

async function getAuthServer(): Promise<oauth.AuthorizationServer> {
  if (cachedAuthServer) return cachedAuthServer;

  const internalBase = DEX_INTERNAL_BASE();
  const externalIssuer = `${env.FRONTEND_URL}/dex`;

  // Build the AuthorizationServer manually so backend-to-Dex calls
  // go directly to the internal port (no proxy round-trip).
  // The authorization_endpoint uses the external URL for browser redirects.
  cachedAuthServer = {
    issuer: externalIssuer,
    authorization_endpoint: `${externalIssuer}/auth`,
    token_endpoint: `${internalBase}/token`,
    userinfo_endpoint: `${internalBase}/userinfo`,
    jwks_uri: `${internalBase}/keys`,
  };

  return cachedAuthServer;
}

export function clearAuthServerCache(): void {
  cachedAuthServer = null;
}

const client: oauth.Client = { client_id: CLIENT_ID };

export async function initiateOidcLogin(
  prisma: PrismaClient,
  connectorId?: string,
  returnUrl?: string,
): Promise<{ authorizationUrl: string; state: string }> {
  await assertSsoEnabled(prisma, connectorId);
  const as = await getAuthServer();
  if (!as.authorization_endpoint) {
    throw new Error("Dex authorization endpoint not found");
  }

  const codeVerifier = oauth.generateRandomCodeVerifier();
  const codeChallenge = await oauth.calculatePKCECodeChallenge(codeVerifier);
  const state = crypto.randomBytes(32).toString("hex");
  const nonce = crypto.randomBytes(16).toString("hex");

  await prisma.oidcState.create({
    data: {
      state,
      codeVerifier,
      nonce,
      returnUrl,
      connectorId,
      expiresAt: new Date(Date.now() + OIDC_STATE_TTL_SECONDS * 1000),
    },
  });

  const authUrl = new URL(as.authorization_endpoint);
  authUrl.searchParams.set("client_id", CLIENT_ID);
  authUrl.searchParams.set("redirect_uri", REDIRECT_URI());
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", "openid email profile federated:id");
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("nonce", nonce);
  authUrl.searchParams.set("code_challenge", codeChallenge);
  authUrl.searchParams.set("code_challenge_method", "S256");

  if (connectorId) {
    authUrl.searchParams.set("connector_id", connectorId);
  }

  return { authorizationUrl: authUrl.toString(), state };
}

interface OidcCallbackResult {
  user: {
    id: string;
    email: string;
    displayName: string;
    avatarUrl: string | null;
    jobTitle: string | null;
    phone: string | null;
    timezone: string | null;
    emailVerified: boolean;
  };
  accessToken: string;
  refreshToken: string;
  returnUrl: string | null;
  workspaces: Array<{
    id: string;
    workspaceId: string;
    role: string;
    workspace: {
      id: string;
      name: string;
      slug: string;
      logoUrl: string | null;
    };
  }>;
}

export async function handleOidcCallback(
  prisma: PrismaClient,
  code: string,
  stateParam: string,
  browserState: string | undefined,
  issuerParam?: string,
): Promise<OidcCallbackResult> {
  const oidcState = await consumeOidcState(prisma, stateParam, browserState);
  await assertSsoEnabled(prisma, oidcState.connectorId);

  const as = await getAuthServer();
  const clientAuth = oauth.ClientSecretPost(env.DEX_CLIENT_SECRET);

  // Exchange code for tokens
  // Build callback URL params as the browser would have delivered them
  const callbackUrl = new URL(REDIRECT_URI());
  callbackUrl.searchParams.set("code", code);
  callbackUrl.searchParams.set("state", stateParam);
  if (issuerParam !== undefined)
    callbackUrl.searchParams.set("iss", issuerParam);

  // validateAuthResponse will throw AuthorizationResponseError on error
  const callbackParams = oauth.validateAuthResponse(
    as,
    client,
    callbackUrl,
    stateParam,
  );

  const isDev =
    env.NODE_ENV === "development" ||
    new URL(DEX_INTERNAL_BASE()).hostname === "127.0.0.1" ||
    new URL(DEX_INTERNAL_BASE()).hostname === "localhost";

  const tokenResponse = await oauth.authorizationCodeGrantRequest(
    as,
    client,
    clientAuth,
    callbackParams,
    REDIRECT_URI(),
    oidcState.codeVerifier,
    isDev ? { [allowInsecureRequests]: true } : {},
  );

  // processAuthorizationCodeResponse will throw ResponseBodyError on error
  const tokenResult = await oauth.processAuthorizationCodeResponse(
    as,
    client,
    tokenResponse,
    { expectedNonce: oidcState.nonce, requireIdToken: true },
  );

  // The token endpoint is reached over loopback HTTP. Verify its actual ID-token
  // signature instead of relying on transport authentication for the response.
  await oauth.validateApplicationLevelSignature(
    as,
    tokenResponse,
    isDev ? { [allowInsecureRequests]: true } : {},
  );

  const claims = oauth.getValidatedIdTokenClaims(tokenResult);
  if (!claims) {
    throw new UnauthorizedError("No ID token claims");
  }

  const identity = readOidcIdentity(claims, as.issuer);
  const user = await resolveOidcUser(prisma, identity, oidcState.connectorId);

  // Generate werkyn tokens. The access token names the new session.
  const { refreshToken, familyId } = await startRefreshSession(prisma, user.id);
  const accessToken = signAccessToken({
    sub: user.id,
    email: user.email,
    sid: familyId,
  });

  const workspaces = await prisma.workspaceMember.findMany({
    where: { userId: user.id },
    select: {
      id: true,
      workspaceId: true,
      role: true,
      workspace: {
        select: { id: true, name: true, slug: true, logoUrl: true },
      },
    },
  });

  return {
    user,
    accessToken,
    refreshToken,
    returnUrl: oidcState.returnUrl,
    workspaces,
  };
}
