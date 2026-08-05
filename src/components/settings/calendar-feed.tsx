"use client";

import { useEffect, useId, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CalendarClock, Copy } from "lucide-react";
import {
  createCalendarFeed,
  disableCalendarFeed,
  regenerateCalendarFeed,
} from "@/app/actions/calendar-feed";
import { cn, touchTarget } from "@/lib/utils";

/**
 * #154 — subscribe to your own schedule from any calendar app.
 *
 * ## The caveat is part of the feature, not decoration
 *
 * The URL is a capability: whoever holds it can read the feed, with no sign-in,
 * from anywhere. That has to be said **where the copying happens** rather than
 * in a paragraph somebody scrolls past, so the warning is the `aria-describedby`
 * of both the field and the Copy control — a screen-reader user hears it as part
 * of the control they are about to use. `calendar-feed.test.tsx` asserts that
 * wiring, because a wording change that quietly drops "anyone with this link"
 * is the regression nobody reviews for.
 *
 * The card also says what the feed carries — step titles and times — because the
 * URL ends up in a calendar provider's logs, and that is the fact somebody needs
 * in order to decide whether they want it at all.
 *
 * ## Both destructive actions confirm
 *
 * Regenerating and turning off each break a subscription that is currently
 * working, and they break it SILENTLY: no error appears anywhere, the person's
 * calendar simply stops updating and they notice days later. One click is the
 * wrong price for that, so each takes two — the same inline-confirmation pattern
 * `integrations-panel.tsx` uses for Disconnect, including returning focus to the
 * trigger when the row unmounts so a keyboard user is not dropped onto `<body>`.
 *
 * ## Accessibility
 *
 * - The URL is a **labelled read-only input**, not a `<code>` block: it is
 *   reachable by keyboard, readable by a screen reader, and selectable when the
 *   clipboard API is refused (Safari, any non-secure context) — which is a real
 *   fallback rather than a theoretical one, because a person who cannot copy the
 *   URL cannot use the feature at all.
 * - Focus indicators are **rings, not background swaps** (WCAG 1.4.11 / 2.4.7),
 *   which #109 and #117 fixed across the app and which the automated gates
 *   structurally cannot see.
 * - Progress and success use `role="status"`, failures `role="alert"` — the pair
 *   the rest of Settings uses.
 * - The Copy control's **accessible name does not change** while it works.
 *
 * The copy is voice-neutral, no `t(key, voice)`. Same rule `export-data.tsx` and
 * `delete-account.tsx` state: copy that is *about* the app rather than part of
 * it does not get a playful skin, and "this link is a password" is squarely that.
 */

const GENERIC_FAILURE =
  "That did not go through. Check your connection and try again.";
const LAPSED = "You are no longer signed in. Reload the page and try again.";

type Confirming = null | "regenerate" | "disable";

