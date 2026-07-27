import { describe, it, expect, vi, beforeEach } from "vitest";

const { disconnectMock, workspaceMock, isOwnerMock, revalidatePathMock } =
  vi.hoisted(() => ({
    disconnectMock: vi.fn(),
    workspaceMock: vi.fn(),
    isOwnerMock: vi.fn(),
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
}));

import { disconnectGoogleTasks } from "./google-schedule";

// #35 Phase A — the owner's workspace is a real per-account id now, not the
// "owner" constant. Ownership is asserted through isOwnerRequest (the role
// check the action actually makes); this id is just the workspace that
// account happens to own.
const OWNER_WS = "ws-owner";

beforeEach(() => vi.clearAllMocks());

describe("disconnectGoogleTasks", () => {
  it("disconnects for the owner and revalidates /settings", async () => {
    workspaceMock.mockResolvedValue(OWNER_WS);
    isOwnerMock.mockResolvedValue(true);
    await expect(disconnectGoogleTasks()).resolves.toEqual({ ok: true });
    expect(disconnectMock).toHaveBeenCalledOnce();
    expect(revalidatePathMock).toHaveBeenCalledWith("/settings");
  });

  it("rejects guests without touching tokens", async () => {
    workspaceMock.mockResolvedValue("guest-ws");
    isOwnerMock.mockResolvedValue(false);
    await expect(disconnectGoogleTasks()).rejects.toThrow("owner only");
    expect(disconnectMock).not.toHaveBeenCalled();
    expect(revalidatePathMock).not.toHaveBeenCalled();
  });
});
