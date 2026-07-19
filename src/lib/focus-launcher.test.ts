import { describe, it, expect } from "vitest";
import {
  focusableSteps,
  focusLauncherData,
  type FocusTask,
  type SingleFocusable,
} from "@/lib/focus-launcher";

const NOW = new Date("2026-07-18T12:00:00Z").getTime();

function step(overrides: Partial<FocusTask["steps"][number]> & { id: string }) {
  return {
    order: 1,
    text: overrides.id,
    done: false,
    estMinutes: 10,
    subtaskEmoji: null,
    resumable: false,
    resumeAt: null,
    ...overrides,
  };
}

function task(overrides: Partial<FocusTask> & { id: string }): FocusTask {
  return {
    title: overrides.id,
    createdAt: new Date(NOW),
    steps: [],
    ...overrides,
  };
}

describe("focusableSteps", () => {
  it("derives one entry = the next incomplete step (first not-done by order) per task", () => {
    const tasks = [
      task({
        id: "t1",
        title: "Write report",
        steps: [
          step({ id: "s1", order: 1, done: true }),
          step({ id: "s2", order: 2, done: false, text: "Draft intro", estMinutes: 25, subtaskEmoji: "✍️" }),
          step({ id: "s3", order: 3, done: false, text: "Later" }),
        ],
      }),
    ];
    const entries = focusableSteps(tasks);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({
      stepId: "s2",
      stepText: "Draft intro",
      subtaskEmoji: "✍️",
      estMinutes: 25,
      taskId: "t1",
      taskTitle: "Write report",
      resumable: false,
      resumeAt: null,
      stepIndex: 2,
      stepsDone: 1,
      stepsTotal: 3,
      nextStepText: "Later",
      nextStepEmoji: null,
    });
  });

  it("carries resumeAt through from the next incomplete step", () => {
    const tasks = [
      task({
        id: "t1",
        steps: [
          step({ id: "s1", order: 1, done: true, resumable: true, resumeAt: 111 }),
          step({ id: "s2", order: 2, done: false, resumable: true, resumeAt: 222 }),
        ],
      }),
    ];
    expect(focusableSteps(tasks)[0]).toMatchObject({ stepId: "s2", resumable: true, resumeAt: 222 });
  });

  it("finds the next incomplete step by order even when steps arrive unsorted", () => {
    const tasks = [
      task({
        id: "t1",
        steps: [
          step({ id: "s3", order: 3, done: false }),
          step({ id: "s1", order: 1, done: true }),
          step({ id: "s2", order: 2, done: false }),
        ],
      }),
    ];
    expect(focusableSteps(tasks).map((e) => e.stepId)).toEqual(["s2"]);
  });

  it("excludes tasks with no incomplete steps (fully done) and tasks with no steps", () => {
    const tasks = [
      task({ id: "done", steps: [step({ id: "d1", done: true }), step({ id: "d2", order: 2, done: true })] }),
      task({ id: "empty", steps: [] }),
      task({ id: "active", steps: [step({ id: "a1", done: false })] }),
    ];
    expect(focusableSteps(tasks).map((e) => e.taskId)).toEqual(["active"]);
  });

  it("orders resumable (paused) entries first", () => {
    const tasks = [
      // Newer, but not resumable.
      task({ id: "fresh", createdAt: new Date(NOW), steps: [step({ id: "f1", resumable: false })] }),
      // Older, but resumable → should sort first.
      task({ id: "paused", createdAt: new Date(NOW - 100_000), steps: [step({ id: "p1", resumable: true })] }),
    ];
    expect(focusableSteps(tasks).map((e) => e.taskId)).toEqual(["paused", "fresh"]);
  });

  it("within the same resumable tier, orders by task recency (newest createdAt first)", () => {
    const tasks = [
      task({ id: "old", createdAt: new Date(NOW - 3_000), steps: [step({ id: "o1" })] }),
      task({ id: "new", createdAt: new Date(NOW - 1_000), steps: [step({ id: "n1" })] }),
      task({ id: "mid", createdAt: new Date(NOW - 2_000), steps: [step({ id: "m1" })] }),
    ];
    expect(focusableSteps(tasks).map((e) => e.taskId)).toEqual(["new", "mid", "old"]);
  });

  it("resumable-first wins over recency: an old paused task beats a newer active one", () => {
    const tasks = [
      task({ id: "newActive", createdAt: new Date(NOW), steps: [step({ id: "na1", resumable: false })] }),
      task({ id: "oldPaused", createdAt: new Date(NOW - 999_999), steps: [step({ id: "op1", resumable: true })] }),
      task({ id: "midActive", createdAt: new Date(NOW - 5_000), steps: [step({ id: "ma1", resumable: false })] }),
    ];
    expect(focusableSteps(tasks).map((e) => e.taskId)).toEqual([
      "oldPaused",
      "newActive",
      "midActive",
    ]);
  });

  it("entry.resumable reflects the NEXT incomplete step's paused state, not earlier done steps", () => {
    const tasks = [
      task({
        id: "t1",
        steps: [
          step({ id: "s1", order: 1, done: true, resumable: true }),
          step({ id: "s2", order: 2, done: false, resumable: false }),
        ],
      }),
    ];
    expect(focusableSteps(tasks)[0]).toMatchObject({ stepId: "s2", resumable: false });
  });

  it("returns an empty array when there are no focusable steps (new-user case)", () => {
    expect(focusableSteps([])).toEqual([]);
  });
});

