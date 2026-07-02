import crypto from "node:crypto";
import { prisma } from "@/lib/db";
import { SINGLETON_ID } from "@/lib/constants";

// Reclaim MCP OAuth 2.1 endpoints (discovered from
// https://mcp.reclaim.ai/.well-known/oauth-authorization-server).
export const RECLAIM_MCP_URL = "https://mcp.reclaim.ai";
const REGISTRATION_ENDPOINT = "https://api.app.reclaim.ai/oauth2/register";
const AUTHORIZE_ENDPOINT = "https://api.app.reclaim.ai/oauth2/authorize";
const TOKEN_ENDPOINT = "https://api.app.reclaim.ai/oauth2/token";
const SCOPES = "read write mcp";

// ── PKCE helpers ──────────────────────────────────────────────────────────
export function createPkce() {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto
    .createHash("sha256")
    .update(verifier)
    .digest("base64url");
  return { verifier, challenge };
}

export function randomState() {
  return crypto.randomBytes(16).toString("base64url");
}

// ── Dynamic client registration (once) ────────────────────────────────────
async function getAuth() {
  return prisma.reclaimAuth.upsert({
    where: { id: SINGLETON_ID },
    create: { id: SINGLETON_ID },
    update: {},
  });
}

/**
 * Ensure we have a registered OAuth client for this exact redirect URI.
 * Re-registers (new client) if the origin changed (e.g. dev port → deploy URL),
 * since a client's redirect_uris are fixed at registration.
 */
export async function ensureClient(redirectUri: string): Promise<{
  clientId: string;
  clientSecret: string | null;
}> {
  const auth = await getAuth();
  if (auth.clientId && auth.redirectUri === redirectUri) {
    return { clientId: auth.clientId, clientSecret: auth.clientSecret };
  }
  const res = await fetch(REGISTRATION_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "dlectroflow",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "client_secret_post",
      scope: SCOPES,
    }),
  });
  if (!res.ok) {
    throw new Error(`Reclaim client registration failed (${res.status})`);
  }
  const data = (await res.json()) as {
    client_id: string;
    client_secret?: string;
  };
  await prisma.reclaimAuth.update({
    where: { id: SINGLETON_ID },
    data: {
      clientId: data.client_id,
      clientSecret: data.client_secret ?? null,
      redirectUri,
      // new client ⇒ any previous tokens are invalid
      accessToken: null,
      refreshToken: null,
      expiresAt: null,
    },
  });
  return { clientId: data.client_id, clientSecret: data.client_secret ?? null };
}

export function buildAuthorizeUrl(params: {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
}): string {
  const u = new URL(AUTHORIZE_ENDPOINT);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", params.clientId);
  u.searchParams.set("redirect_uri", params.redirectUri);
  u.searchParams.set("scope", SCOPES);
  u.searchParams.set("state", params.state);
  u.searchParams.set("code_challenge", params.codeChallenge);
  u.searchParams.set("code_challenge_method", "S256");
  return u.toString();
}

type TokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
};

async function storeTokens(t: TokenResponse) {
  const expiresAt = t.expires_in
    ? new Date(Date.now() + t.expires_in * 1000)
    : null;
  await prisma.reclaimAuth.update({
    where: { id: SINGLETON_ID },
    data: {
      accessToken: t.access_token,
      // Reclaim may omit a new refresh_token on refresh — keep the old one.
      ...(t.refresh_token ? { refreshToken: t.refresh_token } : {}),
      expiresAt,
      scope: t.scope ?? SCOPES,
    },
  });
}

/** Exchange an authorization code for tokens and persist them. */
export async function exchangeCode(
  code: string,
  codeVerifier: string,
  redirectUri: string,
): Promise<void> {
  const auth = await getAuth();
  if (!auth.clientId) throw new Error("No registered Reclaim client.");
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: auth.clientId,
    code_verifier: codeVerifier,
  });
  if (auth.clientSecret) body.set("client_secret", auth.clientSecret);

  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    throw new Error(`Reclaim token exchange failed (${res.status})`);
  }
  await storeTokens((await res.json()) as TokenResponse);
}

async function refreshAccessToken(): Promise<string | null> {
  const auth = await getAuth();
  if (!auth.clientId || !auth.refreshToken) return null;
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: auth.refreshToken,
    client_id: auth.clientId,
  });
  if (auth.clientSecret) body.set("client_secret", auth.clientSecret);

  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) return null;
  const data = (await res.json()) as TokenResponse;
  await storeTokens(data);
  return data.access_token;
}

/** Return a valid access token, refreshing if needed; null if not connected. */
export async function getValidAccessToken(): Promise<string | null> {
  const auth = await getAuth();
  if (!auth.accessToken) return null;
  const soon = Date.now() + 60_000;
  if (auth.expiresAt && auth.expiresAt.getTime() <= soon) {
    return (await refreshAccessToken()) ?? null;
  }
  return auth.accessToken;
}

export async function getReclaimStatus(): Promise<{
  connected: boolean;
  expiresAt: Date | null;
}> {
  const auth = await getAuth();
  return { connected: Boolean(auth.accessToken), expiresAt: auth.expiresAt };
}

export async function disconnectReclaim(): Promise<void> {
  await prisma.reclaimAuth.update({
    where: { id: SINGLETON_ID },
    data: {
      accessToken: null,
      refreshToken: null,
      expiresAt: null,
      scope: null,
    },
  });
}
