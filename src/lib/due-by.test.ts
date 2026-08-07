import { describe, it, expect } from "vitest";
import { dueByLabel } from "./due-by";

/** Noon UTC on Thu 6 Aug 2026 — comfortably mid-day in every zone used below,
 *  so a test that fails does so because of the rule under test rather than
 *  because the fixture happened to straddle a midnight. */
const NOW = Date.parse("2026-08-06T12:00:00Z");

// The zone every case that does not care about zoning uses. Named and explicit
// because `timeZone` became REQUIRED in review on `!284` — these calls used to
// inherit `schedulingTimeZone()`, so what they were actually asserting depended
// on an env var the test never set. Stating it is the point of the change.
const TZ = "Europe/London";

describe("dueByLabel (#187)", () => {
  it("has nothing to say when there is no deadline", () => {
    // A row with no deadline renders NOTHING — not an em dash, not "not
    // scheduled" — so the absence has to be representable, and `null` is it.
    expect(dueByLabel(null, NOW, TZ)).toBeNull();
    expect(dueByLabel(undefined, NOW, TZ)).toBeNull();
  });

  it("treats an unreadable date as no deadline rather than as 'Invalid Date'", () => {
    expect(dueByLabel("not a date", NOW, TZ)).toBeNull();
    expect(dueByLabel(new Date(Number.NaN), NOW, TZ)).toBeNull();
  });

  it("formats the day weekday-first and unambiguous, never as a number pair", () => {
    const label = dueByLabel("2026-08-13T09:00:00Z", NOW, TZ);
    expect(label?.dayText).toBe("Thu 13 Aug");
    // The machine-readable twin for <time dateTime>, in the scheduling zone.
    expect(label?.isoDate).toBe("2026-08-13");
  });

  it("accepts a Date as readily as an ISO string", () => {
    expect(dueByLabel(new Date("2026-08-13T09:00:00Z"), NOW, TZ)?.dayText).toBe(
      "Thu 13 Aug",
    );
  });

  it("is not overdue on the due day itself, whatever the hour", () => {
    // The Schedule menu asks for a DAY (`<input type="date">`), so a deadline is
    // a calendar day and not an instant. Comparing instants would flip a to-do
    // due today into "Overdue" at one minute past whatever time of day the
    // previous value happened to carry.
    const dueEarlyToday = "2026-08-06T00:30:00Z";
    expect(dueByLabel(dueEarlyToday, NOW, TZ)?.overdue).toBe(false);
  });

  it("is overdue once the due day itself has passed", () => {
    // 20:00Z is 21:00 on the 5th in BST — yesterday, and therefore missed.
    expect(dueByLabel("2026-08-05T20:00:00Z", NOW, TZ)?.overdue).toBe(true);
  });

  it("reads the due day in the scheduling zone, not in UTC", () => {
    // 23:30 UTC on the 5th is already 00:30 on the 6th in British Summer Time.
    // A UTC comparison calls this deadline yesterday's and stamps a perfectly
    // current row "Overdue" — the failure the zone exists to prevent, and one
    // that only appears for part of the year.
    const dueAt = "2026-08-05T23:30:00Z";
    expect(dueByLabel(dueAt, NOW, "Europe/London")).toMatchObject({
      isoDate: "2026-08-06",
      dayText: "Thu 6 Aug",
      overdue: false,
    });
  });

  it("honours a self-hoster's own zone rather than assuming London", () => {
    // 20:00Z on the 5th: yesterday evening in London, this morning in Tokyo.
    const dueAt = "2026-08-05T20:00:00Z";
    expect(dueByLabel(dueAt, NOW, "Europe/London")?.overdue).toBe(true);
    expect(dueByLabel(dueAt, NOW, "Asia/Tokyo")).toMatchObject({
      isoDate: "2026-08-06",
      dayText: "Thu 6 Aug",
      overdue: false,
    });
  });

  it("marks a far-future deadline as not overdue", () => {
    expect(dueByLabel("2027-01-04T09:00:00Z", NOW, TZ)?.overdue).toBe(false);
  });
});
