"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ArrowRight } from "lucide-react";
import { t, type Voice } from "@/lib/strings";

/**
 * #142 — how long the finished-step screen waits before moving the user on.
 *
 * Five seconds is the owner's decision, and it is a compromise rather than a
 * measurement: long enough to read what is coming next and press one button,
 * short enough that it still feels like momentum rather than a modal. Exported
 * so the tests (and the timer) assert against the real value instead of a copy
 * of it.
 */
export const AUTO_ADVANCE_SEC = 5;

/**
 * #142 — the countdown panel shown on the finished-step screen when there is
 * something to move on to.
 *
 * Finishing a step used to swap the timer into a `done` phase on the same URL
 * and stop there — for a single-task to-do it said *"That was the last step of
 * this task. 🏁"* and offered nothing. The finish is the highest-momentum moment
 * in the app and it was where momentum stopped.
 *
 * Everything here that looks like belt-and-braces is a WCAG requirement, because
 * an unannounced timed navigation is an accessibility failure and not merely a
 * preference:
 *
 *  - **The escape is not a moving target.** "Stay here" sits in a fixed place
 *    with a fixed label; the number ticks in a separate element, and the
 *    progress track is decorative and `aria-hidden`. Nothing the user has to hit
 *    moves or relabels while they reach for it.
 *  - **Escape cancels, too** (WCAG 2.2.1 Timing Adjustable). A screen-reader
 *    user should not have to tab to a button inside five seconds; a key that
 *    needs no navigation at all is the only escape that is genuinely reachable
 *    in the time available.
 *  - **The countdown holds while the panel has focus.** Tabbing into it is a
 *    deliberate act, and a clock that keeps running while someone reads the
 *    options is the race this component exists to avoid. A pointer user never
 *    triggers it, so the 5-second flow is unchanged for them.
 *  - **One live region, mounted throughout.** Its text *changes* on cancel,
 *    which is what assistive tech announces reliably — a region that mounts with
 *    its content already in place frequently is not announced at all. That is
 *    why the cancelled state is rendered by this component rather than by
 *    swapping it out for something else.
 *  - **Focus lands somewhere deliberate on cancel.** Both escapes unmount the
 *    control that was pressed (or leave focus wherever Escape was typed), so it
 *    is handed to "Go now" — the one thing that still moves the user forward
 *    (WCAG 2.4.3).
 *
 * `prefers-reduced-motion` suppresses the animated progress track only. It does
 * **not** disable the advance: the setting is about motion, and silently
 * changing what the app *does* on the strength of it would be a behaviour change
 * nobody asked for — the timing escape above is what covers the timing concern.
 */
