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

/**
 * How long ANY one call to Google may take before it is abandoned (#211).
 *
 * Node's fetch defaults to a **300 s** header timeout, so an endpoint that
 * accepts the connection and then goes quiet holds the request for five minutes
 * with no error and nothing on screen. That is not hypothetical here: the OAuth
 * callback is a browser navigation with no client-side bound at all, so a
 * stalled token exchange is five minutes of blank page after someone clicks
 * Connect — the same failure `PROVIDER_FETCH_TIMEOUT_MS` was added for in
 * `src/lib/auth/providers.ts`, on the same kind of call to a different provider.
 *
 * **One constant for the whole module**, which is the half of #211 that outlives
 * the fix: `!288` covered the PATCH and left six calls uncovered, and #155 and
 * #194 add more callers next. Anything reaching Google from here uses this
 * rather than a literal of its own, and `google.test.ts` counts the two against
 * each other so a new call site cannot quietly skip it.
 *
 * `TASKS_PATCH_TIMEOUT_MS` folded into this. It was 10 s for the bulk-complete
 * loop, and two numbers with two rationales for one module is the state the
 * issue exists to end.
 *
 * `AbortSignal.timeout` rather than the hand-owned timer in
 * `focus-catalog-source.ts`: that shape exists to avoid truncating a long body,
 * and the largest response here is the task-list read — capped at
 * `maxResults=100` — so every response is small JSON. A server that answers
 * promptly and then trickles the body hits this deadline too, which is measured
 * rather than hoped for — see {@link isDeadlineRejection}. **This is a
 * WHOLE-CALL budget, not a per-phase one:** the clock starts at signal creation
 * and covers the headers and the body together, so a call that spends 6 s on
 * headers has 2 s left for its body.
 *
 * ── Why 8 s and not the house 10 s ──────────────────────────────────────────
 *
 * **It has to fit strictly inside the client's own wait, with room to return**
 * (Duo review, `!368`). Four surfaces bound a server action at 10 s with
 * `withActionTimeout` — `INBOX_ACTION_TIMEOUT_MS` and its three siblings — and
 * one of those actions reaches Google inside that bound: `completeItem`
 * (`braindump.ts:1167`) awaits its Google sync, and the inbox row runs it
 * through the wrapper. At an equal 10 s a stalled Google releases the server at
 * the same instant the client gives up, and the response still has to be
 * serialised and sent after that — so the client wins and reports a completion
 * that LANDED LOCALLY as a failed write, with Retry armed on it.
 *
 * 8 s keeps 2 s of margin for that return trip, and is still far above a slow
 * mobile round trip to Google. `google.test.ts` asserts the inequality against
 * all four client budgets rather than trusting this paragraph, so retuning
 * either side cannot silently invert it.
 *
 * What the margin does NOT buy, because no per-call budget can: a POOL of calls
 * (a bulk complete, a multi-step push) still outlasts any client wait. That is
 * why every Google leg behind a client-bounded action is best-effort and
 * swallowed, while the surfaces that actually render a Google timeout message —
 * `runSchedule` in `inbox-view.tsx`, `breakdown-chat.tsx`, `task-schedule.tsx` —
 * carry no client-side wait at all.
 *
 * ── And why `PROVIDER_FETCH_TIMEOUT_MS` is separate ─────────────────────────
 *
 * Still deliberately NOT imported (Duo review, `!288`), and now for a stated
 * reason rather than "equal by coincidence": that one bounds a **browser
 * navigation** through the sign-in callback, where nothing else is holding a
 * timer, so it has no inequality to satisfy and 10 s is right for it. This one
 * has to fit under a client wrapper. Two different constraints, so two
 * constants — and sharing them would let a slow identity provider's retune
 * silently break this module's margin.
 */
export const GOOGLE_FETCH_TIMEOUT_MS = 8_000;

/**
 * The deadline above fired, expressed as something a caller can act on.
 *
 * The raw rejection is a `DOMException` named `TimeoutError` whose message is
 * "The operation was aborted due to timeout" — and it satisfies `instanceof
 * Error`, so the OAuth callback's `err instanceof Error ? err.message` branch
 * would put that sentence in a URL and the inbox banner would print it. Every
 * call site below therefore converts it into a sentence that names the
 * CONSEQUENCE, because that is the part the reader has to act on.
 *
 * Exported so `src/app/api/google/oauth/callback/route.ts` can tell a deadline
 * apart from Google refusing the exchange: the first is retryable and the second
 * is not, and only one of them should offer to connect again.
 */
