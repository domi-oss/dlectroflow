"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronDown, Clock, TriangleAlert } from "lucide-react";
import { cn, touchTarget } from "@/lib/utils";
import { formatAgo } from "@/lib/format";
import { t } from "@/lib/strings";
import type { StringKey, Voice } from "@/lib/strings";
import type { StrandedGroup, StrandedState } from "@/lib/capture-queue";
import type { CaptureQueueApi } from "@/lib/use-capture-queue";

/**
 * #175 — the "N waiting to save" strip, docked under the capture bar.
 *
 * ── What this component deliberately does NOT contain ────────────────────────
 *
 * **The two live regions.** They are siblings in `inbox-view.tsx`, not children
 * here, and that is a mechanical requirement rather than a style choice:
 * `write-notice-hygiene`'s rules D and E reason about **one file's JSX tree**, so
 * a region rendered by a child component is invisible to both. Rule D is the only
 * thing in the repo that can see a polite region nested inside an assertive one
 * (#218's defect), and rule E the only thing that can see a missing wait
 * announcement — a failure that has shipped green four times here. Moving those
 * regions into this file would give up both.
 *
 * It also does not reach storage or the network. Everything comes through
 * {@link CaptureQueueApi}, so the component cannot enqueue, flush or discard
 * except through the rules `capture-queue.ts` enforces.
 *
 * ── Nothing queued ever appears in the inbox list ────────────────────────────
 *
 * A dimmed row still reads as *"in my inbox"* to someone scanning, and that is
 * the shape of the lie #210 was filed for. It costs zero height when there is
 * nothing waiting.
 *
 * Accepted cost of docking it here rather than fixing it to the viewport: if a
 * flush happens while the user is scrolled deep in the list, the strip is
 * off-screen. That is the trade for spending no fixed height on a phone viewport
 * #253 has just decluttered, and it is recorded so it is not rediscovered as a
 * defect.
 *
 * ── Focus, which is the half an implementation forgets ───────────────────────
 *
 * Discarding entry 3 of 5 removes the focused element while the strip stays
 * mounted, so the unmount path never runs and the browser drops focus to
 * `<body>` — the user's place in the page is gone, and on a screen reader the
 * next key press starts from the top of the document (WCAG 2.4.3). It is also the
 * *more* common press of the two, since the unmount case needs the queue to
 * empty. So focus moves to a **named** anchor on every arm, confirm and cancel
 * alike.
 *
 * ── No `outline-none` anywhere in this file ──────────────────────────────────
 *
 * Every control here keeps the UA focus ring, so **2.4.7 Focus Visible (AA)** is
 * satisfied without a bespoke indicator — the same call the #225 notice records.
 * Removing the outline is what makes the indicator the author's problem, and axe
 * implements no rule for any focus criterion at all, so `a11y-class-hygiene` would
 * be the only thing looking.
 */

/** The sentence a stranded group carries. One per state, never shared. */
const STRANDED_COPY: Record<StrandedState, StringKey> = {
  unmarked: "captureQueue.strandedNeutral",
  "session-expired": "captureQueue.blocked.sessionExpired",
  "session-changed": "captureQueue.blocked.sessionChanged",
  "account-revoked": "captureQueue.blocked.accountRevoked",
};

/**
 * The static sentence a FULL row carries for a restored refusal.
 *
 * Only `account-revoked` can appear on a full row: a 409 means the resolved
 * workspace already disagrees with the entry, so a `session-expired` entry is
 * non-matching by construction and its sentence belongs to a collapsed group.
 * Kept as a map rather than a conditional so a third refusal state cannot inherit
 * silence.
 */
const FULL_ROW_COPY: Record<string, StringKey> = {
  "account-revoked": "captureQueue.blocked.accountRevoked",
  "session-expired": "captureQueue.blocked.sessionExpired",
};

export type CaptureQueueStripProps = {
  api: CaptureQueueApi;
  voice: Voice;
  /** The polite region's id, so Retry's description reaches the wait as well. */
  savingRegionId: string;
  /** Request-time clock, handed down so the age matches the rest of the board. */
  now: number;
  /** Where focus goes when the strip is about to unmount (WCAG 2.4.3). */
  onReturnFocus: () => void;
};

