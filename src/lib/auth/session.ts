import { SignJWT, jwtVerify } from "jose";

export const OWNER_COOKIE = "df_owner";
export const GUEST_COOKIE = "df_guest";
// Middleware forwards the signed guest session token (JWT) on this request header
// so the SAME request's server components can read it before the cookie round-trips.
// resolveWorkspaceId calls verifySession to verify the JWT before trusting it —
// that verification is the IDOR defense; the header NEVER carries a raw workspace id.
// Homed here (pure, Edge-safe) so both middleware and workspace.ts can import it.
export const GUEST_WS_HEADER = "x-guest-ws";

export type SessionPayload =
  | { kind: "owner"; sub: string }
  | { kind: "guest"; wsId: string };

// The single HMAC alg we sign with and the ONLY one we accept on verify. Pinning
// it (issue #21 P5 batch B) stops an attacker downgrading a forged token to a
// different HS* variant — jose accepts any HS* for a symmetric key otherwise.
// Exported so proxy.ts (guest signing) shares this one constant (Duo review).
export const SESSION_ALG = "HS256";

/**
 * Owner session lifetime, in seconds. Shortened from 30d to 7d (issue #21 P5
 * batch B) to bound the blast radius of a stolen stateless owner JWT — there is
 * no server-side revocation yet (follow-up). Guests are signed separately in
 * proxy.ts with their own GUEST_SANDBOX_TTL_HOURS.
 */
export const OWNER_SESSION_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days

function key(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

export async function signOwnerSession(
  // Owner-only signer: the 7-day OWNER_SESSION_TTL_SECONDS is baked in, so it must
  // never sign a guest payload (guests are signed inline in proxy.ts with their
  // own shorter TTL). Narrowed from the SessionPayload union (Duo review, CWE-840).
  payload: { kind: "owner"; sub: string },
  secret: string,
): Promise<string> {
  // Stamp iat/exp from a single `now` so exp - iat is exactly the TTL.
  const nowSec = Math.floor(Date.now() / 1000);
  return new SignJWT({ ...payload })
    .setProtectedHeader({ alg: SESSION_ALG })
    .setIssuedAt(nowSec)
    .setExpirationTime(nowSec + OWNER_SESSION_TTL_SECONDS)
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
    if (payload.kind === "owner" && typeof payload.sub === "string") {
      return { kind: "owner", sub: payload.sub };
    }
    if (payload.kind === "guest" && typeof payload.wsId === "string") {
      return { kind: "guest", wsId: payload.wsId };
    }
    return null;
  } catch {
    return null;
  }
}