export class GoogleTimeoutError extends Error {
  constructor(consequence: string) {
    super(
      `Google did not respond within ${GOOGLE_FETCH_TIMEOUT_MS / 1000}s — ${consequence}`,
    );
    this.name = "GoogleTimeoutError";
  }
}

/**
 * The `reason` the OAuth callback redirects with when the exchange timed out,
 * and the value the inbox banner branches on to offer a reconnect.
 *
 * One token, one definition: the route writes it into the URL and the page reads
 * it back, and two surfaces spelling the same literal is how a banner comes to
 * silently stop matching.
 */
export const GOOGLE_TIMEOUT_REASON = "timed_out";

/**
 * Is this rejection OUR deadline firing, or Google failing some other way?
 *
 * `fetch` rejects with the signal's own reason, which for `AbortSignal.timeout`
 * is a `DOMException` named `TimeoutError`. Measured against a server that
 * accepts the connection and never answers, on both Node majors this app runs
 * on — `node:22-alpine` (v22.23.1, the CI image) and v26.4.0 — with no wrapping
 * `TypeError` and no `cause` chain in either.
 *
 * ── It covers the BODY read too, and that was measured rather than assumed ──
 *
 * Duo review, `!368`, asked whether a stall *after* the headers is classified.
 * Against a server that writes the status line and one byte of JSON and then
 * goes silent, on `node:22-alpine`:
 *
 *   headers at 9ms; `res.json()` rejected at 609ms on a 600ms budget
 *   DOMException / TimeoutError / "The operation was aborted due to timeout"
 *
 * `res.text()` is identical. So the signal stays live through body consumption,
 * one clock covers headers AND body from signal creation, and the rejection has
 * the same shape — this predicate needs no widening and the budget needs no
 * second timer.
 *
 * ⚠️ **What DID need fixing is where the `try` ends.** The body reads sat
 * outside it, so a correctly-shaped rejection escaped unclassified as a raw
 * `DOMException` — and because that satisfies `instanceof Error`, the OAuth
 * callback's `err.message` fallback printed the abort text onto the banner.
 * Every body read is now inside its call site's guard, and
 * `google.test.ts` pins the decided outcome for a mid-body stall per call site.
 *
 * Everything else keeps its own identity on purpose. A dropped socket, an
 * unresolvable host and a malformed JSON body are different faults with
 * different first moves, and relabelling them "Google was slow" sends the
 * reader looking for the wrong thing.
 */