export function CalendarFeed({ url }: { url: string | null }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [confirming, setConfirming] = useState<Confirming>(null);
  const [status, setStatus] = useState("");
  const [error, setError] = useState<string | null>(null);

  const statusId = useId();
  const warningId = useId();
  const confirmId = useId();
  const fieldId = useId();

  const fieldRef = useRef<HTMLInputElement | null>(null);
  const regenerateRef = useRef<HTMLButtonElement | null>(null);
  const disableRef = useRef<HTMLButtonElement | null>(null);
  // Which trigger to hand focus back to when the confirmation row unmounts. The
  // control that had focus is gone at that point, and without this a keyboard
  // user is left on <body> with a Tab that restarts from the top.
  const returnFocusTo = useRef<Confirming>(null);

  useEffect(() => {
    if (confirming !== null || returnFocusTo.current === null) return;
    const target =
      returnFocusTo.current === "regenerate" ? regenerateRef : disableRef;
    returnFocusTo.current = null;
    target.current?.focus();
  }, [confirming]);

  const ask = (which: Exclude<Confirming, null>) => {
    setError(null);
    setStatus("");
    returnFocusTo.current = which;
    // Assigning rather than toggling: only one question may be open at a time,
    // so pressing the other trigger replaces the first rather than stacking.
    setConfirming(which);
  };

  const dismiss = () => setConfirming(null);

  /** Run an action, turn its result into a sentence, and let the server
   *  re-render the card — the URL lives in the page's props, not in state. */
  const run = (
    action: () => Promise<{ ok: boolean; error?: string }>,
    done: string,
  ) => {
    setError(null);
    setStatus("");
    startTransition(async () => {
      try {
        const result = await action();
        if (!result.ok) {
          setError(result.error === "not_signed_in" ? LAPSED : GENERIC_FAILURE);
          return;
        }
        setConfirming(null);
        setStatus(done);
        router.refresh();
      } catch {
        setError(GENERIC_FAILURE);
      }
    });
  };

  const copy = async () => {
    if (!url) return;
    setError(null);
    try {
      await navigator.clipboard.writeText(url);
      setStatus("Copied. Paste it into your calendar app.");
    } catch {
      // Not an error state: the URL is right there and still usable. Select it
      // so the keyboard shortcut is one keystroke away.
      fieldRef.current?.select();
      setStatus(
        "Your browser blocked the clipboard — the URL is selected, copy it with Ctrl/Cmd + C.",
      );
    }
  };

  return (
    <div
      className="mt-4 rounded-lg border p-4"
      data-testid="calendar-feed-card"
    >
      <div className="flex items-center gap-3">
        <div className="flex-1">
          <p className="font-medium">Calendar subscription</p>
          <p className="text-muted-foreground text-sm">
            One URL you paste into Google Calendar, Apple Calendar or Outlook
            once. Your scheduled steps then appear there and stay in sync — no
            Google account, no sign-in, nothing to connect.
          </p>
        </div>
        <span
          className={cn(
            "rounded-full px-2.5 py-0.5 text-xs font-medium",
            url
              ? "bg-green-100 text-green-800"
              : "bg-muted text-muted-foreground",
          )}
        >
          {url ? "On" : "Off"}
        </span>
      </div>

      {url ? (
        <>
          <div className="mt-3 space-y-2">
            <label htmlFor={fieldId} className="block text-sm font-medium">
              Calendar feed URL
            </label>
            <div className="flex flex-wrap items-center gap-2">
              <input
                id={fieldId}
                ref={fieldRef}
                type="text"
                readOnly
                value={url}
                // Selecting on focus makes the manual copy path one keystroke,
                // which is the whole fallback when the clipboard is refused.
                onFocus={(e) => e.currentTarget.select()}
                aria-describedby={`${warningId} ${statusId}`}
                className={cn(
                  "min-w-0 flex-1 rounded-md border px-3 py-2 font-mono text-sm",
                  // WCAG 2.4.7 — a RING, not a background-colour change, so the
                  // indicator survives forced-colours mode and does not rely on hue.
                  "focus-visible:ring-ring outline-none focus-visible:ring-2 focus-visible:ring-offset-2",
                )}
              />
              <button
                type="button"
                onClick={copy}
                aria-describedby={`${warningId} ${statusId}`}
                className={cn(
                  "gap-2 rounded-md border px-3 py-2 text-sm font-medium",
                  "focus-visible:ring-ring outline-none focus-visible:ring-2 focus-visible:ring-offset-2",
                  touchTarget,
                )}
              >
                <Copy aria-hidden="true" className="h-4 w-4 shrink-0" />
                {/* The label does NOT change while the copy happens — a control
                    whose accessible name mutates under the reader is
                    disorienting for anyone navigating by name. */}
                Copy
              </button>
            </div>

            {/* THE CAVEAT, at the point of copying. Both controls above point at
                it, so it is heard as part of them rather than as a paragraph
                nearby. Deliberately blunt: this is the one sentence that decides
                whether somebody treats the URL carelessly. */}
            <p id={warningId} className="text-sm">
              <strong>Treat this URL like a password.</strong> Anyone who has it
              can read your feed without signing in, and calendar apps store it
              in plain text. It carries your step titles and times — nothing
              else. If it gets out, regenerate it.
            </p>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-3">
            {confirming === null && (
              <>
                <button
                  type="button"
                  ref={regenerateRef}
                  onClick={() => ask("regenerate")}
                  className={cn(
                    "rounded-md border px-3 py-2 text-sm font-medium",
                    "focus-visible:ring-ring outline-none focus-visible:ring-2 focus-visible:ring-offset-2",
                    touchTarget,
                  )}
                >
                  Regenerate URL
                </button>
                <button
                  type="button"
                  ref={disableRef}
                  onClick={() => ask("disable")}
                  className={cn(
                    "text-destructive rounded-md border px-3 py-2 text-sm font-medium",
                    "focus-visible:ring-ring outline-none focus-visible:ring-2 focus-visible:ring-offset-2",
                    touchTarget,
                  )}
                >
                  Turn off
                </button>
              </>
            )}

            {confirming !== null && (
              <>
                {/* `role="status"` so a screen-reader user learns the question
                    appeared at all, and `basis-full` so it takes its own line —
                    at 390px the question and both buttons in one row break a
                    label mid-phrase. */}
                <span
                  className="basis-full text-sm"
                  role="status"
                  id={confirmId}
                >
                  {confirming === "regenerate"
                    ? "Every calendar using the current URL — including your own — will stop updating, with no warning at their end. Generate a new URL?"
                    : "Every calendar using this URL will stop updating, and the URL stops working. Turn the feed off?"}
                </span>
                <button
                  type="button"
                  disabled={pending}
                  aria-describedby={confirmId}
                  onClick={() =>
                    confirming === "regenerate"
                      ? run(
                          regenerateCalendarFeed,
                          "New URL generated. The old one stopped working immediately.",
                        )
                      : run(disableCalendarFeed, "Calendar feed turned off.")
                  }
                  className={cn(
                    "bg-destructive text-destructive-foreground rounded-md px-3 py-2 text-sm font-medium disabled:opacity-50",
                    "focus-visible:ring-ring outline-none focus-visible:ring-2 focus-visible:ring-offset-2",
                    touchTarget,
                  )}
                >
                  {confirming === "regenerate"
                    ? "Yes, regenerate"
                    : "Yes, turn it off"}
                </button>
                <button
                  type="button"
                  onClick={dismiss}
                  className={cn(
                    "rounded-md border px-3 py-2 text-sm",
                    "focus-visible:ring-ring outline-none focus-visible:ring-2 focus-visible:ring-offset-2",
                    touchTarget,
                  )}
                >
                  Cancel
                </button>
              </>
            )}
          </div>
        </>
      ) : (
        <div className="mt-3">
          <button
            type="button"
            disabled={pending}
            aria-busy={pending}
            aria-describedby={statusId}
            onClick={() =>
              run(
                createCalendarFeed,
                "Calendar feed created. Copy the URL below.",
              )
            }
            className={cn(
              "bg-primary text-primary-foreground gap-2 rounded-md px-3 py-2 text-sm font-medium disabled:opacity-50",
              "focus-visible:ring-ring outline-none focus-visible:ring-2 focus-visible:ring-offset-2",
              touchTarget,
            )}
          >
            <CalendarClock aria-hidden="true" className="h-4 w-4 shrink-0" />
            Create a calendar feed
          </button>
        </div>
      )}

      {/* Polite: progress and success are worth announcing when the reader gets
          to them, and must not interrupt. `min-h-5` reserves the line so the
          layout does not jump when it fills. */}
      <p
        role="status"
        id={statusId}
        aria-live="polite"
        className="text-muted-foreground mt-2 min-h-5 text-sm"
      >
        {status}
      </p>

      {/* Assertive, and a separate element: a failure here means the person
          thinks they have a working feed and does not. */}
      {error && (
        <p role="alert" className="text-sm text-red-700 dark:text-red-400">
          {error}
        </p>
      )}
    </div>
  );
}
