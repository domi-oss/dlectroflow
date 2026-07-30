import { prisma } from "@/lib/db";
import { createPkce, randomState } from "@/lib/oauth-pkce";
import { encryptToken, decryptNullable } from "@/lib/crypto/token-cipher";

// Google OAuth 2.0 + Tasks API. Google has no dynamic client registration — you
// create an OAuth client once in Google Cloud Console and provide
// GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET via env.
const AUTHORIZE_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const TASKS_API = "https://tasks.googleapis.com/tasks/v1";
const SCOPE = "https://www.googleapis.com/auth/tasks";

// The Google Tasks list Reclaim syncs from. Reclaim syncs EXCLUSIVELY from its
// own "🗓 Reclaim" list — per its docs, "any other tasks in other lists will not
// be synced" — so pointing GOOGLE_TASKS_LIST_NAME at a different list means
// Reclaim never sees anything we push. That is not a broken push: it is a list
// with no scheduler attached, which is a legitimate setup for a self-hoster
// without Reclaim, and `pickEncoder` detects it and drops the Reclaim syntax.
// Match is case-insensitive "contains".
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

/**
 * One user's Google credential, or null.
 *
 * #118 Phase C: a genuine `findUnique`, not the `upsert` it used to be. The old
 * version MATERIALISED a row on every read, so the unconditional
 * `getGoogleStatus()` on the inbox page created a credential row for anonymous
 * guests — and a read that writes cannot answer "is there a row?" honestly.
 *
 * `userId` is a unique column, so this is a primary-key-grade lookup. There is
 * no `id` parameter anywhere in this file's public surface: the row is reached
 * BY the acting user, so there is nothing a caller could point somewhere else.
 * `src/lib/__tests__/scoping.harness.test.ts` asserts that structurally.
 */
