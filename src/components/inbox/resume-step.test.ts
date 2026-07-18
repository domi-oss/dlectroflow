import { describe, it, expect } from "vitest";
import { firstResumableStep } from "@/components/inbox/resume-step";
import type { Item } from "@/components/inbox/bucket";

// Minimal item builder — only `steps` matters to firstResumableStep, but we
// shape it as a full Item (mirrors bucket.test.ts) so callers stay in sync
// with the real Inbox page's mapped shape.
function item(id: string, steps: Item["steps"]): Pick<Item, "steps"> & { id: string } {
  return { id, steps };
}

function step(overrides: Partial<Item["steps"][number]> & { id: string }): Item["steps"][number] {
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

describe("firstResumableStep", () => {
  it("returns a resumable, not-done step", () => {
    const items = [item("i1", [step({ id: "s1", text: "book flight", resumable: true, done: false })])];
    expect(firstResumableStep(items)).toEqual({ id: "s1", text: "book flight" });
  });

  it("skips a resumable step that is already done (stale open FocusSession)", () => {
    const items = [
      item("i1", [
        step({ id: "s1", text: "book flight", resumable: true, done: true }),
      ]),
    ];
    expect(firstResumableStep(items)).toBeNull();
  });

  it("falls through to the next eligible step when an earlier one is resumable-but-done", () => {
    const items = [
      item("i1", [
        step({ id: "s1", text: "book flight", resumable: true, done: true }),
        step({ id: "s2", text: "pack bag", resumable: true, done: false }),
      ]),
    ];
    expect(firstResumableStep(items)).toEqual({ id: "s2", text: "pack bag" });
  });

  it("returns null when there are no resumable steps", () => {
    const items = [
      item("i1", [step({ id: "s1", text: "book flight", resumable: false, done: false })]),
      item("i2", [step({ id: "s2", text: "pack bag", resumable: false, done: true })]),
    ];
    expect(firstResumableStep(items)).toBeNull();
  });

  it("picks the first eligible step across multiple items (createdAt-desc order)", () => {
    const items = [
      item("newest", [step({ id: "s1", text: "not eligible", resumable: false, done: false })]),
      item("older", [step({ id: "s2", text: "eligible", resumable: true, done: false })]),
      item("oldest", [step({ id: "s3", text: "also eligible", resumable: true, done: false })]),
    ];
    expect(firstResumableStep(items)).toEqual({ id: "s2", text: "eligible" });
  });
});