function isDeadlineRejection(err: unknown): boolean {
  return err instanceof Error && err.name === "TimeoutError";
}

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
  let tokens: TokenResponse;
  // The body read is INSIDE, and that is the point (Duo review, !368) — see
  // {@link isDeadlineRejection} for the measurement. The signal covers headers
  // and body from one clock, so a mid-body stall rejects with the same
  // `TimeoutError`; leaving `res.json()` outside meant that rejection escaped
  // unclassified, and because a `DOMException` satisfies `instanceof Error` the
  // callback's `err.message` fallback printed "The operation was aborted due to
  // timeout" straight onto the banner. `storeTokens` stays outside: a database
  // failure is not a deadline and must not be reported as one.
  try {
    const res = await fetch(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(GOOGLE_FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new Error(`Google token exchange failed (${res.status})`);
    }
    tokens = (await res.json()) as TokenResponse;
  } catch (err) {
    // The worst of the six, and the one with no client-side bound of any kind:
    // this runs inside a browser navigation to /api/google/oauth/callback, so
    // until this deadline existed a stalled Google meant five minutes of blank
    // page for someone who had just clicked Connect.
    //
    // Nothing has been written at this point, so the state is exactly what it
    // was before the attempt — which is what makes "try connecting again" a
    // safe thing to offer rather than a guess. The route turns this into
    // `reason=timed_out` and the banner offers the affordance. The refusal
    // thrown just above passes through unchanged, because it is not a deadline.
    if (isDeadlineRejection(err)) {
      throw new GoogleTimeoutError(
        "nothing was connected. Try connecting again.",
      );
    }
    throw err;
  }
  await storeTokens(userId, tokens);
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
  let data: TokenResponse;
  // Body read inside the guard, same as `exchangeCode` and for the same
  // measured reason (!368). The `invalid_grant` branch stays inside too, and
  // that is safe: it either returns null or throws a database error, and a
  // database error is not a deadline so the classifier below rethrows it whole.
  try {
    const res = await fetch(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(GOOGLE_FETCH_TIMEOUT_MS),
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
    data = (await res.json()) as TokenResponse;
  } catch (err) {
    // A deadline is TRANSIENT, and that distinction is the whole point of
    // handling it here. This function's one destructive branch — clearing the
    // tokens and setting `needsReconnect` — belongs to `invalid_grant` and
    // nothing else: it means Google has told us the grant is dead. A timeout
    // tells us nothing about the grant, so treating it the same way would send
    // a perfectly connected person back through consent because of a slow
    // network.
    //
    // `null` is what the non-`invalid_grant` failure branch below already
    // returns for a 5xx, and every caller reads it the same way: the
    // best-effort sync paths (`google-task-sync.ts`) skip and report "not
    // synced", and the interactive push returns `not_connected`, which the
    // schedule surfaces render as the words "Google Tasks isn't connected."
    // Words only — the row's own control is driven by the SERVER-rendered
    // status, which after a timeout still reads connected because the tokens
    // are untouched, so no Connect affordance appears and none should: nothing
    // is wrong with the credential. Returning it here also
    // stops the raw abort propagating out of `pushStepsToGoogleTasks`, which
    // resolves its token OUTSIDE its try/catch — so a rejection there escapes
    // the server action rather than becoming a result the UI can render.
    if (isDeadlineRejection(err)) return null;
    throw err;
  }
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

/** Why a disconnect did not fully succeed. The two are different states with
 *  different clean-ups, so they are never logged as one. */
type DisconnectFailure =
  /** The tokens are gone from here, but Google did not accept the revoke, so
   *  the grant may still be listed in the person's own Google account. Nothing
   *  left at this end can retry it — clearing it is a manual step at
   *  <https://myaccount.google.com/permissions>. */
  | "revoke_rejected"
  /** The stored tokens could not be deleted. The credential row may still be
   *  sitting here, decryptable, on an account that is about to stop being
   *  reachable — #126's own failure state, reached through a database fault.
   *  On the DELETION path the FK cascade still clears it; on the FREEZE path
   *  there is no backstop and it needs clearing by hand. */
  | "tokens_not_cleared";

function logDisconnectFailure(
  userId: string,
  reason: DisconnectFailure,
  message?: string,
): void {
  // The id, not the token or the identity: enough to find the account, and the
  // same pseudonymous key the purge job logs (purge_skip).
  console.error(
    JSON.stringify({
      tag: "google_disconnect_failed",
      reason,
      userId,
      ...(message === undefined ? {} : { message }),
      ts: new Date().toISOString(),
    }),
  );
}

/**
 * Disconnect ONE user's Google account: best-effort server-side revoke (refresh
 * token preferred — revoking it kills the whole grant), then delete that user's
 * row regardless. Idempotent; revoke failures must never keep dead tokens
 * around. `deleteMany` rather than `delete` so a user with no row is a no-op
 * instead of a thrown `RecordNotFound`.
 *
 * Returns whether the GRANT was withdrawn — `true` also for a user with no
 * token, because nothing to revoke is not a failure to revoke. The two halves
 * fail differently and on purpose:
 *
 *  • A failed revoke is RETURNED, and logged here rather than by the callers,
 *    so the log line exists however the disconnect was reached. The tokens go
 *    either way, so there is no decision left to make — but there is one step
 *    left to TAKE, and only the account holder can take it, at
 *    <https://myaccount.google.com/permissions>. Callers are expected to act on
 *    `false`: `disconnectGoogleTasks` passes it to the person who clicked
 *    Disconnect, and the lifecycle paths log it for the operator (#126).
 *  • A failed DELETE still THROWS, because a surviving row means the disconnect
 *    did not happen. `disconnectGoogleTasks` must not tell someone who clicked
 *    Disconnect that it worked. Lifecycle callers contain it instead — see
 *    {@link tryDisconnectGoogle}.
 */
export async function disconnectGoogle(userId: string): Promise<boolean> {
  const auth = await getAuth(userId);
  const token =
    decryptNullable(auth?.refreshToken) ?? decryptNullable(auth?.accessToken);
  let revoked = true;
  if (token) {
    try {
      const res = await fetch(REVOKE_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token }),
        signal: AbortSignal.timeout(GOOGLE_FETCH_TIMEOUT_MS),
      });
      // `fetch` rejects only on a network-level failure — a 400 for a grant
      // Google has already expired, or a 5xx, RESOLVES. Reading `res.ok` is the
      // difference between "the grant is withdrawn" and "we asked"; without it
      // every realistic revoke failure was reported as a success.
      revoked = res.ok;
    } catch {
      // #211 — the deadline needs no new branch here, and that is the decision
      // rather than an omission: "we asked and got no answer" is already
      // `revoke_rejected`, which is exactly what a timeout leaves behind. The
      // tokens still go, because a grant we could not revoke is more reason to
      // drop the token, not less. All the deadline changes is that the person
      // who clicked Disconnect gets their dialog back in ten seconds instead of
      // five minutes — `integrations-panel.tsx` awaits this action unwrapped.
      revoked = false;
    }
    // Logged here, before the delete, not after it: the delete can throw, and a
    // throw would take this line with it. The operator would then be told to
    // clear a surviving row and never learn that the grant ALSO needs clearing
    // at Google — two states, two clean-ups, and the double failure is exactly
    // when losing one of them costs the most.
    if (!revoked) logDisconnectFailure(userId, "revoke_rejected");
  }
  await prisma.googleAuth.deleteMany({ where: { userId } });
  return revoked;
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
 *
 * Returns whether the disconnect FULLY succeeded — revoked at Google and
 * cleared here. Neither caller can act on `false` (access must stop either
 * way), so the value is for tests and future callers; the operator's signal is
 * the log line, one per failure, carrying which of the two states it left
 * behind. See {@link DisconnectFailure} — they need different clean-ups. The
 * `revoke_rejected` half is logged by `disconnectGoogle` itself, so it is
 * reported for the interactive Disconnect too; only the containment is here.
 */
