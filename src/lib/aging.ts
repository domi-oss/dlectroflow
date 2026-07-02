// Aging threshold logic shared by the inbox UI and (step 4) notifications.

export type AgingSettings = {
  agingThresholdMinutes: number;
  demoOverrideSeconds: number | null;
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
