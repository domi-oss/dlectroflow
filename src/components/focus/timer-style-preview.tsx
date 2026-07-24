import type { FocusTimerStyle } from "@/lib/constants";

/**
 * MR ② review follow-up — a tiny, STATIC thumbnail of each timer visual style,
 * shown beside its label in the Focus-timer settings so the four styles
 * (ring / digits / bar / mug) are distinguishable at a glance.
 *
 * a11y: each preview is a distinct SHAPE (never colour-only) and is purely
 * decorative — marked `aria-hidden` so the option's accessible name comes from
 * its text label alone. Deliberately non-animated (no transitions/keyframes), so
 * it is inert under `prefers-reduced-motion` with no extra handling.
 *
 * #40 Phase 3.1 — the ring/bar/mug fills carry the brand gradient so the
 * settings thumbnail matches the neon running timer. These are decorative
 * (aria-hidden) non-text fills; the digits preview keeps its `text-foreground`
 * "0:00" so that (real) text stays WCAG-AA on the settings card.
 */
export function TimerStylePreview({ style }: { style: FocusTimerStyle }) {
  const box = "flex h-7 w-10 shrink-0 items-center justify-center";

  if (style === "digits") {
    return (
      <span
        data-testid="timer-style-preview-digits"
        aria-hidden="true"
        className={box}
      >
        <span className="text-foreground rounded border border-current px-1 text-[10px] font-semibold leading-none tabular-nums">
          0:00
        </span>
      </span>
    );
  }

  if (style === "bar") {
    return (
      <span
        data-testid="timer-style-preview-bar"
        aria-hidden="true"
        className={box}
      >
        <span className="bg-secondary h-2 w-8 overflow-hidden rounded-full">
          <span className="block h-full w-2/3 rounded-full [background-image:var(--gradient-brand)]" />
        </span>
      </span>
    );
  }

  if (style === "mug") {
    return (
      <span
        data-testid="timer-style-preview-mug"
        aria-hidden="true"
        className={box}
      >
        <span className="relative flex h-6 w-5 items-end overflow-hidden rounded-b-lg rounded-t-sm border-2 border-current">
          <span className="block h-3/5 w-full [background-image:var(--gradient-brand)]" />
        </span>
        <span className="-ml-0.5 mb-0.5 h-3 w-1.5 rounded-r-md border-2 border-l-0 border-current" />
      </span>
    );
  }

  // ring (default)
  const r = 9;
  const c = 2 * Math.PI * r;
  return (
    <span
      data-testid="timer-style-preview-ring"
      aria-hidden="true"
      className={box}
    >
      <svg
        viewBox="0 0 24 24"
        role="presentation"
        className="h-6 w-6 -rotate-90"
      >
        <defs>
          <linearGradient id="timerPreviewRingGrad" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#9b5cf0" />
            <stop offset="100%" stopColor="#e0479e" />
          </linearGradient>
        </defs>
        <circle
          cx="12"
          cy="12"
          r={r}
          fill="none"
          className="stroke-secondary"
          strokeWidth="3"
        />
        <circle
          cx="12"
          cy="12"
          r={r}
          fill="none"
          stroke="url(#timerPreviewRingGrad)"
          strokeWidth="3"
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * 0.35}
        />
      </svg>
    </span>
  );
}