export function AutoAdvance({
  seconds = AUTO_ADVANCE_SEC,
  label,
  targetText,
  targetEmoji = null,
  voice,
  reducedMotion,
  onAdvance,
  onCancel,
  extra = null,
}: {
  /** Countdown length. Defaults to AUTO_ADVANCE_SEC; a prop so tests can shorten it. */
  seconds?: number;
  /** What kind of thing is next — "Next step" / "Next to-do". Already voiced. */
  label: string;
  /** The step or to-do being advanced to, so the destination is never a surprise. */
  targetText: string;
  targetEmoji?: string | null;
  voice: Voice;
  reducedMotion: boolean;
  /** Fired once, either when the clock runs out or when "Go now" is pressed. */
  onAdvance: () => void;
  /** Fired once when the user opts out. The panel stays mounted either way. */
  onCancel?: () => void;
  /** Extra control rendered under the buttons — the hyper-focus off-switch. */
  extra?: ReactNode;
}) {
  const [left, setLeft] = useState(seconds);
  const [cancelled, setCancelled] = useState(false);
  // True while the panel holds focus: the countdown is suspended, not reset.
  const [held, setHeld] = useState(false);
  // `onAdvance` must fire exactly once however it is reached — the clock hitting
  // zero, a "Go now" press, or a re-render handing us a new callback identity.
  //
  // Deliberately NOT shared with the cancel guard. Making one flag mean both
  // "already navigated" and "opted out" put the dead end straight back: after
  // "Stay here", "Go now" silently did nothing, so the escape from the
  // auto-advance became the escape from the whole flow. Caught by
  // "after cancelling, the target is still reachable".
  const advancedRef = useRef(false);
  const goRef = useRef<HTMLButtonElement | null>(null);

  const advance = useCallback(() => {
    if (advancedRef.current) return;
    advancedRef.current = true;
    onAdvance();
  }, [onAdvance]);

  // `cancelled` is what stops the clock — the ticker effect and the
  // reached-zero effect below both read it, so a tick already scheduled when
  // the user opts out lands in a render where it is a no-op.
  const cancel = useCallback(() => {
    if (advancedRef.current || cancelled) return;
    setCancelled(true);
    onCancel?.();
  }, [cancelled, onCancel]);

  // The clock. Torn down and rebuilt when `held` flips, which is what suspends
  // it — the remaining count lives in state, so nothing is lost across the gap.
  useEffect(() => {
    if (cancelled || held) return;
    const id = setInterval(() => {
      setLeft((n) => (n <= 0 ? 0 : n - 1));
    }, 1000);
    return () => clearInterval(id);
  }, [cancelled, held]);

  // Separate from the ticker deliberately: calling a navigation side-effect from
  // inside a `setState` updater is impure, and under the React compiler a render
  // can be repeated or discarded, so "it only runs once" would not be a
  // guarantee. Reaching zero is a state, and this reacts to it.
  useEffect(() => {
    if (left > 0 || cancelled) return;
    advance();
  }, [left, cancelled, advance]);

  // WCAG 2.2.1 — the keyboard escape. Bound to the document rather than the
  // panel because focus is wherever the completed step left it, which is not
  // in here; an escape that only works once you have already found the panel
  // is not an escape.
  useEffect(() => {
    if (cancelled) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      cancel();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [cancelled, cancel]);

  // WCAG 2.4.3 — "Stay here" unmounts itself, and an Escape press leaves focus
  // wherever it happened to be. Either way it goes to the one control that still
  // moves the user forward.
  const wasCancelled = useRef(false);
  useEffect(() => {
    if (!cancelled || wasCancelled.current) return;
    wasCancelled.current = true;
    goRef.current?.focus();
  }, [cancelled]);

  const announcement = cancelled
    ? t("focus.advance.cancelled", voice)
    : `${label} ${t("focus.advance.in", voice)} ${seconds} ${t("focus.advance.seconds", voice)}. ${t("focus.advance.escapeHint", voice)}`;

  return (
    <div
      // Hold the clock while the panel has focus. `onFocus`/`onBlur` on a div
      // are React's delegated focusin/focusout, so they fire for descendants —
      // which is the whole point: focus is never on the container itself.
      onFocus={() => setHeld(true)}
      onBlur={() => setHeld(false)}
      className="bg-card mx-auto flex max-w-md flex-col items-center gap-3 rounded-lg border p-4"
    >
      {/* The one live region, mounted for the panel's whole life so its text
          CHANGING is what gets announced. */}
      <p role="status" className="sr-only">
        {announcement}
      </p>

      <p className="text-muted-foreground flex items-center gap-1.5 text-sm font-semibold">
        <ArrowRight aria-hidden="true" className="h-4 w-4 shrink-0" />
        <span>{label}</span>
        {!cancelled && (
          // aria-hidden: a per-second number inside a live region would talk
          // over itself five times. The spoken version is the sentence above,
          // said once.
          <span
            aria-hidden="true"
            data-testid="auto-advance-count"
            className="tabular-nums"
          >
            {t("focus.advance.in", voice)} {left}…
          </span>
        )}
      </p>

      <p className="text-center text-base font-medium">
        {targetEmoji ? `${targetEmoji} ` : ""}
        {targetText}
      </p>

      {/* Decorative only — the count above is the real readout, and this track
          carries no information the text does not. Dropped entirely under
          reduced motion rather than merely un-transitioned, because a bar that
          jumps a fifth of its width every second is still motion. */}
      {!cancelled && !reducedMotion && (
        <div
          aria-hidden="true"
          data-auto-advance-progress
          className="bg-muted h-1 w-full overflow-hidden rounded-full"
        >
          <div
            className="bg-primary h-full transition-[width] duration-1000 ease-linear"
            style={{ width: `${(left / seconds) * 100}%` }}
          />
        </div>
      )}

      <div className="flex flex-wrap justify-center gap-2">
        <button
          ref={goRef}
          type="button"
          onClick={advance}
          className="bg-primary text-primary-foreground inline-flex min-h-[44px] items-center gap-1.5 rounded-md px-4 font-medium"
        >
          {t("focus.advance.goNow", voice)}
        </button>
        {!cancelled && (
          <button
            type="button"
            onClick={cancel}
            className="hover:bg-accent inline-flex min-h-[44px] items-center rounded-md border px-4 font-medium"
          >
            {t("focus.advance.stayHere", voice)}
          </button>
        )}
      </div>

      {extra}
    </div>
  );
}