export function CaptureQueueStrip({
  api,
  voice,
  savingRegionId,
  now,
  onReturnFocus,
}: CaptureQueueStripProps) {
  const [expanded, setExpanded] = useState(false);
  /** Which entry (or group) is showing its confirm. One at a time. */
  const [confirming, setConfirming] = useState<string | null>(null);
  const toggleRef = useRef<HTMLButtonElement | null>(null);
  const confirmRef = useRef<HTMLButtonElement | null>(null);
  /** Where focus is owed once a confirm resolves. Read in an effect, not inline. */
  const focusAfter = useRef<string | null>(null);

  const { mine, stranded } = api;
  const total = mine.length + stranded.reduce((n, g) => n + g.count, 0);

  // ONE effect for every focus hand-off, and that is deliberate rather than
  // tidy: the two arms fire on different state changes — a confirm OPENING
  // changes `confirming`, a confirm RESOLVING changes `mine`/`stranded`, and a
  // CANCEL changes only `confirming` back to null. Split across two effects keyed
  // on their "own" state, the cancel arm never runs and focus lands on `<body>`
  // — measured, and it is the arm a reader is least likely to think about.
  useEffect(() => {
    // A confirm that appears without taking focus is invisible to a screen
    // reader until it is hunted for.
    if (confirming !== null) {
      confirmRef.current?.focus();
      return;
    }
    const owed = focusAfter.current;
    if (owed === null) return;
    focusAfter.current = null;
    if (owed === "input") {
      onReturnFocus();
      return;
    }
    const next = document.querySelector<HTMLElement>(
      `[data-discard-anchor="${owed}"]`,
    );
    // Never `<body>`: the toggle is always mounted while the strip is, so it is
    // the last resort rather than a guess.
    if (next) next.focus();
    else toggleRef.current?.focus();
  }, [confirming, mine, stranded, onReturnFocus]);

  // Zero height when there is nothing waiting. The live regions are NOT gated on
  // this — they are siblings in `inbox-view.tsx` and mount unconditionally, empty,
  // because a region that arrives together with its first message is silent.
  if (total === 0) return null;

  /**
   * Discard, at the confirming press.
   *
   * The re-check against live state is the hook's, not this component's: an
   * open-time-only check leaves the ordinary case open, because the two-step
   * confirm is a human pause of exactly the length a flush trigger needs and
   * `visibilitychange` fires on the very tab-switch a hesitating user makes.
   */
  const resolveDiscard = async (keys: readonly string[], anchor: string) => {
    setConfirming(null);
    focusAfter.current = anchor;
    await api.discard(keys);
  };

  /** Which anchor is owed focus once these keys leave the list. */
  const anchorAfter = (index: number): string => {
    if (mine.length > index + 1) return mine[index + 1]!.clientKey;
    if (mine.length > 1) return mine[index - 1]!.clientKey;
    if (stranded.length > 0) return stranded[0]!.state;
    return "input";
  };

  return (
    <div
      data-testid="capture-queue-strip"
      className="border-input bg-muted/30 mt-2 rounded-md border"
    >
      <div className="flex flex-wrap items-center gap-2 px-2 py-1">
        <button
          ref={toggleRef}
          type="button"
          // WCAG 4.1.2 Name, Role, Value. The strip's whole premise is that the
          // words stay readable on demand, so a toggle that does not report its
          // state leaves a screen-reader user unable to tell whether the queue is
          // on screen.
          aria-expanded={expanded}
          onClick={() => setExpanded((open) => !open)}
          className={cn(
            touchTarget,
            "text-foreground gap-1.5 rounded-md px-2 text-sm font-medium",
          )}
        >
          <Clock aria-hidden="true" className="h-4 w-4 shrink-0" />
          <span>
            {total} {t("captureQueue.waiting", voice)}
          </span>
          <ChevronDown
            aria-hidden="true"
            className={cn(
              "h-4 w-4 shrink-0 transition-transform",
              expanded && "rotate-180",
            )}
          />
          <span className="sr-only">
            {t(
              expanded ? "captureQueue.collapse" : "captureQueue.expand",
              voice,
            )}
          </span>
        </button>
        {mine.length > 0 && (
          // `aria-disabled`, not `disabled`: a disabled element cannot hold
          // focus, so the browser would drop it to `<body>` the moment the flush
          // starts. ⚠️ That means the button stays ACTIVATABLE, so the press is
          // guarded in the handler as well — otherwise Enter or Space on a
          // "disabled" Retry fires a second flush over the first and the attribute
          // is decoration.
          <button
            type="button"
            aria-disabled={api.flushing}
            aria-describedby={savingRegionId}
            onClick={() => {
              if (!api.flushing) void api.flush();
            }}
            className={cn(
              touchTarget,
              "bg-primary text-primary-foreground rounded-md px-3 text-sm font-medium aria-disabled:opacity-50",
            )}
          >
            {t("captureQueue.retry", voice)}
          </button>
        )}
      </div>

      {expanded && (
        <ul className="space-y-1 px-2 pt-1 pb-2">
          {mine.map((entry, index) => {
            const copyKey = entry.blockedBy
              ? FULL_ROW_COPY[entry.blockedBy]
              : undefined;
            return (
              <li
                key={entry.clientKey}
                className="border-input flex flex-wrap items-start gap-2 border-t pt-1 text-sm first:border-t-0"
              >
                <div className="min-w-0 flex-1">
                  {/* The text is rendered rather than truncated, because the
                      confirm has to be made against words the user can read —
                      and because the refusal copy tells them to copy the words
                      out, which they cannot do if they cannot see them. */}
                  <p className="break-words">{entry.text}</p>
                  <p className="text-muted-foreground text-xs">
                    {formatAgo(Math.max(0, now - entry.capturedAt))}
                  </p>
                  {copyKey && (
                    // A refusal restored from storage is STATIC TEXT, never an
                    // assertive announcement: `blockedBy` is persisted so the
                    // reason survives the reload a discarded tab forces, which
                    // means the region would go empty→filled on every page load
                    // and interrupt with news of something that did not just
                    // happen. Associated with the entry, and with the capture
                    // input by `inbox-view.tsx` (WCAG 3.3.1 Error
                    // Identification, which wants the error available WITH the
                    // field rather than announced once and gone).
                    <p
                      id={`capture-queue-refusal-${entry.clientKey}`}
                      className="text-destructive flex items-start gap-1.5 text-xs"
                    >
                      <TriangleAlert
                        aria-hidden="true"
                        className="mt-0.5 h-3.5 w-3.5 shrink-0"
                      />
                      <span className="break-words">{t(copyKey, voice)}</span>
                    </p>
                  )}
                </div>
                {confirming === entry.clientKey ? (
                  <span className="flex shrink-0 items-center gap-1">
                    <button
                      ref={confirmRef}
                      type="button"
                      // The name has to say what is being discarded, so a screen
                      // reader user who arrives here knows which words are at
                      // stake.
                      aria-label={`${t("captureQueue.discardConfirm", voice)}: ${entry.text}`}
                      aria-describedby={`capture-queue-discard-prompt-${entry.clientKey}`}
                      onClick={() =>
                        void resolveDiscard(
                          [entry.clientKey],
                          anchorAfter(index),
                        )
                      }
                      className={cn(
                        touchTarget,
                        "bg-destructive text-destructive-foreground rounded-md px-2 text-xs font-medium",
                      )}
                    >
                      {t("captureQueue.discardConfirm", voice)}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        // A cancel that drops focus is the same defect arriving
                        // on the path where the user chose to change nothing.
                        focusAfter.current = entry.clientKey;
                        setConfirming(null);
                      }}
                      className={cn(
                        touchTarget,
                        "rounded-md px-2 text-xs font-medium",
                      )}
                    >
                      {t("action.cancel", voice)}
                    </button>
                    <span
                      id={`capture-queue-discard-prompt-${entry.clientKey}`}
                      className="sr-only"
                    >
                      {t("captureQueue.discardPrompt", voice)}
                    </span>
                  </span>
                ) : (
                  <button
                    type="button"
                    data-discard-anchor={entry.clientKey}
                    aria-label={`${t("captureQueue.discard", voice)}: ${entry.text}`}
                    onClick={() => {
                      // A courtesy, not the guard: it exists so nobody reads a
                      // confirmation dialog only to be told no afterwards. The
                      // guard is the hook's re-check at confirm-resolution.
                      if (api.inFlight(entry.clientKey)) {
                        void api.discard([entry.clientKey]);
                        return;
                      }
                      setConfirming(entry.clientKey);
                    }}
                    className={cn(
                      touchTarget,
                      "text-muted-foreground hover:text-foreground shrink-0 rounded-md px-2 text-xs",
                    )}
                  >
                    {t("captureQueue.discard", voice)}
                  </button>
                )}
              </li>
            );
          })}

          {stranded.map((group) => (
            <StrandedRow
              key={group.state}
              group={group}
              voice={voice}
              confirming={confirming === group.state}
              onRequest={() => setConfirming(group.state)}
              onCancel={() => {
                focusAfter.current = group.state;
                setConfirming(null);
              }}
              onConfirm={() =>
                void resolveDiscard(group.clientKeys, anchorAfter(0))
              }
              confirmRef={confirming === group.state ? confirmRef : undefined}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * One collapsed group: the count, the state's sentence, and a way to reclaim the
 * bytes — **and no text, no author, no workspace.**
 *
 * `localStorage` is scoped to the origin, not to a session, so without this a
 * second person signing in on the same browser would read the first person's
 * unsaved words. Clearing the queue on sign-out is the obvious fix and it is
 * wrong: it destroys exactly what this feature exists to protect, on the most
 * ordinary event there is.
 *
 * ⚠️ **The discard control is what makes the residual survivable, not a nicety.**
 * The byte cap counts every entry in the key, origin-wide, so a stranded long
 * capture consumes it for ever and the next person's first offline capture is
 * refused with *"no room until some of these save"* — a wait for something that
 * can never happen. That is a denial of capture, and this is the only exit.
 *
 * ⚠️ **It cannot use the ordinary two-step confirm**, which exists so the confirm
 * is made against words the user can read. Here they may not be, so the name is
 * the **count** and the prompt says plainly that the text cannot be shown.
 */
function StrandedRow({
  group,
  voice,
  confirming,
  onRequest,
  onCancel,
  onConfirm,
  confirmRef,
}: {
  group: StrandedGroup;
  voice: Voice;
  confirming: boolean;
  onRequest: () => void;
  onCancel: () => void;
  onConfirm: () => void;
  confirmRef?: React.RefObject<HTMLButtonElement | null>;
}) {
  const promptId = `capture-queue-stranded-prompt-${group.state}`;
  const sentence = t(STRANDED_COPY[group.state], voice);
  return (
    <li className="border-input flex flex-wrap items-start gap-2 border-t pt-1 text-sm first:border-t-0">
      <p
        id={`capture-queue-stranded-${group.state}`}
        className="text-muted-foreground min-w-0 flex-1 break-words text-xs"
      >
        {group.state === "unmarked"
          ? `${group.count} ${sentence}`
          : `${sentence} (${group.count})`}
      </p>
      {confirming ? (
        <span className="flex shrink-0 items-center gap-1">
          <button
            ref={confirmRef}
            type="button"
            // The count and nothing else — the whole point of this control is
            // that the words cannot be shown.
            aria-label={`${t("captureQueue.discardConfirm", voice)}: ${group.count}`}
            aria-describedby={promptId}
            onClick={onConfirm}
            className={cn(
              touchTarget,
              "bg-destructive text-destructive-foreground rounded-md px-2 text-xs font-medium",
            )}
          >
            {t("captureQueue.discardConfirm", voice)}
          </button>
          <button
            type="button"
            onClick={onCancel}
            className={cn(touchTarget, "rounded-md px-2 text-xs font-medium")}
          >
            {t("action.cancel", voice)}
          </button>
          <span id={promptId} className="sr-only">
            {t("captureQueue.strandedDiscardPrompt", voice)}
          </span>
        </span>
      ) : (
        <button
          type="button"
          data-discard-anchor={group.state}
          aria-label={`${t("captureQueue.discard", voice)}: ${group.count}`}
          onClick={onRequest}
          className={cn(
            touchTarget,
            "text-muted-foreground hover:text-foreground shrink-0 rounded-md px-2 text-xs",
          )}
        >
          {t("captureQueue.discard", voice)}
        </button>
      )}
    </li>
  );
}
