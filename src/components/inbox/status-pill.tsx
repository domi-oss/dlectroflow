import { cn } from "@/lib/utils";
import { t, type Voice } from "@/lib/strings";
import type { FreshnessTier } from "@/lib/aging";

/**
 * Freshness tier styling. Colour is AA-tuned per theme (WCAG 4.5:1 on the row
 * background in BOTH light and dark) via a `-700` light / `dark:-400` pair —
 * the old hardcoded hex greens/ambers failed AA in one theme or the other.
 * Colour is never the only signal: every tier also renders a dot glyph AND a
 * word label (see `dot` + `t("freshness.*")`).
 */
const TIER_META: Record<FreshnessTier, { dot: string; color: string }> = {
  recent: { dot: "🟢", color: "text-green-700 dark:text-green-400" },
  aging: { dot: "🟡", color: "text-amber-700 dark:text-amber-400" },
  overdue: { dot: "🟠", color: "text-orange-700 dark:text-orange-400" },
  wayOverdue: { dot: "🔴", color: "text-red-700 dark:text-red-400" },
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
      className={cn("inline-flex shrink-0 items-center gap-1 text-xs font-medium", color)}
    >
      <span aria-hidden="true">{dot}</span>
      {label}
    </span>
  );
}
