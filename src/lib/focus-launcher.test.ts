import { describe, it, expect } from "vitest";
import { focusableSteps, type FocusTask } from "@/lib/focus-launcher";

const NOW = new Date("2026-07-18T12:00:00Z").getTime();

function step(overrides: Partial<FocusTask["steps"][number]> & { id: string }) {
  return {
    order: 1,
    text: overrides.id,
    done: false,
    estMinutes: 10,
    subtaskEmoji: null,
    resumable: false,
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
    });
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
