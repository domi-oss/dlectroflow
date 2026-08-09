"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  Check,
  Minus,
  Pause,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  TriangleAlert,
  Zap,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  beginFocus,
  completeFocus,
  requeueFocus,
  uncompleteStep,
  proposeNewEstimate,
  pauseFocus,
  resumeFocus,
  type CompleteResult,
} from "@/app/actions/focus";
import {
  dismissFocusTimerTip,
  updateFocusShuffle,
  updateFocusSoundCategories,
} from "@/app/actions/settings";
import { ensureFocusStep } from "@/app/actions/braindump";
import { AutoAdvance } from "@/components/focus/auto-advance";
import { Celebration } from "@/components/focus/celebration";
import { TimerVisual } from "@/components/focus/timer-visual";
import { NoteText } from "@/components/breakdown/note-field";
import { Button } from "@/components/ui/button";
import {
  FocusStepTracker,
  type TrackerStep,
} from "@/components/focus/focus-step-tracker";
import { TimerCustomizationHint } from "@/components/focus/timer-customization-hint";
import { resolveTimerStyle } from "@/lib/focus-timer-style";
import {
  isStaleActionError,
  withActionTimeout,
} from "@/lib/server-action-failure";
import {
  applyTimeDelta,
  durationChoices,
  netAddedMin,
  normalizeEstMin,
  DURATION_PRESET_MIN,
  MIN_REMAINING_SEC,
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
import { chooseEnding } from "@/lib/focus-next";
import { usePrefersReducedMotion } from "@/lib/use-prefers-reduced-motion";
import { useHyperFocus } from "@/lib/use-hyper-focus";
import { t, type StringKey } from "@/lib/strings";
import { cn } from "@/lib/utils";
import { pickOne } from "@/lib/pick-one";
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

/**
 * #137 — how long the UI waits on the re-estimate before saying so.
 *
 * The generous end of reasonable: `proposeNewEstimate` is a real LLM round-trip
 * (`maxTokens: 200`, low effort), and a timeout that fires while the answer is
 * still coming would trade a hang for a false alarm. The request itself is not
 * cancelled — a server action cannot be aborted from the client — so nothing is
 * lost by waiting; this only bounds how long the user stares at a spinner
 * before being offered a way forward. Exported so the test asserts against the
 * real value rather than a copy of it.
 */
export const REESTIMATE_TIMEOUT_MS = 30_000;

/**
 * The rest of the focus actions are plain database writes behind one Prisma
 * round-trip. Ten seconds is already pathological for those.
 */
const ACTION_TIMEOUT_MS = 10_000;

/**
 * #181 — how long the playlist tick-list waits before persisting.
 *
 * Matched to `AgingSection`'s auto-save, which is the repo's existing answer to
 * the same question, and for the same reason: ticking three playlists is one
 * decision, and it should cost one write rather than three. Exported so the test
 * advances the real value rather than a copy of it.
 */
export const FOCUS_CATEGORY_SAVE_DEBOUNCE_MS = 600;

/**
 * Which handler failed. Not cosmetic: it decides where the notice renders,
 * which affordances it offers, and what Retry re-runs.
 */
type FailedHandler =
  | "start"
  | "resumeExisting"
  | "togglePause"
  | "complete"
  | "reestimate"
  | "requeue"
  // #198 — putting a step back after an accidental completion. Its own handler
  // because its failure message is the one that cannot say "nothing is lost".
  | "undo"
  // #142 — opening the next single-task to-do. It is a server action too
  // (`ensureFocusStep` creates the to-do's one step on demand), so a chain that
  // failed used to be indistinguishable from a button that does nothing —
  // which is the dead end this issue is about, wearing a different hat.
  | "chain";

type ActionFailure = {
  handler: FailedHandler;
  /**
   * The browser is running a different deployment than the server. Next
   * regenerates server-action ids on every build, so a retry re-posts the same
   * dead id — the ONLY thing that can work is a reload, and offering a retry
   * would be offering something that cannot.
   */
  stale: boolean;
};

/** `run()`'s result — distinguishes "threw" from "returned a falsy value". */
type Outcome<T> = { ok: true; value: T } | { ok: false };

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
  /** #180 — the persisted category selection (Settings.focusSoundCategories).
   * Optional and empty by default: no categories means the whole catalogue,
   * which is what an instance with no reachable catalog plays anyway. */
  categories?: readonly string[] | null;
  /** #68 — persisted playlist shuffle (Settings.focusShuffle). Optional: the
   * column defaults false, so a caller that predates the pref (or a test that
   * doesn't care) simply gets in-order playback. */
  shuffle?: boolean;
  /** #65 — persisted music↔timer pause coupling (Settings.focusPauseTogether).
   * Optional and false by default: omitted means the #43 one-directional
   * behaviour, where pausing the music leaves the countdown running. */
  pauseTogether?: boolean;
};

export type NextStepPeek = {
  id: string;
  text: string;
  subtaskEmoji: string | null;
};

/**
 * #142 — what the REST of the queue has, in effective order (soonest due, then
 * soonest scheduled — see `nextInFocusOrder`), once this task is out of the way.
 * Computed by the page, so the completion screen never has to ask.
 *
 * `null` is a real state and not a missing prop: "there is nothing else" is what
 * sends the user to the dashboard rather than back to an empty list.
 */
export type NextUp =
  /** The next incomplete step of another multi-step task. */
  | {
      kind: "step";
      stepId: string;
      text: string;
      emoji: string | null;
      taskTitle: string;
    }
  /**
   * The next single-task to-do. Carries the BrainDumpItem id, not a step id: a
   * to-do has no step until `ensureFocusStep` creates one, which is exactly how
   * the launcher's ▶ Start works.
   */
  | { kind: "single"; itemId: string; text: string };

/**
 * #137 — which message a failure gets. The stale-deployment case overrides the
 * handler entirely: what the user needs to know is not "the requeue failed" but
 * "your tab is older than the server", because that is what decides whether
 * pressing the button again could ever work.
 */
