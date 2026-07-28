import { prisma } from "@/lib/db";
import { SINGLETON_ID } from "@/lib/constants";
import { createPkce, randomState } from "@/lib/oauth-pkce";
import { encryptToken, decryptNullable } from "@/lib/crypto/token-cipher";

// Google OAuth 2.0 + Tasks API. Google has no dynamic client registration — you
// create an OAuth client once in Google Cloud Console and provide
// GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET via env.
const AUTHORIZE_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const TASKS_API = "https://tasks.googleapis.com/tasks/v1";
const SCOPE = "https://www.googleapis.com/auth/tasks";

// The Google Tasks list Reclaim syncs from (default per Reclaim's docs: "🗓 Reclaim").
// Match is case-insensitive "contains"; override the search term with env.
const RECLAIM_LIST_MATCH = (
  process.env.GOOGLE_TASKS_LIST_NAME ?? "reclaim"
).toLowerCase();

export { createPkce, randomState };

export function googleClient() {
  return {
    clientId: process.env.GOOGLE_CLIENT_ID ?? "",
    clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
  };
}

export function googleConfigured(): boolean {
  const { clientId, clientSecret } = googleClient();
  return Boolean(clientId && clientSecret);
}

async function getAuth() {
  return prisma.googleAuth.upsert({
    where: { id: SINGLETON_ID },
    create: { id: SINGLETON_ID },
    update: {},
  });
}

export function buildAuthorizeUrl(params: {
  redirectUri: string;
  state: string;
  codeChallenge: string;
}): string {
  const { clientId } = googleClient();
  const u = new URL(AUTHORIZE_ENDPOINT);
  u.searchParams.set("client_id", clientId);
  u.searchParams.set("redirect_uri", params.redirectUri);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", SCOPE);
  u.searchParams.set("access_type", "offline"); // get a refresh token
  u.searchParams.set("prompt", "consent"); // ensure refresh token is returned
  u.searchParams.set("include_granted_scopes", "true");
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
  const scope = t.scope ?? SCOPE;
  // upsert (not update): the singleton row may not exist on the first connect.
  await prisma.googleAuth.upsert({
    where: { id: SINGLETON_ID },
    create: {
      id: SINGLETON_ID,
      accessToken: encryptToken(t.access_token),
      refreshToken: t.refresh_token ? encryptToken(t.refresh_token) : null,
      expiresAt,
      scope,
      needsReconnect: false,
    },
    update: {
      accessToken: encryptToken(t.access_token),
      ...(t.refresh_token
        ? { refreshToken: encryptToken(t.refresh_token) }
        : {}),
      expiresAt,
      scope,
      needsReconnect: false,
    },
  });
}

export async function exchangeCode(
  code: string,
  codeVerifier: string,
  redirectUri: string,
): Promise<void> {
  const { clientId, clientSecret } = googleClient();
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    client_secret: clientSecret,
    code_verifier: codeVerifier,
  });
  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    throw new Error(`Google token exchange failed (${res.status})`);
  }
  await storeTokens((await res.json()) as TokenResponse);
}

async function refreshAccessToken(): Promise<string | null> {
  const auth = await getAuth();
  const refreshToken = decryptNullable(auth.refreshToken);
  if (!refreshToken) return null;
  const { clientId, clientSecret } = googleClient();
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
  });
  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    let errCode: string | undefined;
    try {
      errCode = ((await res.json()) as { error?: string }).error;
    } catch {
      /* non-JSON error body — treat as transient */
    }
    if (errCode === "invalid_grant") {
      // The refresh token is dead (revoked/expired). Presence of stale tokens
      // is what makes `connected` lie — clear them and flag for reconnect.
      await prisma.googleAuth.update({
        where: { id: SINGLETON_ID },
        data: {
          accessToken: null,
          refreshToken: null,
          expiresAt: null,
          needsReconnect: true,
        },
      });
    }
    return null;
  }
  const data = (await res.json()) as TokenResponse;
  await storeTokens(data);
  return data.access_token;
}