export async function tryDisconnectGoogle(userId: string): Promise<boolean> {
  try {
    return await disconnectGoogle(userId);
  } catch (err) {
    logDisconnectFailure(
      userId,
      "tokens_not_cleared",
      err instanceof Error ? err.message : String(err),
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
  let data: { items?: TaskList[] };
  // Body read inside the guard (!368): the response is a list of up to a
  // hundred lists, so it is the largest body this module reads and the likeliest
  // of the four to stall part-way through.
  try {
    const res = await fetch(`${TASKS_API}/users/@me/lists?maxResults=100`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(GOOGLE_FETCH_TIMEOUT_MS),
    });
    if (!res.ok)
      throw new Error(`Google Tasks list fetch failed (${res.status})`);
    data = (await res.json()) as { items?: TaskList[] };
  } catch (err) {
    // A read, and the first call a push makes — so nothing has been written
    // anywhere yet and the message can say so without qualification.
    //
    // It does reach the user: `pushStepsToGoogleTasks` returns it as its
    // `error` message, and `runSchedule` (`inbox-view.tsx`) and
    // `task-schedule.tsx` both prefer `res.message` over their dictionary.
    // ⚠️ `breakdown-chat.tsx` resolves the other way round — `map[res.reason]
    // ?? res.message` — and prints this only because `"error"` has no entry in
    // that map. Adding one would silently swallow every message this module
    // writes.
    if (isDeadlineRejection(err)) {
      throw new GoogleTimeoutError("nothing was scheduled.");
    }
    throw err;
  }
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
  // Body read inside the guard (!368), and this is the site where it changes
  // the ANSWER rather than only the wording. A stall while reading the create
  // response means Google accepted the POST and had begun replying, so the task
  // very likely exists — leaking a raw abort here loses precisely the warning
  // that stops the reader making a second one.
  try {
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
      signal: AbortSignal.timeout(GOOGLE_FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`Google Tasks create failed (${res.status}) ${detail}`);
    }
    return (await res.json()) as { id: string };
  } catch (err) {
    // The one message that must NOT claim nothing happened. The deadline fires
    // at this end; the POST may already have reached Google and created the
    // task before it went quiet. Telling someone "nothing was scheduled" here
    // is what walks them into pressing the button again and getting a second
    // task, and a second Reclaim block on their calendar.
    if (isDeadlineRejection(err)) {
      throw new GoogleTimeoutError(
        "the task may or may not have been created. Check your Google Tasks list before trying again.",
      );
    }
    throw err;
  }
}

