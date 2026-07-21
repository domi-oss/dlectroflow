import { describe, it, expect } from "vitest";
import {
  freshnessTier,
  freshnessAgeMs,
  shouldPrompt24h,
  type AgingSettings,
} from "./aging";

const S: AgingSettings = {
  agingThresholdMinutes: 60,
  demoOverrideSeconds: null,
  agingHours: 4,
  overdueHours: 8,
  wayOverdueHours: 12,
};
const H = 3600_000;
const now = 1_000_000_000_000;

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
  it("demo override scales tiers to seconds ×1/×2/×3", () => {
    const demo = { ...S, demoOverrideSeconds: 10 };
    expect(freshnessTier(new Date(now - 5_000), null, demo, now)).toBe(
      "recent",
    ); // <10s
    expect(freshnessTier(new Date(now - 12_000), null, demo, now)).toBe(
      "aging",
    ); // ≥10s
    expect(freshnessTier(new Date(now - 22_000), null, demo, now)).toBe(
      "overdue",
    ); // ≥20s
    expect(freshnessTier(new Date(now - 32_000), null, demo, now)).toBe(
      "wayOverdue",
    ); // ≥30s
  });
});

describe("shouldPrompt24h", () => {
  it("true after 24h untouched, not dismissed", () => {
    expect(shouldPrompt24h(new Date(now - 25 * H), null, null, S, now)).toBe(
      true,
    );
  });
  it("false when dismissed", () => {
    expect(
      shouldPrompt24h(
        new Date(now - 25 * H),
        null,
        new Date(now - 1 * H),
        S,
        now,
      ),
    ).toBe(false);
  });
  it("false when freshenedAt within 24h", () => {
    expect(
      shouldPrompt24h(
        new Date(now - 25 * H),
        new Date(now - 2 * H),
        null,
        S,
        now,
      ),
    ).toBe(false);
  });
  it("demo override: prompts at 4× override seconds", () => {
    const demo = { ...S, demoOverrideSeconds: 10 };
    expect(shouldPrompt24h(new Date(now - 45_000), null, null, demo, now)).toBe(
      true,
    ); // ≥40s
    expect(shouldPrompt24h(new Date(now - 35_000), null, null, demo, now)).toBe(
      false,
    );
  });
});
