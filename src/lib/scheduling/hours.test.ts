import { describe, it, expect } from "vitest";
import {
  WORK_HOURS,
  PERSONAL_HOURS,
  workingMinutesBetween,
  advanceWorkingMinutes,
  snapIntoHours,
} from "./hours";

/** A London wall-clock instant, built without depending on the host timezone. */
function london(
  iso: string, // "2026-07-29T09:00" — BST, so UTC+1
  offsetHours: number,
): Date {
  return new Date(
    `${iso}:00.000${offsetHours >= 0 ? "+" : "-"}${String(Math.abs(offsetHours)).padStart(2, "0")}:00`,
  );
}
const bst = (iso: string) => london(iso, 1); // late March – late October
const gmt = (iso: string) => london(iso, 0);

describe("workingMinutesBetween — work profile (Mon–Fri 08:30–18:00)", () => {
  it("counts a full working day as 570 minutes", () => {
    // Wednesday 29 July 2026, 08:30 → 18:00 BST
    expect(
      workingMinutesBetween(
        bst("2026-07-29T08:30"),
        bst("2026-07-29T18:00"),
        WORK_HOURS,
      ),
    ).toBe(570);
  });

  it("clips to the start of the working day", () => {
    // 06:00 → 09:30 contains only 08:30–09:30
    expect(
      workingMinutesBetween(
        bst("2026-07-29T06:00"),
        bst("2026-07-29T09:30"),
        WORK_HOURS,
      ),
    ).toBe(60);
  });

  it("clips to the end of the working day", () => {
    // 17:00 → 23:00 contains only 17:00–18:00
    expect(
      workingMinutesBetween(
        bst("2026-07-29T17:00"),
        bst("2026-07-29T23:00"),
        WORK_HOURS,
      ),
    ).toBe(60);
  });

  it("skips the weekend entirely", () => {
    // Friday 18:00 → Monday 08:30 is zero working minutes
    expect(
      workingMinutesBetween(
        bst("2026-07-31T18:00"),
        bst("2026-08-03T08:30"),
        WORK_HOURS,
      ),
    ).toBe(0);
  });

  it("spans several days additively", () => {
    // Wed 08:30 → Fri 18:00 = three full days
    expect(
      workingMinutesBetween(
        bst("2026-07-29T08:30"),
        bst("2026-07-31T18:00"),
        WORK_HOURS,
      ),
    ).toBe(570 * 3);
  });

  it("returns 0 when the range is inverted or empty", () => {
    expect(
      workingMinutesBetween(
        bst("2026-07-29T12:00"),
        bst("2026-07-29T12:00"),
        WORK_HOURS,
      ),
    ).toBe(0);
    expect(
      workingMinutesBetween(
        bst("2026-07-29T14:00"),
        bst("2026-07-29T10:00"),
        WORK_HOURS,
      ),
    ).toBe(0);
  });

  it("is correct across the autumn DST change (clocks go back 25 Oct 2026)", () => {
    // Friday 23 Oct (BST) 08:30 → Monday 26 Oct (GMT) 18:00 = two working days
    expect(
      workingMinutesBetween(
        bst("2026-10-23T08:30"),
        gmt("2026-10-26T18:00"),
        WORK_HOURS,
      ),
    ).toBe(570 * 2);
  });
});

describe("workingMinutesBetween — personal profile", () => {
  it("counts a weekday evening as 240 minutes (18:00–22:00)", () => {
    expect(
      workingMinutesBetween(
        bst("2026-07-29T18:00"),
        bst("2026-07-29T22:00"),
        PERSONAL_HOURS,
      ),
    ).toBe(240);
  });

  it("counts a Saturday as 780 minutes (09:00–22:00)", () => {
    expect(
      workingMinutesBetween(
        bst("2026-08-01T09:00"),
        bst("2026-08-01T22:00"),
        PERSONAL_HOURS,
      ),
    ).toBe(780);
  });

  it("excludes the working day", () => {
    // Wednesday 09:00–17:00 is work time, so zero personal minutes
    expect(
      workingMinutesBetween(
        bst("2026-07-29T09:00"),
        bst("2026-07-29T17:00"),
        PERSONAL_HOURS,
      ),
    ).toBe(0);
  });
});

describe("advanceWorkingMinutes", () => {
  it("advances inside a single day", () => {
    expect(
      advanceWorkingMinutes(
        bst("2026-07-29T09:00"),
        120,
        WORK_HOURS,
      ).toISOString(),
    ).toBe(bst("2026-07-29T11:00").toISOString());
  });

  it("rolls over the end of the day into the next working morning", () => {
    // 17:00 + 90 working minutes = 60 today, 30 tomorrow → 09:00 Thursday
    expect(
      advanceWorkingMinutes(
        bst("2026-07-29T17:00"),
        90,
        WORK_HOURS,
      ).toISOString(),
    ).toBe(bst("2026-07-30T09:00").toISOString());
  });

  it("skips the weekend", () => {
    // Friday 17:30 + 60 = 30 on Friday, 30 on Monday → 09:00 Monday
    expect(
      advanceWorkingMinutes(
        bst("2026-07-31T17:30"),
        60,
        WORK_HOURS,
      ).toISOString(),
    ).toBe(bst("2026-08-03T09:00").toISOString());
  });

  it("advancing zero minutes from outside hours snaps to the next window", () => {
    expect(
      advanceWorkingMinutes(
        bst("2026-07-29T06:00"),
        0,
        WORK_HOURS,
      ).toISOString(),
    ).toBe(bst("2026-07-29T08:30").toISOString());
  });

  it("is the inverse of workingMinutesBetween", () => {
    const from = bst("2026-07-29T09:00");
    const to = advanceWorkingMinutes(from, 1234, WORK_HOURS);
    expect(workingMinutesBetween(from, to, WORK_HOURS)).toBe(1234);
  });
});

describe("snapIntoHours", () => {
  it("leaves an instant already inside working hours alone", () => {
    const d = bst("2026-07-29T10:00");
    expect(snapIntoHours(d, WORK_HOURS).toISOString()).toBe(d.toISOString());
  });
  it("moves a 3am instant to the start of the working day", () => {
    expect(
      snapIntoHours(bst("2026-07-29T03:00"), WORK_HOURS).toISOString(),
    ).toBe(bst("2026-07-29T08:30").toISOString());
  });
  it("moves a Saturday instant to Monday morning (work profile)", () => {
    expect(
      snapIntoHours(bst("2026-08-01T12:00"), WORK_HOURS).toISOString(),
    ).toBe(bst("2026-08-03T08:30").toISOString());
  });
});
