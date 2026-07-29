import { cn } from "@/lib/utils";
import { t, type Voice } from "@/lib/strings";
import { isAging, type AgingSettings } from "@/lib/aging";
import { formatAgo } from "@/lib/format";
import type { Item } from "@/components/inbox/bucket";
import { FRESHNESS_TIER_STYLE } from "@/components/inbox/status-pill";
import { itemRemainingMin, activeStepRemainingMin } from "@/lib/task-remaining";

export function nextStepText(item: Item): string | null {
  return item.steps.find((s) => !s.done)?.text ?? null;
}
/**
 * #27 follow-up — the row's task total is now the SUM of each not-done
 * step's EFFECTIVE remaining time (task-remaining.ts): a step with an open
 * FocusSession contributes its real remaining, not its full estimate, so
 * this shrinks as a step is paused mid-way, not only on full completion.
 */
export function remainingMinutes(item: Item): number {
  return itemRemainingMin(item);
}
export function singleTaskEstimate(item: Item): number {
  return item.estMinutes ?? 5;
}
export function rowEmoji(item: Item): string | null {
  return (
    (item.steps.find((s) => !s.done) ?? item.steps[0])?.subtaskEmoji ?? null
  );
}

/** Subtle tabular row index, e.g. "2." */
export function RowNumber({ n }: { n: number }) {
  return (
    <span className="text-muted-foreground min-w-[1.25rem] text-right text-xs tabular-nums">
      {n}.
    </span>
  );
}

/** "Next: <step>" preview (multi-step only). */
export function NextStepLine({ item, voice }: { item: Item; voice: Voice }) {
  const next = nextStepText(item);
  if (!next) return null;
  return (
    <p className="text-muted-foreground truncate text-xs">
      {t("lib.next", voice)} <span className="text-foreground">{next}</span>
    </p>
  );
}

/** Thin progress bar (multi-step only). */
export function ProgressBar({ item }: { item: Item }) {
  if (item.stepsTotal <= 0) return null;
  const pct = Math.round((item.stepsDone / item.stepsTotal) * 100);
  return (
    <div className="bg-secondary mt-1 h-1 w-full max-w-[180px] overflow-hidden rounded-full">
      <div className="bg-primary h-full" style={{ width: `${pct}%` }} />
    </div>
  );
}

/**
 * "added Xh ago" with an amber accent once the item is aging.
 *
 * #95 a11y — the accent was a flat `text-amber-600`: 3.01:1 against the light
 * `--background` (#fdf6fa) at 12px, where AA-normal needs 4.5:1, and with no
 * dark variant at all. It now reads the `aging` tier's colour from
 * FRESHNESS_TIER_STYLE, the pair #57 tuned for exactly this meaning
 * (amber-700 light = 4.73:1, amber-400 dark = 11.40:1) — so the hub agrees with
 * the Inbox and there is one aging amber to change, not two. Colour is not the
 * only signal: the label spells the age out in words either way.
 */
export function AgeLabel({
  item,
  now,
  voice,
  settings,
}: {
  item: Item;
  now: number;
  voice: Voice;
  settings: AgingSettings;
}) {
  // #105 — the row already renders its age from the server's `now`; the amber
  // tint has to be decided by the same clock, or the class the server sent and
  // the class the client computes can disagree on a row sitting on the
  // threshold. The Library page stamps `now` once per request (page.tsx).
  const aging = isAging(item.createdAt, settings, now);
  return (
    <span
      className={cn(
        "text-xs",
        aging ? FRESHNESS_TIER_STYLE.aging.color : "text-muted-foreground",
      )}
    >
      {t("lib.added", voice)}{" "}
      {formatAgo(now - new Date(item.createdAt).getTime())}
    </span>
  );
}

/** Right-aligned "min left" estimate pill (multi-step rows only — single-task
 * rows use the editable `EstimateEditor` in library-rows.tsx instead). */
export function EstimatePill({
  minutes,
  voice,
}: {
  minutes: number;
  voice: Voice;
}) {
  if (minutes <= 0) return null;
  return (
    <span className="text-muted-foreground shrink-0 rounded-full border px-2 py-0.5 text-xs">
      ≈{minutes} {t("lib.minLeft", voice)}
    </span>
  );
}

/**
 * #27 follow-up — a second pill alongside `EstimatePill`, shown only when a
 * step in this row has an open FocusSession (paused or actively running):
 * the row's remaining-on-THIS-step time, distinct from the task total. A
 * persisted snapshot as of render — it does not live-tick in the list.
 */
export function ActiveStepPill({ item, voice }: { item: Item; voice: Voice }) {
  const minutes = activeStepRemainingMin(item);
  if (minutes == null) return null;
  return (
    <span className="text-muted-foreground shrink-0 rounded-full border px-2 py-0.5 text-xs">
      ≈{minutes} {t("lib.minOnStep", voice)}
    </span>
  );
}
