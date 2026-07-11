import { describe, it, expect } from "vitest";
import { ACTION_FOR_BUCKET, dropPlan } from "./move-dispatch";

describe("ACTION_FOR_BUCKET (anti-inversion map)", () => {
  it("maps each bucket to its destination action", () => {
    expect(ACTION_FOR_BUCKET.needsReview).toBe("moveToReview");
    expect(ACTION_FOR_BUCKET.singleTask).toBe("triage");
    expect(ACTION_FOR_BUCKET.multiStep).toBe("requestBreakdown");
    expect(ACTION_FOR_BUCKET.savedLater).toBe("snooze");
    expect(ACTION_FOR_BUCKET.completed).toBe("complete");
  });
});

describe("dropPlan", () => {
  it("is a no-op when dropped on its own bucket", () => {
    expect(dropPlan("singleTask", "singleTask")).toEqual({ kind: "noop" });
  });

  it("applies the target action for a cross-bucket move", () => {
    expect(dropPlan("needsReview", "singleTask")).toEqual({
      kind: "apply", target: "singleTask", action: "triage", reopenFirst: false,
    });
    expect(dropPlan("singleTask", "completed")).toEqual({
      kind: "apply", target: "completed", action: "complete", reopenFirst: false,
    });
  });

  it("reopens first when the source is completed", () => {
    expect(dropPlan("completed", "singleTask")).toMatchObject({ kind: "apply", reopenFirst: true, action: "triage" });
  });

  it("multi-step target moves immediately via requestBreakdown (no blocking prompt)", () => {
    expect(dropPlan("needsReview", "multiStep")).toEqual({
      kind: "apply", target: "multiStep", action: "requestBreakdown", reopenFirst: false,
    });
    expect(dropPlan("completed", "multiStep")).toMatchObject({ reopenFirst: true, action: "requestBreakdown" });
  });
});
