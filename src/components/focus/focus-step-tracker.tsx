import { cn } from "@/lib/utils";
import { t, type Voice } from "@/lib/strings";

export type TrackerStep = {
  id: string;
  text: string;
  done: boolean;
  estMinutes: number;
  subtaskEmoji: string | null;
};

type StepState = "done" | "current" | "upcoming";

function stateOf(step: TrackerStep, currentStepId: string): StepState {
  if (step.done) return "done";
  return step.id === currentStepId ? "current" : "upcoming";
}

/**
 * Multi-step progress for the timer (spec Design B): a segmented bar (done /
 * current / upcoming), a `steps ▾` toggle, and — when expanded — a vertical
 * stepper. Status is carried by shape + glyph + aria-current, not colour alone;
 * the parent auto-expands it on pause / time's-up / complete.
 */
export function FocusStepTracker({
  steps,
  currentStepId,
  expanded,
  onToggle,
  voice,
}: {
  steps: TrackerStep[];
  currentStepId: string;
  expanded: boolean;
  onToggle: () => void;
  voice: Voice;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <ol className="flex flex-1 gap-1" aria-label="step progress">
          {steps.map((s) => {
            const state = stateOf(s, currentStepId);
            return (
              <li
                key={s.id}
                data-testid="tracker-segment"
                aria-current={state === "current" ? "step" : undefined}
                title={state}
                className={cn(
                  "h-1.5 flex-1 rounded-full",
                  state === "done" && "bg-primary",
                  state === "current" && "bg-primary ring-primary/40 ring-2",
                  state === "upcoming" && "bg-secondary",
                )}
              />
            );
          })}
        </ol>
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          className="text-muted-foreground hover:text-foreground inline-flex min-h-[44px] shrink-0 items-center text-xs"
        >
          {t("focus.timer.steps", voice)} {expanded ? "▴" : "▾"}
        </button>
      </div>

      {expanded && (
        <ol className="space-y-1 text-sm">
          {steps.map((s) => {
            const state = stateOf(s, currentStepId);
            const glyph =
              state === "done" ? "✓" : state === "current" ? "●" : "○";
            return (
              <li key={s.id} className="flex items-center gap-2">
                <span aria-hidden="true">{glyph}</span>
                <span
                  className={cn(
                    "min-w-0 flex-1 break-words",
                    state === "current" && "font-semibold",
                  )}
                >
                  {s.subtaskEmoji ? `${s.subtaskEmoji} ` : ""}
                  {s.text}
                </span>
                <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
                  {s.estMinutes}m
                </span>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
