import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { resolveWorkspaceId, MissingWorkspaceError } from "./workspace";
import { signOwnerSession, signGuestSession } from "./auth/session";

const SECRET = "test-secret-at-least-32-bytes-long-xxxxx";

beforeEach(() => {
  vi.stubEnv("AUTH_SESSION_SECRET", SECRET);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("resolveWorkspaceId", () => {
  it("returns 'owner' for a valid owner cookie", async () => {
    const owner = await signOwnerSession({ kind: "owner", sub: "1" }, SECRET);
    expect(await resolveWorkspaceId({ owner })).toBe("owner");
  });

  it("returns the guest wsId for a valid guest cookie", async () => {
    const guest = await signGuestSession("g-123", SECRET, 3600);
    expect(await resolveWorkspaceId({ guest })).toBe("g-123");
  });

  it("prefers owner over guest", async () => {
    const owner = await signOwnerSession({ kind: "owner", sub: "1" }, SECRET);
    const guest = await signGuestSession("g-1", SECRET, 3600);
    expect(await resolveWorkspaceId({ owner, guest })).toBe("owner");
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
