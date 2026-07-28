import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";

const { cookiesMock, userFindUniqueMock, workspaceUpsertMock } = vi.hoisted(
  () => ({
    cookiesMock: vi.fn(),
    userFindUniqueMock: vi.fn(),
    workspaceUpsertMock: vi.fn(),
  }),
);

vi.mock("next/headers", () => ({
  cookies: cookiesMock,
  headers: vi.fn().mockResolvedValue(new Headers()),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    user: { findUnique: userFindUniqueMock },
    workspace: { upsert: workspaceUpsertMock },
  },
}));

import {
  resolveWorkspaceId,
  resolveWorkspace,
  touchWorkspace,
  currentUser,
  isOwnerRequest,
  MissingWorkspaceError,
} from "./workspace";
import {
  signUserSession,
  signGuestSession,
  OWNER_COOKIE,
} from "./auth/session";

const SECRET = "test-secret-at-least-32-bytes-long-xxxxx";

/** A cookie jar holding just the signed-in session cookie. */
function jarWith(token: string | undefined) {
  return {
    get: (name: string) =>
      name === OWNER_COOKIE && token ? { value: token } : undefined,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("AUTH_SESSION_SECRET", SECRET);
  workspaceUpsertMock.mockResolvedValue({});
  cookiesMock.mockResolvedValue(jarWith(undefined));
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("resolveWorkspaceId", () => {
  // #35 Phase A — the whole point of the phase: a signed-in session resolves to
  // the workspace that account actually owns, not to a shared constant.
  it("resolves a user session to that user's own workspace, not a constant", async () => {
    const owner = await signUserSession(
      { kind: "user", userId: "u1", wsId: "ws-real" },
      SECRET,
    );
    expect(await resolveWorkspaceId({ owner })).toBe("ws-real");
  });

  it("gives two different users two different workspaces", async () => {
    const a = await signUserSession(
      { kind: "user", userId: "u1", wsId: "ws-a" },
      SECRET,
    );
    const b = await signUserSession(
      { kind: "user", userId: "u2", wsId: "ws-b" },
      SECRET,
    );
    expect(await resolveWorkspaceId({ owner: a })).toBe("ws-a");
    expect(await resolveWorkspaceId({ owner: b })).toBe("ws-b");
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

  it("does not accept a legacy owner cookie as a session at all", async () => {
    // Pre-#35 cookies carried { kind: "owner", sub }. They must not resolve.
    const guest = await signGuestSession("g-3", SECRET, 3600);
    const legacy = await signGuestSession("ignored", SECRET, 3600);
    expect(await resolveWorkspaceId({ owner: legacy, guest })).toBe("g-3");
  });
});

describe("resolveWorkspace", () => {
  it("reports the kind alongside the id so callers stop inferring it", async () => {
    const owner = await signUserSession(
      { kind: "user", userId: "u1", wsId: "ws-real" },
      SECRET,
    );
    expect(await resolveWorkspace({ owner })).toEqual({
      id: "ws-real",
      kind: "user",
    });
    const guest = await signGuestSession("g-9", SECRET, 3600);
    expect(await resolveWorkspace({ guest })).toEqual({
      id: "g-9",
      kind: "guest",
    });
  });
});

describe("touchWorkspace", () => {
  it("stamps a TTL on a guest workspace", async () => {
    await touchWorkspace("g-1", "guest");
    const [args] = workspaceUpsertMock.mock.calls[0] as [
      { create: { kind: string; expiresAt: Date | null } },
    ];
    expect(args.create.kind).toBe("guest");
    expect(args.create.expiresAt).toBeInstanceOf(Date);
  });

  it("never stamps a TTL on a user workspace", async () => {
    // A user workspace with an expiresAt would be swept by the guest purge.
    await touchWorkspace("ws-real", "user");
    const [args] = workspaceUpsertMock.mock.calls[0] as [
      { create: { kind: string; expiresAt: Date | null } },
    ];
    expect(args.create.kind).toBe("user");
    expect(args.create.expiresAt).toBeNull();
  });

  it("does not extend the TTL of an existing workspace on touch", async () => {
    await touchWorkspace("g-1", "guest");
    const [args] = workspaceUpsertMock.mock.calls[0] as [
      { update: Record<string, unknown> },
    ];
    expect(args.update).not.toHaveProperty("expiresAt");
  });
});

describe("currentUser", () => {
  async function signedInAs(user: {
    id: string;
    role: string;
    status: string;
  }) {
    const token = await signUserSession(
      { kind: "user", userId: user.id, wsId: `ws-${user.id}` },
      SECRET,
    );
    cookiesMock.mockResolvedValue(jarWith(token));
    userFindUniqueMock.mockResolvedValue(user);
  }

  it("returns null when there is no session cookie", async () => {
    expect(await currentUser()).toBeNull();
    expect(userFindUniqueMock).not.toHaveBeenCalled();
  });

  it("returns null for a guest session", async () => {
    const guest = await signGuestSession("g-1", SECRET, 3600);
    cookiesMock.mockResolvedValue(jarWith(guest));
    expect(await currentUser()).toBeNull();
  });

  it("returns null for a tampered token", async () => {
    cookiesMock.mockResolvedValue(jarWith("not.a.jwt"));
    expect(await currentUser()).toBeNull();
  });

  it("returns the account's id, role and workspace", async () => {
    await signedInAs({ id: "u1", role: "member", status: "active" });
    expect(await currentUser()).toEqual({
      id: "u1",
      role: "member",
      workspaceId: "ws-u1",
    });
  });

  it("returns null when the token names a user that no longer exists", async () => {
    const token = await signUserSession(
      { kind: "user", userId: "ghost", wsId: "ws-ghost" },
      SECRET,
    );
    cookiesMock.mockResolvedValue(jarWith(token));
    userFindUniqueMock.mockResolvedValue(null);
    expect(await currentUser()).toBeNull();
  });

  // Revocation has to bite on the NEXT REQUEST, not the next sign-in: the
  // session cookie lives for 30 days, so honouring a revoked account until it
  // expires would make "revoke" mean "revoke in a month".
  it("returns null for a revoked account holding a still-valid cookie", async () => {
    await signedInAs({ id: "u1", role: "owner", status: "revoked" });
    expect(await currentUser()).toBeNull();
  });
});

describe("isOwnerRequest", () => {
  async function signedInAs(role: string, status = "active") {
    const token = await signUserSession(
      { kind: "user", userId: "u1", wsId: "ws-1" },
      SECRET,
    );
    cookiesMock.mockResolvedValue(jarWith(token));
    userFindUniqueMock.mockResolvedValue({ id: "u1", role, status });
  }

  it("treats the owner role as owner", async () => {
    await signedInAs("owner");
    expect(await isOwnerRequest()).toBe(true);
  });

  it("treats a member as not-owner", async () => {
    // The whole reason the role column exists: a signed-in account is NOT
    // automatically the instance owner.
    await signedInAs("member");
    expect(await isOwnerRequest()).toBe(false);
  });

  it("treats a revoked owner as not-owner", async () => {
    await signedInAs("owner", "revoked");
    expect(await isOwnerRequest()).toBe(false);
  });

  it("treats a guest as not-owner", async () => {
    const guest = await signGuestSession("g-1", SECRET, 3600);
    cookiesMock.mockResolvedValue(jarWith(guest));
    expect(await isOwnerRequest()).toBe(false);
  });

  it("treats an anonymous request as not-owner", async () => {
    expect(await isOwnerRequest()).toBe(false);
  });
});
