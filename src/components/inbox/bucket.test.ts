import { describe, it, expect } from "vitest";
import { bucketItems, bucketOfItem, type Item } from "@/components/inbox/bucket";
import { BrainDumpStatus, TaskStatus } from "@/lib/constants";

const NOW = new Date("2026-07-08T12:00:00Z").getTime();

function item(overrides: Partial<Item> & { id: string }): Item {
  return {
    text: overrides.id,
    createdAt: new Date(NOW),
    status: BrainDumpStatus.Inbox,
    triagedAt: null,
    remindedAt: null,
    snoozedUntil: null,
    taskId: null,
    freshenedAt: null,
    promptDismissedAt: null,
    stepsTotal: 0,
    stepsDone: 0,
    taskStatus: null,
    completedAt: null,
    steps: [],
    ...overrides,
  };
}

describe("bucketItems", () => {
  it("needsReview = unsorted inbox NOT saved-for-later", () => {
    const items = [
      item({ id: "review" }),
      item({ id: "saved", snoozedUntil: new Date(NOW + 60_000) }),
      item({ id: "triaged", status: BrainDumpStatus.Triaged }),
    ];
    const { needsReview } = bucketItems(items, NOW);
    expect(needsReview.map((i) => i.id)).toEqual(["review"]);
  });

  it("needsReview is sorted freshest / newest first", () => {
    const items = [
      item({ id: "old", createdAt: new Date(NOW - 3_000) }),
      item({ id: "new", createdAt: new Date(NOW - 1_000) }),
      item({ id: "mid", createdAt: new Date(NOW - 2_000) }),
    ];
    const { needsReview } = bucketItems(items, NOW);
    expect(needsReview.map((i) => i.id)).toEqual(["new", "mid", "old"]);
  });

  it("needsReview sort is freshness-aware: freshenedAt outranks a newer createdAt", () => {
    const items = [
      // Captured most recently but never freshened.
      item({ id: "newest", createdAt: new Date(NOW - 1_000) }),
      // Captured long ago but freshened just now → should sort to the top.
      item({
        id: "freshened",
        createdAt: new Date(NOW - 10_000),
        freshenedAt: new Date(NOW - 500),
      }),
      item({ id: "oldest", createdAt: new Date(NOW - 5_000) }),
    ];
    const { needsReview } = bucketItems(items, NOW);
    expect(needsReview.map((i) => i.id)).toEqual(["freshened", "newest", "oldest"]);
  });

  it("savedLater = inbox items snoozed into the future only", () => {
    const items = [
      item({ id: "future", snoozedUntil: new Date(NOW + 60_000) }),
      item({ id: "past", snoozedUntil: new Date(NOW - 60_000) }),
    ];
    const { savedLater, needsReview } = bucketItems(items, NOW);
    expect(savedLater.map((i) => i.id)).toEqual(["future"]);
    // an expired snooze falls back into needs-review
    expect(needsReview.map((i) => i.id)).toEqual(["past"]);
  });

  it("singleTask = triaged with 0 steps", () => {
    const items = [
      item({ id: "single", status: BrainDumpStatus.Triaged, stepsTotal: 0 }),
      item({
        id: "multi",
        status: BrainDumpStatus.Triaged,
        stepsTotal: 3,
        stepsDone: 1,
      }),
    ];
    const { singleTask } = bucketItems(items, NOW);
    expect(singleTask.map((i) => i.id)).toEqual(["single"]);
  });

  it("multiStep = triaged with steps and not all done", () => {
    const items = [
      item({
        id: "partial",
        status: BrainDumpStatus.Triaged,
        stepsTotal: 3,
        stepsDone: 1,
      }),
    ];
    const { multiStep } = bucketItems(items, NOW);
    expect(multiStep.map((i) => i.id)).toEqual(["partial"]);
  });

  it("excludes fully-done tasks (all steps done OR taskStatus done)", () => {
    const items = [
      item({
        id: "allStepsDone",
        status: BrainDumpStatus.Triaged,
        stepsTotal: 2,
        stepsDone: 2,
      }),
      item({
        id: "statusDone",
        status: BrainDumpStatus.Triaged,
        stepsTotal: 0,
        taskStatus: TaskStatus.Done,
      }),
    ];
    const { singleTask, multiStep } = bucketItems(items, NOW);
    expect(multiStep).toEqual([]);
    expect(singleTask).toEqual([]);
  });
});

describe("completed bucket", () => {
  it("collects completed items, newest first, capped at 10, excluded elsewhere", () => {
    const items = [
      item({ id: "a", status: BrainDumpStatus.Triaged, completedAt: new Date(NOW - 5_000) }),
      item({ id: "b", status: BrainDumpStatus.Triaged, completedAt: new Date(NOW - 1_000) }),
      item({ id: "todo", status: BrainDumpStatus.Triaged }),
    ];
    const { completed, singleTask } = bucketItems(items, NOW);
    expect(completed.map((i) => i.id)).toEqual(["b", "a"]);
    expect(singleTask.map((i) => i.id)).toEqual(["todo"]); // completed excluded
  });

  it("caps completed at 10 most recent", () => {
    const items = Array.from({ length: 14 }, (_, n) =>
      item({ id: `c${n}`, status: BrainDumpStatus.Triaged, completedAt: new Date(NOW - n * 1000) }),
    );
    const { completed } = bucketItems(items, NOW);
    expect(completed).toHaveLength(10);
    expect(completed[0].id).toBe("c0"); // newest
  });

  it("completedTodayCount counts only items completed since local midnight", () => {
    const midnight = new Date(NOW); midnight.setHours(0, 0, 0, 0);
    const items = [
      item({ id: "today", status: BrainDumpStatus.Triaged, completedAt: new Date(midnight.getTime() + 1000) }),
      item({ id: "yesterday", status: BrainDumpStatus.Triaged, completedAt: new Date(midnight.getTime() - 1000) }),
    ];
    const { completedTodayCount } = bucketItems(items, NOW);
    expect(completedTodayCount).toBe(1);
  });
});

describe("bucketOfItem", () => {
  it("classifies completed, saved, review, single-task and multi-step", () => {
    const now = NOW;
    expect(bucketOfItem(item({ id: "completed", status: "triaged", completedAt: new Date(now) }), now)).toBe("completed");
    expect(bucketOfItem(item({ id: "saved", status: "inbox", snoozedUntil: new Date(now + 60_000) }), now)).toBe("savedLater");
    expect(bucketOfItem(item({ id: "review", status: "inbox" }), now)).toBe("needsReview");
    expect(bucketOfItem(item({ id: "single", status: "triaged", stepsTotal: 0 }), now)).toBe("singleTask");
    expect(bucketOfItem(item({ id: "multi", status: "triaged", stepsTotal: 3, stepsDone: 1 }), now)).toBe("multiStep");
  });
});
