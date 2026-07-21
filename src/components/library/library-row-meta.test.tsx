import { describe, it, expect } from "vitest";
import {
  nextStepText,
  remainingMinutes,
  singleTaskEstimate,
  rowEmoji,
} from "./library-row-meta";
import type { Item } from "@/components/inbox/bucket";

const base: Item = {
  id: "1",
  text: "T",
  createdAt: new Date(),
  status: "triaged",
  triagedAt: null,
  remindedAt: null,
  snoozedUntil: null,
  taskId: "t1",
  freshenedAt: null,
  promptDismissedAt: null,
  breakdownRequestedAt: null,
  stepsTotal: 3,
  stepsDone: 1,
  taskStatus: "active",
  completedAt: null,
  scheduledAt: null,
  estMinutes: null,
  steps: [
    {
      id: "s1",
      order: 1,
      text: "one",
      done: true,
      estMinutes: 10,
      subtaskEmoji: "🍳",
      resumable: false,
    },
    {
      id: "s2",
      order: 2,
      text: "two",
      done: false,
      estMinutes: 15,
      subtaskEmoji: "🥕",
      resumable: false,
    },
    {
      id: "s3",
      order: 3,
      text: "three",
      done: false,
      estMinutes: 5,
      subtaskEmoji: null,
      resumable: false,
    },
  ],
};

describe("meta helpers", () => {
  it("nextStepText picks the first not-done step", () => {
    expect(nextStepText(base)).toBe("two");
    expect(nextStepText({ ...base, steps: [] })).toBeNull();
  });
  it("remainingMinutes sums only not-done step minutes", () => {
    expect(remainingMinutes(base)).toBe(20); // 15 + 5
    expect(remainingMinutes({ ...base, steps: [] })).toBe(0);
  });
  it("singleTaskEstimate falls back to 5 when null", () => {
    expect(singleTaskEstimate({ ...base, estMinutes: null })).toBe(5);
    expect(singleTaskEstimate({ ...base, estMinutes: 12 })).toBe(12);
  });
  it("rowEmoji is the first not-done step's emoji", () => {
    expect(rowEmoji(base)).toBe("🥕");
    expect(
      rowEmoji({
        ...base,
        steps: base.steps.map((s) => ({ ...s, done: true })),
      }),
    ).toBe("🍳");
  });
});
