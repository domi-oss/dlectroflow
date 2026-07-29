import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  workspaceMock,
  isOwnerMock,
  revalidatePathMock,
  configuredMock,
  tokenMock,
  statusMock,
  findReclaimListMock,
  listTaskListsMock,
  createGoogleTaskMock,
  upsertGoogleTaskMock,
  taskFindFirstMock,
  taskUpdateMock,
  stepFindFirstMock,
  stepUpdateMock,
  logRewardMock,
  awardBadgeMock,
  getSettingsMock,
} = vi.hoisted(() => ({
  workspaceMock: vi.fn(),
  isOwnerMock: vi.fn(),
  revalidatePathMock: vi.fn(),
  configuredMock: vi.fn(),
  tokenMock: vi.fn(),
  statusMock: vi.fn(),
  findReclaimListMock: vi.fn(),
  listTaskListsMock: vi.fn(),
  createGoogleTaskMock: vi.fn(),
  upsertGoogleTaskMock: vi.fn(),
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
  upsertGoogleTask: upsertGoogleTaskMock,
  getGoogleStatus: statusMock,
  disconnectGoogle: vi.fn(),
}));
vi.mock("@/lib/workspace", () => ({
  currentWorkspaceId: workspaceMock,
  isOwnerRequest: isOwnerMock,
}));

import { RewardType, BadgeKey } from "@/lib/constants";
import { SchedulePriority, ScheduleHours } from "@/lib/scheduling/types";
import type { ScheduleIntent } from "@/lib/scheduling/types";
import { pushStepsToGoogleTasks } from "./google-schedule";

// #35 Phase A — the owner's workspace is a real per-account id now, not the
// "owner" constant. Ownership is asserted through isOwnerRequest (the role
// check the action actually makes); this id is just the workspace that
// account happens to own.
const OWNER_WS = "ws-owner";

