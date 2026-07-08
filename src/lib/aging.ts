// Aging threshold logic shared by the inbox UI and (step 4) notifications.

export type AgingSettings = {
  agingThresholdMinutes: number;
  demoOverrideSeconds: number | null;
  agingHours: number;
  overdueHours: number;
  wayOverdueHours: number;
};

/** Effective aging threshold in ms — the demo override (seconds) wins when set. */
export function effectiveAgingMs(s: AgingSettings): number {
  return s.demoOverrideSeconds != null
    ? s.demoOverrideSeconds * 1000
    : s.agingThresholdMinutes * 60_000;
}

/** True once an inbox item has sat past the aging threshold. */
export function isAging(createdAt: Date | string, s: AgingSettings): boolean {
  const created =
    typeof createdAt === "string" ? new Date(createdAt) : createdAt;
  return Date.now() - created.getTime() >= effectiveAgingMs(s);
}

export type FreshnessTier = "recent" | "aging" | "overdue" | "wayOverdue";

const toMs = (d: Date | string): number => (typeof d === "string" ? new Date(d) : d).getTime();

/** age = now − max(createdAt, freshenedAt). freshenedAt resets the clock non-destructively. */
export function freshnessAgeMs(
  createdAt: Date | string,
  freshenedAt: Date | string | null,
  now: number = Date.now(),
): number {
  const base = freshenedAt ? Math.max(toMs(createdAt), toMs(freshenedAt)) : toMs(createdAt);
  return now - base;
}

/** Tier boundaries in ms. Demo override (seconds) wins and scales ×1/×2/×3. */
function tierBoundsMs(s: AgingSettings): { aging: number; overdue: number; wayOverdue: number } {
  if (s.demoOverrideSeconds != null && s.demoOverrideSeconds > 0) {
    const o = s.demoOverrideSeconds * 1000;
    return { aging: o, overdue: 2 * o, wayOverdue: 3 * o };
  }
  return {
    aging: s.agingHours * 3600_000,
    overdue: s.overdueHours * 3600_000,
    wayOverdue: s.wayOverdueHours * 3600_000,
  };
}

export function freshnessTier(
  createdAt: Date | string,
  freshenedAt: Date | string | null,
  s: AgingSettings,
  now: number = Date.now(),
): FreshnessTier {
  const age = freshnessAgeMs(createdAt, freshenedAt, now);
  const b = tierBoundsMs(s);
  if (age >= b.wayOverdue) return "wayOverdue";
  if (age >= b.overdue) return "overdue";
  if (age >= b.aging) return "aging";
  return "recent";
}

/** 24h "still needed?" boundary: 24h normally, 4× override seconds in demo mode. */
function promptBoundaryMs(s: AgingSettings): number {
  if (s.demoOverrideSeconds != null && s.demoOverrideSeconds > 0) return 4 * s.demoOverrideSeconds * 1000;
  return 24 * 3600_000;
}

export function shouldPrompt24h(
  createdAt: Date | string,
  freshenedAt: Date | string | null,
  promptDismissedAt: Date | string | null,
  s: AgingSettings,
  now: number = Date.now(),
): boolean {
  if (promptDismissedAt) return false;
  return freshnessAgeMs(createdAt, freshenedAt, now) >= promptBoundaryMs(s);
}
