import { describe, it, expect } from "vitest";
import {
  effectiveRemainingMin,
  taskRemainingMin,
  itemRemainingMin,
  activeStepRemainingMin,
} from "@/lib/task-remaining";
import type { Item } from "@/components/inbox/bucket";

// #27 follow-up — "effective remaining" per step, and the task total that's
// the sum of it: 0 once a step is done; the persisted remaining of its open
// FocusSession (paused or actively running — a server-rendered SNAPSHOT, not
// a live tick) when it has one; else its full estimate (not started).
describe("effectiveRemainingMin", () => {
  it("is 0 once the step is done, regardless of estimate or any open session", () => {
    expect(
      effectiveRemainingMin({
        done: true,
        estMinutes: 25,
        openRemainingSec: null,
      }),
    ).toBe(0);
    expect(
      effectiveRemainingMin({
        done: true,
        estMinutes: 25,
        openRemainingSec: 900,
      }),
    ).toBe(0);
  });

  it("is the full estimate when there's no open session (not started)", () => {
    expect(
      effectiveRemainingMin({
        done: false,
        estMinutes: 25,
        openRemainingSec: null,
      }),
    ).toBe(25);
  });

  it("is the open session's remaining (rounded to minutes) when in progress/paused", () => {
    expect(
      effectiveRemainingMin({
        done: false,
        estMinutes: 25,
        openRemainingSec: 15 * 60, // 15m left, exactly
      }),
    ).toBe(15);
    // Rounds rather than floors/ceils raw seconds.
    expect(
      effectiveRemainingMin({
        done: false,
        estMinutes: 25,
        openRemainingSec: 90, // 1.5 minutes → rounds to 2
      }),
    ).toBe(2);
  });

  it("never goes negative", () => {
    expect(
      effectiveRemainingMin({
        done: false,
        estMinutes: 25,
        openRemainingSec: -30,
      }),
    ).toBe(0);
  });

  it("treats a missing openRemainingSec (undefined) the same as null", () => {
    expect(effectiveRemainingMin({ done: false, estMinutes: 25 })).toBe(25);
  });
});

describe("taskRemainingMin — the task total is the SUM of effective-remaining", () => {
  it("sums full estimates for not-started steps (no open sessions)", () => {
    const steps = [
      { done: true, estMinutes: 10, openRemainingSec: null }, // done → 0
      { done: false, estMinutes: 15, openRemainingSec: null },
      { done: false, estMinutes: 5, openRemainingSec: null },
    ];
    expect(taskRemainingMin(steps)).toBe(20); // 15 + 5
  });

  it("a paused/in-progress step contributes its remaining, not its full estimate — the total shrinks as you progress", () => {
    const steps = [
      { done: true, estMinutes: 10, openRemainingSec: null },
      { done: false, estMinutes: 15, openRemainingSec: 5 * 60 }, // 15m est, 5m left
      { done: false, estMinutes: 5, openRemainingSec: null },
    ];
    expect(taskRemainingMin(steps)).toBe(10); // 5 (paused step) + 5 (not started)
  });

  it("is 0 for a fully-completed task", () => {
    const steps = [
      { done: true, estMinutes: 10, openRemainingSec: null },
      { done: true, estMinutes: 15, openRemainingSec: null },
    ];
    expect(taskRemainingMin(steps)).toBe(0);
  });

  it("is 0 for a task with no steps", () => {
    expect(taskRemainingMin([])).toBe(0);
  });
});

function item(steps: Item["steps"]): Pick<Item, "steps"> {
  return { steps };
}

function step(
  overrides: Partial<Item["steps"][number]> & { id: string },
): Item["steps"][number] {
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

describe("itemRemainingMin — Item convenience wrapper (Inbox/Library rows)", () => {
  it("mirrors taskRemainingMin over the item's steps", () => {
    const it1 = item([
      step({ id: "s1", done: true, estMinutes: 10 }),
      step({ id: "s2", done: false, estMinutes: 15, openRemainingSec: 5 * 60 }),
      step({ id: "s3", done: false, estMinutes: 5 }),
    ]);
    expect(itemRemainingMin(it1)).toBe(10); // 5 (in progress) + 5 (not started)
  });

  it("a step with no openRemainingSec field at all (not fetched) is treated as not-started", () => {
    const it1 = item([step({ id: "s1", done: false, estMinutes: 8 })]);
    expect(itemRemainingMin(it1)).toBe(8);
  });
});

describe("activeStepRemainingMin — the one step with an open session, if any", () => {
  it("null when no step has an open session", () => {
    const it1 = item([
      step({ id: "s1", done: false, estMinutes: 10 }),
      step({ id: "s2", done: false, estMinutes: 5 }),
    ]);
    expect(activeStepRemainingMin(it1)).toBeNull();
  });

  it("the remaining minutes of the (one) step with an open session", () => {
    const it1 = item([
      step({ id: "s1", done: true, estMinutes: 10 }),
      step({
        id: "s2",
        done: false,
        estMinutes: 15,
        openRemainingSec: 7 * 60,
      }),
      step({ id: "s3", done: false, estMinutes: 5 }),
    ]);
    expect(activeStepRemainingMin(it1)).toBe(7);
  });

  it("a done step's stale openRemainingSec is ignored (never the active step)", () => {
    const it1 = item([
      step({
        id: "s1",
        done: true,
        estMinutes: 10,
        openRemainingSec: 3 * 60,
      }),
      step({ id: "s2", done: false, estMinutes: 5 }),
    ]);
    expect(activeStepRemainingMin(it1)).toBeNull();
  });
});
