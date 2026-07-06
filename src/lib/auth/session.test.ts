import { describe, it, expect } from "vitest";
import { signSession, verifySession } from "./session";

const SECRET = "test-secret-at-least-32-bytes-long-xxxxx";

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
});
