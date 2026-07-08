"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  beginFocus,
  completeFocus,
  giveUpFocus,
  requeueFocus,
  proposeNewEstimate,
  type CompleteResult,
} from "@/app/actions/focus";
import { Celebration } from "@/components/focus/celebration";
import { t } from "@/lib/strings";
import { useVoice } from "@/components/voice-provider";

const DONE_MESSAGES = [
  "Nice — step done!",
  "Boom. That's one off the list. 💪",
  "Look at you, actually doing the thing.",
  "One step closer. That felt good, right?",
  "Done and dusted. Proud of you.",
];

type Phase = "setup" | "running" | "paused" | "timeup" | "reestimate" | "done" | "requeued" | "gaveup";

type StepInfo = {
  id: string;
  text: string;
  estMinutes: number;
  subtaskEmoji: string | null;
  order: number;
  total: number;
  done: boolean;
};

function mmss(totalSec: number) {
  const s = Math.max(0, totalSec);
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

export function FocusTimer({
  step,
  taskId,
  taskTitle,
  parentEmoji,
  addTimeIncrementMin,
  initialStats,
  nextStepId,
}: {
  step: StepInfo;
  taskId: string;
  taskTitle: string;
  parentEmoji: string | null;
  addTimeIncrementMin: number;
  initialStats: { focusMin: number; sessions: number };
  nextStepId: string | null;
}) {
  const router = useRouter();
  const voice = useVoice();
  const [phase, setPhase] = useState<Phase>("setup");
  const [plannedMin, setPlannedMin] = useState(step.estMinutes);
  const [totalSec, setTotalSec] = useState(step.estMinutes * 60);
  const [remainingSec, setRemainingSec] = useState(step.estMinutes * 60);
  const [addedMin, setAddedMin] = useState(0);
  const elapsedRef = useRef(0);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [newEst, setNewEst] = useState(step.estMinutes);
  const [result, setResult] = useState<CompleteResult | null>(null);
  const doneMsgRef = useRef(
    DONE_MESSAGES[Math.floor(Math.random() * DONE_MESSAGES.length)],
  );

  const inc = Math.max(1, addTimeIncrementMin || 5);
  const durationMin = () => Math.max(0, Math.round(elapsedRef.current / 60));

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

  const start = async () => {
    setPending(true);
    const id = await beginFocus(step.id, plannedMin);
    setPending(false);
    if (!id) return;
    setSessionId(id);
    setTotalSec(plannedMin * 60);
    setRemainingSec(plannedMin * 60);
    elapsedRef.current = 0;
    setPhase("running");
  };

  const addTime = (mins: number) => {
    setTotalSec((t) => t + mins * 60);
    setRemainingSec((r) => r + mins * 60);
    setAddedMin((a) => a + mins);
    if (phase === "timeup") setPhase("running");
  };

  const finishComplete = useCallback(async () => {
    if (!sessionId) return;
    setPending(true);
    const res = await completeFocus(sessionId, {
      durationMin: durationMin(),
      addedMin,
    });
    setPending(false);
    setResult(res);
    setPhase("done");
    router.refresh();
  }, [sessionId, addedMin, router]);

  const giveUp = async () => {
    if (!sessionId) {
      router.push(`/tasks/${taskId}`);
      return;
    }
    setPending(true);
    await giveUpFocus(sessionId, { durationMin: durationMin(), addedMin });
    setPending(false);
    setPhase("gaveup");
  };

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
      addedMin,
      newEstMinutes: newEst,
    });
    setPending(false);
    setPhase("requeued");
  };

  const fraction = totalSec > 0 ? remainingSec / totalSec : 0;

  const title = (
    <h1 className="text-xl font-semibold">
      {parentEmoji ? `${parentEmoji} ` : ""}
      {taskTitle}
      <span className="text-muted-foreground font-normal">
        {" "}· {t("step.counter", voice)} {step.order} of {step.total}
      </span>
    </h1>
  );

  // ── End screens ──────────────────────────────────────────────────────────
  if (phase === "done") {
    return (
      <div className="space-y-5 text-center">
        {title}
        <div className="flex justify-center pt-6">
          <Celebration />
        </div>
        <div className="text-6xl">🎉</div>
        <p className="text-lg font-medium">{doneMsgRef.current}</p>
        {result && (
          <p className="text-muted-foreground text-sm">
            +{result.points} points
            {result.reclaimSynced ? " · marked complete in Reclaim ✅" : ""}
          </p>
        )}
        {result?.streak ? (
          <p className="text-sm font-medium text-amber-600">
            {result.freshStart
              ? "🌱 Fresh start — day 1 again, and that's completely okay."
              : `🔥 ${result.streak}-day streak!`}
          </p>
        ) : null}
        <div className="flex flex-col items-center gap-2">
          {nextStepId ? (
            <Link
              href={`/focus/${nextStepId}`}
              className="bg-primary text-primary-foreground rounded-md px-4 py-2 font-medium"
            >
              ▶ {t("focus.nextStep", voice)}
            </Link>
          ) : (
            <p className="text-sm">That was the last step of this task. 🏁</p>
          )}
          <Link href={`/tasks/${taskId}`} className="text-muted-foreground text-sm hover:underline">
            ← back to task
          </Link>
        </div>
      </div>
    );
  }

  if (phase === "requeued") {
    return (
      <div className="space-y-4 text-center">
        {title}
        <div className="text-5xl">🌱</div>
        <p className="text-lg font-medium">No worries — bumped to {newEst} min.</p>
        <p className="text-muted-foreground text-sm">
          It&apos;s back on your list with a kinder estimate.
        </p>
        <Link
          href={`/tasks/${taskId}`}
          className="bg-primary text-primary-foreground inline-block rounded-md px-4 py-2 font-medium"
        >
          ← back to task
        </Link>
      </div>
    );
  }

  if (phase === "gaveup") {
    return (
      <div className="space-y-4 text-center">
        {title}
        <div className="text-5xl">💛</div>
        <p className="text-lg font-medium">Paused — no guilt.</p>
        <p className="text-muted-foreground text-sm">Come back whenever you&apos;re ready.</p>
        <Link
          href={`/tasks/${taskId}`}
          className="bg-primary text-primary-foreground inline-block rounded-md px-4 py-2 font-medium"
        >
          ← back to task
        </Link>
      </div>
    );
  }

  // ── Active / setup screen ──────────────────────────────────────────────────
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        {title}
        <span className="text-muted-foreground text-xs">
          today: {initialStats.focusMin}m · {initialStats.sessions} sessions
        </span>
      </div>

      <p className="text-center text-lg">
        {step.subtaskEmoji ? `${step.subtaskEmoji} ` : ""}
        {step.text}
      </p>

      {/* Ring + countdown */}
      <div className="flex justify-center">
        <div className="relative h-64 w-64">
          <svg viewBox="0 0 240 240" className="h-full w-full -rotate-90">
            <circle
              cx="120" cy="120" r="110" fill="none"
              className="stroke-secondary" strokeWidth="12"
            />
            <circle
              cx="120" cy="120" r="110" fill="none"
              className={phase === "timeup" ? "stroke-amber-500" : "stroke-primary"}
              strokeWidth="12" strokeLinecap="round"
              strokeDasharray={2 * Math.PI * 110}
              strokeDashoffset={2 * Math.PI * 110 * (1 - fraction)}
              style={{ transition: "stroke-dashoffset 1s linear" }}
            />
          </svg>
          <div className="absolute inset-0 flex flex-col items-center justify-center">
            <span className="text-5xl font-semibold tabular-nums">
              {mmss(remainingSec)}
            </span>
            {addedMin > 0 && (
              <span className="text-muted-foreground text-xs">+{addedMin}m added</span>
            )}
          </div>
        </div>
      </div>

      {/* Controls */}
      {phase === "setup" && (
        <div className="flex flex-col items-center gap-3">
          <label className="text-muted-foreground flex items-center gap-2 text-sm">
            Duration
            <input
              type="number" min={1} value={plannedMin}
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
            className="rounded-md bg-green-600 px-4 py-2 font-medium text-white disabled:opacity-50"
          >
            {t("focus.complete", voice)}
          </button>
          <button
            onClick={() => setPhase((p) => (p === "running" ? "paused" : "running"))}
            className="hover:bg-accent rounded-md border px-4 py-2"
          >
            {phase === "running" ? t("focus.pause", voice) : t("focus.resume", voice)}
          </button>
          <button onClick={() => addTime(inc)} className="hover:bg-accent rounded-md border px-3 py-2">
            ➕ {inc}m
          </button>
          <button onClick={() => addTime(inc * 2)} className="hover:bg-accent rounded-md border px-3 py-2">
            ➕ {inc * 2}m
          </button>
          <button
            onClick={giveUp}
            disabled={pending}
            className="text-muted-foreground hover:text-foreground rounded-md px-3 py-2 text-sm"
          >
            {t("focus.giveUp", voice)}
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
              className="rounded-md bg-green-600 px-4 py-2 font-medium text-white disabled:opacity-50"
            >
              {t("focus.yesDone", voice)}
            </button>
            <button
              onClick={() => addTime(inc)}
              className="hover:bg-accent rounded-md border px-4 py-2"
            >
              ➕ {inc} more min
            </button>
            <button
              onClick={startReestimate}
              disabled={pending}
              className="hover:bg-accent rounded-md border px-4 py-2 disabled:opacity-50"
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
                type="number" min={1} value={newEst}
                onChange={(e) => setNewEst(Math.max(1, Number(e.target.value) || 1))}
                className="border-input w-24 rounded-md border px-2 py-1 text-right"
              />
              <span className="text-muted-foreground text-sm">min</span>
              <button
                onClick={confirmRequeue}
                className="bg-primary text-primary-foreground rounded-md px-4 py-2 font-medium"
              >
                Requeue
              </button>
            </div>
          )}
        </div>
      )}

      <div className="text-center">
        <Link href={`/tasks/${taskId}`} className="text-muted-foreground text-xs hover:underline">
          ← back to task
        </Link>
      </div>
    </div>
  );
}