export async function getValidAccessToken(): Promise<string | null> {
  const auth = await getAuth();
  const accessToken = decryptNullable(auth.accessToken);
  if (!accessToken) return null;
  const soon = Date.now() + 60_000;
  if (auth.expiresAt && auth.expiresAt.getTime() <= soon) {
    return (await refreshAccessToken()) ?? null;
  }
  return accessToken;
}

export async function getGoogleStatus(): Promise<{
  configured: boolean;
  connected: boolean;
  needsReconnect: boolean;
}> {
  const auth = await getAuth();
  return {
    configured: googleConfigured(),
    connected: Boolean(auth.accessToken),
    needsReconnect: Boolean(auth.needsReconnect),
  };
}

const REVOKE_ENDPOINT = "https://oauth2.googleapis.com/revoke";

/**
 * Disconnect Google: best-effort server-side revoke (refresh token preferred —
 * revoking it kills the whole grant), then delete the stored row regardless.
 * Idempotent; revoke failures must never keep dead tokens around.
 */
export async function disconnectGoogle(): Promise<void> {
  const auth = await getAuth();
  const token =
    decryptNullable(auth.refreshToken) ?? decryptNullable(auth.accessToken);
  if (token) {
    try {
      await fetch(REVOKE_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token }),
      });
    } catch {
      // Best-effort: the row still gets deleted below.
    }
  }
  await prisma.googleAuth.deleteMany({ where: { id: SINGLETON_ID } });
}

// ── Google Tasks API ──────────────────────────────────────────────────────

/**
 * Percent-encode one identifier so it can only ever be a single path segment.
 *
 * `encodeURIComponent` neutralises `/`, `\`, `?`, `#` and everything else that
 * could add structure to the URL. It cannot neutralise a bare `.` or `..`:
 * dots are unreserved, so they survive encoding and the URL parser inside
 * `fetch` still resolves the segment as a directory hop. Encoding the dots
 * does not help either — `%2e%2e` is treated as a double-dot segment too. A
 * Google identifier is never empty, `.` or `..`, so reject those rather than
 * send a request to a path we did not mean to call.
 */
function pathSegment(value: string): string {
  if (value === "" || value === "." || value === "..") {
    throw new Error(
      `Invalid Google Tasks identifier: ${JSON.stringify(value)}`,
    );
  }
  return encodeURIComponent(value);
}

/**
 * Build a Google Tasks API URL. Every segment is encoded, so the invariant
 * ("an identifier cannot change the path or graft on a query") holds for new
 * endpoints too, instead of depending on each call site remembering to encode.
 */
function tasksUrl(...segments: string[]): string {
  return `${TASKS_API}/${segments.map(pathSegment).join("/")}`;
}

type TaskList = { id: string; title: string };

export async function listTaskLists(token: string): Promise<TaskList[]> {
  const res = await fetch(`${TASKS_API}/users/@me/lists?maxResults=100`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok)
    throw new Error(`Google Tasks list fetch failed (${res.status})`);
  const data = (await res.json()) as { items?: TaskList[] };
  return data.items ?? [];
}

/** Find the Google Tasks list Reclaim syncs (title contains "reclaim"). */
export async function findReclaimList(token: string): Promise<TaskList | null> {
  const lists = await listTaskLists(token);
  return (
    lists.find((l) => l.title.toLowerCase().includes(RECLAIM_LIST_MATCH)) ??
    null
  );
}

export async function createGoogleTask(
  token: string,
  listId: string,
  input: { title: string; notes?: string; due?: string },
): Promise<{ id: string }> {
  const res = await fetch(tasksUrl("lists", listId, "tasks"), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      title: input.title,
      notes: input.notes,
      ...(input.due ? { due: input.due } : {}),
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Google Tasks create failed (${res.status}) ${detail}`);
  }
  return (await res.json()) as { id: string };
}

/**
 * PATCH a Google Task (title/status/notes). Best-effort — returns ok.
 * Throws only if an identifier is unusable (see {@link pathSegment}); callers
 * already skip steps with a missing list/task id.
 */
export async function patchGoogleTask(
  token: string,
  listId: string,
  taskId: string,
  patch: { title?: string; status?: "needsAction" | "completed" },
): Promise<boolean> {
  const res = await fetch(tasksUrl("lists", listId, "tasks", taskId), {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(patch),
  });
  return res.ok;
}