const baseTask = (over: Record<string, unknown> = {}) => ({
  id: "task-1",
  title: "T",
  parentEmoji: "🚀",
  scheduledAt: null,
  steps: [
    {
      id: "s1",
      order: 1,
      text: "a",
      estMinutes: 10,
      subtaskEmoji: null,
      googleTaskId: null,
    },
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
  upsertGoogleTaskMock.mockResolvedValue({ id: "g1", created: true });
  workspaceMock.mockResolvedValue(OWNER_WS);
  isOwnerMock.mockResolvedValue(true);
  getSettingsMock.mockResolvedValue({ voice: "plain" });
});

describe("pushStepsToGoogleTasks — provider-agnostic marker + reward-once", () => {
  // #119 — this file's beforeEach pins isOwnerRequest → true, so until now every
  // test here ran as the owner and NOTHING asserted the rejection. That absent
  // negative case is why the missing owner gate on the OAuth routes went
  // unnoticed: the guard was covered on the paths that USE the credential
  // (single/disconnect) and nowhere on the push path. Phase C (#118) will change
  // what "allowed" means here, and this is the test it has to keep passing.
  it("rejects a non-owner without touching Google", async () => {
    isOwnerMock.mockResolvedValue(false);
    taskFindFirstMock.mockResolvedValue(baseTask());
    await expect(pushStepsToGoogleTasks("task-1")).rejects.toThrow(
      "owner only",
    );
    expect(upsertGoogleTaskMock).not.toHaveBeenCalled();
    expect(createGoogleTaskMock).not.toHaveBeenCalled();
    expect(taskUpdateMock).not.toHaveBeenCalled();
    expect(logRewardMock).not.toHaveBeenCalled();
  });

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
    expect(logRewardMock).toHaveBeenCalledWith(OWNER_WS, RewardType.Scheduled);
    expect(awardBadgeMock).toHaveBeenCalledWith(
      OWNER_WS,
      BadgeKey.FirstSchedule,
    );
  });

  // #104: the deep link used to be built ONCE from steps[0] and reused, so
  // every event opened the timer on step 1. It is now built per step.
  it("attaches a voice-aware focus deep-link note pointing at ITS OWN step (#104)", async () => {
    process.env.PUBLIC_ORIGIN = "https://app.example";
    getSettingsMock.mockResolvedValue({ voice: "playful" });
    taskFindFirstMock.mockResolvedValue(
      baseTask({
        steps: [
          {
            id: "s1",
            order: 1,
            text: "a",
            estMinutes: 10,
            subtaskEmoji: null,
            googleTaskId: null,
          },
          {
            id: "s2",
            order: 2,
            text: "b",
            estMinutes: 10,
            subtaskEmoji: null,
            googleTaskId: null,
          },
        ],
      }),
    );
    await pushStepsToGoogleTasks("task-1");

    expect(upsertGoogleTaskMock).toHaveBeenCalledTimes(2);
    const notesFor = (stepId: string) =>
      upsertGoogleTaskMock.mock.calls.find((c) =>
        (c[3] as { notes: string }).notes.includes(`/focus/${stepId}`),
      )?.[3] as { notes: string } | undefined;
    expect(notesFor("s1")?.notes).toContain("https://app.example/focus/s1");
    expect(notesFor("s2")?.notes).toContain("https://app.example/focus/s2");
    // Voice still resolved from settings, on every note.
    for (const call of upsertGoogleTaskMock.mock.calls) {
      expect((call[3] as { notes: string }).notes).toContain("🍽️");
    }
    delete process.env.PUBLIC_ORIGIN;
  });

  // #104: the sequence Reclaim needs in order to stop inverting the steps.
  it("briefs Reclaim with disjoint windows, the 30-minute floor and the hours category", async () => {
    taskFindFirstMock.mockResolvedValue(
      baseTask({
        steps: [
          {
            id: "s1",
            order: 1,
            text: "a",
            estMinutes: 10,
            subtaskEmoji: null,
            googleTaskId: null,
          },
          {
            id: "s2",
            order: 2,
            text: "b",
            estMinutes: 10,
            subtaskEmoji: null,
            googleTaskId: null,
          },
        ],
      }),
    );
    await pushStepsToGoogleTasks("task-1");

    const titles = upsertGoogleTaskMock.mock.calls.map(
      (c) => (c[3] as { title: string }).title,
    );
    expect(titles[0]).toContain("[1/2]");
    expect(titles[1]).toContain("[2/2]");
    // The first unit may start immediately; later ones may not.
    expect(titles[0]).not.toContain("not before");
    expect(titles[1]).toContain("(not before ");
    for (const title of titles) {
      expect(title).toContain("(duration:30m)"); // 10m estimate, floored
      expect(title).toContain("(nosplit)");
      expect(title).toContain("(priority:P2)");
      expect(title).toContain("(type work)");
      expect(title).toContain("(due ");
    }
  });

  // #104: Step.googleTaskId was persisted and never read, so a re-schedule
  // POSTed a second task and Reclaim booked a second block.
  it("updates the existing Google Task on a re-schedule instead of creating another", async () => {
    taskFindFirstMock.mockResolvedValue(
      baseTask({
        steps: [
          {
            id: "s1",
            order: 1,
            text: "a",
            estMinutes: 10,
            subtaskEmoji: null,
            googleTaskId: "gtask-existing",
          },
        ],
      }),
    );
    upsertGoogleTaskMock.mockResolvedValue({
      id: "gtask-existing",
      created: false,
    });
    await pushStepsToGoogleTasks("task-1");
    expect(upsertGoogleTaskMock).toHaveBeenCalledWith(
      "tok",
      "list-9",
      "gtask-existing",
      expect.objectContaining({ title: expect.any(String) }),
    );
    expect(createGoogleTaskMock).not.toHaveBeenCalled();
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
      OWNER_WS,
      BadgeKey.FirstSchedule,
    );
  });
});

