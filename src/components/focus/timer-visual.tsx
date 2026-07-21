import { mmss, timerFraction } from "@/lib/focus-timer-clock";
import type { FocusTimerStyle } from "@/lib/constants";
import { t, type Voice } from "@/lib/strings";

type VisualPhase = "setup" | "running" | "paused" | "timeup";

/** The readable countdown text — always shown, in every style, so time-status
 * is never conveyed by colour/shape alone. */
function Readout({
  remainingSec,
  totalSec,
  voice,
}: {
  remainingSec: number;
  totalSec: number;
  voice: Voice;
}) {
  return (
    <div className="flex flex-col items-center">
      <span className="text-5xl font-semibold tabular-nums">
        {mmss(remainingSec)}
      </span>
      <span className="text-muted-foreground text-xs tabular-nums">
        {t("focus.timer.of", voice)} {Math.round(totalSec / 60)}m
      </span>
    </div>
  );
}

/**
 * The countdown visual. Four styles (spec Design B): `ring` (SVG ring), `digits`
 * (readout only), `bar` (linear depleting bar), `mug` (a cup that drains). Each
 * shares the Readout and, at time's-up, tints amber (paired with the visible
 * "0:00" text). `reducedMotion` drops the depletion transition.
 */
export function TimerVisual({
  style,
  remainingSec,
  totalSec,
  phase,
  reducedMotion,
  voice,
}: {
  style: FocusTimerStyle;
  remainingSec: number;
  totalSec: number;
  phase: VisualPhase;
  reducedMotion: boolean;
  voice: Voice;
}) {
  const fraction = timerFraction(remainingSec, totalSec);
  const timeup = phase === "timeup";
  const readout = (
    <Readout remainingSec={remainingSec} totalSec={totalSec} voice={voice} />
  );

  if (style === "digits") {
    return (
      <div
        data-testid="timer-visual-digits"
        className="flex justify-center py-10"
      >
        {readout}
      </div>
    );
  }

  if (style === "bar") {
    return (
      <div data-testid="timer-visual-bar" className="space-y-4">
        <div
          className="bg-secondary h-6 w-full overflow-hidden rounded-full"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={Math.round(totalSec / 60)}
          aria-valuenow={Math.round(remainingSec / 60)}
        >
          <div
            className={`h-full ${timeup ? "bg-amber-500" : "bg-primary"} ${
              reducedMotion ? "" : "motion-safe:transition-[width]"
            }`}
            style={{ width: `${fraction * 100}%` }}
          />
        </div>
        <div className="flex justify-center">{readout}</div>
      </div>
    );
  }

  if (style === "mug") {
    return (
      <div
        data-testid="timer-visual-mug"
        className="flex flex-col items-center gap-3"
      >
        <div className="relative h-40 w-32 overflow-hidden rounded-b-3xl rounded-t-md border-4">
          <div
            className={`absolute inset-x-0 bottom-0 ${
              timeup ? "bg-amber-400" : "bg-primary/70"
            } ${reducedMotion ? "" : "motion-safe:transition-[height]"}`}
            style={{ height: `${fraction * 100}%` }}
            aria-hidden="true"
          />
        </div>
        {readout}
      </div>
    );
  }

  // ring (default)
  const R = 110;
  const C = 2 * Math.PI * R;
  return (
    <div data-testid="timer-visual-ring" className="flex justify-center">
      <div className="relative h-64 w-64">
        <svg viewBox="0 0 240 240" className="h-full w-full -rotate-90">
          <circle
            cx="120"
            cy="120"
            r={R}
            fill="none"
            className="stroke-secondary"
            strokeWidth="12"
          />
          <circle
            cx="120"
            cy="120"
            r={R}
            fill="none"
            className={timeup ? "stroke-amber-500" : "stroke-primary"}
            strokeWidth="12"
            strokeLinecap="round"
            strokeDasharray={C}
            strokeDashoffset={C * (1 - fraction)}
            style={
              reducedMotion
                ? undefined
                : { transition: "stroke-dashoffset 1s linear" }
            }
          />
        </svg>
        <div className="absolute inset-0 flex items-center justify-center">
          {readout}
        </div>
      </div>
    </div>
  );
}
