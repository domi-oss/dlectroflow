/**
 * Test for the Focus launcher's Task query — #64 (focus↔library data
 * integrity) defensive filter.
 *
 * Root cause: `deleteBrainDumpItem` used to be able to leave a Task with zero
 * referencing BrainDumpItem rows (an orphan) — that Task's ID is unreachable
 * from anywhere the Library reads from, yet this page's `prisma.task.findMany`
 * read Task directly with no existence check, so the orphan surfaced here
 * forever. This pins the belt-and-suspenders fix: the query's `where` must
 * require at least one live (non-archived) BrainDumpItem still pointing at
 * the Task, so Focus can never show what the Library can't.
 *
 * This is intentionally a query-shape assertion, not a rendering test — the
 * page returns a React element (`<FocusLauncher ... />`) without rendering
 * it, so no DOM/jsdom setup is needed.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { BrainDumpStatus } from "@/lib/constants";

const { prismaMock, getSettingsMock, currentWorkspaceIdMock } = vi.hoisted(
  () => {
    const prismaMock = {
      task: { findMany: vi.fn().mockResolvedValue([]) },
      brainDumpItem: { findMany: vi.fn().mockResolvedValue([]) },
    };
    return {
      prismaMock,
      getSettingsMock: vi.fn().mockResolvedValue({ voice: "plain" }),
      currentWorkspaceIdMock: vi.fn().mockResolvedValue("owner"),
    };
  },
);

vi.mock("@/lib/db", () => ({
  prisma: prismaMock,
  getSettings: getSettingsMock,
}));
vi.mock("@/lib/workspace", () => ({
  currentWorkspaceId: currentWorkspaceIdMock,
}));
vi.mock("@/lib/rewards", () => ({
  getDashboardData: vi.fn().mockResolvedValue({
    focusMinToday: 0,
    currentStreak: 0,
    stepsDoneToday: 0,
  }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  currentWorkspaceIdMock.mockResolvedValue("owner");
  getSettingsMock.mockResolvedValue({ voice: "plain" });
  prismaMock.task.findMany.mockResolvedValue([]);
  prismaMock.brainDumpItem.findMany.mockResolvedValue([]);
});

describe("FocusLauncherPage — Task query", () => {
  it("requires at least one live BrainDumpItem still referencing the Task (excludes orphans, #64)", async () => {
    const { default: FocusLauncherPage } = await import("./page");
    await FocusLauncherPage();

    expect(prismaMock.task.findMany).toHaveBeenCalledTimes(1);
    const call = prismaMock.task.findMany.mock.calls[0][0];
    expect(call.where).toMatchObject({
      workspaceId: "owner",
      brainDumpItems: {
        some: { status: { not: BrainDumpStatus.Archived } },
      },
    });
  });
});
