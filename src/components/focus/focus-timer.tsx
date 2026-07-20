"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  beginFocus,
  completeFocus,
  requeueFocus,
  proposeNewEstimate,
  type CompleteResult,
} from "@/app/actions/focus";
import { dismissFocusTimerTip } from "@/app/actions/settings";
import { Celebration } from "@/components/focus/celebration";
import { TimerVisual } from "@/components/focus/timer-visual";
import { FocusStepTracker, type TrackerStep } from "@/components/focus/focus-step-tracker";
import { TimerCustomizationHint } from "@/components/focus/timer-customization-hint";
import { resolveTimerStyle } from "@/lib/focus-timer-style";
import { applyTimeDelta, netAddedMin } from "@/lib/focus-timer-clock";
import {
  createAlarm,
  createLoopPlayer,
  acquireWakeLock,
  FOCUS_SOUND_SRC,
  type Alarm,
  type LoopPlayer,
  type WakeGuard,
} from "@/lib/focus-sounds";
import { usePrefersReducedMotion } from "@/lib/use-prefers-reduced-motion";
import { t } from "@/lib/strings";
import { useVoice } from "@/components/voice-provider";

const DONE_MESSAGES = [
  "Nice — step done!",
  "Boom. That's one off the list. 💪",
  "Look at you, actually doing the thing.",
  "One step closer. That felt good, right?",
  "Done and dusted. Proud of you.",
];

type Phase = "setup" | "running" | "paused" | "timeup" | "reestimate" | "done" | "requeued";

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

export type NextStepPeek = { id: string; text: string; subtaskEmoji: string | null };

