import { describe, it, expect } from "vitest";
import {
  agingBoundaryMs,
  freshnessTier,
  freshnessAgeMs,
  isAging,
  shouldPrompt24h,
  PROMPT_BOUNDARY_HOURS,
  type AgingSettings,
} from "./aging";

const S: AgingSettings = {
  agingHours: 4,
  overdueHours: 8,
  wayOverdueHours: 12,
};
const H = 3600_000;
const now = 1_000_000_000_000;

describe("agingBoundaryMs", () => {
  it("is agingHours in ms — the ONE aging threshold (#261)", () => {
    expect(agingBoundaryMs(S)).toBe(4 * H);
    expect(agingBoundaryMs({ ...S, agingHours: 1 })).toBe(H);
  });
});

describe("freshnessAgeMs", () => {
  it("uses createdAt when no freshenedAt", () => {
    expect(freshnessAgeMs(new Date(now - 3 * H), null, now)).toBe(3 * H);
  });
  it("uses max(createdAt, freshenedAt) — freshenedAt resets age", () => {
    expect(
      freshnessAgeMs(new Date(now - 10 * H), new Date(now - 1 * H), now),
    ).toBe(1 * H);
  });
});

describe("freshnessTier", () => {
  it("recent under 4h", () => {
    expect(freshnessTier(new Date(now - 2 * H), null, S, now)).toBe("recent");
  });
  it("aging at 4h", () => {
    expect(freshnessTier(new Date(now - 4 * H), null, S, now)).toBe("aging");
  });
  it("overdue at 8h", () => {
    expect(freshnessTier(new Date(now - 8 * H), null, S, now)).toBe("overdue");
  });
  it("wayOverdue at 12h", () => {
    expect(freshnessTier(new Date(now - 13 * H), null, S, now)).toBe(
      "wayOverdue",
    );
  });
});

describe("isAging", () => {
  it("is false below agingHours and true at it", () => {
    expect(isAging(new Date(now - 3 * H), null, S, now)).toBe(false);
    expect(isAging(new Date(now - 4 * H), null, S, now)).toBe(true);
  });

  /**
   * #261 — the defect this issue is named for, pinned as a test.
   *
   * `isAging` used to read `agingThresholdMinutes` while `freshnessTier` read
   * `agingHours`, so the amber age tint and the status pill on the SAME row could
   * disagree: a workspace with the minutes control on its 240 default and the
   * hours control moved to 8 rendered "recent" next to an amber age. The two are
   * one question now, so the only honest test is that they cannot part company
   * at any age.
   */
  it("never disagrees with freshnessTier, at any age or threshold", () => {
    const settings: AgingSettings = {
      agingHours: 3,
      overdueHours: 6,
      wayOverdueHours: 9,
    };
    for (let hours = 0; hours <= 12; hours += 0.5) {
      const createdAt = new Date(now - hours * H);
      expect({
        hours,
        aging: isAging(createdAt, null, settings, now),
      }).toEqual({
        hours,
        aging: freshnessTier(createdAt, null, settings, now) !== "recent",
      });
    }
  });

  it("follows agingHours when it moves — the user-facing edge in #261", () => {
    const createdAt = new Date(now - 6 * H);
    expect(isAging(createdAt, null, { ...S, agingHours: 4 }, now)).toBe(true);
    expect(isAging(createdAt, null, { ...S, agingHours: 8 }, now)).toBe(false);
  });

  /**
   * Freshening an item already resets the status pill (`freshnessAgeMs` takes
   * `max(createdAt, freshenedAt)`), and now resets the amber tint, the nav's
   * aging count and the desktop reminder with it. Before #261 it reset the pill
   * ONLY, because `isAging` read `createdAt` alone — so "yes, still needed"
   * turned the pill green and left the row amber and still nagging.
   */
  it("is reset by freshenedAt, like every other freshness answer", () => {
    const createdAt = new Date(now - 10 * H);
    expect(isAging(createdAt, null, S, now)).toBe(true);
    expect(isAging(createdAt, new Date(now - 1 * H), S, now)).toBe(false);
  });

  it("accepts ISO strings for both timestamps", () => {
    expect(
      isAging(
        new Date(now - 10 * H).toISOString(),
        new Date(now - 1 * H).toISOString(),
        S,
        now,
      ),
    ).toBe(false);
  });
});

describe("shouldPrompt24h", () => {
  it("has a fixed 24h boundary, not a settings-derived one (#261)", () => {
    expect(PROMPT_BOUNDARY_HOURS).toBe(24);
  });
  it("true after 24h untouched, not dismissed", () => {
    expect(shouldPrompt24h(new Date(now - 25 * H), null, null, now)).toBe(true);
  });
  it("false at 23h", () => {
    expect(shouldPrompt24h(new Date(now - 23 * H), null, null, now)).toBe(
      false,
    );
  });
  it("false when dismissed", () => {
    expect(
      shouldPrompt24h(new Date(now - 25 * H), null, new Date(now - 1 * H), now),
    ).toBe(false);
  });
  it("false when freshenedAt within 24h", () => {
    expect(
      shouldPrompt24h(new Date(now - 25 * H), new Date(now - 2 * H), null, now),
    ).toBe(false);
  });
});
