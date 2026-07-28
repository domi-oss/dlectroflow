import { SignJWT, jwtVerify } from "jose";

// The signed-in session cookie. The NAME is deliberately unchanged across the
// #35 Phase A cutover — only the payload inside it changed — so nothing else in
// the app (or in the e2e storage state) has to move at the same time.
export const OWNER_COOKIE = "df_owner";
export const GUEST_COOKIE = "df_guest";
// Middleware forwards the signed guest session token (JWT) on this request header
// so the SAME request's server components can read it before the cookie round-trips.
// resolveWorkspaceId calls verifySession to verify the JWT before trusting it —
// that verification is the IDOR defense; the header NEVER carries a raw workspace id.
// Homed here (pure, Edge-safe) so both middleware and workspace.ts can import it.
export const GUEST_WS_HEADER = "x-guest-ws";

/**
 * #35 Phase A: `{ kind: "owner"; sub }` is GONE, replaced by a real account.
 * `userId` is who you are, `wsId` is the workspace they own — carried in the
 * token so the common path resolves a workspace with no database round trip,
 * exactly as the guest payload does.
 *
 * The old shape is not accepted for backward compatibility, deliberately: it
 * resolved to a constant workspace id and has no user record behind it. The
 * owner is the only holder of one, and signs in once after deploy.
 */
export type SessionPayload =
  | { kind: "user"; userId: string; wsId: string }
  | { kind: "guest"; wsId: string };

// The single HMAC alg we sign with and the ONLY one we accept on verify. Pinning
// it (issue #21 P5 batch B) stops an attacker downgrading a forged token to a
// different HS* variant — jose accepts any HS* for a symmetric key otherwise.
// Exported so proxy.ts (guest signing) shares this one constant (Duo review).
export const SESSION_ALG = "HS256";

/**
 * Signed-in session lifetime, in seconds. Kept at 30 days (owner decision on
 * !76 — declined the 7-day shorten; no server-side revocation yet, though #35
 * Phase D's revoke does block the next sign-in). The JWT `exp` and the session
 * cookie's `maxAge` both derive from this single const so they can't drift
 * (Duo CWE-613). Guests are signed separately in proxy.ts with their own
 * GUEST_SANDBOX_TTL_HOURS.
 */
export const USER_SESSION_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

function key(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

export async function signUserSession(
  // Signed-in-user signer: the 30-day USER_SESSION_TTL_SECONDS is baked in, so
  // it must never sign a guest payload (guests are signed inline in proxy.ts
  // with their own shorter TTL). Narrowed from the SessionPayload union
  // (Duo review, CWE-840).
  payload: { kind: "user"; userId: string; wsId: string },
  secret: string,
): Promise<string> {
  // Stamp iat/exp from a single `now` so exp - iat is exactly the TTL.
  const nowSec = Math.floor(Date.now() / 1000);
  return new SignJWT({ ...payload })
    .setProtectedHeader({ alg: SESSION_ALG })
    .setIssuedAt(nowSec)
    .setExpirationTime(nowSec + USER_SESSION_TTL_SECONDS)
    .sign(key(secret));
}

/**
 * Guest session signer — used by proxy.ts (and tests). Takes an EXPLICIT TTL so
 * a guest token can never inherit the owner's 7-day expiry (Duo review, CWE-840),
 * and shares SESSION_ALG so there is a single canonical signing algorithm across
 * both signing sites (CWE-327).
 */
export async function signGuestSession(
  wsId: string,
  secret: string,
  ttlSeconds: number,
): Promise<string> {
  const nowSec = Math.floor(Date.now() / 1000);
  return new SignJWT({ kind: "guest", wsId })
    .setProtectedHeader({ alg: SESSION_ALG })
    .setIssuedAt(nowSec)
    .setExpirationTime(nowSec + ttlSeconds)
    .sign(key(secret));
}

export async function verifySession(
  token: string,
  secret: string,
): Promise<SessionPayload | null> {
  try {
    const { payload } = await jwtVerify(token, key(secret), {
      algorithms: [SESSION_ALG],
    });
    // Both ids are required. A "user" token missing wsId would otherwise fall
    // through to the guest resolution path and hand a signed-in account a
    // sandbox; a token missing userId is an identity we can't check a role on.
    if (
      payload.kind === "user" &&
      typeof payload.userId === "string" &&
      typeof payload.wsId === "string"
    ) {
      return { kind: "user", userId: payload.userId, wsId: payload.wsId };
    }
    if (payload.kind === "guest" && typeof payload.wsId === "string") {
      return { kind: "guest", wsId: payload.wsId };
    }
    return null;
  } catch {
    return null;
  }
}
