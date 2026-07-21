import { describe, it, expect, vi, beforeEach } from "vitest";

const { disconnectMock, workspaceMock, revalidatePathMock } = vi.hoisted(
  () => ({
    disconnectMock: vi.fn(),
    workspaceMock: vi.fn(),
    revalidatePathMock: vi.fn(),
  }),
);

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
vi.mock("@/lib/workspace", () => ({ currentWorkspaceId: workspaceMock }));

import { OWNER_WORKSPACE_ID } from "@/lib/constants";
import { disconnectGoogleTasks } from "./google-schedule";

beforeEach(() => vi.clearAllMocks());

describe("disconnectGoogleTasks", () => {
  it("disconnects for the owner and revalidates /settings", async () => {
    workspaceMock.mockResolvedValue(OWNER_WORKSPACE_ID);
    await expect(disconnectGoogleTasks()).resolves.toEqual({ ok: true });
    expect(disconnectMock).toHaveBeenCalledOnce();
    expect(revalidatePathMock).toHaveBeenCalledWith("/settings");
  });

  it("rejects guests without touching tokens", async () => {
    workspaceMock.mockResolvedValue("guest-ws");
    await expect(disconnectGoogleTasks()).rejects.toThrow("owner only");
    expect(disconnectMock).not.toHaveBeenCalled();
    expect(revalidatePathMock).not.toHaveBeenCalled();
  });
});
