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
import { applyTimeDelta, netAddedMin } from "@/lib/focus-timer-clock";
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
  // #27 bugfix — when a paused session exists, seed the ring/Duration/
  // remaining state from IT (the same values resumeExisting() applies on
  // click), not from the step's static estMinutes. pauseFocus() bakes any
  // mid-session +/-time taps into the session's own plannedMin without ever
  // touching Step.estMinutes, so a 10m step paused after +5m twice persists
  // a session with plannedMin=20 — seeding from estMinutes here made the
  // ring/Duration show "10m" while the Resume button (reading
  // existingSession.remainingSec) said "~15m left": two different numbers
  // for what's supposed to be the same session. Note start() (the "Start
  // fresh" handler) doesn't itself reset plannedMin — it submits whatever's
  // currently in this state — so with a resumable session present, an
  // unedited "Start fresh" now begins at the session's (possibly grown)
  // plannedMin rather than the original estimate; that's consistent with
  // what the Duration field visibly shows, and the fresh-start-with-no-
  // session path (no existingSession) is unaffected, still seeding from
  // step.estMinutes as before.
  const [plannedMin, setPlannedMin] = useState(
    existingSession?.plannedMin ?? step.estMinutes,
  );
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

  // Single-task focus uses the auto-created ensureFocusStep step, whose text
  // equals the task title — so rendering both the task-context line AND the step
  // heading would show the same title twice. Collapse to one primary heading (the
  // task title). Multi-step keeps the hierarchy: task title as context + the
  // active step as the h1.
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

      {showContext && (
        <div className="space-y-2">
          <p className="text-muted-foreground text-xs tabular-nums">
            {t("step.counter", voice)} {step.order} of {step.total} · ~
            {remainingInTask}m {t("focus.timer.leftInTask", voice)}
          </p>
          <FocusStepTracker
            steps={steps}
            currentStepId={step.id}
            expanded={expanded}
            onToggle={() => setExpanded((e) => !e)}
            voice={voice}
          />
        </div>
      )}

      <TimerVisual
        style={timerStyle}
        remainingSec={remainingSec}
        totalSec={totalSec}
        phase={phase === "reestimate" ? "timeup" : phase}
        reducedMotion={reducedMotion}
        voice={voice}
      />
      {net !== 0 && (
        <p className="text-muted-foreground text-center text-xs tabular-nums">
          {net > 0 ? "+" : "−"}
          {Math.abs(net)}m
        </p>
      )}

      {/* Controls */}
      {phase === "setup" && (
        <div className="flex flex-col items-center gap-3">
          {/* #27 — a truly-paused session exists for this step: offer BOTH
              choices rather than silently resuming (owner decision) or
              silently discarding it. "Start fresh" below still works exactly
              as before — beginFocus retires this paused row first. */}
          {existingSession && (
            <Button
              variant="brand"
              onClick={resumeExisting}
              disabled={pending}
              className="h-auto min-h-[52px] gap-2 rounded-full px-8 py-3"
            >
              <Play aria-hidden="true" />
              <span>
                {stripLeadingGlyph(t("focus.resume", voice))} · ~
                {Math.max(1, Math.ceil(existingSession.remainingSec / 60))}m{" "}
                {t("focus.hero.left", voice)}
              </span>
            </Button>
          )}
          <label className="text-muted-foreground flex items-center gap-2 text-sm">
            Duration
            <input
              type="number"
              min={1}
              value={plannedMin}
              onChange={(e) => {
                const v = Math.max(1, Number(e.target.value) || 1);
                setPlannedMin(v);
                setTotalSec(v * 60);
                setRemainingSec(v * 60);
              }}
              className="border-input w-20 rounded-md border px-2 py-1 text-right"
            />
            min
          </label>
          {/* #40 Phase 3.1 — the single CTA that launches the neon focus
              session earns the brand gradient (hero moment). variant="brand"
              carries the ≥18.6px-bold label + visible focus ring. Once an
              existingSession offers Resume above, this becomes the secondary
              "Start fresh" choice (outline, not the hero gradient). */}
          <Button
            variant={existingSession ? "outline" : "brand"}
            onClick={start}
            disabled={pending}
            className={
              existingSession
                ? "min-h-[44px] gap-2 rounded-full px-6"
                : "h-auto min-h-[52px] gap-2 rounded-full px-8 py-3"
            }
          >
            {existingSession ? (
              <RotateCcw aria-hidden="true" />
            ) : (
              <Play aria-hidden="true" />
            )}
            {existingSession
              ? stripLeadingGlyph(t("focus.startFresh", voice))
              : stripLeadingGlyph(t("focus.startTimer", voice))}
          </Button>
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