async function getAuth(userId: string) {
  return prisma.googleAuth.findUnique({ where: { userId } });
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

async function storeTokens(userId: string, t: TokenResponse) {
  const expiresAt = t.expires_in
    ? new Date(Date.now() + t.expires_in * 1000)
    : null;
  const scope = t.scope ?? SCOPE;
  // upsert (not update): this user may be connecting for the first time.
  //
  // `userId` is in `create` and deliberately NOT in `update`. The unique index
  // sits on a NULLABLE column, so Postgres will happily hold many
  // `userId IS NULL` rows — a create that forgot the binding would accumulate
  // orphaned credentials silently instead of failing. And an update that wrote
  // `userId` could RE-KEY an existing row, which is precisely how one account's
  // connection becomes another's (#119).
  await prisma.googleAuth.upsert({
    where: { userId },
    create: {
      userId,
      accessToken: encryptToken(t.access_token),
      refreshToken: t.refresh_token ? encryptToken(t.refresh_token) : null,
      expiresAt,
      scope,
      needsReconnect: false,
    },
    update: {
      accessToken: encryptToken(t.access_token),
      // Google omits refresh_token on a re-consent; overwriting it with null
      // would silently end the grant at the next expiry.
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
  userId: string,
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
  await storeTokens(userId, (await res.json()) as TokenResponse);
}

async function refreshAccessToken(userId: string): Promise<string | null> {
  const auth = await getAuth(userId);
  const refreshToken = decryptNullable(auth?.refreshToken);
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
        where: { userId },
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
  await storeTokens(userId, data);
  return data.access_token;
}

export async function getValidAccessToken(
  userId: string,
): Promise<string | null> {
  const auth = await getAuth(userId);
  if (!auth) return null;
  const accessToken = decryptNullable(auth.accessToken);
  if (!accessToken) return null;
  const soon = Date.now() + 60_000;
  if (auth.expiresAt && auth.expiresAt.getTime() <= soon) {
    return (await refreshAccessToken(userId)) ?? null;
  }
  return accessToken;
}

/**
 * One user's connection status, or the instance-level answer for nobody.
 *
 * `userId === null` means "no signed-in account" (a guest, or an anonymous
 * request) and short-circuits BEFORE any query: a guest has no credential to
 * report and must learn nothing about anyone else's.
 *
 * `connected` is derived from DECRYPTABILITY, not from ciphertext presence. The
 * old `Boolean(auth.accessToken)` meant that after a TOKEN_ENC_KEY rotation the
 * UI said "Connected" while every push returned "not connected". An unreadable
 * credential also sets `needsReconnect`, because reconnecting is exactly the
 * action that fixes it — a bare "Not connected" tells the user nothing about a
 * row that is sitting right there.
 */
export async function getGoogleStatus(userId: string | null): Promise<{
  configured: boolean;
  connected: boolean;
  needsReconnect: boolean;
}> {
  const configured = googleConfigured();
  if (!userId) return { configured, connected: false, needsReconnect: false };
  const auth = await getAuth(userId);
  if (!auth) return { configured, connected: false, needsReconnect: false };
  const connected = Boolean(decryptNullable(auth.accessToken));
  return {
    configured,
    connected,
    needsReconnect:
      Boolean(auth.needsReconnect) || (Boolean(auth.accessToken) && !connected),
  };
}

const REVOKE_ENDPOINT = "https://oauth2.googleapis.com/revoke";

/**
 * Disconnect ONE user's Google account: best-effort server-side revoke (refresh
 * token preferred — revoking it kills the whole grant), then delete that user's
 * row regardless. Idempotent; revoke failures must never keep dead tokens
 * around. `deleteMany` rather than `delete` so a user with no row is a no-op
 * instead of a thrown `RecordNotFound`.
 */
export async function disconnectGoogle(userId: string): Promise<void> {
  const auth = await getAuth(userId);
  const token =
    decryptNullable(auth?.refreshToken) ?? decryptNullable(auth?.accessToken);
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
  await prisma.googleAuth.deleteMany({ where: { userId } });
}

/**
 * {@link disconnectGoogle} with its failure contained. Never throws (#126).
 *
 * The account-lifecycle callers — freezing a member (`revokePerson`) and
 * deleting an account (`deleteAccount`) — must withdraw the grant BEFORE the
 * account stops being reachable, because after that point nothing in the
 * product can: a frozen account resolves to `null` in `currentUser()`, so its
 * owner can no longer reach the Disconnect control, and a deleted `User`
 * cascades the credential away without ever telling Google.
 *
 * But the revoke must never abort the step that asked for it. An account left
 * ACTIVE because Google was unreachable is worse than a grant that has to be
 * withdrawn at Google's end, so this reports the outcome instead of raising it.
 * `disconnectGoogle` already swallows a failing revoke CALL and deletes the row
 * regardless; what this adds is the same containment for the database half.
 *
 * Returns whether the disconnect completed. A failure gets one structured,
 * greppable line, because "a grant this app could not withdraw" is precisely
 * the state an operator has to go and clear by hand at Google's end.
 */
export async function tryDisconnectGoogle(userId: string): Promise<boolean> {
  try {
    await disconnectGoogle(userId);
    return true;
  } catch (err) {
    // The id, not the token or the identity: enough to find the account, and
    // this is the same pseudonymous key the purge job logs (purge_skip).
    console.error(
      JSON.stringify({
        tag: "google_disconnect_failed",
        userId,
        message: err instanceof Error ? err.message : String(err),
        ts: new Date().toISOString(),
      }),
    );
    return false;
  }
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
  patch: {
    title?: string;
    notes?: string;
    /** RFC 3339. Google Tasks stores date-only precision but accepts a timestamp. */
    due?: string;
    status?: "needsAction" | "completed";
  },
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

/**
 * Create-or-update one Google Task (#104).
 *
 * Both scheduling call sites used to POST unconditionally, so every re-schedule
 * added a second task and Reclaim dutifully booked a second block. `Step`
 * already persists `googleTaskId`; this is the function that finally reads it.
 * Reclaim two-way-syncs title/duration/due edits, so a PATCH MOVES the existing
 * calendar block rather than leaving a stale twin behind.
 *
 * A 404 means the task was deleted in Google since we stored the id — recreate
 * rather than fail, since the user's intent is "this should be scheduled".
 * Anything else throws: silently dropping a schedule is worse than an error.
 */
export async function upsertGoogleTask(
  token: string,
  listId: string,
  existingTaskId: string | null,
  body: { title: string; notes?: string; due?: string },
): Promise<{ id: string; created: boolean }> {
  const payload = {
    title: body.title,
    ...(body.notes != null ? { notes: body.notes } : {}),
    ...(body.due ? { due: body.due } : {}),
  };

  if (existingTaskId) {
    const res = await fetch(
      tasksUrl("lists", listId, "tasks", existingTaskId),
      {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      },
    );
    if (res.ok) return { id: existingTaskId, created: false };
    if (res.status !== 404) {
      const detail = await res.text().catch(() => "");
      throw new Error(`Google Tasks update failed (${res.status}) ${detail}`);
    }
    // Fall through: it is gone in Google, so create a replacement.
  }

  const created = await createGoogleTask(token, listId, {
    title: body.title,
    notes: body.notes,
    due: body.due,
  });
  return { id: created.id, created: true };
}