// ── #106 — the Schedule menu's intent ────────────────────────────────────────
// These assert on the `prisma.task.update` argument through this file's existing
// module-boundary mock, rather than adding a second harness.
describe("pushStepsToGoogleTasks — persisting what the owner chose (#106)", () => {
  const chosen: ScheduleIntent = {
    dueAt: new Date("2026-08-07T16:00:00.000Z"),
    priority: SchedulePriority.Critical,
    hours: ScheduleHours.Personal,
    busy: true,
    units: [],
  };

  const twoStepTask = (over: Record<string, unknown> = {}) =>
    baseTask({
      steps: [
        {
          id: "s1",
          order: 1,
          text: "a",
          estMinutes: 10,
          subtaskEmoji: null,
          googleTaskId: null,
        },
        {
          id: "s2",
          order: 2,
          text: "b",
          estMinutes: 10,
          subtaskEmoji: null,
          googleTaskId: null,
        },
      ],
      ...over,
    });

  const lastUpdateData = () =>
    taskUpdateMock.mock.calls.at(-1)![0].data as Record<string, unknown>;
  const pushedTitles = () =>
    upsertGoogleTaskMock.mock.calls.map(
      (c) => (c[3] as { title: string }).title,
    );

  it("writes the chosen deadline, priority and hours onto the task", async () => {
    taskFindFirstMock.mockResolvedValue(baseTask());
    await pushStepsToGoogleTasks("task-1", chosen);
    expect(lastUpdateData()).toMatchObject({
      scheduleDueAt: chosen.dueAt,
      schedulePriority: "critical",
      scheduleHours: "personal",
    });
  });

  it("briefs Reclaim with the chosen priority and hours, not the defaults", async () => {
    taskFindFirstMock.mockResolvedValue(baseTask());
    await pushStepsToGoogleTasks("task-1", chosen);
    const title = pushedTitles()[0];
    expect(title).toContain("(priority:P1)"); // critical, not High's P2
    expect(title).toContain("(type personal)");
  });

  it("leaves the three columns untouched when no intent is supplied", async () => {
    taskFindFirstMock.mockResolvedValue(baseTask());
    await pushStepsToGoogleTasks("task-1");
    const data = lastUpdateData();
    expect(data).not.toHaveProperty("schedulePriority");
    expect(data).not.toHaveProperty("scheduleHours");
    expect(data).not.toHaveProperty("scheduleDueAt");
    // ...and the marker is still stamped, exactly as before #106.
    expect(data).toMatchObject({ scheduledVia: "google" });
  });

  // A defaults-only push must not quietly overwrite what the owner picked last
  // time — that is the whole point of persisting it.
  it("does not touch the task at all on a defaults-only re-push", async () => {
    taskFindFirstMock.mockResolvedValue(baseTask({ scheduledAt: new Date() }));
    await pushStepsToGoogleTasks("task-1");
    expect(taskUpdateMock).not.toHaveBeenCalled();
  });

  it("still records a chosen intent on an already-scheduled task", async () => {
    taskFindFirstMock.mockResolvedValue(baseTask({ scheduledAt: new Date() }));
    await pushStepsToGoogleTasks("task-1", chosen);
    const data = lastUpdateData();
    expect(data).toMatchObject({ schedulePriority: "critical" });
    // The marker is a FIRST-schedule fact: re-scheduling must not restamp it.
    expect(data).not.toHaveProperty("scheduledAt");
    expect(data).not.toHaveProperty("scheduledVia");
  });

  // A client could otherwise smuggle in steps that do not exist, or drop ones
  // that do, and we would push a schedule for work the task does not contain.
  it("ignores units supplied by the caller and uses the task's real steps", async () => {
    taskFindFirstMock.mockResolvedValue(twoStepTask());
    await pushStepsToGoogleTasks("task-1", {
      ...chosen,
      units: [
        {
          id: "not_a_real_step",
          order: 1,
          total: 1,
          text: "injected",
          estMinutes: 30,
        },
      ],
    });
    const titles = pushedTitles();
    expect(titles.some((t) => t.includes("injected"))).toBe(false);
    expect(titles).toHaveLength(2); // the task's two real steps
    expect(titles[0]).toContain("[1/2]");
  });

  it("still awards the first-schedule reward exactly once", async () => {
    taskFindFirstMock.mockResolvedValue(baseTask());
    await pushStepsToGoogleTasks("task-1", chosen);
    // Second push sees the marker the first one wrote.
    taskFindFirstMock.mockResolvedValue(baseTask({ scheduledAt: new Date() }));
    await pushStepsToGoogleTasks("task-1", chosen);
    expect(awardBadgeMock).toHaveBeenCalledTimes(1);
    expect(logRewardMock).toHaveBeenCalledTimes(1);
  });
});
