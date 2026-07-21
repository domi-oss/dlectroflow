/**
 * Action tests for dismissWelcome + updateFirstRunPreview (#8 Phase 5).
 *
 * dismissWelcome persists that the workspace dismissed the first-run welcome
 * card (welcomeDismissedAt = now). updateFirstRunPreview toggles a demo-only
 * knob that forces the Inbox to render as a brand-new user sees it. Both are
 * workspace-scoped upserts, matching updateVoice's shape.
 *
 * Mirrors the vi.mock shape used in settings.test.ts / snooze.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { prismaMock, revalidatePathMock, currentWorkspaceIdMock } = vi.hoisted(
  () => {
    const prismaMock = {
      settings: {
        upsert: vi.fn().mockResolvedValue({}),
      },
    };
    return {
      prismaMock,
      revalidatePathMock: vi.fn(),
      currentWorkspaceIdMock: vi.fn().mockResolvedValue("owner"),
    };
  },
);
vi.mock("next/cache", () => ({ revalidatePath: revalidatePathMock }));
vi.mock("@/lib/db", () => ({ prisma: prismaMock }));
vi.mock("@/lib/workspace", () => ({
  currentWorkspaceId: currentWorkspaceIdMock,
  isOwnerRequest: vi.fn().mockResolvedValue(true),
}));

beforeEach(() => {
  vi.clearAllMocks();
  currentWorkspaceIdMock.mockResolvedValue("owner");
});

describe("dismissWelcome", () => {
  it("upserts welcomeDismissedAt (a Date) scoped to the current workspace", async () => {
    const { dismissWelcome } = await import("./settings");
    const before = Date.now();
    await dismissWelcome();

    expect(prismaMock.settings.upsert).toHaveBeenCalledTimes(1);
    const call = prismaMock.settings.upsert.mock.calls[0][0];
    expect(call.where).toEqual({ workspaceId: "owner" });
    expect(call.create.workspaceId).toBe("owner");
    expect(call.create.welcomeDismissedAt).toBeInstanceOf(Date);
    expect(call.update.welcomeDismissedAt).toBeInstanceOf(Date);
    expect(call.update.welcomeDismissedAt.getTime()).toBeGreaterThanOrEqual(
      before,
    );
  });

  it("scopes to a different workspace when called from a guest sandbox", async () => {
    currentWorkspaceIdMock.mockResolvedValue("g_123");
    const { dismissWelcome } = await import("./settings");
    await dismissWelcome();

    const call = prismaMock.settings.upsert.mock.calls[0][0];
    expect(call.where).toEqual({ workspaceId: "g_123" });
    expect(call.create.workspaceId).toBe("g_123");
  });

  it("revalidates /inbox", async () => {
    const { dismissWelcome } = await import("./settings");
    await dismissWelcome();
    expect(revalidatePathMock).toHaveBeenCalledWith("/inbox");
  });
});

describe("updateFirstRunPreview", () => {
  it("upserts firstRunPreview=true scoped to the current workspace", async () => {
    const { updateFirstRunPreview } = await import("./settings");
    await updateFirstRunPreview(true);

    expect(prismaMock.settings.upsert).toHaveBeenCalledTimes(1);
    const call = prismaMock.settings.upsert.mock.calls[0][0];
    expect(call.where).toEqual({ workspaceId: "owner" });
    expect(call.create).toMatchObject({
      workspaceId: "owner",
      firstRunPreview: true,
    });
    expect(call.update).toEqual({ firstRunPreview: true });
  });

  it("upserts firstRunPreview=false", async () => {
    const { updateFirstRunPreview } = await import("./settings");
    await updateFirstRunPreview(false);

    const call = prismaMock.settings.upsert.mock.calls[0][0];
    expect(call.update).toEqual({ firstRunPreview: false });
  });

  it("revalidates /inbox", async () => {
    const { updateFirstRunPreview } = await import("./settings");
    await updateFirstRunPreview(true);
    expect(revalidatePathMock).toHaveBeenCalledWith("/inbox");
  });
});
