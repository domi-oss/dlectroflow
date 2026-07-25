import { describe, it, expect } from "vitest";
import { SignJWT, decodeJwt } from "jose";
import {
  signOwnerSession,
  signGuestSession,
  verifySession,
  OWNER_SESSION_TTL_SECONDS,
} from "./session";

const SECRET = "test-secret-at-least-32-bytes-long-xxxxx";

function key(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

describe("session cookie", () => {
  it("round-trips an owner payload", async () => {
    const token = await signOwnerSession(
      { kind: "owner", sub: "1234567" },
      SECRET,
    );
    expect(await verifySession(token, SECRET)).toEqual({
      kind: "owner",
      sub: "1234567",
    });
  });

  it("round-trips a guest payload", async () => {
    const token = await signGuestSession("abc", SECRET, 3600);
    expect(await verifySession(token, SECRET)).toEqual({
      kind: "guest",
      wsId: "abc",
    });
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

  it("returns null for validly-signed owner token missing sub", async () => {
    const token = await new SignJWT({ kind: "owner" })
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
    const token = await new SignJWT({ kind: "owner", sub: "1234567" })
      .setProtectedHeader({ alg: "HS512" })
      .setIssuedAt()
      .setExpirationTime("30d")
      .sign(key(SECRET));
    expect(await verifySession(token, SECRET)).toBeNull();
  });

  it("still accepts the pinned HS256 alg", async () => {
    const token = await signOwnerSession({ kind: "owner", sub: "abc" }, SECRET);
    expect(await verifySession(token, SECRET)).toEqual({
      kind: "owner",
      sub: "abc",
    });
  });

  it("signs sessions with the HS256 header (matching the verify pin)", async () => {
    const token = await signOwnerSession({ kind: "owner", sub: "abc" }, SECRET);
    const header = JSON.parse(
      Buffer.from(token.split(".")[0], "base64url").toString(),
    );
    expect(header.alg).toBe("HS256");
  });
});

// Owner session TTL kept at 30 days (owner decision on !76 — declined the 7-day
// shorten). Both the JWT exp and the owner-cookie maxAge derive from this const.
describe("owner session TTL", () => {
  it("is 30 days", () => {
    expect(OWNER_SESSION_TTL_SECONDS).toBe(60 * 60 * 24 * 30);
  });

  it("stamps exp exactly OWNER_SESSION_TTL_SECONDS after iat", async () => {
    const token = await signOwnerSession({ kind: "owner", sub: "abc" }, SECRET);
    const { iat, exp } = decodeJwt(token);
    expect(exp! - iat!).toBe(OWNER_SESSION_TTL_SECONDS);
  });
});
