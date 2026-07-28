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
 * digits switch to a light (or gradient) tone so they clear AA on near-black.
 *
 * #66 — `subLabel` replaces the "of Nm" total. The live timer wants both figures
 * (how long is left, of how long), but the setup screen must show exactly ONE
 * number, so it passes a word that names what that number is instead
 * ("focus time" / "left on this step"). */
function Readout({
  remainingSec,
  totalSec,
  voice,
  tone = "default",
  subLabel,
}: {
  remainingSec: number;
  totalSec: number;
  voice: Voice;
  tone?: ReadoutTone;
  subLabel?: string;
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
          "text-xs",
          !subLabel && "tabular-nums",
          tone === "default" ? "text-muted-foreground" : "text-white/70",
        )}
      >
        {subLabel ??
          `${t("focus.timer.of", voice)} ${Math.round(totalSec / 60)}m`}
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
 *
 * #66 — pass `subLabel` to replace the readout's "of Nm" total with a word (the
 * setup screen shows one number only; see `Readout`).
 */
export function TimerVisual({
  style,
  remainingSec,
  totalSec,
  phase,
  reducedMotion,
  voice,
  subLabel,
}: {
  style: FocusTimerStyle;
  remainingSec: number;
  totalSec: number;
  phase: VisualPhase;
  reducedMotion: boolean;
  voice: Voice;
  subLabel?: string;
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
          subLabel={subLabel}
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
            subLabel={subLabel}
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
          subLabel={subLabel}
        />
      </div>
    );
  }

  // ring (default)
  const R = 110;
  const C = 2 * Math.PI * R;
  const gradientStroke = neon && !timeup;
  // #89 — while a session is PAUSED the ring doubles as a paced breathing guide
  // (4s in / 6s out; the cadence and the animation itself are the
  // `focus-breathe` keyframes in globals.css, which this marker attribute opts
  // into). Three deliberate boundaries:
  //
  //  • Paused only. The running screen is what you stare at while
  //    concentrating, and ambient motion there pulls attention — it would also
  //    fight #66's "one number, one action" and the point of minimal mode. A
  //    pause, by contrast, usually means something went sideways, and that
  //    screen is otherwise dead space.
  //  • Keyed off the PHASE, not off whichever control was pressed, so #65's
  //    coupled mini-player transport produces exactly the same paused screen as
  //    the timer's own Pause button.
  //  • Reduced motion removes it outright rather than slowing it (the spec):
  //    the caller has already resolved the OS setting, so there is simply no
  //    animation to reduce.
  //
  // Ring style only: a breathing bar, mug or set of digits is a different and
  // worse idea, and the ring is the one shape a breath maps onto. The animated
  // element is this <svg> alone — the readout is a sibling overlay, so the
  // remaining time neither moves nor fades at any point in the cycle, and since
  // only `scale`/`opacity` animate inside a fixed 16rem frame, entering or
  // leaving the paused state shifts no layout.
  const breathing = phase === "paused" && !reducedMotion;
  return (
    <div data-testid="timer-visual-ring" className="flex justify-center">
      <div
        className={cn(
          "relative h-64 w-64",
          neon && `rounded-full ${NEON_FIELD}`,
        )}
      >
        {/* Decorative: the depletion arc duplicates the Readout text below it,
            which is the figure AT exposes (#66). */}
        <svg
          aria-hidden="true"
          data-breathing={breathing ? "" : undefined}
          viewBox="0 0 240 240"
          className="h-full w-full -rotate-90"
        >
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
            subLabel={subLabel}
          />
        </div>
      </div>
    </div>
  );
}
