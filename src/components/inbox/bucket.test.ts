import { describe, it, expect } from "vitest";
import { bucketItems, bucketOfItem, libraryBuckets, type Item } from "@/components/inbox/bucket";
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
    breakdownRequestedAt: null,
    stepsTotal: 0,
    stepsDone: 0,
    taskStatus: null,
    completedAt: null,
    scheduledAt: null,
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

  it("a one-step task is a single to-do (its step is the ▶ Focus target), not multi-step", () => {
    const items = [
      item({
        id: "one-step",
        status: BrainDumpStatus.Triaged,
        taskId: "t1",
        stepsTotal: 1,
        stepsDone: 0,
      }),
    ];
    const { singleTask, multiStep } = bucketItems(items, NOW);
    expect(singleTask.map((i) => i.id)).toEqual(["one-step"]);
    expect(multiStep).toEqual([]);
    expect(bucketOfItem(items[0], NOW)).toBe("singleTask");
  });

  it("a triaged 0-step item with breakdownRequestedAt sits in multiStep (awaiting breakdown), not singleTask", () => {
    const items = [
      item({
        id: "awaiting",
        status: BrainDumpStatus.Triaged,
        stepsTotal: 0,
        breakdownRequestedAt: new Date(NOW),
      }),
    ];
    const { multiStep, singleTask } = bucketItems(items, NOW);
    expect(multiStep.map((i) => i.id)).toEqual(["awaiting"]);
    expect(singleTask).toEqual([]);
    expect(bucketOfItem(items[0], NOW)).toBe("multiStep");
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

describe("libraryBuckets (Library hub tabs)", () => {
  it("plated/sorted/pantry mirror the Inbox singleTask/multiStep/savedLater buckets", () => {
    const items = [
      item({ id: "single", status: BrainDumpStatus.Triaged, stepsTotal: 0 }),
      item({ id: "partial", status: BrainDumpStatus.Triaged, taskId: "t", stepsTotal: 3, stepsDone: 1 }),
      item({ id: "saved", snoozedUntil: new Date(NOW + 60_000) }),
    ];
    const lib = libraryBuckets(items, NOW);
    expect(lib.singleTask.map((i) => i.id)).toEqual(["single"]);
    expect(lib.multiStep.map((i) => i.id)).toEqual(["partial"]);
    expect(lib.savedLater.map((i) => i.id)).toEqual(["saved"]);
  });

  it("Done: a task graduates when ALL steps are done", () => {
    const items = [
      item({ id: "allDone", status: BrainDumpStatus.Triaged, taskId: "t", stepsTotal: 4, stepsDone: 4 }),
    ];
    const lib = libraryBuckets(items, NOW);
    expect(lib.done.map((i) => i.id)).toEqual(["allDone"]);
    // and it has GRADUATED out of the in-progress Multi-step tab
    expect(lib.multiStep).toEqual([]);
  });

  it("Done: a partially-done task does NOT graduate (stays in Multi-step)", () => {
    const items = [
      item({ id: "partial", status: BrainDumpStatus.Triaged, taskId: "t", stepsTotal: 4, stepsDone: 2 }),
    ];
    const lib = libraryBuckets(items, NOW);
    expect(lib.done).toEqual([]);
    expect(lib.multiStep.map((i) => i.id)).toEqual(["partial"]);
  });

  it("Done: a no-step task that isn't completed does NOT graduate (stays Single-task)", () => {
    const items = [
      item({ id: "single", status: BrainDumpStatus.Triaged, stepsTotal: 0 }),
    ];
    const lib = libraryBuckets(items, NOW);
    expect(lib.done).toEqual([]);
    expect(lib.singleTask.map((i) => i.id)).toEqual(["single"]);
  });

  it("Done also collects explicitly-completed items (e.g. a finished single to-do)", () => {
    const items = [
      item({ id: "todoDone", status: BrainDumpStatus.Triaged, stepsTotal: 0, completedAt: new Date(NOW) }),
    ];
    const lib = libraryBuckets(items, NOW);
    expect(lib.done.map((i) => i.id)).toEqual(["todoDone"]);
    // completed items are excluded from the in-progress tabs
    expect(lib.singleTask).toEqual([]);
  });

  it("Done is newest-first and NOT capped at 10 (unlike the Inbox preview)", () => {
    const items = Array.from({ length: 14 }, (_, n) =>
      item({ id: `d${n}`, status: BrainDumpStatus.Triaged, completedAt: new Date(NOW - n * 1000) }),
    );
    const lib = libraryBuckets(items, NOW);
    expect(lib.done).toHaveLength(14);
    expect(lib.done[0].id).toBe("d0"); // newest first
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

  it("falls back to needsReview for states outside every bucket rule", () => {
    // Fully done but not stamped completedAt — e.g. a task finished before the
    // completedAt migration, or a race between task.status and the stamp.
    expect(
      bucketOfItem(item({ id: "doneNoStamp", status: "triaged", taskStatus: TaskStatus.Done }), NOW),
    ).toBe("needsReview");
    expect(
      bucketOfItem(item({ id: "allStepsDone", status: "triaged", stepsTotal: 2, stepsDone: 2 }), NOW),
    ).toBe("needsReview");
    // An unknown status string shouldn't crash the board either.
    expect(bucketOfItem(item({ id: "weird", status: "archived" }), NOW)).toBe("needsReview");
  });
});
