/**
 * The one line under the Schedule menu's fields (#106).
 *
 * Pure on purpose: it is the only logic in the menu worth testing, and keeping it
 * out of the component means the wording can be asserted exactly without a DOM.
 * It has two moods — a calm summary, and the same facts turned into a warning
 * when the deadline cannot hold the work. It never blocks: a deliberate
 * over-commit is the owner's call, so the warning informs and the Schedule button
 * stays enabled.
 */
import { formatShortDay } from "./hours";
import type { WindowPlan } from "./windows";

/** `"45m"` / `"2h"` / `"3h30m"` — never `"2h0m"`, never `"NaNm"`. */
export function formatBlockMinutes(total: number): string {
  // A negative or non-finite total means a bug upstream, but this string is
  // rendered: "-1h-30m" in the UI is a worse outcome than an honest "0m".
  const m = Number.isFinite(total) ? Math.max(0, Math.round(total)) : 0;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  if (h === 0) return `${rest}m`;
  return rest === 0 ? `${h}h` : `${h}h${rest}m`;
}

/** `"Fri 31 Jul"` — in the scheduling zone, not the server's. Shared with the
 *  /focus launcher's due-by (#187) so the two cannot name different days. */
const shortDay = (d: Date): string => formatShortDay(d);

export function scheduleSummary(
  plan: WindowPlan,
  unitCount: number,
  dueAt: Date,
): { text: string; warning: boolean } {
  const steps = `${unitCount} step${unitCount === 1 ? "" : "s"}`;
  const blocks = formatBlockMinutes(plan.requiredMin);

  if (plan.feasible) {
    // One step has nothing to order, so the clause would be noise.
    const ordered =
      unitCount > 1 ? `, spread in order before ${shortDay(dueAt)}` : "";
    return { text: `${steps} · ${blocks} of blocks${ordered}`, warning: false };
  }

  if (plan.availableMin <= 0) {
    return {
      text: `${shortDay(dueAt)} leaves no working time before the deadline — ${steps} need ${blocks}.`,
      warning: true,
    };
  }

  // Omitted entirely rather than rendered empty: "Earliest that fits: ." would
  // be worse than saying nothing.
  const fits = plan.earliestFeasibleDue
    ? ` Earliest that fits: ${shortDay(plan.earliestFeasibleDue)}.`
    : "";
  return {
    text: `${shortDay(dueAt)} leaves ${formatBlockMinutes(plan.availableMin)} of working time; ${steps} need ${blocks}.${fits}`,
    warning: true,
  };
}
