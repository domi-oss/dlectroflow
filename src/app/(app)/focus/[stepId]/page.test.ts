/**
 * #142 — what the focus timer page hands the completion screen as "next up".
 *
 * A query-shape + selection test, not a rendering one: the page returns a
 * `<FocusTimer …/>` element without rendering it, so its props can be read
 * directly and no jsdom setup is needed — the same shape as the launcher's
 * `page.test.ts` next door.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { BrainDumpStatus, TaskStatus } from "@/lib/constants";

const { prismaMock, getSettingsMock, currentWorkspaceIdMock, notFoundMock } =
  vi.hoisted(() => {
    const prismaMock = {
      step: { findFirst: vi.fn(), findMany: vi.fn() },
      task: { findMany: vi.fn() },
      brainDumpItem: { findMany: vi.fn() },
      focusSession: { findFirst: vi.fn() },
    };
    return {
      prismaMock,
      getSettingsMock: vi.fn(),
      currentWorkspaceIdMock: vi.fn(),
      notFoundMock: vi.fn(() => {
        throw new Error("notFound");
      }),
    };
  });

vi.mock("@/lib/db", () => ({
  prisma: prismaMock,
  getSettings: getSettingsMock,
}));
vi.mock("@/lib/workspace", () => ({
  currentWorkspaceId: currentWorkspaceIdMock,
}));
vi.mock("@/lib/rewards", () => ({
  getDashboardData: vi
    .fn()
    .mockResolvedValue({ focusMinToday: 0, currentStreak: 0 }),
}));
vi.mock("next/navigation", () => ({ notFound: notFoundMock }));

const CURRENT_TASK = "t-current";

/** The step being focused: step 1 of 1 of `t-current` (a single-task to-do). */
function currentStep(over: Record<string, unknown> = {}) {
  return {
    id: "s-current",
    text: "Call the bank",
    estMinutes: 10,
    subtaskEmoji: null,
    order: 1,
    total: 1,
    done: false,
    taskId: CURRENT_TASK,
    task: { id: CURRENT_TASK, title: "Call the bank", parentEmoji: null },
    ...over,
  };
}

function item(over: Record<string, unknown> = {}) {
  return {
    id: "i1",
    text: "Book the dentist",
    createdAt: new Date("2026-08-01T09:00:00Z"),
    status: BrainDumpStatus.Triaged,
    triagedAt: new Date("2026-08-01T09:00:00Z"),
    remindedAt: null,
    snoozedUntil: null,
    freshenedAt: null,
    promptDismissedAt: null,
    breakdownRequestedAt: null,
    completedAt: null,
    estMinutes: 5,
    taskId: null,
    task: null,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  currentWorkspaceIdMock.mockResolvedValue("owner");
  getSettingsMock.mockResolvedValue({
    voice: "plain",
    addTimeIncrementMin: 5,
    focusTimerStyle: null,
    focusMinimalMode: false,
    focusKeepAwake: true,
    focusAlarmEnabled: true,
    focusSound: "off",
    focusShuffle: false,
    focusPauseTogether: false,
    focusTimerTipDismissedAt: null,
  });
  prismaMock.step.findFirst.mockImplementation(
    async (args: { where?: { done?: boolean } }) =>
      // The first call resolves the focused step; the "next step in this task"
      // call filters on done:false and has nothing to find here.
      args?.where?.done === false ? null : currentStep(),
  );
  prismaMock.step.findMany.mockResolvedValue([currentStep()]);
  prismaMock.task.findMany.mockResolvedValue([]);
  prismaMock.brainDumpItem.findMany.mockResolvedValue([]);
  prismaMock.focusSession.findFirst.mockResolvedValue(null);
});

async function nextUpOf() {
  const { default: FocusPage } = await import("./page");
  const el = await FocusPage({
    params: Promise.resolve({ stepId: "s-current" }),
  });
  return (el as { props: { nextUp: unknown } }).props.nextUp;
}

describe("FocusPage — nextUp (#142)", () => {
  it("never offers the task the finished step belongs to", async () => {
    await nextUpOf();
    const call = prismaMock.task.findMany.mock.calls[0][0];
    expect(call.where).toMatchObject({
      workspaceId: "owner",
      id: { not: CURRENT_TASK },
      status: { not: TaskStatus.Archived },
      // Same #64 orphan filter the launcher uses, so Focus can never offer
      // something the Library cannot see.
      brainDumpItems: { some: { status: { not: BrainDumpStatus.Archived } } },
      steps: { some: { done: false } },
    });
  });

  it("picks the multi-step task with the soonest DUE date, and its next incomplete step", async () => {
    prismaMock.task.findMany.mockResolvedValue([
      {
        id: "t-late",
        title: "Later task",
        scheduleDueAt: new Date("2026-09-01T09:00:00Z"),
        scheduledAt: null,
        steps: [
          { id: "l1", text: "L1", subtaskEmoji: null, done: true },
          { id: "l2", text: "L2", subtaskEmoji: null, done: false },
        ],
      },
      {
        id: "t-soon",
        title: "Plan the offsite",
        scheduleDueAt: new Date("2026-08-05T09:00:00Z"),
        scheduledAt: null,
        steps: [
          { id: "p1", text: "Book a room", subtaskEmoji: null, done: true },
          {
            id: "p2",
            text: "Draft the agenda",
            subtaskEmoji: "📝",
            done: false,
          },
        ],
      },
    ]);
    expect(await nextUpOf()).toEqual({
      kind: "step",
      stepId: "p2",
      text: "Draft the agenda",
      emoji: "📝",
      taskTitle: "Plan the offsite",
    });
  });

  it("does not treat a ONE-step task as a multi-step task — that is a single to-do", async () => {
    prismaMock.task.findMany.mockResolvedValue([
      {
        id: "t-one",
        title: "One-stepper",
        scheduleDueAt: null,
        scheduledAt: null,
        steps: [{ id: "o1", text: "Do it", subtaskEmoji: null, done: false }],
      },
    ]);
    expect(await nextUpOf()).toBeNull();
  });

  it("falls back to the next single-task to-do once the multi-step queue is empty", async () => {
    prismaMock.brainDumpItem.findMany.mockResolvedValue([
      item({ id: "i-late", text: "Later to-do" }),
      item({
        id: "i-soon",
        text: "Book the dentist",
        taskId: "t-soon",
        task: {
          id: "t-soon",
          status: TaskStatus.Active,
          scheduledAt: null,
          scheduleDueAt: new Date("2026-08-05T09:00:00Z"),
          steps: [],
        },
      }),
    ]);
    expect(await nextUpOf()).toEqual({
      kind: "single",
      itemId: "i-soon",
      text: "Book the dentist",
    });
  });

  it("never offers the to-do that owns the step just finished", async () => {
    prismaMock.brainDumpItem.findMany.mockResolvedValue([
      item({
        id: "i-self",
        text: "Call the bank",
        taskId: CURRENT_TASK,
        task: {
          id: CURRENT_TASK,
          status: TaskStatus.Active,
          scheduledAt: null,
          scheduleDueAt: null,
          steps: [
            { id: "s-current", order: 1, text: "Call the bank", done: false },
          ],
        },
      }),
    ]);
    expect(await nextUpOf()).toBeNull();
  });

  it("is null when there is nothing left at all — the state that sends you to the dashboard", async () => {
    expect(await nextUpOf()).toBeNull();
  });
});
