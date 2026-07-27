"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Minus, Pause, Play, Plus, RotateCcw } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  beginFocus,
  completeFocus,
  requeueFocus,
  proposeNewEstimate,
  pauseFocus,
  resumeFocus,
  type CompleteResult,
} from "@/app/actions/focus";
import { dismissFocusTimerTip } from "@/app/actions/settings";
import { Celebration } from "@/components/focus/celebration";
import { TimerVisual } from "@/components/focus/timer-visual";
import { Button } from "@/components/ui/button";
import {
  FocusStepTracker,
  type TrackerStep,
} from "@/components/focus/focus-step-tracker";
import { TimerCustomizationHint } from "@/components/focus/timer-customization-hint";
import { resolveTimerStyle } from "@/lib/focus-timer-style";
import {
  applyTimeDelta,
  durationChoices,
  netAddedMin,
} from "@/lib/focus-timer-clock";
import {
  createAlarm,
  acquireWakeLock,
  type Alarm,
  type WakeGuard,
} from "@/lib/focus-sounds";
import { useFocusSound } from "@/lib/use-focus-sound";
import { FocusSoundPlayer } from "@/components/focus/focus-sound-player";
import { FocusSound } from "@/lib/constants";
import { usePrefersReducedMotion } from "@/lib/use-prefers-reduced-motion";
import { t } from "@/lib/strings";
import { cn } from "@/lib/utils";
import { useVoice } from "@/components/voice-provider";

// #43 — the shared focus control strings carry a leading functional glyph
// (✓/▶/⏸/✅) for text-only surfaces; on the focus timer we render a lucide icon
// instead, so strip that leading glyph from the button label here (the strings
// themselves stay glyph-bearing for the inbox/lane/task-step affordances).
function stripLeadingGlyph(label: string): string {
  return label.replace(/^\P{L}+/u, "");
}

const DONE_MESSAGES = [
  "Nice — step done!",
  "Boom. That's one off the list. 💪",
  "Look at you, actually doing the thing.",
  "One step closer. That felt good, right?",
  "Done and dusted. Proud of you.",
];

type Phase =
  | "setup"
  | "running"
  | "paused"
  | "timeup"
  | "reestimate"
  | "done"
  | "requeued";

type StepInfo = {
  id: string;
  text: string;
  estMinutes: number;
  subtaskEmoji: string | null;
  order: number;
  total: number;
  done: boolean;
};

export type TimerSettings = {
  timerStyle: string | null;
  minimalMode: boolean;
  keepAwake: boolean;
  alarmEnabled: boolean;
  sound: string;
};

export type NextStepPeek = {
  id: string;
  text: string;
  subtaskEmoji: string | null;
};

/** #27 — a TRULY paused (not merely abandoned) open session for this step,
 * loaded by the page so the setup screen can offer a real "Resume" instead of
 * only "Start" (owner decision: ask, don't silently resume). Null when there
 * is none. */
export type ExistingPausedSession = {
  id: string;
  plannedMin: number;
  totalSec: number;
  remainingSec: number;
};

