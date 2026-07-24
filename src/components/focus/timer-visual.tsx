import { mmss, timerFraction } from "@/lib/focus-timer-clock";
import type { FocusTimerStyle } from "@/lib/constants";
import { t, type Voice } from "@/lib/strings";
import { cn } from "@/lib/utils";

type VisualPhase = "setup" | "running" | "paused" | "timeup";

/** Near-black hero field (the dark-mode `--background` anchor) the running timer
 * sits on in BOTH themes, so the neon gradient + glow read as a focused,
 * dopamine-forward moment (spec §6.1). Reserved for the running/paused hero — not
 * general chrome. */
const NEON_FIELD = "bg-[#0c0a14] shadow-[var(--shadow-glow-dark)]";

type ReadoutTone = "default" | "light" | "gradient";

/** The readable countdown text — always shown, in every style, so time-status
 * is never conveyed by colour/shape alone. On the near-black neon field the
 * digits switch to a light (or gradient) tone so they clear AA on near-black. */
function Readout({
  remainingSec,
  totalSec,
  voice,
  tone = "default",
}: {
  remainingSec: number;
  totalSec: number;
  voice: Voice;
  tone?: ReadoutTone;
}) {
  return (
    <div className="flex flex-col items-center">
      <span
        className={cn(
          "text-5xl font-semibold tabular-nums",
          tone === "light" && "text-white",
          tone === "gradient" &&
            "bg-clip-text text-transparent [background-image:var(--gradient-brand)]",
        )}
      >
        {mmss(remainingSec)}
      </span>
      <span
        className={cn(
          "text-xs tabular-nums",
          tone === "default" ? "text-muted-foreground" : "text-white/70",
        )}
      >
        {t("focus.timer.of", voice)} {Math.round(totalSec / 60)}m
      </span>
    </div>
  );
}

/**
 * The countdown visual. Four styles (spec Design B): `ring` (SVG ring), `digits`
 * (readout only), `bar` (linear depleting bar), `mug` (a cup that drains). Each
 * shares the Readout and, at time's-up, tints amber (paired with the visible
 * "0:00" text). `reducedMotion` drops the depletion transition (the sweep).
 *
 * #40 Phase 3.1 — while the timer is live (running/paused) each style earns the
 * neon signature: the depleting element fills with `--gradient-brand` on a
 * near-black field with a `--shadow-glow-dark` glow. Time's-up keeps its warm
 * amber semantic (not repainted with brand).
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
  // Neon hero treatment only while the countdown is live; setup keeps the calm
  // primary look, time's-up keeps its amber semantic.
  const neon = phase === "running" || phase === "paused";

  if (style === "digits") {
    return (
      <div
        data-testid="timer-visual-digits"
        className={cn(
          "flex justify-center py-10",
          neon && `rounded-3xl px-10 ${NEON_FIELD}`,
        )}
      >
        <Readout
          remainingSec={remainingSec}
          totalSec={totalSec}
          voice={voice}
          tone={neon ? "gradient" : "default"}
        />
      </div>
    );
  }

  if (style === "bar") {
    return (
      <div
        data-testid="timer-visual-bar"
        className={cn("space-y-4", neon && `rounded-3xl p-6 ${NEON_FIELD}`)}
      >
        <div
          className={cn(
            "h-6 w-full overflow-hidden rounded-full",
            neon ? "bg-white/10" : "bg-secondary",
          )}
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={Math.round(totalSec / 60)}
          aria-valuenow={Math.round(remainingSec / 60)}
        >
          <div
            className={cn(
              "h-full",
              timeup
                ? "bg-amber-500"
                : neon
                  ? "[background-image:var(--gradient-brand)]"
                  : "bg-primary",
              reducedMotion ? "" : "motion-safe:transition-[width]",
            )}
            style={{ width: `${fraction * 100}%` }}
          />
        </div>
        <div className="flex justify-center">
          <Readout
            remainingSec={remainingSec}
            totalSec={totalSec}
            voice={voice}
            tone={neon ? "light" : "default"}
          />
        </div>
      </div>
    );
  }

  if (style === "mug") {
    return (
      <div
        data-testid="timer-visual-mug"
        className={cn(
          "flex flex-col items-center gap-3",
          neon && `rounded-3xl p-6 ${NEON_FIELD}`,
        )}
      >
        <div
          className={cn(
            "relative h-40 w-32 overflow-hidden rounded-b-3xl rounded-t-md border-4",
            neon && "border-white/30",
          )}
        >
          <div
            className={cn(
              "absolute inset-x-0 bottom-0",
              timeup
                ? "bg-amber-400"
                : neon
                  ? "[background-image:var(--gradient-brand)]"
                  : "bg-primary/70",
              reducedMotion ? "" : "motion-safe:transition-[height]",
            )}
            style={{ height: `${fraction * 100}%` }}
            aria-hidden="true"
          />
        </div>
        <Readout
          remainingSec={remainingSec}
          totalSec={totalSec}
          voice={voice}
          tone={neon ? "light" : "default"}
        />
      </div>
    );
  }

  // ring (default)
  const R = 110;
  const C = 2 * Math.PI * R;
  const gradientStroke = neon && !timeup;
  return (
    <div data-testid="timer-visual-ring" className="flex justify-center">
      <div
        className={cn(
          "relative h-64 w-64",
          neon && `rounded-full ${NEON_FIELD}`,
        )}
      >
        <svg viewBox="0 0 240 240" className="h-full w-full -rotate-90">
          {gradientStroke && (
            <defs>
              <linearGradient id="timerRingGrad" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0%" stopColor="#9b5cf0" />
                <stop offset="100%" stopColor="#e0479e" />
              </linearGradient>
            </defs>
          )}
          <circle
            cx="120"
            cy="120"
            r={R}
            fill="none"
            className={neon ? "stroke-white/10" : "stroke-secondary"}
            strokeWidth="12"
          />
          <circle
            cx="120"
            cy="120"
            r={R}
            fill="none"
            stroke={gradientStroke ? "url(#timerRingGrad)" : undefined}
            className={
              gradientStroke
                ? undefined
                : timeup
                  ? "stroke-amber-500"
                  : "stroke-primary"
            }
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
          <Readout
            remainingSec={remainingSec}
            totalSec={totalSec}
            voice={voice}
            tone={neon ? "light" : "default"}
          />
        </div>
      </div>
    </div>
  );
}
