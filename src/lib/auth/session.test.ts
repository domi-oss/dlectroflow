import { describe, it, expect } from "vitest";
import { SignJWT, decodeJwt } from "jose";
import {
  signUserSession,
  signGuestSession,
  verifySession,
  USER_SESSION_TTL_SECONDS,
  SESSION_ALG,
} from "./session";

const SECRET = "test-secret-at-least-32-bytes-long-xxxxx";

function key(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

describe("session cookie", () => {
  it("round-trips a user payload", async () => {
    const token = await signUserSession(
      { kind: "user", userId: "u1", wsId: "w1" },
      SECRET,
    );
    expect(await verifySession(token, SECRET)).toEqual({
      kind: "user",
      userId: "u1",
      wsId: "w1",
    });
  });

  it("round-trips a guest payload", async () => {
    const token = await signGuestSession("abc", SECRET, 3600);
    expect(await verifySession(token, SECRET)).toEqual({
      kind: "guest",
      wsId: "abc",
    });
  });

  // #35 Phase A — the deliberate cutover. The old payload was
  // { kind: "owner", sub } and resolved to the constant workspace "owner".
  // That shape must now fail CLOSED rather than resolving to anything: the
  // owner signs in once after deploy and gets a real account. A legacy cookie
  // that still verified would be an authenticated session with no user record
  // behind it.
  it("rejects a legacy owner token outright", async () => {
    const legacy = await new SignJWT({ kind: "owner", sub: "42" })
      .setProtectedHeader({ alg: SESSION_ALG })
      .setIssuedAt()
      .setExpirationTime("30d")
      .sign(key(SECRET));
    expect(await verifySession(legacy, SECRET)).toBeNull();
  });

  it("rejects a token signed with a different secret", async () => {
    const token = await signGuestSession("abc", SECRET, 3600);
    expect(
      await verifySession(token, "another-secret-32-bytes-long-yyyyyyyy"),
    ).toBeNull();
  });

  it("returns null for garbage", async () => {
    expect(await verifySession("not.a.jwt", SECRET)).toBeNull();
  });

  it("returns null for validly-signed token with unknown kind", async () => {
    const token = await new SignJWT({ kind: "admin", x: 1 })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("30d")
      .sign(key(SECRET));
    expect(await verifySession(token, SECRET)).toBeNull();
  });

  it("returns null for a user token missing userId", async () => {
    const token = await new SignJWT({ kind: "user", wsId: "w1" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("30d")
      .sign(key(SECRET));
    expect(await verifySession(token, SECRET)).toBeNull();
  });

  it("returns null for a user token missing wsId", async () => {
    // A user session with no workspace would fall through to the guest
    // resolution path and silently hand the signed-in user a sandbox.
    const token = await new SignJWT({ kind: "user", userId: "u1" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("30d")
      .sign(key(SECRET));
    expect(await verifySession(token, SECRET)).toBeNull();
  });

  it("returns null for a user token whose ids are not strings", async () => {
    const token = await new SignJWT({ kind: "user", userId: 1, wsId: 2 })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("30d")
      .sign(key(SECRET));
    expect(await verifySession(token, SECRET)).toBeNull();
  });

  // Item 6c (#21 P5 batch B): pin the JWT algorithm on verify. jose accepts any
  // HS* alg for a symmetric key unless `algorithms` is passed, so a token signed
  // with the SAME secret but a different HMAC alg (HS512 here) would otherwise
  // verify — an alg-downgrade foothold. It must be rejected.
  it("rejects a same-secret token signed with a non-pinned HMAC alg (HS512)", async () => {
    const token = await new SignJWT({ kind: "user", userId: "u1", wsId: "w1" })
      .setProtectedHeader({ alg: "HS512" })
      .setIssuedAt()
      .setExpirationTime("30d")
      .sign(key(SECRET));
    expect(await verifySession(token, SECRET)).toBeNull();
  });

  it("still accepts the pinned HS256 alg", async () => {
    const token = await signUserSession(
      { kind: "user", userId: "u1", wsId: "w1" },
      SECRET,
    );
    expect(await verifySession(token, SECRET)).toEqual({
      kind: "user",
      userId: "u1",
      wsId: "w1",
    });
  });

  it("signs sessions with the HS256 header (matching the verify pin)", async () => {
    const token = await signUserSession(
      { kind: "user", userId: "u1", wsId: "w1" },
      SECRET,
    );
    const header = JSON.parse(
      Buffer.from(token.split(".")[0], "base64url").toString(),
    );
    expect(header.alg).toBe("HS256");
  });
});

// User session TTL kept at 30 days (owner decision on !76 — declined the 7-day
// shorten). Both the JWT exp and the session-cookie maxAge derive from this const.
describe("user session TTL", () => {
  it("is 30 days", () => {
    expect(USER_SESSION_TTL_SECONDS).toBe(60 * 60 * 24 * 30);
  });

  it("stamps exp exactly USER_SESSION_TTL_SECONDS after iat", async () => {
    const token = await signUserSession(
      { kind: "user", userId: "u1", wsId: "w1" },
      SECRET,
    );
    const { iat, exp } = decodeJwt(token);
    expect(exp! - iat!).toBe(USER_SESSION_TTL_SECONDS);
  });
});