export function FocusTimer({
  step,
  steps,
  taskTitle,
  parentEmoji,
  streak,
  focusMinToday,
  nextStep,
  isSingleTask,
  addTimeIncrementMin,
  settings,
  tipDismissed,
  existingSession = null,
}: {
  step: StepInfo;
  steps: TrackerStep[];
  // taskId is accepted (the page passes it) but the redesigned timer navigates
  // to /focus rather than /tasks/:id, so it isn't read here. Kept for the page's
  // prop shape + potential future use.
  taskId: string;
  taskTitle: string;
  parentEmoji: string | null;
  streak: number;
  focusMinToday: number;
  nextStep: NextStepPeek | null;
  isSingleTask: boolean;
  addTimeIncrementMin: number;
  settings: TimerSettings;
  tipDismissed: boolean;
  existingSession?: ExistingPausedSession | null;
}) {
  const router = useRouter();
  const voice = useVoice();
  const reducedMotion = usePrefersReducedMotion();
  const timerStyle = resolveTimerStyle(settings.timerStyle, voice);

  const [phase, setPhase] = useState<Phase>("setup");
  // #27 bugfix (!139) — when a paused session exists, seed the clock state from
  // IT (the same values resumeExisting() applies on click), not from the step's
  // static estMinutes. pauseFocus() bakes any mid-session +/-time taps into the
  // session's own plannedMin without ever touching Step.estMinutes, so a 10m
  // step paused after +5m twice persists a session with plannedMin=20 — seeding
  // from estMinutes made the setup screen show "10m" while the Resume button
  // (reading existingSession.remainingSec) said "~15m left": two different
  // numbers for what's supposed to be the same session. #66 additionally makes
  // the setup ring DERIVE its figure per state (setupRemainingSec below), so
  // there is no longer a stored number that can drift from the CTA at all — but
  // this seed still decides which duration chip starts selected and what "Start
  // fresh" submits, so it must be the session's value (what's on screen), not
  // the stale estimate. The no-session path is unaffected: step.estMinutes.
  const seedMin = existingSession?.plannedMin ?? step.estMinutes;
  const [plannedMin, setPlannedMin] = useState(seedMin);
  const [totalSec, setTotalSec] = useState(
    existingSession?.totalSec ?? step.estMinutes * 60,
  );
  const [remainingSec, setRemainingSec] = useState(
    existingSession?.remainingSec ?? step.estMinutes * 60,
  );
  const elapsedRef = useRef(0);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [newEst, setNewEst] = useState(step.estMinutes);
  const [result, setResult] = useState<CompleteResult | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [tipVisible, setTipVisible] = useState(!tipDismissed);
  // #66 — progressive disclosure. While a resumable session exists the setup
  // screen offers ONE choice (Resume); flipping this (the "Start fresh"
  // affordance) is what reveals the duration chips. It's a plain UI toggle, not
  // a commitment: nothing is retired server-side until Start is pressed, so a
  // mis-tap can be undone with "Keep my paused session".
  const [startingFresh, setStartingFresh] = useState(false);
  // The setup screen's primary CTA (Resume or Start), focused after a
  // disclosure toggle — see the effect below.
  const setupCtaRef = useRef<HTMLButtonElement | null>(null);
  const disclosureMounted = useRef(false);
  const doneMsgRef = useRef(
    DONE_MESSAGES[Math.floor(Math.random() * DONE_MESSAGES.length)],
  );

  // Device-effect handles (created on Start inside the user gesture).
  const alarmRef = useRef<Alarm | null>(null);
  const wakeRef = useRef<WakeGuard | null>(null);
  // #43 — the shared lo-fi player (current track / play state / volume). Drives
  // both the Start-gesture autoplay and the embedded mini-player below. The
  // returned object is a new literal each render (its reactive state changes),
  // so we destructure the *stable* callbacks (each is useCallback-memoised inside
  // the hook) to use in this component's effects/handlers — depending on the
  // whole `sound` object would needlessly recreate memoised callbacks.
  const sound = useFocusSound(settings.sound);
  const { play: playSound, pause: pauseSound, stop: stopSound } = sound;
  const soundOff = settings.sound === FocusSound.Off;

  const inc = Math.max(1, addTimeIncrementMin || 5);
  const durationMin = () => Math.max(0, Math.round(elapsedRef.current / 60));
  const net = netAddedMin(totalSec, plannedMin * 60);
  const atFloor = remainingSec <= 60;

  const releaseWake = () => {
    wakeRef.current?.release();
    wakeRef.current = null;
  };

  // Countdown ticker.
  useEffect(() => {
    if (phase !== "running") return;
    const id = setInterval(() => {
      elapsedRef.current += 1;
      setRemainingSec((r) => {
        if (r <= 1) {
          clearInterval(id);
          setPhase("timeup");
          return 0;
        }
        return r - 1;
      });
    }, 1000);
    return () => clearInterval(id);
  }, [phase]);

  // Focus sound + wake lock follow the "running" phase: the lo-fi pauses and
  // resumes WITH the timer (owner decision). The first play() happens in the
  // Start gesture (start()) to unlock autoplay; this effect keeps the audio in
  // lockstep on pause↔resume (and any other transition out of "running" pauses
  // it). Session end / unmount still fully stop it (finishComplete / cleanup).
  // No-op when sound is off. The mini-player reflects the paused state via the
  // hook's `playing` flag, which pause()/play() here keep truthful.
  useEffect(() => {
    if (phase === "running") {
      if (!soundOff) playSound();
      if (settings.keepAwake && !wakeRef.current) {
        void acquireWakeLock().then((g) => {
          wakeRef.current = g;
        });
      }
    } else {
      if (!soundOff) pauseSound();
      releaseWake();
    }
  }, [phase, settings.keepAwake, soundOff, playSound, pauseSound]);

  // Alarm at time's-up.
  useEffect(() => {
    if (phase === "timeup") alarmRef.current?.play();
  }, [phase]);

  // Auto-expand the step tracker when the timer stops (calm while running,
  // orienting when stopped).
  useEffect(() => {
    if (phase === "paused" || phase === "timeup") setExpanded(true);
  }, [phase]);

  // #66 — either disclosure toggle unmounts the button that was just clicked
  // (the setup CTA block is swapped wholesale), which would drop focus to
  // <body> and lose a keyboard/screen-reader user's place mid-decision. Hand it
  // to whichever action is now primary. The mounted guard keeps it from stealing
  // focus on first render.
  useEffect(() => {
    if (!disclosureMounted.current) {
      disclosureMounted.current = true;
      return;
    }
    setupCtaRef.current?.focus();
  }, [startingFresh]);

  // Cleanup on unmount — ← Back leaves the FocusSession OPEN (no server call),
  // so we only stop local effects here. (useFocusSound also stops its element on
  // unmount; this is belt-and-braces.) stopSound is a stable callback, so this
  // runs once on mount and cleans up on unmount.
  useEffect(
    () => () => {
      stopSound();
      releaseWake();
    },
    [stopSound],
  );

  const start = async () => {
    setPending(true);
    const id = await beginFocus(step.id, plannedMin);
    setPending(false);
    if (!id) return;
    // Prime device effects inside the user gesture (unlocks audio playback).
    if (settings.alarmEnabled) alarmRef.current = createAlarm();
    if (!soundOff) playSound();
    setSessionId(id);
    setTotalSec(plannedMin * 60);
    setRemainingSec(plannedMin * 60);
    elapsedRef.current = 0;
    setPhase("running");
  };

  // #27 — setup-screen "Resume" CTA: reuses the existing paused session (no
  // new FocusSession row) and restores its frozen remaining time. Device
  // effects are primed here too — this is the user gesture that (re)starts
  // the countdown, same as start().
  const resumeExisting = async () => {
    if (!existingSession) return;
    setPending(true);
    const res = await resumeFocus(existingSession.id);
    setPending(false);
    if (!res.ok) return;
    if (settings.alarmEnabled) alarmRef.current = createAlarm();
    if (!soundOff) playSound();
    setSessionId(existingSession.id);
    setPlannedMin(res.plannedMin);
    setTotalSec(res.totalSec);
    setRemainingSec(res.remainingSec);
    elapsedRef.current = Math.max(0, res.totalSec - res.remainingSec);
    setPhase(res.remainingSec <= 0 ? "timeup" : "running");
  };

  // #27 — the in-session Pause/Resume toggle now persists real state instead
  // of only flipping local `phase`: pausing stamps the session (so leaving
  // the tab, reloading, or opening another device restores correctly);
  // resuming reuses that same session (see resumeFocus). Both directions
  // await the server BEFORE committing the local phase transition — if the
  // server disagrees (e.g. a concurrent request/another device already
  // closed the session), we reconcile to what the server actually has
  // rather than showing a phase it doesn't (Duo review) — same fail-safe
  // shape either way: stay "running", the one state both sides always agree
  // a live session is in.
  const togglePause = async () => {
    if (phase === "running") {
      if (!sessionId) {
        setPhase("paused");
        return;
      }
      setPending(true);
      const res = await pauseFocus(sessionId, { totalSec });
      setPending(false);
      if (!res.ok) return; // server disagrees — stay running, don't show a paused state it doesn't have
      setPhase("paused");
      return;
    }
    if (phase !== "paused" || !sessionId) return;
    setPending(true);
    const res = await resumeFocus(sessionId);
    setPending(false);
    if (!res.ok) {
      setPhase("running");
      return;
    }
    setRemainingSec(res.remainingSec);
    elapsedRef.current = Math.max(0, res.totalSec - res.remainingSec);
    setPhase(res.remainingSec <= 0 ? "timeup" : "running");
  };

  const changeTime = (mins: number) => {
    const next = applyTimeDelta({ totalSec, remainingSec }, mins * 60);
    setTotalSec(next.totalSec);
    setRemainingSec(next.remainingSec);
    if (phase === "timeup" && mins > 0) setPhase("running");
  };

  const finishComplete = useCallback(async () => {
    if (!sessionId) return;
    setPending(true);
    const res = await completeFocus(sessionId, {
      durationMin: durationMin(),
      addedMin: Math.max(0, net),
    });
    setPending(false);
    setResult(res);
    stopSound();
    releaseWake();
    setPhase("done");
    router.refresh();
  }, [sessionId, net, router, stopSound]);

  const startReestimate = async () => {
    setPhase("reestimate");
    setPending(true);
    const suggested = await proposeNewEstimate(step.id);
    setNewEst(suggested);
    setPending(false);
  };

  const confirmRequeue = async () => {
    if (!sessionId) return;
    setPending(true);
    await requeueFocus(sessionId, {
      durationMin: durationMin(),
      addedMin: Math.max(0, net),
      newEstMinutes: newEst,
    });
    setPending(false);
    stopSound();
    releaseWake();
    setPhase("requeued");
  };

  const dismissTip = () => {
    setTipVisible(false);
    void dismissFocusTimerTip();
  };

  const running = phase === "running";
  const showContext = !isSingleTask && !(settings.minimalMode && running);
  const showCorner = !(settings.minimalMode && running);
  // #43 — the mini-player rides along an active session (running or paused) when
  // a lo-fi track is chosen; minimal mode hides it while running (no distraction).
  const sessionActive = phase === "running" || phase === "paused";
  const showSoundPlayer =
    sessionActive && !soundOff && !(settings.minimalMode && running);
  const remainingInTask = steps
    .filter((s) => !s.done)
    .reduce((n, s) => n + s.estMinutes, 0);

  // ── #66: the setup screen's ONE number ─────────────────────────────────────
  // The setup phase used to show up to four figures at once (ring countdown,
  // the step-context line's "~Xm left in task", the Resume button's own
  // "~Xm left", and a "Duration [n] min" input) — and in the resume case the
  // ring and the button openly contradicted each other (!139 fixed the data
  // side; this closes it on the presentation side). Now: one number, one
  // action, everything else revealed only when asked.
  const setup = phase === "setup";
  // The paused session the setup screen is currently OFFERING (null once the
  // user has asked to start fresh). Every setup-phase figure below derives from
  // this single value, so the ring and the CTA cannot disagree.
  const resumable = startingFresh ? null : existingSession;
  // Rounded UP to whole minutes, once, and reused by both the CTA and the quiet
  // line — never recomputed differently in two places. No 1m floor: a session
  // paused with nothing left must read the same 0m the ring shows (resuming it
  // lands straight on time's-up, which is correct).
  const resumeMinLeft = resumable ? Math.ceil(resumable.remainingSec / 60) : 0;
  // What the ring shows in setup: the paused session's remainder while resuming,
  // the chosen duration when starting fresh. Derived, never stored, so there is
  // no second copy to drift.
  const setupRemainingSec = resumable
    ? resumable.remainingSec
    : plannedMin * 60;
  const setupTotalSec = resumable ? resumable.totalSec : plannedMin * 60;
  // …and a word instead of the "of Nm" total, naming what that one number is.
  const setupSubLabel = resumable
    ? isSingleTask
      ? t("focus.setup.ringPickUp", voice)
      : t("focus.setup.ringLeftOnStep", voice)
    : t("focus.setup.ringFocusTime", voice);
  // The chips are derived from the SEEDED estimate, not the live `plannedMin`:
  // an off-preset seed (a 7m step, or a session grown to 20m by +time taps)
  // keeps its own chip after the user taps another one, so its value stays
  // reachable.
  const chipMinutes = durationChoices(seedMin);
  const stepsToGo = Math.max(0, step.total - step.order);
  // The ONE quiet subordinate line for a multi-step task: progress is a count
  // ("Step N of M", now the header eyebrow), so the whole-task minutes figure
  // sits here — present for context, never competing with the step's ring.
  // Built as a single string so it reads (and is testable) as one unit.
  const taskTotalText =
    `~${remainingInTask}m ${t("focus.setup.leftWholeTask", voice)}` +
    (stepsToGo > 0
      ? ` · ${stepsToGo} ${t(stepsToGo === 1 ? "focus.setup.stepToGo" : "focus.setup.stepsToGo", voice)}`
      : "");
  const taskTotalLine = showContext ? (
    <p className="text-muted-foreground text-center text-xs tabular-nums">
      {taskTotalText}
    </p>
  ) : null;

  // Single-task focus uses the auto-created ensureFocusStep step, whose text
  // equals the task title — so rendering both the task-context line AND the step
  // heading would show the same title twice. Collapse to one primary heading (the
  // task title). Multi-step keeps the hierarchy: task title as context, a
  // "Step N of M" eyebrow, then the active step as the h1 hero (#66 — the step
  // is what you're about to do, so it's the biggest thing on screen).
  const stepHeading = (
    <div className="min-w-0">
      {isSingleTask ? (
        <h1 className="text-xl font-bold">
          {parentEmoji ? `${parentEmoji} ` : ""}
          {taskTitle}
        </h1>
      ) : (
        <>
          <p className="text-muted-foreground truncate text-sm font-semibold">
            {parentEmoji ? `${parentEmoji} ` : ""}
            {taskTitle}
          </p>
          <p className="text-primary text-xs font-bold tracking-[0.12em] uppercase tabular-nums">
            {t("step.counter", voice)} {step.order} of {step.total}
          </p>
          <h1 className="text-xl font-bold">
            {step.subtaskEmoji ? `${step.subtaskEmoji} ` : ""}
            {step.text}
          </h1>
        </>
      )}
    </div>
  );

  // ── End screens ────────────────────────────────────────────────────────────
  if (phase === "done") {
    return (
      <div className="space-y-5 text-center">
        {stepHeading}
        <div className="flex justify-center pt-6">
          <Celebration />
        </div>
        <div className="text-6xl">🎉</div>
        <p className="text-lg font-medium">{doneMsgRef.current}</p>
        {result && (
          <p className="text-muted-foreground text-sm">
            +{result.points} points
            {result.googleSynced ? " · marked complete in Google Tasks ✅" : ""}
          </p>
        )}
        {result?.streak ? (
          <p className="text-sm font-medium text-amber-700 dark:text-amber-400">
            {result.freshStart
              ? "🌱 Fresh start — day 1 again, and that's completely okay."
              : `🔥 ${result.streak}-day streak!`}
          </p>
        ) : null}
        <div className="flex flex-col items-center gap-2">
          {nextStep ? (
            <Link
              href={`/focus/${nextStep.id}`}
              className="bg-primary text-primary-foreground inline-flex items-center gap-1.5 rounded-md px-4 py-2 font-medium"
            >
              <Play aria-hidden="true" className="h-4 w-4 shrink-0" />
              {t("focus.nextStep", voice)}
            </Link>
          ) : (
            <p className="text-sm">That was the last step of this task. 🏁</p>
          )}
          <Link
            href="/focus"
            className="text-muted-foreground text-sm hover:underline"
          >
            {t("action.back", voice)}
          </Link>
        </div>
      </div>
    );
  }

  if (phase === "requeued") {
    return (
      <div className="space-y-4 text-center">
        {stepHeading}
        <div className="text-5xl">🌱</div>
        <p className="text-lg font-medium">
          No worries — bumped to {newEst} min.
        </p>
        <p className="text-muted-foreground text-sm">
          It&apos;s back on your list with a kinder estimate.
        </p>
        <Link
          href="/focus"
          className="bg-primary text-primary-foreground inline-block rounded-md px-4 py-2 font-medium"
        >
          {t("action.back", voice)}
        </Link>
      </div>
    );
  }

  // ── Active / setup screen ────────────────────────────────────────────────────
  return (
    <div className="space-y-5">
      {/* ← Back → /focus (the launcher is the logical parent; leaving makes no
          server call, so the FocusSession stays open/resumable). */}
      <Link
        href="/focus"
        className="text-muted-foreground hover:text-foreground inline-flex min-h-[44px] items-center text-sm"
      >
        {t("action.back", voice)}
      </Link>

      <div className="flex items-start justify-between gap-2">
        {stepHeading}
        {showCorner && (
          <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
            🔥{streak} · {focusMinToday}m today
          </span>
        )}
      </div>

      {tipVisible && (
        <TimerCustomizationHint voice={voice} onDismiss={dismissTip} />
      )}

      {/* #66 — the step count moved up into the heading eyebrow and the
          whole-task minutes into the one quiet line below the controls, so
          what's left here is the tracker itself. */}
      {showContext && (
        <FocusStepTracker
          steps={steps}
          currentStepId={step.id}
          expanded={expanded}
          onToggle={() => setExpanded((e) => !e)}
          voice={voice}
        />
      )}

      <TimerVisual
        style={timerStyle}
        remainingSec={setup ? setupRemainingSec : remainingSec}
        totalSec={setup ? setupTotalSec : totalSec}
        phase={phase === "reestimate" ? "timeup" : phase}
        reducedMotion={reducedMotion}
        voice={voice}
        subLabel={setup ? setupSubLabel : undefined}
      />
      {/* The ±Nm net note belongs to a live session's ±time taps; in setup it
          would just be another number next to the ring (#66). */}
      {!setup && net !== 0 && (
        <p className="text-muted-foreground text-center text-xs tabular-nums">
          {net > 0 ? "+" : "−"}
          {Math.abs(net)}m
        </p>
      )}

      {/* Controls */}
      {setup && (
        <div className="flex flex-col items-center gap-3">
          {resumable ? (
            <>
              {/* #27 — a truly-paused session exists for this step: offer it
                  rather than silently resuming (owner decision) or silently
                  discarding it. #66 — it's the screen's ONE action, and its
                  figure is the same one the ring is showing above (both read
                  `resumable.remainingSec`, rounded once into resumeMinLeft). */}
              <Button
                ref={setupCtaRef}
                variant="brand"
                onClick={resumeExisting}
                disabled={pending}
                className="h-auto min-h-[52px] gap-2 rounded-full px-8 py-3"
              >
                <Play aria-hidden="true" />
                <span>
                  {stripLeadingGlyph(t("focus.resume", voice))} · ~
                  {resumeMinLeft}m {t("focus.hero.left", voice)}
                </span>
              </Button>
              {/* One quiet subordinate line: the same figure again for a single
                  task, the whole-task total for a multi-step one. */}
              {isSingleTask ? (
                <p className="text-muted-foreground text-center text-xs tabular-nums">
                  {resumeMinLeft} min {t("focus.hero.left", voice)}{" "}
                  {t("focus.setup.onThisTask", voice)}
                </p>
              ) : (
                taskTotalLine
              )}
              {/* #66 — progressive disclosure: the duration chips only exist
                  once the user asks to start fresh. One decision at a time. */}
              <button
                type="button"
                onClick={() => setStartingFresh(true)}
                className="text-muted-foreground hover:text-foreground inline-flex min-h-[44px] items-center gap-1.5 text-sm font-semibold underline underline-offset-4"
              >
                <RotateCcw aria-hidden="true" className="h-4 w-4 shrink-0" />
                {stripLeadingGlyph(t("focus.startFresh", voice))}
              </button>
            </>
          ) : (
            <>
              {/* #40 Phase 3.1 — the single CTA that launches the neon focus
                  session earns the brand gradient (hero moment). variant="brand"
                  carries the ≥18.6px-bold label + visible focus ring. */}
              <Button
                ref={setupCtaRef}
                variant="brand"
                onClick={start}
                disabled={pending}
                className="h-auto min-h-[52px] gap-2 rounded-full px-8 py-3"
              >
                <Play aria-hidden="true" />
                {stripLeadingGlyph(t("focus.startTimer", voice))}
              </Button>
              {/* #66 — duration is a chip row, not a free-type number field:
                  one tap, nothing to second-guess, and every chip is a ≥44px
                  aria-pressed toggle. Picking one moves the ring (which derives
                  from `plannedMin`), so the number on screen is always the
                  number Start will use. */}
              <div className="flex flex-col items-center gap-2">
                <p
                  id="focus-duration-label"
                  className="text-muted-foreground text-sm font-semibold"
                >
                  {t("focus.setup.focusFor", voice)}
                </p>
                <div
                  role="group"
                  aria-labelledby="focus-duration-label"
                  className="flex flex-wrap justify-center gap-2"
                >
                  {chipMinutes.map((min) => {
                    const active = min === plannedMin;
                    return (
                      <button
                        key={min}
                        type="button"
                        aria-pressed={active}
                        onClick={() => setPlannedMin(min)}
                        className={cn(
                          "inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-full border px-4 text-sm font-semibold tabular-nums transition-colors",
                          active
                            ? // Token-paired tint (designed to clear AA in both
                              // themes) — deliberately quieter than the gradient
                              // CTA it sits under.
                              "border-primary bg-accent text-accent-foreground"
                            : "border-border text-foreground hover:bg-muted",
                        )}
                      >
                        {min}m
                      </button>
                    );
                  })}
                </div>
              </div>
              {!isSingleTask && taskTotalLine}
              {/* The way back out of the disclosure — the paused session is
                  still there until Start actually retires it. */}
              {existingSession && (
                <button
                  type="button"
                  onClick={() => setStartingFresh(false)}
                  className="text-muted-foreground hover:text-foreground inline-flex min-h-[44px] items-center gap-1.5 text-sm font-semibold underline underline-offset-4"
                >
                  <RotateCcw aria-hidden="true" className="h-4 w-4 shrink-0" />
                  {stripLeadingGlyph(t("focus.setup.keepPaused", voice))}
                </button>
              )}
            </>
          )}
        </div>
      )}

      {(phase === "running" || phase === "paused") && (
        <div className="flex flex-wrap items-center justify-center gap-2">
          <button
            onClick={finishComplete}
            disabled={pending}
            className="inline-flex min-h-[44px] items-center gap-1.5 rounded-md bg-green-600 px-5 font-medium text-white disabled:opacity-50"
          >
            <Check aria-hidden="true" className="h-4 w-4 shrink-0" />
            {stripLeadingGlyph(t("focus.timer.completeStep", voice))}
          </button>
          <button
            onClick={togglePause}
            disabled={pending}
            className="hover:bg-accent inline-flex min-h-[44px] items-center gap-1.5 rounded-md border px-4 disabled:opacity-50"
          >
            {phase === "running" ? (
              <>
                <Pause aria-hidden="true" className="h-4 w-4 shrink-0" />
                {stripLeadingGlyph(t("focus.pause", voice))}
              </>
            ) : (
              <>
                <Play aria-hidden="true" className="h-4 w-4 shrink-0" />
                {stripLeadingGlyph(t("focus.resume", voice))}
              </>
            )}
          </button>
          <button
            onClick={() => changeTime(-inc)}
            disabled={atFloor}
            aria-label={`Subtract ${inc} minutes`}
            className="hover:bg-accent inline-flex min-h-[44px] min-w-[44px] items-center justify-center gap-0.5 rounded-md border disabled:opacity-40"
          >
            <Minus aria-hidden="true" className="h-4 w-4 shrink-0" />
            {inc}m
          </button>
          <button
            onClick={() => changeTime(inc)}
            aria-label={`Add ${inc} minutes`}
            className="hover:bg-accent inline-flex min-h-[44px] min-w-[44px] items-center justify-center gap-0.5 rounded-md border"
          >
            <Plus aria-hidden="true" className="h-4 w-4 shrink-0" />
            {inc}m
          </button>
        </div>
      )}

      {phase === "timeup" && (
        <div className="space-y-3 text-center">
          <p className="text-lg font-medium">{t("focus.timesUp", voice)}</p>
          <div className="flex flex-wrap justify-center gap-2">
            <button
              onClick={finishComplete}
              disabled={pending}
              className="inline-flex min-h-[44px] items-center gap-1.5 rounded-md bg-green-600 px-4 font-medium text-white disabled:opacity-50"
            >
              <Check aria-hidden="true" className="h-4 w-4 shrink-0" />
              {stripLeadingGlyph(t("focus.yesDone", voice))}
            </button>
            <button
              onClick={() => changeTime(inc)}
              aria-label={`Add ${inc} minutes`}
              className="hover:bg-accent inline-flex min-h-[44px] items-center gap-0.5 rounded-md border px-4"
            >
              <Plus aria-hidden="true" className="h-4 w-4 shrink-0" />
              {inc}m
            </button>
            <button
              onClick={startReestimate}
              disabled={pending}
              className="hover:bg-accent inline-flex min-h-[44px] items-center rounded-md border px-4 disabled:opacity-50"
            >
              {t("focus.notYet", voice)}
            </button>
          </div>
        </div>
      )}

      {phase === "reestimate" && (
        <div className="space-y-3 text-center">
          <p className="font-medium">
            No problem. Here&apos;s a kinder estimate:
          </p>
          {pending ? (
            <p className="text-muted-foreground text-sm">
              Claude is re-estimating…
            </p>
          ) : (
            <div className="flex items-center justify-center gap-2">
              <input
                type="number"
                min={1}
                value={newEst}
                onChange={(e) =>
                  setNewEst(Math.max(1, Number(e.target.value) || 1))
                }
                className="border-input w-24 rounded-md border px-2 py-1 text-right"
              />
              <span className="text-muted-foreground text-sm">min</span>
              <button
                onClick={confirmRequeue}
                className="bg-primary text-primary-foreground inline-flex min-h-[44px] items-center rounded-md px-4 font-medium"
              >
                Requeue
              </button>
            </div>
          )}
        </div>
      )}

      {/* #66 — the same quiet task-total line for the live/time's-up phases (in
          setup it's rendered inside the controls, directly under the CTA, per
          the approved mockup's hierarchy). */}
      {!setup && taskTotalLine}

      {/* #43 — embedded lo-fi mini-player (play/pause · prev/next · volume ·
          now-playing). Hidden when sound is off or minimal-mode-while-running. */}
      {showSoundPlayer && <FocusSoundPlayer controls={sound} voice={voice} />}

      {/* Next-step peek (below controls). Shown for any multi-step active/setup
          phase; hidden by minimal mode while running (via showContext) and on the
          done/requeued end screens (which return early above). */}
      {showContext && nextStep && (
        <p className="text-muted-foreground text-center text-xs">
          {t("focus.hero.next", voice)}{" "}
          {nextStep.subtaskEmoji ? `${nextStep.subtaskEmoji} ` : ""}
          {nextStep.text}
        </p>
      )}
    </div>
  );
}
