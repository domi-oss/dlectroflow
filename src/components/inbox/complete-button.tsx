"use client";

import { t } from "@/lib/strings";
import type { Voice } from "@/lib/strings";
import { cn, touchTarget } from "@/lib/utils";

/**
 * The secondary "Complete" button every inbox bucket row shows — one source for
 * its styling instead of many copies. Shared with the TaskSteps step rows AND
 * the focus-lane quick-complete so every "complete this" affordance in the app
 * is visually + textually identical (owner report: it had drifted — a bordered
 * box in the inbox vs an icon-only ✓ in focus lanes). Borderless `rounded-md` +
 * `hover:bg-accent` + `font-medium` matches the row's other secondary controls
 * (the ▾ overflow trigger in row-actions.tsx) instead of standing out as the
 * only bordered pill.
 *
 * The label is `t("action.complete", voice)` and is a WORD, not a glyph: #253
 * dropped the "✓ " prefix it used to carry, because this button is rendered on
 * every row of every list and the tick was paying for width on all of them
 * while naming no state (it is only rendered on a row that is NOT complete).
 * Nothing here relies on colour, and nothing relies on an icon — the accessible
 * name is the visible text.
 */
export function CompleteButton({
  voice,
  onClick,
}: {
  voice: Voice;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "hover:bg-accent rounded-md px-2.5 py-1 font-medium",
        touchTarget,
      )}
    >
      {t("action.complete", voice)}
    </button>
  );
}
