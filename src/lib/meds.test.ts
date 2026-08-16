import { describe, it, expect } from "vitest";
import { MedsDoseState } from "@/lib/constants";
import {
  DerivedDoseState,
  deriveTodayDoses,
  doseDeadline,
  medicationAppliesOn,
  nextUnrecordedDose,
  type MedsMedicationInput,
} from "@/lib/meds";

/**
 * #269 — the derived `Missed` state.
 *
 * Every instant here is built with `new Date(y, m, d, …)`, which is LOCAL, and no
 * clock is mocked anywhere: `now` is a parameter, so the tests that matter are
 * two calls to one function with two instants rather than two behaviours.
 *
 * 2026-08-17 is a Monday and 2026-08-16 is a Sunday; both are used below and the
 * weekday is load-bearing, so they are named rather than left to be counted.
 */
const MONDAY_0900 = new Date(2026, 7, 17, 9, 0);
const MONDAY_1400 = new Date(2026, 7, 17, 14, 0);
const MONDAY_1800 = new Date(2026, 7, 17, 18, 0);
const MONDAY_2200 = new Date(2026, 7, 17, 22, 0);
const SUNDAY_1800 = new Date(2026, 7, 16, 18, 0);

const SETTINGS = { workdayEndTime: "17:00", workingDays: "1,2,3,4,5" };

/** The owner's day-one regimen: 2 tablets after breakfast, 1 after lunch. */
function regimen(
  overrides: Partial<MedsMedicationInput> = {},
): MedsMedicationInput {
  return {
    id: "med-1",
    name: "Ritalin",
    days: null,
    active: true,
    order: 1,
    doses: [
      {
        id: "dose-breakfast",
        label: "after breakfast",
        quantity: 2,
        dueAfter: null,
        order: 1,
      },
      {
        id: "dose-lunch",
        label: "after lunch",
        quantity: 1,
        dueAfter: null,
        order: 2,
      },
    ],
    ...overrides,
  };
}

function derive(now: Date, over: Parameters<typeof deriveTodayDoses>[0] = {}) {
  return deriveTodayDoses({
    medications: [regimen()],
    settings: SETTINGS,
    logs: [],
    now,
    ...over,
  });
}

describe("doseDeadline", () => {
  it("is workdayEndTime when the dose states no time", () => {
    expect(doseDeadline(null, "17:00", MONDAY_0900)).toBe(
      new Date(2026, 7, 17, 17, 0).getTime(),
    );
  });

  it("is the LATER of workdayEndTime and dueAfter", () => {
    // The edge case the naive rule gets wrong. An evening dose at 21:00 against a
    // workday ending at 17:00 must not be judged by 17:00.
    expect(doseDeadline("21:00", "17:00", MONDAY_0900)).toBe(
      new Date(2026, 7, 17, 21, 0).getTime(),
    );
  });

  it("stays at workdayEndTime when dueAfter is EARLIER", () => {
    // The owner's own regimen, if a time were ever added to it: breakfast and
    // lunch are both before 17:00, so the deadline is unchanged and neither dose
    // behaves differently from reading workdayEndTime alone.
    expect(doseDeadline("09:00", "17:00", MONDAY_0900)).toBe(
      new Date(2026, 7, 17, 17, 0).getTime(),
    );
  });

  /**
   * ⚠️ The FEATURE-level half of the `!364` range fix, and it is not redundant
   * with `target-time.test.ts`.
   *
   * That file proves the helper degrades. This proves the degradation reaches the
   * thing that matters: a deadline computed from an out-of-range time used to
   * land on **another day**, and a deadline in tomorrow means a dose that can
   * never read as *missed* today. The helper-level test alone would have gone
   * green while a dose was silently un-missable, which is the exact shape of
   * failure this module's docblock warns about.
   *
   * `dueAfter` carries no CHECK constraint by design, so the values below are
   * reachable from a hand-edited row today and from any future importer.
   */
  it.each(["25:00", "24:00", "12:99", "99:99"])(
    "keeps the deadline on TODAY for the out-of-range dueAfter %o",
    (bad) => {
      const deadline = new Date(doseDeadline(bad, "17:00", MONDAY_0900));
      expect(deadline.getDate(), `${bad} moved the deadline off Monday`).toBe(
        17,
      );
      // It collapses to `workdayEndTime`, which is exactly a dose with no stated
      // time — the honest reading of a value nobody could have meant.
      expect(deadline.getTime()).toBe(new Date(2026, 7, 17, 17, 0).getTime());
    },
  );

  it("keeps the deadline on today for an out-of-range workdayEndTime too", () => {
    // The other side of the `max`. `Settings.workdayEndTime` has no constraint
    // either, and a workspace holding "24:00" would otherwise push EVERY dose's
    // deadline into tomorrow at once.
    const deadline = new Date(doseDeadline(null, "24:00", MONDAY_0900));
    expect(deadline.getDate()).toBe(17);
    expect(deadline.getTime()).toBe(new Date(2026, 7, 17, 17, 0).getTime());
  });

  it("degrades a malformed dueAfter to workdayEndTime rather than to NaN", () => {
    // NaN would be worse than either bound: every comparison against it is false,
    // so the dose would silently never be missed.
    expect(doseDeadline("nonsense", "17:00", MONDAY_0900)).toBe(
      new Date(2026, 7, 17, 17, 0).getTime(),
    );
  });
});

