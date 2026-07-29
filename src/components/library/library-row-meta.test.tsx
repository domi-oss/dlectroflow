// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import {
  nextStepText,
  remainingMinutes,
  singleTaskEstimate,
  rowEmoji,
  AgeLabel,
} from "./library-row-meta";
import type { AgingSettings } from "@/lib/aging";
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
  // #27 follow-up — the total is the SUM of each step's EFFECTIVE remaining:
  // a step with an open FocusSession contributes its real remaining, not its
  // full estimate, so the total shrinks below the raw sum as you progress.
  it("remainingMinutes shrinks below the raw estimate sum once a step is paused/in progress", () => {
    const paused = {
      ...base,
      steps: base.steps.map((s) =>
        s.id === "s2" ? { ...s, openRemainingSec: 4 * 60 } : s,
      ),
    };
    // Raw sum would be 20 (15 + 5); s2 (est 15) is paused with only 4m left.
    expect(remainingMinutes(paused)).toBe(9); // 4 + 5
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

// #95 — the aging age label. `text-amber-600` (#e17100) is only 3.01:1 on the
// #40 light `--background` (#fdf6fa) at 12px, where AA-normal needs 4.5:1, and
// the class carried no dark variant at all. The repo already solved this exact
// pairing for the identical semantic in #57 (the Inbox's own captured-ago label
// and status-pill.tsx's `aging` tier): `text-amber-700 dark:text-amber-400`,
// 4.73:1 light / 11.40:1 dark. The Library hub was simply missed by that pass,
// so it keeps its own regression test rather than trusting the Inbox's.
//
// Only reachable once `isAging()` is true — which is why neither /library a11y
// gate ever saw it (CI's database is always fresh). These tests pin the state
// directly; the e2e half seeds a real aged row (e2e/a11y-contrast.spec.ts).
describe("AgeLabel — aging accent (#95 a11y)", () => {
  afterEach(cleanup);

  const settings: AgingSettings = {
    agingThresholdMinutes: 240,
    demoOverrideSeconds: null,
    agingHours: 4,
    overdueHours: 24,
    wayOverdueHours: 72,
  };
  const now = Date.now();
  const aged = { ...base, createdAt: new Date(now - 13 * 3600_000) };
  const fresh = { ...base, createdAt: new Date(now - 60_000) };

  // `afterEach(cleanup)` only runs BETWEEN tests, so a second call inside one
  // test would leave the first render mounted and `getByText` would throw
  // "Found multiple elements" — a failure that points nowhere near the cause.
  // Cleaning up here instead makes the helper safe to call repeatedly, which is
  // what a future test comparing two states in one block will want to do.
  function label(item: Item): HTMLElement {
    cleanup();
    render(
      <AgeLabel item={item} now={now} voice="plain" settings={settings} />,
    );
    return screen.getByText(/added/).closest("span")!;
  }

  it("uses the AA-tuned amber pair, not the sub-AA flat text-amber-600", () => {
    const el = label(aged);
    expect(el.className).toContain("text-amber-700");
    expect(el.className).toContain("dark:text-amber-400");
    expect(el.className).not.toContain("text-amber-600");
  });

  it("matches the amber the Inbox + status-pill already use for `aging`", async () => {
    // One "attention, not alarm" colour across the app, so a future tweak has a
    // single place to happen. Asserted against the real source of truth rather
    // than a duplicated literal.
    const { FRESHNESS_TIER_STYLE } =
      await import("@/components/inbox/status-pill");
    expect(label(aged).className).toContain(FRESHNESS_TIER_STYLE.aging.color);
  });

  it("stays muted (no amber at all) while the item is still fresh", () => {
    const el = label(fresh);
    expect(el.className).toContain("text-muted-foreground");
    expect(el.className).not.toMatch(/amber/);
  });
});
