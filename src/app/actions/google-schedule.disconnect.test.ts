import { describe, it, expect, vi, beforeEach } from "vitest";

const { disconnectMock, workspaceMock, currentUserMock, revalidatePathMock } =
  vi.hoisted(() => ({
    disconnectMock: vi.fn(),
    workspaceMock: vi.fn(),
    currentUserMock: vi.fn(),
    revalidatePathMock: vi.fn(),
  }));

vi.mock("next/cache", () => ({ revalidatePath: revalidatePathMock }));
vi.mock("@/lib/db", () => ({ prisma: {} }));
vi.mock("@/lib/rewards", () => ({
  logReward: vi.fn().mockResolvedValue(undefined),
  awardBadge: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/google", () => ({
  getValidAccessToken: vi.fn(),
  googleConfigured: vi.fn(),
  findReclaimList: vi.fn(),
  listTaskLists: vi.fn(),
  createGoogleTask: vi.fn(),
  getGoogleStatus: vi.fn(),
  disconnectGoogle: disconnectMock,
}));
vi.mock("@/lib/workspace", () => ({
  currentWorkspaceId: workspaceMock,
  currentUser: currentUserMock,
}));

import { disconnectGoogleTasks } from "./google-schedule";

// #35 Phase A — the owner's workspace is a real per-account id now, not the
// "owner" constant; this id is just the workspace that account happens to own.
const OWNER_WS = "ws-owner";

// #118 Phase C — currentUser() is the ONE identity mock in this file. The action
// no longer calls isOwnerRequest() at all: the acting user's id is what keys
// their own GoogleAuth row, and "signed in" is the whole gate. Two mocks
// answering one question is how a test ends up describing two different people,
// so isOwnerRequest is gone from the factory rather than left inert.
const OWNER_ID = "user-owner";
const ownerUser = () => ({
  id: OWNER_ID,
  role: "owner" as const,
  workspaceId: OWNER_WS,
  provider: "gitlab",
  handle: "owner",
});
const MEMBER_ID = "user-member";
const memberUser = () => ({
  id: MEMBER_ID,
  role: "member" as const,
  workspaceId: "ws-member",
  provider: "gitlab",
  handle: "member",
});

beforeEach(() => {
  vi.clearAllMocks();
  currentUserMock.mockResolvedValue(ownerUser());
  // #126 — `disconnectGoogle` answers whether Google accepted the revoke.
  disconnectMock.mockResolvedValue(true);
});

describe("disconnectGoogleTasks", () => {
  it("disconnects for the owner and revalidates /settings", async () => {
    workspaceMock.mockResolvedValue(OWNER_WS);
    await expect(disconnectGoogleTasks()).resolves.toEqual({
      ok: true,
      revoked: true,
    });
    // #118 — the ACTING account's own connection, reached by their own id.
    expect(disconnectMock).toHaveBeenCalledWith(OWNER_ID);
    expect(disconnectMock).toHaveBeenCalledOnce();
    expect(revalidatePathMock).toHaveBeenCalledWith("/settings");
  });

  // #118 Phase C — the credential is per user, so a member disconnecting is
  // disconnecting THEIRS. #119's role negative moves to "no account at all".
  it("disconnects the ACTING user's connection, never another's", async () => {
    workspaceMock.mockResolvedValue("ws-member");
    currentUserMock.mockResolvedValue(memberUser());
    await expect(disconnectGoogleTasks()).resolves.toEqual({
      ok: true,
      revoked: true,
    });
    expect(disconnectMock).toHaveBeenCalledWith(MEMBER_ID);
    expect(disconnectMock).not.toHaveBeenCalledWith(OWNER_ID);
  });

  // #126 — the disconnect DID happen at this end either way, so this is not an
  // error; `ok` stays true. But the one remaining step belongs to the person who
  // clicked, and only they can take it (their own Google permissions page). A
  // hardcoded `{ ok: true }` told them it was finished when it was not — the
  // same "you cannot withdraw it through the product" gap #126 is about, at the
  // one moment the product had their attention.
  it("reports an unrevoked grant rather than a bare ok", async () => {
    workspaceMock.mockResolvedValue(OWNER_WS);
    disconnectMock.mockResolvedValue(false);
    await expect(disconnectGoogleTasks()).resolves.toEqual({
      ok: true,
      revoked: false,
    });
    // Still a completed disconnect at this end: the tokens are gone and the
    // page must re-render as "Not connected".
    expect(revalidatePathMock).toHaveBeenCalledWith("/settings");
  });

  it("rejects a caller with no signed-in account without touching tokens", async () => {
    workspaceMock.mockResolvedValue("guest-ws");
    currentUserMock.mockResolvedValue(null);
    await expect(disconnectGoogleTasks()).rejects.toThrow(/sign in required/);
    expect(disconnectMock).not.toHaveBeenCalled();
    expect(revalidatePathMock).not.toHaveBeenCalled();
  });
});
