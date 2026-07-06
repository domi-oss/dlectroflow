import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { resolveWorkspaceId, MissingWorkspaceError } from "./workspace";
import { signSession } from "./auth/session";

const SECRET = "test-secret-at-least-32-bytes-long-xxxxx";

beforeEach(() => {
  vi.stubEnv("AUTH_SESSION_SECRET", SECRET);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("resolveWorkspaceId", () => {
  it("returns 'owner' for a valid owner cookie", async () => {
    const owner = await signSession({ kind: "owner", sub: "1" }, SECRET);
    expect(await resolveWorkspaceId({ owner })).toBe("owner");
  });

  it("returns the guest wsId for a valid guest cookie", async () => {
    const guest = await signSession({ kind: "guest", wsId: "g-123" }, SECRET);
    expect(await resolveWorkspaceId({ guest })).toBe("g-123");
  });

  it("prefers owner over guest", async () => {
    const owner = await signSession({ kind: "owner", sub: "1" }, SECRET);
    const guest = await signSession({ kind: "guest", wsId: "g-1" }, SECRET);
    expect(await resolveWorkspaceId({ owner, guest })).toBe("owner");
  });

  it("falls back to the forwarded header", async () => {
    expect(await resolveWorkspaceId({ header: "g-hdr" })).toBe("g-hdr");
  });

  it("throws when nothing resolves", async () => {
    await expect(resolveWorkspaceId({})).rejects.toBeInstanceOf(
      MissingWorkspaceError,
    );
  });
});
