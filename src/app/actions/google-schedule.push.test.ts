import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  workspaceMock,
  revalidatePathMock,
  configuredMock,
  tokenMock,
  statusMock,
  findReclaimListMock,
  listTaskListsMock,
  createGoogleTaskMock,
  taskFindFirstMock,
  taskUpdateMock,
  stepFindFirstMock,
  stepUpdateMock,
  logRewardMock,
  awardBadgeMock,
  getSettingsMock,
} = vi.hoisted(() => ({
  workspaceMock: vi.fn(),
  revalidatePathMock: vi.fn(),
  configuredMock: vi.fn(),
  tokenMock: vi.fn(),
  statusMock: vi.fn(),
  findReclaimListMock: vi.fn(),
  listTaskListsMock: vi.fn(),
  createGoogleTaskMock: vi.fn(),
  taskFindFirstMock: vi.fn(),
  taskUpdateMock: vi.fn(),
  stepFindFirstMock: vi.fn(),
  stepUpdateMock: vi.fn(),
  logRewardMock: vi.fn(),
  awardBadgeMock: vi.fn(),
  getSettingsMock: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: revalidatePathMock }));
vi.mock("@/lib/db", () => ({
  prisma: {
    task: { findFirst: taskFindFirstMock, update: taskUpdateMock },
    step: { findFirst: stepFindFirstMock, update: stepUpdateMock },
  },
  getSettings: getSettingsMock,
}));
vi.mock("@/lib/rewards", () => ({
  logReward: logRewardMock,
  awardBadge: awardBadgeMock,
}));
vi.mock("@/lib/google", () => ({
  getValidAccessToken: tokenMock,
  googleConfigured: configuredMock,
  findReclaimList: findReclaimListMock,
  listTaskLists: listTaskListsMock,
  createGoogleTask: createGoogleTaskMock,
  getGoogleStatus: statusMock,
  disconnectGoogle: vi.fn(),
}));
vi.mock("@/lib/workspace", () => ({ currentWorkspaceId: workspaceMock }));

import { OWNER_WORKSPACE_ID, RewardType, BadgeKey } from "@/lib/constants";
import { pushStepsToGoogleTasks } from "./google-schedule";

const baseTask = (over: Record<string, unknown> = {}) => ({
  id: "task-1",
  title: "T",
  parentEmoji: "🚀",
  scheduledAt: null,
  steps: [
    { id: "s1", order: 1, text: "a", estMinutes: 10, subtaskEmoji: null },
  ],
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  logRewardMock.mockResolvedValue(undefined);
  awardBadgeMock.mockResolvedValue(undefined);
  taskUpdateMock.mockResolvedValue({});
  stepUpdateMock.mockResolvedValue({});
  stepFindFirstMock.mockResolvedValue({ id: "s1" });
  configuredMock.mockReturnValue(true);
  tokenMock.mockResolvedValue("tok");
  findReclaimListMock.mockResolvedValue({ id: "list-9", title: "🗓 Reclaim" });
  createGoogleTaskMock.mockResolvedValue({ id: "g1" });
  workspaceMock.mockResolvedValue(OWNER_WORKSPACE_ID);
  getSettingsMock.mockResolvedValue({ voice: "plain" });
});

describe("pushStepsToGoogleTasks — provider-agnostic marker + reward-once", () => {
  it("marks the task scheduled + awards once on first push", async () => {
    taskFindFirstMock.mockResolvedValue(baseTask());
    const res = await pushStepsToGoogleTasks("task-1");
    expect(res.ok).toBe(true);
    expect(taskUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "task-1" },
        data: expect.objectContaining({ scheduledVia: "google" }),
      }),
    );
    expect(logRewardMock).toHaveBeenCalledWith(
      OWNER_WORKSPACE_ID,
      RewardType.Scheduled,
    );
    expect(awardBadgeMock).toHaveBeenCalledWith(
      OWNER_WORKSPACE_ID,
      BadgeKey.FirstSchedule,
    );
  });

  it("attaches a voice-aware focus deep-link note (first step) to each Google Task (#39)", async () => {
    process.env.PUBLIC_ORIGIN = "https://app.example";
    getSettingsMock.mockResolvedValue({ voice: "playful" });
    taskFindFirstMock.mockResolvedValue(
      baseTask({
        steps: [
          { id: "s1", order: 1, text: "a", estMinutes: 10, subtaskEmoji: null },
          { id: "s2", order: 2, text: "b", estMinutes: 10, subtaskEmoji: null },
        ],
      }),
    );
    await pushStepsToGoogleTasks("task-1");
    // Every created task carries the note; the deep-link targets the FIRST step.
    for (const call of createGoogleTaskMock.mock.calls) {
      const input = call[2];
      expect(input.notes).toContain("https://app.example/focus/s1");
      expect(input.notes).toContain("🍽️");
    }
    delete process.env.PUBLIC_ORIGIN;
  });

  it("does not re-award when the task is already scheduled (idempotent)", async () => {
    taskFindFirstMock.mockResolvedValue(baseTask({ scheduledAt: new Date() }));
    await pushStepsToGoogleTasks("task-1");
    expect(logRewardMock).not.toHaveBeenCalled();
    expect(awardBadgeMock).not.toHaveBeenCalled();
  });

  // Reconciliation (c) — closes an open Duo nitpick: the steps path lacked a
  // reward-failure-safety test (the single path has one in
  // google-schedule.single.test.ts). The Google tasks are already pushed +
  // committed, so a rejecting logReward must NOT fail scheduling (allSettled).
  it("still returns ok when a reward call fails — reward errors must not fail scheduling", async () => {
    taskFindFirstMock.mockResolvedValue(baseTask());
    logRewardMock.mockRejectedValueOnce(new Error("reward store down"));
    const res = await pushStepsToGoogleTasks("task-1");
    expect(res.ok).toBe(true);
    // allSettled: a logReward failure must NOT skip the idempotent awardBadge.
    expect(awardBadgeMock).toHaveBeenCalledWith(
      OWNER_WORKSPACE_ID,
      BadgeKey.FirstSchedule,
    );
  });
});
