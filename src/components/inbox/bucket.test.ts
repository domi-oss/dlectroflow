import { describe, it, expect } from "vitest";
import { bucketItems, type Item } from "@/components/inbox/bucket";
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
