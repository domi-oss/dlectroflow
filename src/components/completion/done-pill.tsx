import { cn } from "@/lib/utils";
import { COMPLETE_TICK } from "@/lib/completion-style";
import { t, type Voice } from "@/lib/strings";

/**
 * The single app-wide "done" marker (MR ③, Design D) — the pill first used in the
 * Library "done" view. A ✓ (colour resolves from --tick-color) + a text label, in
 * a rounded, tick-coloured border. Use this EVERYWHERE a completed state is shown
 * (task steps, inbox, library); never re-style a bare ✓ or re-hardcode the pill.
 *
 * Pass `done`/`total` for a step count ("✓ 3/5 done"); omit them for a plain
 * "✓ done". The ✓ is paired with the "done" text so status is never colour-only.
 */
export function DonePill({
  voice,
  done,
  total,
  className,
}: {
  voice: Voice;
  done?: number;
  total?: number;
  className?: string;
}) {
  const label =
    typeof total === "number" && total > 0
      ? `✓ ${done ?? 0}/${total} ${t("progress.done", voice)}`
      : `✓ ${t("progress.done", voice)}`;
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-full border border-[color:var(--tick-color)] px-2 py-0.5 text-xs",
        COMPLETE_TICK,
        className,
      )}
    >
      {label}
    </span>
  );
}
