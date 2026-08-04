import { describe, it, expect } from "vitest";
import {
  compareFocusOrder,
  nextInFocusOrder,
  type FocusOrdered,
} from "@/lib/focus-next";

const at = (iso: string) => new Date(iso);

function row(
  id: string,
  dueAt: Date | string | null,
  scheduledAt: Date | string | null = null,
): FocusOrdered & { id: string } {
  return { id, dueAt, scheduledAt };
}

describe("compareFocusOrder (#142) — soonest due, then soonest scheduled", () => {
  it("puts the soonest due date first", () => {
    const rows = [
      row("late", at("2026-08-10T09:00:00Z")),
      row("soon", at("2026-08-05T09:00:00Z")),
    ];
    expect([...rows].sort(compareFocusOrder).map((r) => r.id)).toEqual([
      "soon",
      "late",
    ]);
  });

  it("sorts an undated row AFTER every dated one — no due date is not 'due now'", () => {
    const rows = [
      row("undated", null),
      row("dated", at("2027-01-01T00:00:00Z")),
    ];
    expect([...rows].sort(compareFocusOrder).map((r) => r.id)).toEqual([
      "dated",
      "undated",
    ]);
  });

  it("falls back to the soonest scheduled time when neither is due", () => {
    const rows = [
      row("later", null, at("2026-08-05T15:00:00Z")),
      row("earlier", null, at("2026-08-05T09:00:00Z")),
    ];
    expect([...rows].sort(compareFocusOrder).map((r) => r.id)).toEqual([
      "earlier",
      "later",
    ]);
  });

  it("never lets a scheduled time outrank a due date", () => {
    const rows = [
      // Scheduled for this morning, but nothing is due about it.
      row("scheduledToday", null, at("2026-08-04T09:00:00Z")),
      // Due next year, and not scheduled at all.
      row("dueNextYear", at("2027-01-01T00:00:00Z"), null),
    ];
    expect([...rows].sort(compareFocusOrder).map((r) => r.id)).toEqual([
      "dueNextYear",
      "scheduledToday",
    ]);
  });

  it("breaks a due-date tie on the scheduled time", () => {
    const due = at("2026-08-05T09:00:00Z");
    const rows = [
      row("b", due, at("2026-08-05T14:00:00Z")),
      row("a", due, at("2026-08-05T10:00:00Z")),
    ];
    expect([...rows].sort(compareFocusOrder).map((r) => r.id)).toEqual([
      "a",
      "b",
    ]);
  });

  it("leaves rows with nothing to compare in the caller's order", () => {
    // Deliberately NOT an opinion of this module: `sort` is stable, so equal
    // rows keep the order the caller loaded them in. #142 adds "due, then
    // scheduled" and nothing else — the residual order belongs to whoever
    // built the list, and the manual override that replaces it is #143.
    const rows = [row("first", null), row("second", null), row("third", null)];
    expect([...rows].sort(compareFocusOrder).map((r) => r.id)).toEqual([
      "first",
      "second",
      "third",
    ]);
  });

  it("accepts ISO strings as well as Dates (a server component may hand over either)", () => {
    const rows = [
      row("late", "2026-08-10T09:00:00Z"),
      row("soon", at("2026-08-05T09:00:00Z")),
    ];
    expect([...rows].sort(compareFocusOrder).map((r) => r.id)).toEqual([
      "soon",
      "late",
    ]);
  });

  it("treats an unparseable date as no date rather than sorting it to the front", () => {
    // `new Date("nonsense").getTime()` is NaN, and NaN comparisons are all
    // false — a subtraction-based comparator would scatter it unpredictably
    // and could put junk data at the head of the focus queue.
    const rows = [
      row("junk", "not-a-date"),
      row("real", at("2027-01-01T00:00:00Z")),
    ];
    expect([...rows].sort(compareFocusOrder).map((r) => r.id)).toEqual([
      "real",
      "junk",
    ]);
  });
});

describe("nextInFocusOrder (#142)", () => {
  it("returns the head of the effective order", () => {
    const rows = [
      row("later", at("2026-08-10T09:00:00Z")),
      row("next", at("2026-08-05T09:00:00Z")),
    ];
    expect(nextInFocusOrder(rows)?.id).toBe("next");
  });

  it("returns null for an empty queue — the caller must handle 'nothing left'", () => {
    expect(nextInFocusOrder([])).toBeNull();
  });

  it("does not mutate the caller's array", () => {
    const rows = [
      row("later", at("2026-08-10T09:00:00Z")),
      row("next", at("2026-08-05T09:00:00Z")),
    ];
    nextInFocusOrder(rows);
    expect(rows.map((r) => r.id)).toEqual(["later", "next"]);
  });
});
