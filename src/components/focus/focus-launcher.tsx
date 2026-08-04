import Link from "next/link";
import { t, type Voice } from "@/lib/strings";
import type { LauncherData } from "@/lib/focus-launcher";
import { SingleTaskLane, MultiStepLane } from "@/components/focus/focus-lanes";
import { HyperFocusToggle } from "@/components/focus/hyper-focus-toggle";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * The /focus launcher shell: ← Back, title, a glanceable meta line into the
 * dashboard, an optional amber resume hero (most-recently-active paused
 * multi-step step), and the Single-task / Multi-step lanes using the exact
 * inbox SubHeader + "see all →". Read-only + Server-Component-safe; the lanes
 * (focus-lanes.tsx) are the only interactive island (optimistic quick-complete).
 */
export function FocusLauncher({
  data,
  focusMinToday,
  currentStreak,
  clearedToday,
  voice,
}: {
  data: LauncherData;
  focusMinToday: number;
  currentStreak: number;
  /** true → show the all-cleared moment; false → the brand-new Inbox card. */
  clearedToday: boolean;
  voice: Voice;
}) {
  const { resumeHero, singleTasks, multiStep, meta } = data;
  const isEmpty =
    !resumeHero && singleTasks.length === 0 && multiStep.length === 0;

  return (
    <div className="space-y-4">
      {/* 1. ← Back → / (the inbox root; matches the Library page exactly). */}
      <Link
        href="/"
        className="text-muted-foreground hover:text-foreground inline-flex min-h-[44px] items-center text-sm"
      >
        {t("action.back", voice)}
      </Link>

      {/* 2. Title. */}
      <h1 className="text-xl font-semibold">{t("nav.focusTimer", voice)}</h1>

      {/* 3. Meta line → /dashboard. Numbers composed around static units. */}
      <Link
        href="/dashboard"
        className="text-muted-foreground hover:text-foreground inline-flex min-h-[44px] flex-wrap items-center gap-x-1.5 text-sm"
      >
        <span className="tabular-nums">
          {focusMinToday}m {t("focus.meta.focusedToday", voice)}
        </span>
        <span aria-hidden="true">·</span>
        <span className="tabular-nums">
          🔥 {currentStreak}
          {t("focus.meta.dayStreak", voice)}
        </span>
        <span aria-hidden="true">·</span>
        <span className="tabular-nums">
          ~{meta.minutesToClear}m {t("focus.meta.toClear", voice)}
        </span>
      </Link>

      {/* #142 — the "hyper focus mode" switch. Here rather than in Settings
          because it is a mode this session is in, not a taste, and because it
          is the one place turning it back OFF is reachable without first
          finishing something: the completion screen offers to turn it on, and
          an on-switch whose off-switch lives somewhere else is a trap. Hidden
          when there is nothing to chain — a mode with an empty queue is noise. */}
      {singleTasks.length > 0 && <HyperFocusToggle voice={voice} />}

      {/* 4. Resume hero (amber) — only when a paused multi-step step exists. */}
      {resumeHero && (
        <div className="space-y-2 rounded-lg border border-amber-500/40 bg-amber-50 p-4 dark:bg-amber-950/20">
          <div className="flex items-center gap-2 text-xs">
            {/* Status glyph + text, not colour-only. */}
            <span className="font-medium text-amber-800 dark:text-amber-300">
              {t("focus.paused", voice)}
            </span>
            <span className="text-muted-foreground">
              {resumeHero.taskTitle}
            </span>
          </div>
          <p className="text-base font-semibold">
            {resumeHero.subtaskEmoji ? `${resumeHero.subtaskEmoji} ` : ""}
            {resumeHero.stepText}
          </p>
          <p className="text-muted-foreground text-xs tabular-nums">
            {t("step.counter", voice)} {resumeHero.stepIndex}/
            {resumeHero.stepsTotal}
            {/* #27 follow-up — the paused step's TRUE remaining time (may be
                well below its original estimate), not the full estimate. */}
            {` · ~${resumeHero.remainingMin}m ${t("focus.hero.left", voice)}`}
          </p>
          <div
            className="h-1.5 w-full overflow-hidden rounded-full bg-amber-200 dark:bg-amber-900"
            role="progressbar"
            aria-valuenow={resumeHero.stepsDone}
            aria-valuemin={0}
            aria-valuemax={resumeHero.stepsTotal}
          >
            {/* motion-safe → reduced-motion users get an instant fill. */}
            <div
              className="h-full rounded-full bg-amber-500 motion-safe:transition-[width]"
              style={{
                width: `${(resumeHero.stepsDone / resumeHero.stepsTotal) * 100}%`,
              }}
            />
          </div>
          {resumeHero.nextStepText && (
            <p className="text-muted-foreground text-xs">
              {t("focus.hero.next", voice)}{" "}
              {resumeHero.nextStepEmoji ? `${resumeHero.nextStepEmoji} ` : ""}
              {resumeHero.nextStepText}
            </p>
          )}
          {/* #40 Phase 3.3 — the launcher's primary "start/resume focus" CTA
              earns the brand gradient (Button variant="brand" styling on the
              routing Link): gradient fill, >=18.6px bold label, visible focus
              ring. The amber card around it still signals "paused". */}
          <Link
            href={`/focus/${resumeHero.stepId}`}
            className={cn(
              buttonVariants({ variant: "brand" }),
              "min-h-[44px] rounded-md px-4",
            )}
          >
            {t("focus.hero.resume", voice)}
          </Link>
        </div>
      )}

      {/* 5 + 6. Lanes (hidden entirely in the empty/all-cleared case).
          #136 — each lane owns its own SubHeader, count and zero-state. This
          shell used to render the header from ITS copy of the rows while the
          lane rendered the list from an optimistically filtered one, and a
          Server Component cannot follow a client-side ✓: completing the last
          row in a lane left a stale count beside a bare empty <ul>. The count
          now comes from the same array the list maps, inside the one component
          that knows about both. */}
      {!isEmpty && (
        <div className="space-y-4">
          <SingleTaskLane items={singleTasks} voice={voice} />
          <MultiStepLane items={multiStep} voice={voice} />
        </div>
      )}

      {/* 7. Empty states. */}
      {isEmpty && clearedToday && (
        <div className="rounded-lg border border-dashed p-6 text-center">
          <p className="text-sm">{t("focus.launcher.allClear", voice)}</p>
        </div>
      )}
      {isEmpty && !clearedToday && (
        <div className="space-y-3 rounded-lg border border-dashed p-6 text-center">
          <p className="text-muted-foreground text-sm">
            {t("focus.launcher.empty", voice)}
          </p>
          <Link
            href="/"
            className="inline-flex min-h-[44px] items-center justify-center text-sm underline"
          >
            {t("nav.inbox", voice)}
          </Link>
        </div>
      )}
    </div>
  );
}
