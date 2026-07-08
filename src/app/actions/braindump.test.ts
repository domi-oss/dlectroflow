/**
 * Action tests for braindump.ts (freshenItem, dismissPrompt) and
 * settings.ts (updateAgingSettings per-tier hours).
 *
 * Mirrors the vi.mock shape used in src/lib/ai-scope-guards.test.ts:
 * mock next/cache, @/lib/db (prisma), @/lib/workspace (currentWorkspaceId).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { prismaMock, revalidatePathMock, currentWorkspaceIdMock } = vi.hoisted(() => {
  const prismaMock = {
    brainDumpItem: {
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    settings: {
      upsert: vi.fn().mockResolvedValue({}),
    },
  };
  const revalidatePathMock = vi.fn();
  const currentWorkspaceIdMock = vi.fn().mockResolvedValue("owner");
  return { prismaMock, revalidatePathMock, currentWorkspaceIdMock };
});

vi.mock("next/cache", () => ({ revalidatePath: revalidatePathMock }));

vi.mock("@/lib/db", () => ({ prisma: prismaMock }));

vi.mock("@/lib/workspace", () => ({
  currentWorkspaceId: currentWorkspaceIdMock,
  isOwnerRequest: vi.fn().mockResolvedValue(true),
  MissingWorkspaceError: class MissingWorkspaceError extends Error {},
}));

describe("braindump.ts › freshenItem", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentWorkspaceIdMock.mockResolvedValue("owner");
  });

  it("updates only the scoped row and sets freshenedAt", async () => {
    const { freshenItem } = await import("./braindump");
    await freshenItem("item-1");

    expect(prismaMock.brainDumpItem.updateMany).toHaveBeenCalledTimes(1);
    const call = prismaMock.brainDumpItem.updateMany.mock.calls[0][0];
    expect(call.where).toEqual({ id: "item-1", workspaceId: "owner" });
    expect(call.data.freshenedAt).toBeInstanceOf(Date);
  });

  it("revalidates /inbox", async () => {
    const { freshenItem } = await import("./braindump");
    await freshenItem("item-1");
    expect(revalidatePathMock).toHaveBeenCalledWith("/inbox");
  });
});

describe("braindump.ts › dismissPrompt", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentWorkspaceIdMock.mockResolvedValue("owner");
  });

  it("updates only the scoped row and sets promptDismissedAt", async () => {
    const { dismissPrompt } = await import("./braindump");
    await dismissPrompt("item-2");

    expect(prismaMock.brainDumpItem.updateMany).toHaveBeenCalledTimes(1);
    const call = prismaMock.brainDumpItem.updateMany.mock.calls[0][0];
    expect(call.where).toEqual({ id: "item-2", workspaceId: "owner" });
    expect(call.data.promptDismissedAt).toBeInstanceOf(Date);
  });

  it("revalidates /inbox", async () => {
    const { dismissPrompt } = await import("./braindump");
    await dismissPrompt("item-2");
    expect(revalidatePathMock).toHaveBeenCalledWith("/inbox");
  });
});

describe("settings.ts › updateAgingSettings (per-tier hours)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentWorkspaceIdMock.mockResolvedValue("owner");
  });

  it("persists clamped hour values into both create and update", async () => {
    const { updateAgingSettings } = await import("./settings");
    await updateAgingSettings({
      agingThresholdMinutes: 30,
      demoOverrideSeconds: null,
      agingHours: 5,
      overdueHours: 9,
      wayOverdueHours: 13,
    });

    expect(prismaMock.settings.upsert).toHaveBeenCalledTimes(1);
    const call = prismaMock.settings.upsert.mock.calls[0][0];
    expect(call.where).toEqual({ workspaceId: "owner" });
    expect(call.create).toMatchObject({ agingHours: 5, overdueHours: 9, wayOverdueHours: 13 });
    expect(call.update).toMatchObject({ agingHours: 5, overdueHours: 9, wayOverdueHours: 13 });
  });

  it("clamps zero/negative hours to 1", async () => {
    const { updateAgingSettings } = await import("./settings");
    await updateAgingSettings({
      agingThresholdMinutes: 30,
      demoOverrideSeconds: null,
      agingHours: 0,
      overdueHours: -3,
      wayOverdueHours: 1,
    });

    const call = prismaMock.settings.upsert.mock.calls[0][0];
    expect(call.update.agingHours).toBe(1);
    expect(call.update.overdueHours).toBe(1);
    expect(call.update.wayOverdueHours).toBe(1);
  });

  it("clamps NaN/Infinity hours to 1 (not the tier default)", async () => {
    const { updateAgingSettings } = await import("./settings");
    await updateAgingSettings({
      agingThresholdMinutes: 30,
      demoOverrideSeconds: null,
      agingHours: NaN,
      overdueHours: Infinity,
      wayOverdueHours: -Infinity,
    });

    const call = prismaMock.settings.upsert.mock.calls[0][0];
    expect(call.update.agingHours).toBe(1);
    expect(call.update.overdueHours).toBe(1);
    expect(call.update.wayOverdueHours).toBe(1);
    // and reflected in the create branch too
    expect(call.create.agingHours).toBe(1);
    expect(call.create.overdueHours).toBe(1);
    expect(call.create.wayOverdueHours).toBe(1);
  });

  it("rounds float hours", async () => {
    const { updateAgingSettings } = await import("./settings");
    await updateAgingSettings({
      agingThresholdMinutes: 30,
      demoOverrideSeconds: null,
      agingHours: 4.6,
      overdueHours: 8.2,
      wayOverdueHours: 12.5,
    });

    const call = prismaMock.settings.upsert.mock.calls[0][0];
    expect(call.update.agingHours).toBe(5);
    expect(call.update.overdueHours).toBe(8);
    expect(call.update.wayOverdueHours).toBe(13);
  });
});