export function FocusTimer({
  step,
  steps,
  taskId,
  taskTitle,
  parentEmoji,
  streak,
  focusMinToday,
  nextStep,
  isSingleTask,
  addTimeIncrementMin,
  settings,
  tipDismissed,
}: {
  step: StepInfo;
  steps: TrackerStep[];
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
}) {
  const router = useRouter();
  const voice = useVoice();
  const reducedMotion = usePrefersReducedMotion();
  const timerStyle = resolveTimerStyle(settings.timerStyle, voice);

  const [phase, setPhase] = useState<Phase>("setup");
  const [plannedMin, setPlannedMin] = useState(step.estMinutes);
  const [totalSec, setTotalSec] = useState(step.estMinutes * 60);
  const [remainingSec, setRemainingSec] = useState(step.estMinutes * 60);
  const elapsedRef = useRef(0);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [newEst, setNewEst] = useState(step.estMinutes);
  const [result, setResult] = useState<CompleteResult | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [tipVisible, setTipVisible] = useState(!tipDismissed);
  const doneMsgRef = useRef(DONE_MESSAGES[Math.floor(Math.random() * DONE_MESSAGES.length)]);

  // Device-effect handles (created on Start inside the user gesture).
  const alarmRef = useRef<Alarm | null>(null);
  const loopRef = useRef<LoopPlayer | null>(null);
  const wakeRef = useRef<WakeGuard | null>(null);

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

  // Focus sound + wake lock follow the "running" phase.
  useEffect(() => {
    if (phase === "running") {
      loopRef.current?.play();
      if (settings.keepAwake && !wakeRef.current) {
        void acquireWakeLock().then((g) => {
          wakeRef.current = g;
        });
      }
    } else {
      loopRef.current?.pause();
      releaseWake();
    }
  }, [phase, settings.keepAwake]);

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
  // so we only stop local effects here.
  useEffect(
    () => () => {
      loopRef.current?.stop();
      releaseWake();
    },
    [],
  );

  const start = async () => {
    setPending(true);
    const id = await beginFocus(step.id, plannedMin);
    setPending(false);
    if (!id) return;
    // Prime device effects inside the user gesture (unlocks audio playback).
    if (settings.alarmEnabled) alarmRef.current = createAlarm();
    const src = FOCUS_SOUND_SRC[settings.sound] ?? null;
    if (src) loopRef.current = createLoopPlayer(src);
    setSessionId(id);
    setTotalSec(plannedMin * 60);
    setRemainingSec(plannedMin * 60);
    elapsedRef.current = 0;
    setPhase("running");
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
    loopRef.current?.stop();
    releaseWake();
    setPhase("done");
    router.refresh();
  }, [sessionId, net, router]);

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
    loopRef.current?.stop();
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
  const remainingInTask = steps.filter((s) => !s.done).reduce((n, s) => n + s.estMinutes, 0);

  const stepHeading = (
    <div className="min-w-0">
      <p className="text-muted-foreground truncate text-sm font-semibold">
        {parentEmoji ? `${parentEmoji} ` : ""}
        {taskTitle}
      </p>
      <h1 className="text-xl font-bold">
        {step.subtaskEmoji ? `${step.subtaskEmoji} ` : ""}
        {step.text}
      </h1>
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
              className="bg-primary text-primary-foreground rounded-md px-4 py-2 font-medium"
            >
              ▶ {t("focus.nextStep", voice)}
            </Link>
          ) : (
            <p className="text-sm">That was the last step of this task. 🏁</p>
          )}
          <Link href="/focus" className="text-muted-foreground text-sm hover:underline">
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
        <p className="text-lg font-medium">No worries — bumped to {newEst} min.</p>
        <p className="text-muted-foreground text-sm">It&apos;s back on your list with a kinder estimate.</p>
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

      {tipVisible && <TimerCustomizationHint voice={voice} onDismiss={dismissTip} />}

      {showContext && (
        <div className="space-y-2">
          <p className="text-muted-foreground text-xs tabular-nums">
            {t("step.counter", voice)} {step.order} of {step.total} · ~{remainingInTask}m{" "}
            {t("focus.timer.leftInTask", voice)}
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
          <button
            onClick={start}
            disabled={pending}
            className="bg-primary text-primary-foreground rounded-full px-8 py-3 text-lg font-medium disabled:opacity-50"
          >
            {t("focus.startTimer", voice)}
          </button>
        </div>
      )}

      {(phase === "running" || phase === "paused") && (
        <div className="flex flex-wrap items-center justify-center gap-2">
          <button
            onClick={finishComplete}
            disabled={pending}
            className="inline-flex min-h-[44px] items-center rounded-md bg-green-600 px-5 font-medium text-white disabled:opacity-50"
          >
            {t("focus.timer.completeStep", voice)}
          </button>
          <button
            onClick={() => setPhase((p) => (p === "running" ? "paused" : "running"))}
            className="hover:bg-accent inline-flex min-h-[44px] items-center rounded-md border px-4"
          >
            {phase === "running" ? t("focus.pause", voice) : t("focus.resume", voice)}
          </button>
          <button
            onClick={() => changeTime(-inc)}
            disabled={atFloor}
            className="hover:bg-accent inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-md border disabled:opacity-40"
          >
            −{inc}m
          </button>
          <button
            onClick={() => changeTime(inc)}
            className="hover:bg-accent inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-md border"
          >
            +{inc}m
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
              className="inline-flex min-h-[44px] items-center rounded-md bg-green-600 px-4 font-medium text-white disabled:opacity-50"
            >
              {t("focus.yesDone", voice)}
            </button>
            <button
              onClick={() => changeTime(inc)}
              className="hover:bg-accent inline-flex min-h-[44px] items-center rounded-md border px-4"
            >
              +{inc}m
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
          <p className="font-medium">No problem. Here&apos;s a kinder estimate:</p>
          {pending ? (
            <p className="text-muted-foreground text-sm">Claude is re-estimating…</p>
          ) : (
            <div className="flex items-center justify-center gap-2">
              <input
                type="number"
                min={1}
                value={newEst}
                onChange={(e) => setNewEst(Math.max(1, Number(e.target.value) || 1))}
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

      {/* Next-step peek (below controls). Shown for any multi-step active/setup
          phase; hidden by minimal mode while running (via showContext) and on the
          done/requeued end screens (which return early above). */}
      {showContext && nextStep && (
        <p className="text-muted-foreground text-center text-xs">
          {t("focus.hero.next", voice)} {nextStep.subtaskEmoji ? `${nextStep.subtaskEmoji} ` : ""}
          {nextStep.text}
        </p>
      )}
    </div>
  );
}