function failureMessageKey(failure: ActionFailure): StringKey {
  if (failure.stale) return "focus.error.stale";
  switch (failure.handler) {
    case "reestimate":
      return "focus.error.reestimate";
    case "requeue":
      return "focus.error.requeue";
    case "complete":
      return "focus.error.complete";
    case "undo":
      return "focus.error.undo";
    case "chain":
      return "focus.error.chain";
    // start / resumeExisting / togglePause — all "the session couldn't be
    // reached", and the affordance (press it again) is the same for each.
    default:
      return "focus.error.session";
  }
}

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
  nextUp = null,
  isSingleTask,
  taskNote = null,
  stepNote = null,
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
  /** #142 — the rest of the queue, in effective order. Optional so a caller
   * that predates the completion flow (or a test that doesn't care) simply
   * gets the "nothing else" ending. */
  nextUp?: NextUp | null;
  isSingleTask: boolean;
  /** #44 — the task's freeform note, and this step's own. READ-ONLY here: the
   *  issue asks for the jotted context to be present "while you're doing the
   *  work", and the session's whole job is to remove decisions — a live text
   *  field with an autosave is an invitation to edit instead of to work. Every
   *  other surface that renders this task or step can edit it. */
  taskNote?: string | null;
  stepNote?: string | null;
  addTimeIncrementMin: number;
  settings: TimerSettings;
  tipDismissed: boolean;
  existingSession?: ExistingPausedSession | null;
}) {
  const router = useRouter();
  const voice = useVoice();
  const reducedMotion = usePrefersReducedMotion();
  // #142 — read here rather than in the done screen so the hook order is stable
  // across every phase; it is only ever consulted once the step is finished.
  const [hyperFocus, setHyperFocus] = useHyperFocus();
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
  //
  // Duo review (#66) — normalized through the SAME helper the chips use, so the
  // seeded value is always one of the chips on offer. estMinutes/plannedMin are
  // plain Ints with no CHECK bounding them to >= 1, and a 0 row would otherwise
  // preselect nothing and let Start open a 0-minute session.
  const seedMin = normalizeEstMin(
    existingSession?.plannedMin ?? step.estMinutes,
  );
  const [plannedMin, setPlannedMin] = useState(seedMin);
  const [totalSec, setTotalSec] = useState(
    existingSession?.totalSec ?? seedMin * 60,
  );
  const [remainingSec, setRemainingSec] = useState(
    existingSession?.remainingSec ?? seedMin * 60,
  );
  const elapsedRef = useRef(0);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  // #137 — null while nothing has gone wrong. Set by `run()` below (and by the
  // two handlers whose action reports failure through its RETURN value rather
  // than by throwing), cleared when the next attempt starts.
  const [failure, setFailure] = useState<ActionFailure | null>(null);
  const [newEst, setNewEst] = useState(step.estMinutes);
  const [result, setResult] = useState<CompleteResult | null>(null);
  // #198 — set by the done-screen undo so the setup screen it lands on confirms
  // what happened. A phase change is silent to a screen-reader user, and "did
  // that work?" is the whole question in the moment after an accident.
  const [undone, setUndone] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [tipVisible, setTipVisible] = useState(!tipDismissed);
  // #66 — progressive disclosure. While a resumable session exists the setup
  // screen offers ONE choice (Resume); flipping this (the "Start fresh"
  // affordance) is what reveals the duration chips. It's a plain UI toggle, not
  // a commitment: nothing is retired server-side until Start is pressed, so a
  // mis-tap can be undone with "Keep my paused session".
  const [startingFresh, setStartingFresh] = useState(false);
  // The chip group is named by its visible "Focus for" label (no aria-label to
  // drift from it); useId keeps that association collision-free, matching
  // focus-sound-player's popover id.
  const durationLabelId = useId();
  // #138 — same trick for the time-up screen's "Keep going for" row, named by
  // its own visible label so the four bare numbers are not the whole message.
  const keepGoingLabelId = useId();
  // #137 — ties the failure message to the notice's primary action, so the
  // reason is announced with the remedy. See failureNotice below.
  const failureMessageId = useId();
  // #218 — the retry-in-flight line's own id. It exists so the wait can be
  // reachable from the CTA that is still holding focus, which is what replaced
  // the nested live region it used to be. See failureNotice below.
  const retryingMessageId = useId();
  // The setup screen's primary CTA (Resume or Start), focused after a
  // disclosure toggle — see the effect below.
  const setupCtaRef = useRef<HTMLButtonElement | null>(null);
  const disclosureMounted = useRef(false);
  // #65 — the live session's primary control (Pause/Resume, or the time's-up
  // CTA once the clock runs out; the two blocks are mutually exclusive, so only
  // one is ever mounted). Focus lands here when a coupled resume from the
  // mini-player unmounts the button that was pressed — see the effect below.
  const sessionCtaRef = useRef<HTMLButtonElement | null>(null);
  // Why focus needs handing off after the next phase commit, or null for "it
  // doesn't". A reason rather than a boolean (#138) because the two cases want
  // *different* behaviour when the sound player is on screen, and a second
  // boolean ref would have let a third case pick the wrong one silently:
  //
  // - "coupled-transport" (#65): the button pressed was the mini-player's, which
  //   is still mounted when the player stays visible — so stand down, because
  //   moving focus off a control the user is still pointing at is the rudeness
  //   the `showSoundPlayer` guard exists to prevent.
  // - "keep-going" (#138): the button pressed lived in the `timeup` block, which
  //   has just unmounted. Focus has nowhere to be and MUST move, whether or not
  //   the player is showing. `showSoundPlayer` is false during `timeup` and true
  //   once `running` commits, so guarding on it here skipped the hand-off in
  //   exactly the case that needed it (Duo review; WCAG 2.4.3).
  const handoffReasonRef = useRef<"coupled-transport" | "keep-going" | null>(
    null,
  );
  // #137 a11y (WCAG 2.4.3) — the error notice's own primary action (Retry, or
  // Reload when the deployment moved on). Focus lands here when the notice
  // appears, for the same reason the two refs above exist: the transition can
  // unmount the control that was just pressed, and a screen-reader user who is
  // dropped to <body> has no idea a message appeared.
  const failureCtaRef = useRef<HTMLButtonElement | null>(null);
  // #142 — the finished-step screen's deliberate focus landing spot: the
  // celebration + points + streak block, which is the whole reason the phase
  // changed. See the effect below for why it is not the auto-advance panel.
  const doneSummaryRef = useRef<HTMLDivElement | null>(null);
  // #23 — the celebration line is rolled when the step is actually completed
  // (an event), not during render into a ref: an unseeded random draw in render
  // is impure (react-hooks/purity) and reading a ref during render is unsafe
  // (react-hooks/refs) — under the React compiler a render could be repeated or
  // discarded, so a "stable" ref read is not guaranteed stable. The initial
  // value is never shown: `done` is only reachable through finishComplete.
  const [doneMsg, setDoneMsg] = useState(DONE_MESSAGES[0]);

  // Device-effect handles (created on Start inside the user gesture).
  const alarmRef = useRef<Alarm | null>(null);
  const wakeRef = useRef<WakeGuard | null>(null);
  // #43 — the shared lo-fi player (current track / play state / volume). Drives
  // both the Start-gesture autoplay and the embedded mini-player below. The
  // returned object is a new literal each render (its reactive state changes),
  // so we destructure the *stable* callbacks (each is useCallback-memoised inside
  // the hook) to use in this component's effects/handlers — depending on the
  // whole `sound` object would needlessly recreate memoised callbacks.
  // #68 — shuffle is a taste setting: seed the playlist from Settings and write
  // the new value straight back when the mini-player toggles it (fire-and-forget,
  // like the tip dismissal — nothing on screen waits on the round-trip).
  const persistShuffle = useCallback((next: boolean) => {
    void updateFocusShuffle(next);
  }, []);
  /**
   * #180 — the selected categories narrow the pool the hook walks; empty is the
   * whole catalogue. #181 makes them editable from the player, so this is state
   * rather than a straight read of the prop: ONE value drives both the pool the
   * hook resolves and the ticks the panel draws, and a tick has to change what is
   * playing immediately rather than after a round-trip.
   *
   * Seeded from Settings and never re-seeded. The focus route is force-dynamic,
   * so the prop only changes on a fresh load — and a `router.refresh()` from some
   * unrelated action must not reach in and undo a tick that is still in its
   * debounce window.
   */
  const [categories, setCategories] = useState<readonly string[]>(
    settings.categories ?? [],
  );
  const categorySaveRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingCategoriesRef = useRef<string[] | null>(null);
  /** Write the outstanding selection now, if there is one. Idempotent. */
  const flushCategories = useCallback(() => {
    if (categorySaveRef.current) {
      clearTimeout(categorySaveRef.current);
      categorySaveRef.current = null;
    }
    const pending = pendingCategoriesRef.current;
    if (!pending) return;
    pendingCategoriesRef.current = null;
    void updateFocusSoundCategories(pending);
  }, []);
  const changeCategories = useCallback(
    (next: string[]) => {
      setCategories(next);
      pendingCategoriesRef.current = next;
      if (categorySaveRef.current) clearTimeout(categorySaveRef.current);
      categorySaveRef.current = setTimeout(
        flushCategories,
        FOCUS_CATEGORY_SAVE_DEBOUNCE_MS,
      );
    },
    [flushCategories],
  );
  // Flush rather than merely cancel on unmount, which is where this differs from
  // AgingSection's otherwise identical debounce. A settings page is somewhere you
  // linger; the focus timer is somewhere you leave abruptly — Complete, ← Back, a
  // chained next step — and it has no save indicator, so a dropped write would be
  // a tick that silently never happened.
  useEffect(() => flushCategories, [flushCategories]);
  // No opening track is passed, and there is no longer one to pass: `focusSound`
  // is a two-value switch, so every session opens on the head of its pass.
  const sound = useFocusSound({
    categories,
    shuffle: settings.shuffle ?? false,
    onShuffleChange: persistShuffle,
  });
  const { play: playSound, pause: pauseSound, stop: stopSound } = sound;
  const soundOff = settings.sound === FocusSound.Off;
  // #65 — did this workspace opt into the second direction of the coupling?
  const pauseTogether = Boolean(settings.pauseTogether);

  const inc = Math.max(1, addTimeIncrementMin || 5);
  const durationMin = () => Math.max(0, Math.round(elapsedRef.current / 60));
  const net = netAddedMin(totalSec, plannedMin * 60);
  // #151 — the −time button's guard, and the same threshold `applyTimeDelta`
  // caps a removal at. Read from the constant rather than a literal 60 so the
  // two can't drift: this condition is now exactly when that helper is a
  // no-op, so the button is disabled precisely when pressing it would do
  // nothing. Kept as defence in depth even though the helper is safe on its
  // own — a control that silently does nothing is a worse answer than one that
  // says it is unavailable.
  const atFloor = remainingSec <= MIN_REMAINING_SEC;

  const releaseWake = () => {
    wakeRef.current?.release();
    wakeRef.current = null;
  };

  // #23 — every phase change goes through this so that stopping the timer
  // auto-expands the step tracker (calm while running, orienting when stopped).
  // That used to be an effect watching `phase`, which re-rendered the whole
  // timer a second time on each pause / time's-up (react-hooks/
  // set-state-in-effect); doing it at the transition is the same behaviour in
  // one pass, and keeps new transitions honest by construction.
  const goToPhase = useCallback((next: Phase) => {
    if (next === "paused" || next === "timeup") setExpanded(true);
    setPhase(next);
  }, []);

  // Countdown ticker.
  useEffect(() => {
    if (phase !== "running") return;
    const id = setInterval(() => {
      elapsedRef.current += 1;
      setRemainingSec((r) => {
        if (r <= 1) {
          clearInterval(id);
          goToPhase("timeup");
          return 0;
        }
        return r - 1;
      });
    }, 1000);
    return () => clearInterval(id);
  }, [phase, goToPhase]);

  // Focus sound + wake lock follow the "running" phase: the lo-fi pauses and
  // resumes WITH the timer (owner decision). The first play() happens in the
  // Start gesture (start()) to unlock autoplay; this effect keeps the audio in
  // lockstep on pause↔resume (and any other transition out of "running" pauses
  // it). Session end / unmount still fully stop it (finishComplete / cleanup).
  // No-op when sound is off. The mini-player reflects the paused state via the
  // hook's `playing` flag, which pause()/play() here keep truthful.
  //
  // #65 — this stays the ONLY thing that pauses/resumes the audio during a
  // session, in both coupling modes: the opt-in second direction routes the
  // mini-player's press through togglePause() (→ phase → here), so the two can
  // never end up disagreeing about who is paused.
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

  /**
   * #137 — every focus server action goes through here.
   *
   * Three handlers (`finishComplete`, `startReestimate`, `confirmRequeue`) had
   * the identical unguarded shape: `setPending(true)`, `await`, `setPending
   * (false)`. A rejection skipped the third line, so `pending` stayed true and
   * the UI silently stopped responding while *looking* like it was working —
   * which is worse than an error, because it gives no reason to try anything
   * else. It stranded the owner at the worst possible moment: the alarm had
   * gone off, they were mid-decision, and the only way out was a reload that
   * lost their place.
   *
   * Three properties, all load-bearing:
   *
   *  - `setPending(false)` lives in a `finally`, so **no path can leave the UI
   *    pending** — including one added later by someone who hasn't read this.
   *  - the call is bounded by `withActionTimeout`, because silence is a third
   *    failure mode alongside "resolved" and "rejected", and an un-timed-out
   *    `await` on a hung request reproduces the original bug exactly.
   *  - the returned `Outcome` distinguishes "threw" from "returned falsy", so a
   *    caller can tell a real failure from `beginFocus` legitimately answering
   *    `null`.
   */
  const run = useCallback(
    async <T,>(
      handler: FailedHandler,
      call: () => Promise<T>,
      timeoutMs: number = ACTION_TIMEOUT_MS,
    ): Promise<Outcome<T>> => {
      setPending(true);
      try {
        const value = await withActionTimeout(call(), timeoutMs);
        // Cleared on SUCCESS rather than up front (Duo review round 6): wiping
        // it before the call unmounted the notice — and the Retry button inside
        // it that the user had just pressed — dropping focus to <body> for the
        // whole round trip (WCAG 2.4.3). The notice stays put and reports the
        // attempt instead.
        setFailure(null);
        return { ok: true, value };
      } catch (error) {
        setFailure({ handler, stale: isStaleActionError(error) });
        return { ok: false };
      } finally {
        setPending(false);
      }
    },
    [],
  );

  const start = async () => {
    // #198 — a new attempt on this step is no longer "just put back". Clearing it
    // here rather than only gating the render keeps the state honest for anything
    // that reads it later.
    setUndone(false);
    const outcome = await run("start", () => beginFocus(step.id, plannedMin));
    if (!outcome.ok) return;
    const id = outcome.value;
    if (!id) {
      // #139's shape, one function above the case that exposed it (review round
      // 5). `beginFocus` answers `null` when the step is not in the resolved
      // workspace, and discarding that left Start visibly doing nothing — the
      // dead end #139 is about. `stale: false`: a returned value proves the
      // action was found and ran, so pressing again can legitimately work.
      setFailure({ handler: "start", stale: false });
      return;
    }
    // Prime device effects inside the user gesture (unlocks audio playback).
    if (settings.alarmEnabled) alarmRef.current = createAlarm();
    if (!soundOff) playSound();
    setSessionId(id);
    setTotalSec(plannedMin * 60);
    setRemainingSec(plannedMin * 60);
    elapsedRef.current = 0;
    goToPhase("running");
  };

  // #27 — setup-screen "Resume" CTA: reuses the existing paused session (no
  // new FocusSession row) and restores its frozen remaining time. Device
  // effects are primed here too — this is the user gesture that (re)starts
  // the countdown, same as start().
  const resumeExisting = async () => {
    if (!existingSession) return;
    // #198 — same reason as `start()`: resuming is a new attempt, not a state of
    // having just undone something.
    setUndone(false);
    const outcome = await run("resumeExisting", () =>
      resumeFocus(existingSession.id),
    );
    if (!outcome.ok) return;
    const res = outcome.value;
    if (!res.ok) {
      // #139's shape, and the case that made it matter (review round 5).
      // `resumeFocus` filters on `endedAt: null`, so it refuses a session that has
      // been closed — and discarding that answer left this button doing nothing at
      // all: no notice, no phase change, nothing announced. Verbatim the defect
      // #139 named on `confirmRequeue`, "indistinguishable from a successful one".
      //
      // The commonest cause is now prevented rather than explained: a spent
      // `existingSession` is no longer offered at all (see `resumable` below), so
      // what reaches here is a genuine refusal — another device closed the row, or
      // it turns out not to be paused — which a retry can legitimately answer.
      // `stale: false` for the reason `confirmRequeue` records: a returned
      // `ok: false` proves the action was found and ran, so its id is live.
      //
      // Staying in `setup` is the fail-safe direction, matching `togglePause`: do
      // not advance to a running session the server does not have.
      setFailure({ handler: "resumeExisting", stale: false });
      return;
    }
    if (settings.alarmEnabled) alarmRef.current = createAlarm();
    if (!soundOff) playSound();
    setSessionId(existingSession.id);
    setPlannedMin(res.plannedMin);
    setTotalSec(res.totalSec);
    setRemainingSec(res.remainingSec);
    elapsedRef.current = Math.max(0, res.totalSec - res.remainingSec);
    goToPhase(res.remainingSec <= 0 ? "timeup" : "running");
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
  //
  // #65 — memoised because togglePauseFromPlayer (below) is handed to the
  // mini-player, and a useCallback whose own dependency is recreated on every
  // render would be theatre: it would be invalidated by the per-second tick
  // anyway. The deps are everything this reads — none of which changes on a
  // tick (`remainingSec` is not read here, and elapsedRef is a ref), so the
  // identity is genuinely stable while the countdown runs.
  const togglePause = useCallback(async () => {
    if (phase === "running") {
      if (!sessionId) {
        goToPhase("paused");
        return;
      }
      const outcome = await run("togglePause", () =>
        pauseFocus(sessionId, { totalSec }),
      );
      if (!outcome.ok) return; // #137 — threw; the notice says so, stay running
      if (!outcome.value.ok) return; // server disagrees — stay running, don't show a paused state it doesn't have
      goToPhase("paused");
      return;
    }
    if (phase !== "paused" || !sessionId) return;
    const outcome = await run("togglePause", () => resumeFocus(sessionId));
    // #137 — a THROW is not the same as a server "no". The `!res.ok` fail-safe
    // below reconciles to "running" because the server has told us the session
    // is not paused; a rejection tells us nothing about the session at all, so
    // claiming it resumed would be inventing state. Stay paused, show the
    // notice, let Retry re-ask.
    if (!outcome.ok) return;
    const res = outcome.value;
    if (!res.ok) {
      goToPhase("running");
      return;
    }
    setRemainingSec(res.remainingSec);
    elapsedRef.current = Math.max(0, res.totalSec - res.remainingSec);
    goToPhase(res.remainingSec <= 0 ? "timeup" : "running");
  }, [phase, sessionId, totalSec, goToPhase, run]);

  /**
   * #65 — the mini-player's transport press, WHEN this workspace opted into the
   * pause coupling. It drives the session, not the audio: togglePause() persists
   * the pause/resume and the phase effect above is what then pauses/resumes the
   * music. Going through the session (rather than pausing both by hand) is what
   * keeps the two from disagreeing, and keeps #43's promise that the track
   * resumes from where it stopped.
   *
   * Deliberately the ONLY audio-side event wired to the timer: a track ending,
   * an autoplay block, an interrupted element or a volume change never reach
   * here. Those are things the audio does, not things the user asked of their
   * focus session — and the element's own `pause` event can't tell them apart
   * from the pauses this timer itself issues, which would feed back on itself.
   *
   * Memoised (Duo review): it is the one handler this component hands to a
   * child, so its identity is part of that child's props. Nothing re-renders
   * needlessly today — FocusSoundPlayer is not React.memo-wrapped, so it
   * re-renders with its parent regardless — but that makes a future memo() on
   * the player a trap, where a handler rebuilt on every countdown tick would
   * silently defeat it. Stable now, and stable if that changes.
   */
  const togglePauseFromPlayer = useCallback(async () => {
    // A coupled RESUME can unmount the player (minimal mode hides it while
    // running; a resume landing on time's-up hides it outright), so flag the
    // focus hand-off before the phase moves. A coupled pause keeps it mounted.
    //
    // The `sessionId` half matters (Duo review): arm this ONLY when togglePause
    // is certain to move the phase, because the effect that disarms it is keyed
    // on `phase`. Every other route out of a paused session changes phase — a
    // rejected resume falls back to "running", a successful one lands on
    // running/timeup — but `phase === "paused"` with no session id returns
    // immediately, which would leave the flag armed for the next, unrelated
    // transition to consume as a focus jump the user never asked for.
    //
    // NOT done by resetting the flag after the await: `goToPhase` inside
    // togglePause schedules a React update, so the disarm would win the race
    // against the commit and the hand-off would silently stop happening. That
    // exact suggestion was tried and it fails the minimal-mode focus test.
    handoffReasonRef.current =
      phase === "paused" && sessionId != null ? "coupled-transport" : null;
    await togglePause();
  }, [phase, sessionId, togglePause]);

  const changeTime = (mins: number) => {
    const next = applyTimeDelta({ totalSec, remainingSec }, mins * 60);
    setTotalSec(next.totalSec);
    setRemainingSec(next.remainingSec);
    if (phase === "timeup" && mins > 0) {
      // #138 a11y (WCAG 2.4.3) — this transition unmounts the whole time-up
      // block, including the keep-going button that was just pressed, so focus
      // would land on <body>. The effect below moves it to sessionCtaRef, which
      // in the running block is the Pause control. Armed only on THIS branch —
      // the running screen's ±5 buttons also call changeTime and they stay
      // mounted, so hijacking focus there would yank it off the button the user
      // is still tapping.
      //
      // Tagged "keep-going" rather than reusing #65's reason (Duo review): #65
      // stands down while the sound player is visible, and here that guard is
      // actively wrong — showSoundPlayer is false during `timeup` and true once
      // `running` commits, so it suppressed the hand-off precisely when the
      // pressed button had gone.
      handoffReasonRef.current = "keep-going";
      goToPhase("running");
    }
  };

  const finishComplete = useCallback(async () => {
    if (!sessionId) return;
    const outcome = await run("complete", () =>
      completeFocus(sessionId, {
        durationMin: durationMin(),
        addedMin: Math.max(0, net),
      }),
    );
    if (!outcome.ok) return;
    const res = outcome.value;
    // #139's sibling on the completion path: `completeFocus` answers
    // `ok: false` when the session isn't this workspace's, or has vanished.
    // Celebrating a session the server refused to close is the same lie the
    // requeue screen was telling — and it would show "+0 points" while doing
    // it. The session stays on screen so the CTA can be pressed again.
    if (!res.ok) {
      // `stale: false` is not a default — it is known. The action RETURNED,
      // which means the browser's action id was recognised and the server ran
      // it; deploy skew can only ever surface as a rejection, never as a
      // well-formed `ok: false`. Offering a reload here would be wrong advice.
      setFailure({ handler: "complete", stale: false });
      return;
    }
    setResult(res);
    stopSound();
    releaseWake();
    setDoneMsg(pickOne(DONE_MESSAGES));
    goToPhase("done");
    router.refresh();
  }, [sessionId, net, router, stopSound, goToPhase, run]);

  /**
   * #198 — put the step back after an accidental completion.
   *
   * Offered on the done screen because that is where the mistake #197 produced
   * actually happens: before this, the only un-complete route in the app was
   * `reopenItem` from the inbox Done view, which a step inside a still-open task
   * never reaches. An undo two screens away from the error is not a recovery path.
   *
   * Returning to `setup` is doing real work, not just tidying the view: it
   * unmounts the done block and with it `AutoAdvance`, whose five-second
   * countdown would otherwise keep running and navigate away from the very step
   * the user has just rescued. Leaving the closed FocusSession closed is also
   * deliberate — the session genuinely ran, and the claim being corrected is
   * "this step is finished", not "that time never happened".
   */
  const undoComplete = useCallback(async () => {
    const outcome = await run("undo", () => uncompleteStep(step.id));
    if (!outcome.ok) return;
    setResult(null);
    setUndone(true);
    goToPhase("setup");
    router.refresh();
  }, [goToPhase, router, run, step.id]);

  const startReestimate = useCallback(async () => {
    goToPhase("reestimate");
    const outcome = await run(
      "reestimate",
      () => proposeNewEstimate(step.id),
      // The one call in this component that waits on an LLM.
      REESTIMATE_TIMEOUT_MS,
    );
    if (!outcome.ok) return;
    setNewEst(outcome.value);
  }, [goToPhase, run, step.id]);

  const confirmRequeue = useCallback(async () => {
    if (!sessionId) return;
    const outcome = await run("requeue", () =>
      requeueFocus(sessionId, {
        durationMin: durationMin(),
        addedMin: Math.max(0, net),
        newEstMinutes: newEst,
      }),
    );
    if (!outcome.ok) return;
    // #139 — this return value used to be discarded entirely, so all four of
    // `requeueFocus`'s guard failures (session not found, no step, and the two
    // ownership checks) landed the user on the "🌱 bumped to N min" success
    // screen. A failed requeue was indistinguishable from a successful one.
    if (!outcome.value.ok) {
      // Known-not-stale for the same reason as `finishComplete` above: a
      // returned `ok: false` proves the action was found and ran.
      setFailure({ handler: "requeue", stale: false });
      return;
    }
    stopSound();
    releaseWake();
    goToPhase("requeued");
    // #139 — the client half of the staleness. The server now revalidates `/`,
    // but the router also holds its own cache of the page this session came
    // from; `finishComplete` has always refreshed and this path never did, so
    // the two omissions compounded instead of covering for each other.
    router.refresh();
  }, [sessionId, net, newEst, router, stopSound, goToPhase, run]);

  /**
   * #137 — re-run whatever failed. Dispatching on the recorded handler (rather
   * than storing a closure in state) keeps the retry honest: it re-reads the
   * live `sessionId` / `newEst` at press time instead of replaying whatever
   * they were when the failure happened.
   *
   * Never reachable for a stale-deployment failure — that notice offers a
   * reload instead, because the retry would post the same dead action id.
   */
  const retryFailed = () => {
    // A `Record<FailedHandler, …>` rather than a switch, so adding a handler to
    // the union without giving it a retry is a TYPE error rather than a Retry
    // button that silently does nothing — which would be this MR's own bug,
    // reintroduced in the button that exists to fix it.
    const retry: Record<FailedHandler, () => void> = {
      start: () => void start(),
      resumeExisting: () => void resumeExisting(),
      togglePause: () => void togglePause(),
      complete: () => void finishComplete(),
      // #198 — retrying an undo is both safe and effective, and it took review
      // round 4 to make the second half true. `uncompleteStep` is atomic, so a
      // failure rolled every one of its writes back and the retry re-runs the
      // whole undo, reward reversal included. Safe for the reason this comment
      // always gave: an undo that DID succeed leaves a step that is already not
      // done, which the action's own guard no-ops on, so nothing can be reversed
      // or reopened twice. Before that fix only the safety held — a retry after a
      // partial failure hit the same guard and silently did nothing at all.
      undo: () => void undoComplete(),
      reestimate: () => void startReestimate(),
      requeue: () => void confirmRequeue(),
      chain: () => void startSingle(),
    };
    if (failure) retry[failure.handler]();
  };

  /**
   * #137 — "Skip — pick a time myself". Clearing the failure while the phase
   * stays `reestimate` reveals the number field seeded with the step's own
   * estimate, so a re-estimate Claude could not produce still ends in a
   * requeue rather than a dead end.
   */
  const skipReestimate = () => setFailure(null);

  /**
   * #142 — where the auto-advance goes at the end of the countdown.
   *
   * A plain route push, deliberately: `/focus/[stepId]` opens in the `setup`
   * phase, so the user lands on the next step's start screen with its own
   * Start button rather than mid-countdown on work they have not agreed to.
   */
  const goToNextStep = useCallback(() => {
    if (nextStep) router.push(`/focus/${nextStep.id}`);
  }, [nextStep, router]);

  /**
   * #142 — open the next single-task to-do.
   *
   * A to-do has no Step until one is created for it, so this goes through
   * `ensureFocusStep` exactly as the launcher's ▶ Start does, rather than
   * guessing a URL. Routed through `run()` like every other server call in this
   * component: an `ensureFocusStep` that rejects, hangs or answers `null` would
   * otherwise leave a button that visibly does nothing — which is the dead end
   * this issue is about, reintroduced inside its own fix.
   */
  const startSingle = useCallback(async () => {
    if (nextUp?.kind !== "single") return;
    const outcome = await run("chain", () => ensureFocusStep(nextUp.itemId));
    if (!outcome.ok) return;
    const stepId = outcome.value;
    // `null` means the action ran and could not produce a step (the item was
    // archived or completed from another tab). It is a failure the user must
    // see, not a silent no-op — and it is known-not-stale for the same reason
    // finishComplete's `ok: false` is: the action RETURNED.
    if (!stepId) {
      setFailure({ handler: "chain", stale: false });
      return;
    }
    router.push(`/focus/${stepId}`);
  }, [nextUp, router, run]);

  /** #142 — stable identity for the countdown's `onAdvance`. An inline arrow
   * would hand AutoAdvance a new callback on every render, invalidating the
   * memoised `advance` it guards its fire-once behaviour with. It is guarded by
   * a ref too, so this is tidiness rather than a fix — but it keeps that ref
   * from being the only thing standing between a re-render and a double
   * navigation. */
  const advanceSingle = useCallback(() => void startSingle(), [startSingle]);

  /** #142 — the empty-multi-step-queue offer: turn the mode on AND act on it,
   * because the button's own sentence ("work through the single-task to-dos?")
   * promises both and splitting them would cost a second tap for one decision. */
  const acceptHyperFocus = useCallback(() => {
    setHyperFocus(true);
    void startSingle();
  }, [setHyperFocus, startSingle]);

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
  // #65 a11y (WCAG 2.4.3) — pressing the mini-player's coupled transport can
  // unmount that very button (minimal mode hides the player again the moment the
  // timer is running), which would drop a keyboard/screen-reader user's focus to
  // <body> mid-session. Hand it to whichever session control is now primary,
  // exactly as the #66 setup disclosure does. Declared here because it reads
  // showSoundPlayer — the post-transition value, since effects run after commit
  // — so there is no second copy of that condition to drift. Unconditional and
  // above every early return, so hook order is stable.
  useEffect(() => {
    const reason = handoffReasonRef.current;
    if (!reason) return;
    handoffReasonRef.current = null;
    // #137 — a failed coupled press does not change the phase, so this effect
    // would not otherwise re-run and the flag would stay armed for the next,
    // unrelated transition to consume. Disarm above this line, then stand
    // down: the error notice has taken focus, and yanking it back to the
    // session control would bounce a screen-reader user away from the message
    // that just appeared.
    if (failure) return;
    // See handoffReasonRef: only the coupled-transport case defers to a visible
    // sound player. A keep-going tap always hands off, because the button it was
    // made on no longer exists.
    if (reason === "keep-going" || !showSoundPlayer) {
      sessionCtaRef.current?.focus();
    }
  }, [phase, showSoundPlayer, failure]);

  // #137 a11y (WCAG 2.4.3) — when the notice appears, put focus on the one
  // thing that can move the user forward. Same precedent as the #66 setup
  // disclosure and the #65 coupled transport above: a transition that unmounts
  // (or disables) the control that was pressed must hand focus somewhere
  // sensible rather than dropping it to <body>. `role="alert"` announces the
  // text; this makes the remedy reachable without hunting for it.
  useEffect(() => {
    if (failure) failureCtaRef.current?.focus();
  }, [failure]);

  // #142 a11y (WCAG 2.4.3) — the `done` phase replaces the entire screen,
  // including the Complete button that was just pressed, so focus would drop to
  // <body> at the one moment there is something to say. It goes to the outcome
  // summary rather than to the auto-advance panel on purpose: focusing a control
  // inside the panel would HOLD its countdown (see AutoAdvance), so the feature
  // would never fire for anyone. Reading the result first and hearing the
  // pending navigation second is also the right order — the polite live region
  // in the panel follows on behind.
  useEffect(() => {
    if (phase === "done") doneSummaryRef.current?.focus();
  }, [phase]);

  // #198 a11y (WCAG 2.4.3) — the mirror image of the effect above, for the way
  // back. An undo returns to `setup`, which unmounts the whole `done` block
  // including the "Actually, I hadn't finished" button that was just pressed, so
  // focus fell to <body> at the precise moment the user had corrected a mistake
  // and most needed to know where they were. It goes to whichever setup CTA is now
  // primary — the same landing spot the #66 disclosure effect uses, and it works
  // for either of `setupCtaRef`'s two mutually-exclusive call sites because only
  // one is ever mounted.
  //
  // Gated on `undone`, which is the state the notice is ALREADY gated on, so the
  // announcement and the hand-off cannot disagree about whether an undo happened.
  // That gate is also what stops it stealing focus on first render or on an
  // ordinary arrival at `setup` — opening /focus/[stepId] normally, where nothing
  // was pressed and nothing unmounted, and moving focus would be the rudeness the
  // hand-off exists to prevent. `undone` is reset when a session begins, so it
  // cannot re-fire later either.
  //
  // No conflict with the #66 effect: that one fires on `startingFresh`, which an
  // undo does not touch, and these deps do not change when the disclosure is
  // toggled — so each transition is handled exactly once, by one of them.
  //
  // Focusing does not disturb the notice. It is a sibling <p role="status">, not
  // an ancestor of the CTA, so the polite announcement queues behind the button's
  // own rather than being suppressed or repeated — the same coexistence the
  // done-summary focus has with the auto-advance panel's live region.
  useEffect(() => {
    if (undone && phase === "setup") setupCtaRef.current?.focus();
  }, [undone, phase]);

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
  //
  // A live `sessionId` retires it as well (review round 5). `existingSession` is a
  // PROP: it keeps describing the row the page loaded long after that row has been
  // closed, and it is only replaced when `router.refresh()` lands. Both routes out
  // of this screen close it — `resumeExisting` adopts the row and `finishComplete`
  // ends it, while `beginFocus` retires any open session on the step before
  // creating its own — so once this component holds a `sessionId`, the prop is
  // spent and `resumeFocus` can only refuse it. Offering "Resume · ~Xm left" for
  // it was a control the app already knew was dead, which is the same thing the
  // `stale` flag refuses to do by never offering Retry it cannot honour.
  //
  // In practice this only bites after an undo, since `goToPhase("setup")` has
  // exactly one call site (`undoComplete`) and `sessionId` is never cleared. That
  // is an invariant, not a coincidence: a NEW transition back to `setup` while a
  // session is still open would need this gate revisited, or it would hide a
  // legitimate offer. Kept separate from `startingFresh` deliberately — that flag
  // means "the user asked for a fresh one", this means "the server row is spent",
  // and collapsing them would reopen whichever question it dropped.
  const resumable =
    startingFresh || sessionId !== null ? null : existingSession;
  // Review round 14 — the toggle back out of the start-fresh disclosure may only
  // appear when pressing it would actually change something. It was gated on the
  // raw `existingSession` prop, which survives an undo, while `resumable` does not:
  // once `sessionId !== null` the session is spent, so clearing `startingFresh`
  // leaves `resumable` null and the press does NOTHING. A control the app knows is
  // dead — the #139 class the rest of this MR exists to remove, reintroduced by the
  // gate two lines up. Derived from the same inputs as `resumable` so the two
  // cannot drift.
  const canKeepPaused = Boolean(existingSession) && sessionId === null;
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

  // #137 — the reestimate phase has FOUR states, not two, and naming them once
  // here keeps the JSX below from re-deriving them:
  //
  //   waiting        pending, nothing failed yet  → "Claude is re-estimating…"
  //   ready          the estimate arrived         → the number field
  //   estimate failed                            → the notice alone (there is
  //                                                no estimate to edit)
  //   requeue failed                             → the field AND the notice —
  //                                                the number in it is the
  //                                                user's own, and a retry must
  //                                                not throw it away
  //
  // The field also survives a retry of a failed requeue (`pending` with a
  // `requeue` failure), which is why this is not simply `!pending && !failure`.
  const showEstimateField =
    failure?.handler === "requeue" || (!pending && !failure);

  // ── #137: the failure notice ───────────────────────────────────────────────
  // One notice, rendered wherever the user currently is (inside the reestimate
  // block for that phase, under the controls everywhere else), so the message
  // and its remedies are written once.
  //
  // a11y: `role="alert"` announces it the moment it mounts, and the effect
  // above then puts focus on its primary action. Doing both risks a screen
  // reader cutting the alert short as focus moves, so the primary action also
  // carries `aria-describedby` — whichever announcement wins, the user hears
  // the reason along with the remedy. The icon is decorative and the state is
  // carried by the text, never by the red alone (WCAG 1.4.1);
  // `text-destructive` on --background/--card is the token globals.css
  // documents as AA in both themes (5.2:1+); every control is a ≥44px target.
  //
  // #218 — while a retry runs, the description also picks up the wait, so the
  // reason AND the fact that something is happening are both reachable from the
  // one control focus is deliberately parked on. Derived once and applied to
  // BOTH branches of the CTA below rather than written out twice: the stale
  // branch's Reload does not set `pending` itself, but a stale failure arriving
  // while a request is already in flight would otherwise be the one path where
  // the wait is on screen and described by nothing. Retracts on its own when
  // `pending` clears, so the button cannot go on claiming a retry is running.
  const ctaDescribedBy = pending
    ? `${failureMessageId} ${retryingMessageId}`
    : failureMessageId;
  const failureNotice = failure ? (
    <div
      role="alert"
      className="border-destructive/40 bg-destructive/5 mx-auto flex max-w-md flex-col items-center gap-2 rounded-md border p-3"
    >
      <p
        id={failureMessageId}
        className="text-destructive flex items-start gap-1.5 text-sm font-medium"
      >
        <TriangleAlert aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
        <span>{t(failureMessageKey(failure), voice)}</span>
      </p>
      {/* #218 — deliberately NOT `role="status"`, which is what this was. A
          polite live region nested inside the assertive one above has no defined
          announcement behaviour: `aria-live` on the container applies to its whole
          subtree, so whether this text is read politely, assertively, twice or
          not at all is down to the screen reader. Deleting it was not an option
          either — #137's point stands, the wait must not be silent.
          It rides the two mechanisms that ARE defined instead, and both are
          already available precisely because the CTA below is `aria-disabled`
          rather than `disabled` and therefore still holds focus: that button's
          own state change, which a screen reader reports because focus is on it,
          and its `aria-describedby`, which picks this node up while it shows.
          Sighted users see the identical text in the identical place.
          Same shape as the capture notice in `inbox-view.tsx` after !290. */}
      {pending && (
        <p id={retryingMessageId} className="text-muted-foreground text-xs">
          {t("focus.error.retrying", voice)}
        </p>
      )}
      <div className="flex flex-wrap justify-center gap-2">
        {failure.stale ? (
          // Retrying re-posts the same action id the running deployment has
          // already forgotten, so a reload is the ONLY thing on offer here.
          <button
            ref={failureCtaRef}
            type="button"
            aria-describedby={ctaDescribedBy}
            onClick={() => window.location.reload()}
            className="bg-primary text-primary-foreground inline-flex min-h-[44px] items-center gap-1.5 rounded-md px-4 font-medium"
          >
            <RefreshCw aria-hidden="true" className="h-4 w-4 shrink-0" />
            {t("focus.error.reload", voice)}
          </button>
        ) : (
          // `aria-disabled`, not `disabled`: a disabled element cannot hold
          // focus, so the browser would drop it to <body> the moment the retry
          // starts — the very thing keeping the notice mounted is here to
          // prevent. The press is guarded in the handler instead, so a
          // double-tap still cannot fire two requests.
          <button
            ref={failureCtaRef}
            type="button"
            aria-describedby={ctaDescribedBy}
            aria-disabled={pending}
            onClick={() => {
              if (!pending) retryFailed();
            }}
            className="bg-primary text-primary-foreground inline-flex min-h-[44px] items-center gap-1.5 rounded-md px-4 font-medium aria-disabled:opacity-50"
          >
            <RotateCcw aria-hidden="true" className="h-4 w-4 shrink-0" />
            {t("focus.error.retry", voice)}
          </button>
        )}
        {/* The escape hatch from a failed re-estimate — but NOT when the
            deployment moved on. Skipping only reveals the number field; the
            Requeue behind it is another server action, which would post
            another dead id and fail the same way. Offering it there would be
            walking the user into a second dead end, which is the opposite of
            what detecting the stale case is for. */}
        {phase === "reestimate" &&
          failure.handler === "reestimate" &&
          !failure.stale && (
            <button
              type="button"
              onClick={skipReestimate}
              className="hover:bg-accent inline-flex min-h-[44px] items-center rounded-md border px-4 font-medium"
            >
              {t("focus.error.pickTime", voice)}
            </button>
          )}
      </div>
    </div>
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

      {/* #44 — the context you jotted, where you actually need it. Both grains,
          task first, matching the order `buildScheduleNote` composes them into
          a calendar entry, so the same note reads the same way wherever it
          surfaces. Deduped: on a single-task focus the two can be the same
          string, and printing it twice reads as a bug. */}
      {[taskNote?.trim(), stepNote?.trim()]
        .filter((n, i, all): n is string => Boolean(n) && all.indexOf(n) === i)
        .map((n) => (
          <div key={n} className="mt-2">
            <NoteText>{n}</NoteText>
          </div>
        ))}
    </div>
  );

  // #142 — which of the seven endings the finished screen shows. Derived here
  // rather than in the JSX below: the decision is the interesting part and it is
  // unit-tested on its own (focus-next.test.ts), while the render is just the
  // seven shapes it can take.
  const ending = chooseEnding({
    hasNextStep: nextStep != null,
    nextUpKind: nextUp?.kind ?? null,
    isSingleTask,
    hyperFocus,
  });

  // ── End screens ────────────────────────────────────────────────────────────
  if (phase === "done") {
    return (
      <div className="space-y-5 text-center">
        {stepHeading}
        {/* #142 — one focusable block, not five loose paragraphs: focus lands
            here on the phase change (see the effect above) and a screen-reader
            user hears the whole outcome — message, points, streak — as one
            unit, before the auto-advance announcement follows. tabIndex={-1}
            keeps it out of the tab order; it is a target, not a stop. The UA
            outline is deliberately NOT suppressed (a11y-class-hygiene Rule D /
            WCAG 2.4.11): a visible ring around what just changed is correct. */}
        <div
          ref={doneSummaryRef}
          tabIndex={-1}
          data-testid="focus-done-summary"
          className="space-y-3"
        >
          <div className="flex justify-center pt-6">
            <Celebration />
          </div>
          <div aria-hidden="true" className="text-6xl">
            🎉
          </div>
          <p className="text-lg font-medium">{doneMsg}</p>
          {result && (
            <p className="text-muted-foreground text-sm">
              +{result.points} points
              {result.googleSynced
                ? " · marked complete in Google Tasks ✅"
                : ""}
            </p>
          )}
          {result?.streak ? (
            <p className="text-sm font-medium text-amber-700 dark:text-amber-400">
              {result.freshStart
                ? "🌱 Fresh start — day 1 again, and that's completely okay."
                : `🔥 ${result.streak}-day streak!`}
            </p>
          ) : null}
        </div>
        <div className="flex flex-col items-center gap-3">
          {/* #142 — what used to be `nextStep ? <link> : "that was the last
              step 🏁"`, i.e. a dead end for every single-task to-do and for the
              end of every task. `chooseEnding` picks one of seven, and it lives
              in focus-next.ts because seven branches over four inputs written
              inline as `&&`s is precisely how the dead end got there. */}
          {ending.kind === "advance-step" && nextStep && (
            // Moves on by itself after five seconds, onto the next step's SETUP
            // screen (a plain route push — nothing starts a timer there), with
            // an escape announced before it is needed. Ungated by hyper focus
            // mode: inside a task the sequence is already agreed.
            <AutoAdvance
              label={t("focus.advance.nextStep", voice)}
              targetText={nextStep.text}
              targetEmoji={nextStep.subtaskEmoji}
              voice={voice}
              reducedMotion={reducedMotion}
              onAdvance={goToNextStep}
            />
          )}

          {ending.kind === "advance-single" && nextUp?.kind === "single" && (
            <AutoAdvance
              label={t("focus.advance.nextTodo", voice)}
              targetText={nextUp.text}
              voice={voice}
              reducedMotion={reducedMotion}
              onAdvance={advanceSingle}
            />
          )}

          {/* The way out of the countdown itself. "Stay here" stops the clock
              but leaves you on a finished step, so without this the escape
              would trade one dead end for another — the exact shape of the bug
              #142 is about. Quiet, because moving on is the primary answer. */}
          {(ending.kind === "advance-step" ||
            ending.kind === "advance-single") && (
            <Link
              href="/focus"
              className="text-muted-foreground inline-flex min-h-[44px] items-center text-sm hover:underline"
            >
              {t("focus.done.doneForNow", voice)}
            </Link>
          )}

          {/* The end of a WHOLE task. Never a countdown, whatever the mode
              says: this finish is a bigger deal than finishing a step and
              deserves a real pause. It just must not be a dead end. */}
          {ending.kind !== "advance-step" &&
            ending.kind !== "advance-single" && (
              <>
                <p className="text-lg font-medium">
                  {t(
                    isSingleTask
                      ? "focus.done.singleComplete"
                      : "focus.done.taskComplete",
                    voice,
                  )}
                </p>

                {ending.kind === "offer-task" && nextUp?.kind === "step" && (
                  <>
                    <Link
                      href={`/focus/${nextUp.stepId}`}
                      className="bg-primary text-primary-foreground inline-flex min-h-[44px] items-center gap-1.5 rounded-md px-4 font-medium"
                    >
                      <Play aria-hidden="true" className="h-4 w-4 shrink-0" />
                      {t("focus.nextStep", voice)}
                    </Link>
                    {/* Which task, and which step of it — an unnamed "next" is
                      just another thing to open before you know what it is. */}
                    <p className="text-muted-foreground text-sm">
                      {nextUp.taskTitle}
                    </p>
                    <p className="text-sm">
                      {nextUp.emoji ? `${nextUp.emoji} ` : ""}
                      {nextUp.text}
                    </p>
                  </>
                )}

                {ending.kind === "offer-single" &&
                  nextUp?.kind === "single" && (
                    <>
                      <button
                        type="button"
                        onClick={() => void startSingle()}
                        disabled={pending}
                        className="bg-primary text-primary-foreground inline-flex min-h-[44px] items-center gap-1.5 rounded-md px-4 font-medium disabled:opacity-50"
                      >
                        <Play aria-hidden="true" className="h-4 w-4 shrink-0" />
                        {t("focus.advance.nextTodo", voice)}
                      </button>
                      <p className="text-sm">{nextUp.text}</p>
                    </>
                  )}

                {ending.kind === "offer-hyper" && nextUp?.kind === "single" && (
                  <>
                    <p className="text-muted-foreground text-sm">
                      {t("focus.done.queueEmpty", voice)}
                    </p>
                    <button
                      type="button"
                      onClick={acceptHyperFocus}
                      disabled={pending}
                      className="bg-primary text-primary-foreground inline-flex min-h-[44px] items-center gap-1.5 rounded-md px-4 font-medium disabled:opacity-50"
                    >
                      <Zap aria-hidden="true" className="h-4 w-4 shrink-0" />
                      {t("focus.hyper.turnOn", voice)}
                    </button>
                    <p className="text-sm">{nextUp.text}</p>
                  </>
                )}

                {ending.kind === "nothing-left" && (
                  <>
                    <p className="text-muted-foreground text-sm">
                      {t("focus.done.allClear", voice)}
                    </p>
                    {/* The dashboard, not the inbox or the library: it is the only
                      one of the three that treats an empty queue as an
                      ACHIEVEMENT rather than a state needing correction. The
                      inbox is the fullest screen in the app, and landing on a
                      pile straight after clearing your queue swaps the reward
                      for a demand. The daily spark is already rendered there,
                      and the "find something else" link beside it keeps the
                      page from being a cul-de-sac. */}
                    <Link
                      href="/dashboard"
                      className="bg-primary text-primary-foreground inline-flex min-h-[44px] items-center rounded-md px-4 font-medium"
                    >
                      {t("focus.done.seeYourDay", voice)}
                    </Link>
                  </>
                )}

                {/* Stopping, as a first-class answer rather than a link hiding
                  under the next thing — except when there is nothing to go back
                  to, where /focus would be its own dead end. */}
                {ending.kind !== "nothing-left" && (
                  <Link
                    href="/focus"
                    className={
                      ending.kind === "back-to-focus"
                        ? "bg-primary text-primary-foreground inline-flex min-h-[44px] items-center rounded-md px-4 font-medium"
                        : "text-muted-foreground inline-flex min-h-[44px] items-center text-sm hover:underline"
                    }
                  >
                    {t(
                      ending.kind === "back-to-focus"
                        ? "focus.done.backToFocus"
                        : "focus.done.doneForNow",
                      voice,
                    )}
                  </Link>
                )}
              </>
            )}

          {/* #198 — the undo, and it belongs HERE rather than only on the step
              row, because this screen is where an accidental completion is
              discovered: the tick has just landed and the countdown to the next
              step has started. Recovery that lives two screens away is not
              recovery.

              Rendered for every `ending.kind`, deliberately — a mis-tap on the
              LAST step of a task lands on the celebration branch, and that is
              the case with the most to put right, since it closed the task and
              moved the inbox item to Done as well.

              Quiet by design, and the only destructive-looking thing on a screen
              whose job is to feel good: it sits under every other answer, in the
              muted register the "Done for now" escape already uses, so it is
              findable when wanted and not an invitation to second-guess a real
              finish. No confirm dialog on it either — it is itself the
              correction, and it is reversible by pressing Complete again. */}
          <button
            type="button"
            onClick={() => void undoComplete()}
            disabled={pending}
            className="text-muted-foreground hover:text-foreground focus-visible:ring-ring inline-flex min-h-[44px] items-center gap-1.5 rounded text-sm underline underline-offset-4 outline-none focus-visible:ring-2 disabled:opacity-50"
          >
            <RotateCcw aria-hidden="true" className="h-4 w-4 shrink-0" />
            {t("focus.done.undo", voice)}
          </button>

          {/* #137/#142 — the same notice as everywhere else. The done screen
              returns early, so without this a failed chain would report
              nothing at all: a button that visibly does nothing, which is the
              dead end this whole issue is about. */}
          {failureNotice}
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

      {/* #198 — confirm the undo actually landed. The phase change alone is
          silent to a screen-reader user, and "did that work?" is the entire
          question in the moment after correcting an accident — the answer has to
          be stated, not inferred from the screen having changed. `role="status"`
          (polite) rather than an alert: this is good news arriving, not an
          interruption.

          **Gated on `phase === "setup"`, and `undone` is also reset when a session
          begins.** An earlier version had neither, on the stated but false
          reasoning that "starting the step again replaces this whole screen" — it
          does not. This is ONE component with `phase` toggling inside it, and this
          block sits in the shared tree above the phase-specific ones, so the
          notice kept showing over a live countdown for the same step (Duo review
          round 2). Belt and braces on purpose: the gate fixes what is displayed,
          the reset fixes the state, and either alone would leave the other
          misleading to the next reader. */}
      {undone && phase === "setup" && (
        <p
          role="status"
          className="text-muted-foreground text-sm"
          data-testid="focus-undone-notice"
        >
          {t("focus.done.undone", voice)}
        </p>
      )}

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
                disabled={pending}
                className="text-muted-foreground hover:text-foreground inline-flex min-h-[44px] items-center gap-1.5 text-sm font-semibold underline underline-offset-4 disabled:opacity-50"
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
                  id={durationLabelId}
                  className="text-muted-foreground text-sm font-semibold"
                >
                  {t("focus.setup.focusFor", voice)}
                </p>
                <div
                  role="group"
                  aria-labelledby={durationLabelId}
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
              {canKeepPaused && (
                <button
                  type="button"
                  onClick={() => setStartingFresh(false)}
                  disabled={pending}
                  className="text-muted-foreground hover:text-foreground inline-flex min-h-[44px] items-center gap-1.5 text-sm font-semibold underline underline-offset-4 disabled:opacity-50"
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
          {/* #197 — Pause LEADS this row, and Complete step follows it.
              It was the other way round, and one user completed a step by
              accident five separate times reaching for pause. Two reasons the
              order matters more than it looks:

              1. Pause is reversible and frequent; Complete is irreversible and
                 happens once per step. Every media and timer convention puts the
                 transport control in the leading slot, so muscle memory arrives
                 there expecting pause — and the row is `flex-wrap` with no
                 `order-*` utilities, so this source order is also the visual
                 order and the tab/switch order.
              2. `sessionCtaRef` — the element focus returns to after a resume —
                 has always been on THIS button, so the code's own idea of the
                 primary control disagreed with what the row looked like.

              Pause also takes the filled `bg-primary` treatment so that Complete
              is no longer the only filled button competing for the eye. Deliberately
              NOT a confirm dialog on Complete: that was weighed and declined
              (recorded on #197) because it taxes the app's happy path forever, and
              #198 supplies the recovery path instead. `focus-timer.test.tsx`
              asserts both the order and the weighting, so a later style pass
              cannot quietly undo this. */}
          <button
            ref={sessionCtaRef}
            onClick={togglePause}
            disabled={pending}
            className="bg-primary text-primary-foreground hover:bg-primary/80 inline-flex min-h-[44px] items-center gap-1.5 rounded-md px-5 font-medium disabled:opacity-50"
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
          {/* #99 a11y — green-700, not green-600. White on `bg-green-600`
              (#00a63e) measures 3.21:1 and AA-normal needs 4.5:1: at 16px /
              weight 500 this is not "large text" (that needs 18.66px bold or
              24px), so the 3:1 allowance does not apply, and it failed in both
              themes because neither the fill nor the label had a dark variant.
              green-700 (#008236) takes white to 4.95:1 — and, because this is a
              borderless solid fill whose colour IS the button's visual
              boundary, it also keeps that boundary above the 3:1 non-text floor
              (WCAG 1.4.11) in both themes: 4.65:1 on the light background,
              3.97:1 on the dark one. green-800 reads better for the label alone
              (7.13:1) but drops the boundary to 2.75:1 in dark — one AA failure
              traded for another — so 700 is the weight that clears both.
              Same family as the completion tick's darkened green
              (--tick-color in globals.css), which solved this for text. */}
          <button
            onClick={finishComplete}
            disabled={pending}
            className="inline-flex min-h-[44px] items-center gap-1.5 rounded-md bg-green-700 px-4 font-medium text-white disabled:opacity-50"
          >
            <Check aria-hidden="true" className="h-4 w-4 shrink-0" />
            {stripLeadingGlyph(t("focus.timer.completeStep", voice))}
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

      {/* #138 — three answers, not two. The middle one is a row of preset
          minutes: in practice the commonest answer to "how did that go?" is
          "not yet, and I already know roughly how much longer I need", which
          the old two-option screen forced through an AI re-estimate for a
          decision the user had already made.

          Ordered done → keep going → not sure, i.e. cheapest answer first and
          the one that costs a server round-trip last. */}
      {phase === "timeup" && (
        <div className="space-y-3 text-center">
          <p className="text-lg font-medium">{t("focus.timesUp", voice)}</p>
          <div className="flex flex-wrap justify-center gap-2">
            {/* Shares sessionCtaRef with the Pause/Resume control above: the two
                blocks are mutually exclusive, so a coupled resume that lands
                straight on time's-up still has somewhere to put focus (#65).
                green-700 for AA — see the "Complete step" CTA above for the
                measured ratios; the two are the same control at two moments and
                must stay the same green. */}
            <button
              ref={sessionCtaRef}
              onClick={finishComplete}
              disabled={pending}
              className="inline-flex min-h-[44px] items-center gap-1.5 rounded-md bg-green-700 px-4 font-medium text-white disabled:opacity-50"
            >
              <Check aria-hidden="true" className="h-4 w-4 shrink-0" />
              {stripLeadingGlyph(t("focus.yesDone", voice))}
            </button>
          </div>
          {/* A `group` with its own label, not four loose buttons: without it a
              screen-reader user hears "15, 30, 45, 60" with nothing saying what
              the numbers mean. Same shape as the setup screen's "Focus for" chip
              group. Each button also carries a spoken "Add N minutes", because a
              bare number is a quantity, not an action.

              The row reads as one sentence — "Keep going for 15 / 30 / 45 / 60
              min" — so the buttons hold bare numbers and the unit is said once at
              the end. That is deliberately UNLIKE the setup screen's chips, which
              each carry their own "10m" because there a chip is a standalone
              value you select rather than part of a phrase. Owner-approved copy
              (#138); the alternative, four "15m"-style buttons, repeats the unit
              four times and leaves the label dangling.

              These are NOT aria-pressed toggles like the setup chips — tapping
              one is a one-shot action that immediately returns the timer to
              `running`, so there is no selected state to report.

              `disabled={pending}` matches the two buttons above, and is load-
              bearing rather than cosmetic (Duo review): the block stays mounted
              while a `completeFocus` is in flight, because the phase only moves
              once the server answers. Without the guard a tap here would set
              phase to `running` and then have `finishComplete` resolve and
              override it with `done`, silently discarding the choice. */}
          {/* The label and the unit sit OUTSIDE the group (Duo review): inside,
              "Keep going for" is both the group's accessible name via
              `aria-labelledby` AND a text node in its traversal content, so some
              screen readers announce it twice — once on entry, once while
              reading the children. The setup screen's "Focus for" group already
              gets this right; this now matches it. */}
          <div className="flex flex-wrap items-center justify-center gap-2">
            {/* No `stripLeadingGlyph` here, unlike the buttons above (Duo
                review): that call exists because those render their own lucide
                icon, so a leading glyph in the string would double it up. This
                is a plain text label with no icon beside it — stripping would be
                a no-op today and would silently eat a playful emoji if one is
                ever added, which for a label is the wrong default. */}
            <span id={keepGoingLabelId} className="text-muted-foreground">
              {t("focus.keepGoingFor", voice)}
            </span>
            <div
              role="group"
              aria-labelledby={keepGoingLabelId}
              className="flex flex-wrap items-center justify-center gap-2"
            >
              {DURATION_PRESET_MIN.map((mins) => (
                <button
                  key={mins}
                  onClick={() => changeTime(mins)}
                  disabled={pending}
                  aria-label={`Add ${mins} minutes`}
                  className="hover:bg-accent inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-md border px-3 disabled:opacity-50"
                >
                  {mins}
                </button>
              ))}
            </div>
            <span aria-hidden="true" className="text-muted-foreground">
              {t("focus.keepGoingUnit", voice)}
            </span>
          </div>
          {/* Last, not beside "All done" (Duo review). The comment above claims
              the order is done -> keep going -> not sure, and this button sitting
              in the same flex row as "All done" made that false in the DOM: tab
              and screen-reader order announced the AI round-trip BEFORE the four
              immediate choices, which is the opposite of the rationale. Cheapest
              answer first, the one that costs a server round-trip last. */}
          <div className="flex justify-center">
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
          {/* #137 — three outcomes, not two. `pending` is the spinner; a failed
              RE-ESTIMATE replaces the number field (there is no estimate to
              edit, so the notice offers Retry and Skip instead); a failed
              REQUEUE keeps the field, because the number in it is the user's
              own and a retry must not throw it away. */}
          {pending && !failure && (
            <p role="status" className="text-muted-foreground text-sm">
              Claude is re-estimating…
            </p>
          )}
          {showEstimateField && (
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
                disabled={pending}
                className="bg-primary text-primary-foreground inline-flex min-h-[44px] items-center rounded-md px-4 font-medium disabled:opacity-50"
              >
                Requeue
              </button>
            </div>
          )}
          {failureNotice}
        </div>
      )}

      {/* #137 — everywhere else the notice sits under the controls it belongs
          to (setup's Start/Resume, the live session's Complete/Pause, time's-up
          Yes/Not yet), so the remedy is next to the thing that failed. */}
      {phase !== "reestimate" && failureNotice}

      {/* #66 — the same quiet task-total line for the live/time's-up phases (in
          setup it's rendered inside the controls, directly under the CTA, per
          the approved mockup's hierarchy). */}
      {!setup && taskTotalLine}

      {/* #43 — embedded lo-fi mini-player (play/pause · prev/next · volume ·
          now-playing). Hidden when sound is off or minimal-mode-while-running.
          #65 — when the workspace opted in, its transport button drives the
          SESSION (and says so in its label); otherwise it stays audio-only and
          the countdown is untouched, exactly as #43 shipped it. */}
      {showSoundPlayer && (
        <FocusSoundPlayer
          controls={sound}
          voice={voice}
          categories={categories}
          onCategoriesChange={changeCategories}
          onPauseTogether={pauseTogether ? togglePauseFromPlayer : undefined}
          pauseTogetherPending={pending}
        />
      )}

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
