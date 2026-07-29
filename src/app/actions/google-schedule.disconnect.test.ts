import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  disconnectMock,
  workspaceMock,
  isOwnerMock,
  currentUserMock,
  revalidatePathMock,
} = vi.hoisted(() => ({
  disconnectMock: vi.fn(),
  workspaceMock: vi.fn(),
  isOwnerMock: vi.fn(),
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
  isOwnerRequest: isOwnerMock,
  currentUser: currentUserMock,
}));

import { disconnectGoogleTasks } from "./google-schedule";

// #35 Phase A — the owner's workspace is a real per-account id now, not the
// "owner" constant. Ownership is asserted through isOwnerRequest (the role
// check the action actually makes); this id is just the workspace that
// account happens to own.
const OWNER_WS = "ws-owner";

// #118 Phase C — the action reads currentUser() now, because the acting user's
// id is what keys their own GoogleAuth row. isOwnerRequest() is no longer called
// by the action; its mock stays only until #118 retires it in the next commit.
// The two must always describe the SAME person — two mocks answering one
// question is how a test ends up proving something about nobody.
const OWNER_ID = "user-owner";
const ownerUser = () => ({
  id: OWNER_ID,
  role: "owner" as const,
  workspaceId: OWNER_WS,
  provider: "gitlab",
  handle: "owner",
});
const memberUser = () => ({
  id: "user-member",
  role: "member" as const,
  workspaceId: "ws-member",
  provider: "gitlab",
  handle: "member",
});

beforeEach(() => {
  vi.clearAllMocks();
  currentUserMock.mockResolvedValue(ownerUser());
});

describe("disconnectGoogleTasks", () => {
  it("disconnects for the owner and revalidates /settings", async () => {
    workspaceMock.mockResolvedValue(OWNER_WS);
    isOwnerMock.mockResolvedValue(true);
    await expect(disconnectGoogleTasks()).resolves.toEqual({ ok: true });
    // #118 — the ACTING account's own connection, reached by their own id.
    expect(disconnectMock).toHaveBeenCalledWith(OWNER_ID);
    expect(disconnectMock).toHaveBeenCalledOnce();
    expect(revalidatePathMock).toHaveBeenCalledWith("/settings");
  });

  it("rejects guests without touching tokens", async () => {
    workspaceMock.mockResolvedValue("guest-ws");
    isOwnerMock.mockResolvedValue(false);
    // Kept in sync with isOwnerMock — the action gates on currentUser().role
    // now (#118).
    currentUserMock.mockResolvedValue(memberUser());
    await expect(disconnectGoogleTasks()).rejects.toThrow("owner only");
    expect(disconnectMock).not.toHaveBeenCalled();
    expect(revalidatePathMock).not.toHaveBeenCalled();
  });
});
