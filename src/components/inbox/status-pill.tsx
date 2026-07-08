import { cn } from "@/lib/utils";
import { t, type Voice } from "@/lib/strings";
import type { FreshnessTier } from "@/lib/aging";

const TIER_META: Record<FreshnessTier, { dot: string; color: string }> = {
  recent: { dot: "🟢", color: "#2f7d32" },
  aging: { dot: "🟡", color: "#b8860b" },
  overdue: { dot: "🟠", color: "#d35400" },
  wayOverdue: { dot: "🔴", color: "#c0392b" },
};

/** Dot + word freshness indicator — colour is never the only signal (a11y). */
export function StatusPill({
  tier,
  voice,
}: {
  tier: FreshnessTier;
  voice: Voice;
}) {
  const { dot, color } = TIER_META[tier];
  const label = t(`freshness.${tier}`, voice);
  return (
    <span
      className={cn("inline-flex shrink-0 items-center gap-1 text-xs font-medium")}
      style={{ color }}
    >
      <span aria-hidden="true">{dot}</span>
      {label}
    </span>
  );
}
