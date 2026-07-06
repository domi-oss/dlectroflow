import { describe, it, expect } from "vitest";
import { SignJWT } from "jose";
import { signSession, verifySession } from "./session";

const SECRET = "test-secret-at-least-32-bytes-long-xxxxx";

function key(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

describe("session cookie", () => {
  it("round-trips an owner payload", async () => {
    const token = await signSession({ kind: "owner", sub: "13595692" }, SECRET);
    expect(await verifySession(token, SECRET)).toEqual({
      kind: "owner",
      sub: "13595692",
    });
  });

  it("round-trips a guest payload", async () => {
    const token = await signSession({ kind: "guest", wsId: "abc" }, SECRET);
    expect(await verifySession(token, SECRET)).toEqual({
      kind: "guest",
      wsId: "abc",
    });
  });

  it("rejects a token signed with a different secret", async () => {
    const token = await signSession({ kind: "guest", wsId: "abc" }, SECRET);
    expect(await verifySession(token, "another-secret-32-bytes-long-yyyyyyyy")).toBeNull();
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
});
