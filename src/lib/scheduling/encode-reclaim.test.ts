import { describe, it, expect } from "vitest";
import {
  encodeReclaim,
  formatReclaimDate,
  stripReclaimParams,
} from "./encode-reclaim";
import { ScheduleHours, SchedulePriority } from "./types";
import type { ScheduleIntent, ScheduleUnit } from "./types";
import type { ScheduleWindow } from "./windows";

const bst = (iso: string) => new Date(`${iso}:00.000+01:00`);

const unit: ScheduleUnit = {
  id: "step_6",
  order: 6,
  total: 7,
  text: "Note any steps or rules in the quoting process you want to remember",
  emoji: "✏️",
  estMinutes: 15,
};

const window: ScheduleWindow = {
  unitId: "step_6",
  notBefore: bst("2026-07-31T09:00"),
  due: bst("2026-07-31T11:00"),
  durationMin: 30,
  floored: true,
};

const intent: ScheduleIntent = {
  dueAt: bst("2026-07-31T17:00"),
  priority: SchedulePriority.High,
  hours: ScheduleHours.Work,
  busy: true,
  units: [unit],
};

const args = {
  unit,
  window,
  intent,
  taskTitle: "do flex training",
  parentEmoji: "🏷️",
  origin: "https://dlectroflow.dev",
  voice: "plain" as const,
};

describe("formatReclaimDate", () => {
  it("uses a month NAME, never a numeric date", () => {
    expect(formatReclaimDate(bst("2026-07-31T17:00"))).toBe(
      "Jul 31 2026 5:00pm",
    );
  });
  it("formats morning times with am", () => {
    expect(formatReclaimDate(bst("2026-07-31T09:00"))).toBe(
      "Jul 31 2026 9:00am",
    );
  });
  it("formats midday and midnight unambiguously", () => {
    expect(formatReclaimDate(bst("2026-07-31T12:00"))).toBe(
      "Jul 31 2026 12:00pm",
    );
    expect(formatReclaimDate(bst("2026-07-31T00:30"))).toBe(
      "Jul 31 2026 12:30am",
    );
  });
  it("renders in the scheduling timezone, not UTC", () => {
    // 23:30 UTC on 30 July is 00:30 BST on 31 July.
    expect(formatReclaimDate(new Date("2026-07-30T23:30:00.000Z"))).toBe(
      "Jul 31 2026 12:30am",
    );
  });
  it("never emits a slash", () => {
    expect(formatReclaimDate(bst("2026-07-31T17:00"))).not.toContain("/");
  });
});

describe("encodeReclaim — title", () => {
  it("is the exact expected string", () => {
    expect(encodeReclaim(args).title).toBe(
      "[6/7] ✏️ Note any steps or rules in the quoting process you want to remember ~15m " +
        "(duration:30m) (nosplit) (not before Jul 31 2026 9:00am) (due Jul 31 2026 11:00am) " +
        "(priority:P2) (type work)",
    );
  });

  it("leads with the counter badge so position survives truncation", () => {
    expect(encodeReclaim(args).title.startsWith("[6/7] ")).toBe(true);
  });

  it("shows the real estimate ONLY when the floor changed it", () => {
    const notFloored = {
      ...args,
      unit: { ...unit, estMinutes: 45 },
      window: { ...window, durationMin: 45, floored: false },
    };
    expect(encodeReclaim(notFloored).title).toContain("(duration:45m)");
    expect(encodeReclaim(notFloored).title).not.toContain("~");
  });

  it("omits (not before) for the first unit", () => {
    const first = {
      ...args,
      unit: { ...unit, order: 1 },
      window: { ...window, notBefore: null },
    };
    const title = encodeReclaim(first).title;
    expect(title).not.toContain("not before");
    expect(title).toContain("(due Jul 31 2026 11:00am)");
  });

  it("omits (nosplit) and the badge for a single-unit task", () => {
    const single = {
      ...args,
      unit: {
        ...unit,
        order: 1,
        total: 1,
        emoji: null,
        text: "Book the dentist",
      },
      window: { ...window, notBefore: null },
    };
    const title = encodeReclaim(single).title;
    expect(title).not.toContain("[1/1]");
    expect(title).not.toContain("(nosplit)");
    expect(title.startsWith("Book the dentist ")).toBe(true);
  });

  it("maps every priority to its Reclaim code", () => {
    const p = (priority: SchedulePriority) =>
      encodeReclaim({ ...args, intent: { ...intent, priority } }).title;
    expect(p(SchedulePriority.Critical)).toContain("(priority:P1)");
    expect(p(SchedulePriority.High)).toContain("(priority:P2)");
    expect(p(SchedulePriority.Normal)).toContain("(priority:P3)");
    expect(p(SchedulePriority.Low)).toContain("(priority:P4)");
  });

  it("emits (type personal) when the work is personal", () => {
    expect(
      encodeReclaim({
        ...args,
        intent: { ...intent, hours: ScheduleHours.Personal },
      }).title,
    ).toContain("(type personal)");
  });

  it("omits an absent step emoji without leaving a double space", () => {
    const noEmoji = { ...args, unit: { ...unit, emoji: null } };
    expect(encodeReclaim(noEmoji).title.startsWith("[6/7] Note any")).toBe(
      true,
    );
    expect(encodeReclaim(noEmoji).title).not.toContain("  ");
  });
});

describe("stripReclaimParams — the contract with Reclaim's parser", () => {
  it("leaves exactly the text the user should see on the calendar", () => {
    expect(stripReclaimParams(encodeReclaim(args).title)).toBe(
      "[6/7] ✏️ Note any steps or rules in the quoting process you want to remember ~15m",
    );
  });

  it("does not eat parentheses that belong to the step text", () => {
    const parenthetical = {
      ...args,
      unit: { ...unit, text: "Read the overview (the short one)" },
    };
    expect(stripReclaimParams(encodeReclaim(parenthetical).title)).toBe(
      "[6/7] ✏️ Read the overview (the short one) ~15m",
    );
  });
});

describe("encodeReclaim — notes", () => {
  it("carries the parent task, the position and the honest estimate", () => {
    const { notes } = encodeReclaim(args);
    expect(notes).toContain("🏷️ do flex training");
    expect(notes).toContain("step 6 of 7");
    expect(notes).toContain("15m");
  });

  it("deep-links to THIS unit's step, not the task's first step", () => {
    const { notes } = encodeReclaim(args);
    expect(notes).toContain("https://dlectroflow.dev/focus/step_6");
  });
});
