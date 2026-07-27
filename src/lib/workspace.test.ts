import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { resolveWorkspaceId, MissingWorkspaceError } from "./workspace";
import { signUserSession, signGuestSession } from "./auth/session";

const SECRET = "test-secret-at-least-32-bytes-long-xxxxx";

beforeEach(() => {
  vi.stubEnv("AUTH_SESSION_SECRET", SECRET);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("resolveWorkspaceId", () => {
  it("returns the user's own workspace for a valid user cookie", async () => {
    const owner = await signUserSession(
      { kind: "user", userId: "u1", wsId: "ws-real" },
      SECRET,
    );
    expect(await resolveWorkspaceId({ owner })).toBe("ws-real");
  });

  it("returns the guest wsId for a valid guest cookie", async () => {
    const guest = await signGuestSession("g-123", SECRET, 3600);
    expect(await resolveWorkspaceId({ guest })).toBe("g-123");
  });

  it("prefers the user session over guest", async () => {
    const owner = await signUserSession(
      { kind: "user", userId: "u1", wsId: "ws-real" },
      SECRET,
    );
    const guest = await signGuestSession("g-1", SECRET, 3600);
    expect(await resolveWorkspaceId({ owner, guest })).toBe("ws-real");
  });

  it("resolves a signed guest token forwarded via header", async () => {
    const token = await signGuestSession("g-hdr", SECRET, 3600);
    expect(await resolveWorkspaceId({ header: token })).toBe("g-hdr");
  });

  it("rejects a spoofed (unsigned) header value", async () => {
    await expect(
      resolveWorkspaceId({ header: "g-spoofed-raw-id" }),
    ).rejects.toBeInstanceOf(MissingWorkspaceError);
  });

  it("throws when nothing resolves", async () => {
    await expect(resolveWorkspaceId({})).rejects.toBeInstanceOf(
      MissingWorkspaceError,
    );
  });

  it("falls through to guest when the owner cookie is invalid/tampered", async () => {
    const guest = await signGuestSession("g-2", SECRET, 3600);
    expect(await resolveWorkspaceId({ owner: "bad.token.here", guest })).toBe(
      "g-2",
    );
  });
});
