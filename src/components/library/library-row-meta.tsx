import { cn } from "@/lib/utils";
import { t, type Voice } from "@/lib/strings";
import { isAging, type AgingSettings } from "@/lib/aging";
import { formatAgo } from "@/lib/format";
import type { Item } from "@/components/inbox/bucket";

export function nextStepText(item: Item): string | null {
  return item.steps.find((s) => !s.done)?.text ?? null;
}
export function remainingMinutes(item: Item): number {
  return item.steps.filter((s) => !s.done).reduce((n, s) => n + (s.estMinutes || 0), 0);
}
export function singleTaskEstimate(item: Item): number {
  return item.estMinutes ?? 5;
}
export function rowEmoji(item: Item): string | null {
  return (item.steps.find((s) => !s.done) ?? item.steps[0])?.subtaskEmoji ?? null;
}

/** Subtle tabular row index, e.g. "2." */
export function RowNumber({ n }: { n: number }) {
  return <span className="text-muted-foreground min-w-[1.25rem] text-right text-xs tabular-nums">{n}.</span>;
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

/** "added Xh ago" with an amber accent once the item is aging. */
export function AgeLabel({ item, now, voice, settings }: { item: Item; now: number; voice: Voice; settings: AgingSettings }) {
  const aging = isAging(item.createdAt, settings);
  return (
    <span className={cn("text-xs", aging ? "text-amber-600" : "text-muted-foreground")}>
      {t("lib.added", voice)} {formatAgo(now - new Date(item.createdAt).getTime())}
    </span>
  );
}

/** Right-aligned "min left" estimate pill (multi-step rows only — single-task
 * rows use the editable `EstimateEditor` in library-rows.tsx instead). */
export function EstimatePill({ minutes, voice }: { minutes: number; voice: Voice }) {
  if (minutes <= 0) return null;
  return (
    <span className="text-muted-foreground shrink-0 rounded-full border px-2 py-0.5 text-xs">
      ≈{minutes} {t("lib.minLeft", voice)}
    </span>
  );
}