describe("medicationAppliesOn", () => {
  it("inherits Settings.workingDays when the medication states no days", () => {
    expect(medicationAppliesOn(null, "1,2,3,4,5", MONDAY_0900)).toBe(true);
    expect(medicationAppliesOn(null, "1,2,3,4,5", SUNDAY_1800)).toBe(false);
  });

  it("uses the medication's own days when it states them", () => {
    expect(medicationAppliesOn("1,2,3,4,5,6,7", "1,2,3,4,5", SUNDAY_1800)).toBe(
      true,
    );
    expect(medicationAppliesOn("6,7", "1,2,3,4,5", MONDAY_0900)).toBe(false);
  });

  it("fails CLOSED on an empty CSV — every day is a non-working day", () => {
    expect(medicationAppliesOn("", "1,2,3,4,5", MONDAY_0900)).toBe(false);
    expect(medicationAppliesOn(null, "", MONDAY_0900)).toBe(false);
  });
});

describe("deriveTodayDoses", () => {
  it("reads the SAME absent row as not-recorded before the deadline and missed after it", () => {
    // One property, two instants, no clock mocking and no second fixture: the
    // stored shape is identical in both calls and only the clock differs.
    const before = derive(MONDAY_1400);
    const after = derive(MONDAY_1800);

    expect(before.map((d) => d.state)).toEqual([
      DerivedDoseState.Unknown,
      DerivedDoseState.Unknown,
    ]);
    expect(after.map((d) => d.state)).toEqual([
      DerivedDoseState.Missed,
      DerivedDoseState.Missed,
    ]);
  });

  it("still marks an out-of-range-dueAfter dose missed on its OWN day", () => {
    // ⚠️ The consequence, asserted on the rendered state rather than on the
    // helper. Before the `!364` fix a `dueAfter` of "24:00" pushed the deadline
    // to tomorrow, so this dose read `not recorded` at 22:00 on the day it was
    // due and never became `missed` at all — un-missable, silently, on a health
    // record. It now behaves as a dose with no stated time.
    const bad = regimen({
      doses: [
        {
          id: "dose-evening",
          label: "after dinner",
          quantity: 1,
          dueAfter: "24:00",
          order: 1,
        },
      ],
    });
    const state = (now: Date) =>
      deriveTodayDoses({
        medications: [bad],
        settings: SETTINGS,
        logs: [],
        now,
      })[0].state;
    expect(state(MONDAY_1400)).toBe(DerivedDoseState.Unknown);
    expect(state(MONDAY_1800)).toBe(DerivedDoseState.Missed);
    expect(state(MONDAY_2200)).toBe(DerivedDoseState.Missed);
  });

  it("does not mark a 21:00 dose missed at 18:00", () => {
    const evening = regimen({
      doses: [
        {
          id: "dose-evening",
          label: "after dinner",
          quantity: 1,
          dueAfter: "21:00",
          order: 1,
        },
      ],
    });
    expect(
      deriveTodayDoses({
        medications: [evening],
        settings: SETTINGS,
        logs: [],
        now: MONDAY_1800,
      })[0].state,
    ).toBe(DerivedDoseState.Unknown);
    expect(
      deriveTodayDoses({
        medications: [evening],
        settings: SETTINGS,
        logs: [],
        now: MONDAY_2200,
      })[0].state,
    ).toBe(DerivedDoseState.Missed);
  });

  it("reports a logged dose by its stored state, at any hour", () => {
    const logs = [
      { medicationDoseId: "dose-breakfast", state: MedsDoseState.Taken },
      { medicationDoseId: "dose-lunch", state: MedsDoseState.Skipped },
    ];
    for (const now of [MONDAY_1400, MONDAY_1800]) {
      expect(derive(now, { logs }).map((d) => d.state)).toEqual([
        DerivedDoseState.Taken,
        DerivedDoseState.Skipped,
      ]);
    }
  });

  it("yields nothing on a day the regimen does not apply", () => {
    expect(derive(SUNDAY_1800)).toEqual([]);
  });

  it("yields no due doses and no missed doses when workingDays is empty", () => {
    // Fail-closed, and pinned rather than relied on as a coincidence. Currently
    // unreachable through the UI — `Settings.workingDays` has no editor — which is
    // one reason v1 does not add one.
    expect(
      derive(MONDAY_1800, { settings: { ...SETTINGS, workingDays: "" } }),
    ).toEqual([]);
  });

  it("omits a deactivated medication entirely", () => {
    expect(
      derive(MONDAY_1400, { medications: [regimen({ active: false })] }),
    ).toEqual([]);
  });

  it("carries the medication name, dose label and quantity for the accessible name", () => {
    // "Ritalin, after breakfast, 2 tablets, …" — the strip has several chips and a
    // screen-reader user must not have to infer which one from position.
    expect(derive(MONDAY_1400)[0]).toMatchObject({
      doseId: "dose-breakfast",
      medicationId: "med-1",
      medicationName: "Ritalin",
      label: "after breakfast",
      quantity: 2,
    });
  });

  it("orders by medication then dose, tie-broken on id so two reads agree", () => {
    const second = regimen({
      id: "med-2",
      name: "Vitamin D",
      order: 1,
      doses: [
        {
          id: "dose-vd",
          label: "with breakfast",
          quantity: 1,
          dueAfter: null,
          order: 1,
        },
      ],
    });
    const ids = deriveTodayDoses({
      medications: [second, regimen()],
      settings: SETTINGS,
      logs: [],
      now: MONDAY_1400,
    }).map((d) => d.doseId);
    expect(ids).toEqual(["dose-breakfast", "dose-lunch", "dose-vd"]);
  });

  it("re-derives from the instant it is given rather than from a captured day", () => {
    // The rollover property, at the level the pure function can hold it: the same
    // inputs on either side of midnight give different days, so a caller polling
    // with a fresh instant cannot keep yesterday's answer.
    const beforeMidnight = new Date(2026, 7, 17, 23, 59);
    const afterMidnight = new Date(2026, 7, 18, 0, 1);
    expect(derive(beforeMidnight).map((d) => d.state)).toEqual([
      DerivedDoseState.Missed,
      DerivedDoseState.Missed,
    ]);
    expect(derive(afterMidnight).map((d) => d.state)).toEqual([
      DerivedDoseState.Unknown,
      DerivedDoseState.Unknown,
    ]);
  });

  it("defaults `now` so the pure function is callable without a clock", () => {
    expect(() =>
      deriveTodayDoses({
        medications: [regimen({ days: "1,2,3,4,5,6,7" })],
        settings: SETTINGS,
        logs: [],
      }),
    ).not.toThrow();
  });
});

describe("nextUnrecordedDose", () => {
  it("is the first dose with no row, missed or not", () => {
    const doses = derive(MONDAY_1800);
    expect(nextUnrecordedDose(doses)?.doseId).toBe("dose-breakfast");
  });

  it("skips a dose that already carries a row, taken or skipped", () => {
    const doses = derive(MONDAY_1400, {
      logs: [
        { medicationDoseId: "dose-breakfast", state: MedsDoseState.Skipped },
      ],
    });
    expect(nextUnrecordedDose(doses)?.doseId).toBe("dose-lunch");
  });

  it("is null when every dose is recorded", () => {
    const doses = derive(MONDAY_1400, {
      logs: [
        { medicationDoseId: "dose-breakfast", state: MedsDoseState.Taken },
        { medicationDoseId: "dose-lunch", state: MedsDoseState.Taken },
      ],
    });
    expect(nextUnrecordedDose(doses)).toBeNull();
  });
});