/**
 * PATCH a Google Task (title/status/notes). Best-effort — returns ok.
 *
 * Throws only if an identifier is unusable (see {@link pathSegment}); callers
 * already skip steps with a missing list/task id. A timed-out request rejects,
 * which every caller already treats as "not synced" — `google-task-sync.ts`
 * swallows it structurally rather than leaving each call site to remember.
 *
 * This is the call `!288` (#195) gave the module's first deadline, because it
 * put the call inside `completeItem`, which `bulkBrainDumpAction` runs in a
 * sequential loop: one stalled connection there stops being a slow request and
 * becomes a bulk operation that never returns — twenty selected to-dos against
 * Node's 300 s default is an hour and forty minutes. That reasoning still holds
 * and is why the loop is worth naming here; what has changed is that it is no
 * longer the only covered call, so its own `TASKS_PATCH_TIMEOUT_MS` is gone and
 * the shared {@link GOOGLE_FETCH_TIMEOUT_MS} does the job for all seven (#211).
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
  let res: Response;
  try {
    res = await fetch(tasksUrl("lists", listId, "tasks", taskId), {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(patch),
      signal: AbortSignal.timeout(GOOGLE_FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    // ⚠️ Nobody reads this message today, and the mapping is here anyway.
    //
    // Both callers discard it with a bare catch and no log line — `patchOne`
    // (`google-task-sync.ts`) returns false, and the requeue in
    // `focus.ts` lets the Google title drift. So this is NOT an observability
    // claim; the JSDoc above ("swallows it structurally") is the accurate
    // description of where it goes, which is nowhere. (Duo review, !368: this
    // comment used to assert the message "reaches an operator", contradicting
    // that JSDoc and its own opening clause in one sentence.)
    //
    // What it is for is the module's CONTRACT being uniform. Every call here
    // that hands a deadline BACK to its caller turns it into a
    // `GoogleTimeoutError` — five of the seven, asserted per call site in
    // `google.test.ts`. The other two never reject at all and decide it
    // locally instead: the refresh returns null, the revoke reports
    // `revoked: false`. Leaving the PATCH as the one exception would
    // mean a caller that catches the type — as the OAuth callback does — misses
    // this one silently, and the wording is settled now so that whoever first
    // surfaces it does not have to reconstruct what a stalled PATCH left
    // behind. Adding the log to back it up is a real change to a
    // best-effort path (it fires per item, so a bulk complete against a stalled
    // Google is one line per row), not a comment fix, so it is not smuggled in
    // here.
    if (isDeadlineRejection(err)) {
      throw new GoogleTimeoutError("the task was not confirmed updated.");
    }
    throw err;
  }
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
    let res: Response;
    try {
      res = await fetch(tasksUrl("lists", listId, "tasks", existingTaskId), {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(GOOGLE_FETCH_TIMEOUT_MS),
      });
    } catch (err) {
      // #211 — this must THROW, and the fall-through below is exactly why.
      // Recreating is right for a 404, where Google has told us the task is
      // gone; a deadline tells us nothing, and the task is most likely still
      // sitting there. Continuing would POST a second one, and Reclaim would
      // book a second calendar block for the same step — the duplicate #104
      // exists to have stopped.
      if (isDeadlineRejection(err)) {
        throw new GoogleTimeoutError(
          "the task may not have been updated, and was not replaced.",
        );
      }
      throw err;
    }
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
