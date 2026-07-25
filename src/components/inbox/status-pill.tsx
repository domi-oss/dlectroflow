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

/**
 * Dot + word freshness indicator — colour is never the only signal (a11y).
 *
 * `size="meta"` (#52) renders the pill on the inbox row's metadata line, next
 * to "captured x ago": small + muted (`text-muted-foreground`, no bold, no loud
 * tier colour) so urgency reads as secondary metadata rather than competing with
 * the task title. The decorative dot glyph still carries a glanceable colour cue,
 * and the word label keeps status perceivable without colour (still not
 * colour-only). `size="default"` keeps the standalone AA-tuned tier colour.
 */
export function StatusPill({
  tier,
  voice,
  size = "default",
}: {
  tier: FreshnessTier;
  voice: Voice;
  size?: "default" | "meta";
}) {
  const { dot, color } = TIER_META[tier];
  const label = t(`freshness.${tier}`, voice);
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 text-xs",
        size === "meta" ? "text-muted-foreground" : cn("font-medium", color),
      )}
    >
      <span aria-hidden="true">{dot}</span>
      {label}
    </span>
  );
}
