import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  workspaceMock,
  revalidatePathMock,
  taskFindFirstMock,
  taskUpdateMock,
  logRewardMock,
  awardBadgeMock,
  getSettingsMock,
} = vi.hoisted(() => ({
  workspaceMock: vi.fn(),
  revalidatePathMock: vi.fn(),
  taskFindFirstMock: vi.fn(),
  taskUpdateMock: vi.fn(),
  logRewardMock: vi.fn(),
  awardBadgeMock: vi.fn(),
  getSettingsMock: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: revalidatePathMock }));
vi.mock("@/lib/db", () => ({
  prisma: { task: { findFirst: taskFindFirstMock, update: taskUpdateMock } },
  getSettings: getSettingsMock,
}));
vi.mock("@/lib/rewards", () => ({
  logReward: logRewardMock,
  awardBadge: awardBadgeMock,
}));
vi.mock("@/lib/workspace", () => ({ currentWorkspaceId: workspaceMock }));

import { scheduleViaIcs } from "./ics-schedule";
import { RewardType, BadgeKey } from "@/lib/constants";

beforeEach(() => {
  vi.clearAllMocks();
  logRewardMock.mockResolvedValue(undefined);
  awardBadgeMock.mockResolvedValue(undefined);
  taskUpdateMock.mockResolvedValue({});
  getSettingsMock.mockResolvedValue({ voice: "plain" });
});

const stepTask = (over: Record<string, unknown> = {}) => ({
  id: "task-1",
  title: "Ship the thing",
  parentEmoji: "🚀",
  scheduledAt: null,
  steps: [{ text: "Plan", estMinutes: 15, subtaskEmoji: "📝" }],
  ...over,
});

describe("scheduleViaIcs", () => {
  it("awards Scheduled + FirstSchedule once on first schedule and marks the task", async () => {
    workspaceMock.mockResolvedValue("owner");
    taskFindFirstMock.mockResolvedValue(stepTask());
    const res = await scheduleViaIcs("task-1");
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.ics).toContain("BEGIN:VCALENDAR");
      expect(res.icsFilename).toBe("dlectroflow-Ship-the-thing.ics");
    }
    expect(taskUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "task-1" },
        data: expect.objectContaining({ scheduledVia: "ics" }),
      }),
    );
    expect(logRewardMock).toHaveBeenCalledWith("owner", RewardType.Scheduled);
    expect(awardBadgeMock).toHaveBeenCalledWith(
      "owner",
      BadgeKey.FirstSchedule,
    );
  });

  it("guest workspace earns the reward (no owner gate)", async () => {
    workspaceMock.mockResolvedValue("guest-ws");
    taskFindFirstMock.mockResolvedValue(stepTask());
    const res = await scheduleViaIcs("task-1");
    expect(res.ok).toBe(true);
    expect(logRewardMock).toHaveBeenCalledWith(
      "guest-ws",
      RewardType.Scheduled,
    );
  });

  it("is idempotent: an already-scheduled task returns the .ics but does NOT re-award", async () => {
    workspaceMock.mockResolvedValue("owner");
    taskFindFirstMock.mockResolvedValue(
      stepTask({ scheduledAt: new Date("2026-07-17T10:00:00Z") }),
    );
    const res = await scheduleViaIcs("task-1");
    expect(res.ok).toBe(true);
    expect(taskUpdateMock).not.toHaveBeenCalled();
    expect(logRewardMock).not.toHaveBeenCalled();
    expect(awardBadgeMock).not.toHaveBeenCalled();
  });

  it("no-steps task synthesizes one event from durationMin", async () => {
    workspaceMock.mockResolvedValue("owner");
    taskFindFirstMock.mockResolvedValue(stepTask({ steps: [] }));
    const res = await scheduleViaIcs("task-1", { durationMin: 45 });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect((res.ics.match(/BEGIN:VEVENT/g) ?? []).length).toBe(1);
      expect(res.ics).toContain("SUMMARY:🚀 Ship the thing");
    }
  });

  it("wrong-workspace taskId is not found (IDOR-safe) — no award, no marker", async () => {
    workspaceMock.mockResolvedValue("guest-ws");
    taskFindFirstMock.mockResolvedValue(null);
    const res = await scheduleViaIcs("task-owned-by-someone-else");
    expect(res).toEqual({ ok: false, reason: "not_found" });
    expect(taskFindFirstMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "task-owned-by-someone-else", workspaceId: "guest-ws" },
      }),
    );
    expect(logRewardMock).not.toHaveBeenCalled();
    expect(taskUpdateMock).not.toHaveBeenCalled();
  });

  // #104: every VEVENT used to carry steps[0]'s link, so a downloaded calendar
  // sent all of a task's events to step 1's timer. Each event links to ITS step.
  it("embeds a voice-aware focus deep-link note pointing at ITS OWN step (#104)", async () => {
    workspaceMock.mockResolvedValue("owner");
    getSettingsMock.mockResolvedValue({ voice: "playful" });
    process.env.PUBLIC_ORIGIN = "https://app.example";
    taskFindFirstMock.mockResolvedValue(
      stepTask({
        steps: [
          { id: "step-A", text: "Plan", estMinutes: 15 },
          { id: "step-B", text: "Build", estMinutes: 20 },
        ],
      }),
    );
    const res = await scheduleViaIcs("task-1");
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect((res.ics.match(/DESCRIPTION:/g) ?? []).length).toBe(2);
      expect(res.ics).toContain("https://app.example/focus/step-A");
      expect(res.ics).toContain("https://app.example/focus/step-B");
      expect(res.ics).toContain("🍽️"); // playful voice resolved from settings
      // The owner asked for defended time and an .ics can say so (#104).
      expect((res.ics.match(/TRANSP:OPAQUE/g) ?? []).length).toBe(2);
    }
    delete process.env.PUBLIC_ORIGIN;
  });

  it("stepless task deep-links to the /focus launcher (no step id available)", async () => {
    workspaceMock.mockResolvedValue("owner");
    process.env.PUBLIC_ORIGIN = "https://app.example";
    taskFindFirstMock.mockResolvedValue(stepTask({ steps: [] }));
    const res = await scheduleViaIcs("task-1", { durationMin: 30 });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.ics).toContain("https://app.example/focus");
      expect(res.ics).not.toContain("/focus/");
    }
    delete process.env.PUBLIC_ORIGIN;
  });

  it("a reward failure does not fail scheduling (returns the .ics anyway)", async () => {
    workspaceMock.mockResolvedValue("owner");
    taskFindFirstMock.mockResolvedValue(stepTask());
    logRewardMock.mockRejectedValue(new Error("db down"));
    const res = await scheduleViaIcs("task-1");
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.ics).toContain("BEGIN:VCALENDAR");
  });
});
