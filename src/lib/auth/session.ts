import { SignJWT, jwtVerify } from "jose";

export const OWNER_COOKIE = "df_owner";
export const GUEST_COOKIE = "df_guest";
// Middleware forwards the resolved guest workspace id on this request header so
// the SAME request's server components can read it before the cookie round-trips.
// Homed here (pure, Edge-safe) so both middleware and workspace.ts can import it.
export const GUEST_WS_HEADER = "x-guest-ws";

export type SessionPayload =
  | { kind: "owner"; sub: string }
  | { kind: "guest"; wsId: string };

function key(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

export async function signSession(
  payload: SessionPayload,
  secret: string,
): Promise<string> {
  return new SignJWT({ ...payload })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("30d")
    .sign(key(secret));
}

export async function verifySession(
  token: string,
  secret: string,
): Promise<SessionPayload | null> {
  try {
    const { payload } = await jwtVerify(token, key(secret));
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