const single = (o: Partial<SingleFocusable> & { itemId: string }): SingleFocusable => ({
  text: o.itemId,
  estMinutes: 5,
  ...o,
});

describe("focusLauncherData", () => {
  it("passes single-task items straight through and keeps one-step tasks OUT of the multi-step lane", () => {
    const tasks = [
      task({ id: "single-task", steps: [step({ id: "st1" })] }), // one step → NOT multi
      task({ id: "multi", steps: [step({ id: "m1", done: true }), step({ id: "m2" })] }),
    ];
    const items = [single({ itemId: "i1", text: "Buy milk", estMinutes: 8 })];
    const data = focusLauncherData(tasks, items);
    expect(data.singleTasks).toEqual(items);
    expect(data.multiStep.map((e) => e.taskId)).toEqual(["multi"]);
  });

  it("picks the resume hero = the most-recently-active paused MULTI-step step (highest resumeAt)", () => {
    // The paused step must be each task's NEXT INCOMPLETE step (leading steps
    // done) — resumable is read off the next-incomplete step (see focusableSteps).
    const tasks = [
      task({ id: "a", steps: [step({ id: "a1", order: 1, done: true }), step({ id: "a2", order: 2, resumable: true, resumeAt: 100 })] }),
      task({ id: "b", steps: [step({ id: "b1", order: 1, done: true }), step({ id: "b2", order: 2, resumable: true, resumeAt: 300 })] }),
      task({ id: "c", steps: [step({ id: "c1", order: 1, done: true }), step({ id: "c2", order: 2, resumable: true, resumeAt: 200 })] }),
    ];
    const data = focusLauncherData(tasks, []);
    expect(data.resumeHero?.stepId).toBe("b2");
  });

  it("excludes the hero from the multi-step lane (no duplication)", () => {
    const tasks = [
      task({ id: "a", steps: [step({ id: "a1", order: 1, done: true }), step({ id: "a2", order: 2, resumable: true, resumeAt: 100 })] }),
      task({ id: "b", steps: [step({ id: "b1", order: 1 }), step({ id: "b2", order: 2 })] }),
    ];
    const data = focusLauncherData(tasks, []);
    expect(data.resumeHero?.taskId).toBe("a");
    expect(data.multiStep.map((e) => e.taskId)).toEqual(["b"]);
  });

  it("has no hero when no multi-step step is paused", () => {
    const tasks = [task({ id: "b", steps: [step({ id: "b1" }), step({ id: "b2" })] })];
    expect(focusLauncherData(tasks, []).resumeHero).toBeNull();
  });

  it("computes minutesToClear = Σ next multi-step est + Σ single-task est (hero included)", () => {
    const tasks = [
      task({ id: "a", steps: [step({ id: "a1", done: true }), step({ id: "a2", estMinutes: 20, resumable: true, resumeAt: 5 })] }),
      task({ id: "b", steps: [step({ id: "b1", estMinutes: 15 }), step({ id: "b2" })] }),
    ];
    const items = [single({ itemId: "i1", estMinutes: 8 }), single({ itemId: "i2", estMinutes: 12 })];
    // 20 (hero a2) + 15 (b1) + 8 + 12 = 55
    expect(focusLauncherData(tasks, items).meta.minutesToClear).toBe(55);
  });

  it("returns empty lanes + null hero + 0 minutes for the empty/all-cleared case", () => {
    expect(focusLauncherData([], [])).toEqual({
      resumeHero: null,
      singleTasks: [],
      multiStep: [],
      meta: { minutesToClear: 0 },
    });
  });
});
