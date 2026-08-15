"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { t, type Voice } from "@/lib/strings";

export type SaveStatus = "idle" | "saving" | "saved" | "error" | "stalled";

/**
 * #227 — how long a save may go unanswered before the indicator stops claiming
 * it is still working.
 *
 * 10s, the same bound `CAPTURE_FLUSH_TIMEOUT_MS` and `SHOPPING_ACTION_TIMEOUT_MS`
 * already use for a server action, and generous for the same reason
 * `withActionTimeout` gives: it bounds how long the UI is willing to *wait*,
 * not the request. A server action cannot be aborted from the client, so the
 * write may still land — which is exactly why this reports rather than fails.
 */
export const SAVE_STALL_MS = 10_000;

/**
 * Transient auto-save status. `markSaved()` shows the "Saved ✓" affordance and
 * fades it back to idle after `fadeMs`; `markError()` sticks until the next
 * save attempt (so a failed write stays visible while the field stays editable).
 *
 * ## The state this hook was missing (#227)
 *
 * `markSaving()` also arms a `stallMs` bound. A write that neither resolves nor
 * rejects — a pod rolling mid-request, a connection that never closes — used to
 * leave the indicator on "…" for as long as the page stayed open, which reads
 * as "still working": the one thing it is not. That is the third failure mode
 * `withActionTimeout` names on the capture surfaces, and it belongs here rather
 * than in each section, because six sections inventing six answers to it is how
 * the settings page drifts apart.
 *
 * It is deliberately **not** `error`. The client cannot tell a hung write from
 * a slow one that will land, so "couldn't save" would be a claim it has no
 * evidence for — and, at the call sites, would trigger a rollback that undoes a
 * value the server may already hold. `stalled` says only what is true: no
 * answer yet. A late `markSaved()`/`markError()` still takes over from it.
 *
 * Only one timer is ever pending — the stall bound while saving, the fade after
 * a save lands, neither after an error — so one ref covers both.
 */
export function useSaveStatus(fadeMs = 2000, stallMs = SAVE_STALL_MS) {
  const [status, setStatus] = useState<SaveStatus>("idle");
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clear = () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };
  useEffect(() => clear, []);

  const markSaving = useCallback(() => {
    clear();
    setStatus("saving");
    timerRef.current = setTimeout(() => setStatus("stalled"), stallMs);
  }, [stallMs]);
  const markSaved = useCallback(() => {
    clear();
    setStatus("saved");
    timerRef.current = setTimeout(() => setStatus("idle"), fadeMs);
  }, [fadeMs]);
  const markError = useCallback(() => {
    clear();
    setStatus("error");
  }, []);

  return { status, markSaving, markSaved, markError };
}

/** Inline, non-blocking auto-save indicator shared by the settings sections. */
export function SaveIndicator({
  status,
  voice,
}: {
  status: SaveStatus;
  voice: Voice;
}) {
  if (status === "saving")
    return (
      <span
        className="text-muted-foreground text-xs"
        role="status"
        data-save-status="saving"
      >
        …
      </span>
    );
  if (status === "saved")
    return (
      <span
        // #109 — `text-green-600` is 3.03:1 at 12px on the light --background,
        // and only ever painted for the moment after a save lands, so every
        // /settings contrast gate scanned an idle page and passed. green-700 is
        // 4.65:1; the dark partner was already correct at 11.06:1.
        className="text-xs text-green-700 dark:text-green-400"
        role="status"
        data-save-status="saved"
      >
        {t("settings.saved", voice)}
      </span>
    );
  if (status === "stalled")
    return (
      <span
        // #227 — amber, not red: this is "we do not know", not "it failed", and
        // the two must not read alike at 12px in a heading band. amber-700 is
        // 4.75:1 on the light --background (amber-600 is 3.00:1 and would trip
        // a11y-class-hygiene's Rule A); the dark partner amber-400 is 11.44:1.
        // Same pair aging-section's demo-override badge uses — #57 settled it
        // for "attention, not alarm", which is precisely this state.
        className="text-xs text-amber-700 dark:text-amber-400"
        // WCAG 4.1.3: announced, not merely painted — but POLITELY. `alert` is
        // reserved for the definite failure below; an unanswered write does not
        // demand that someone be interrupted, and keeping `role="status"` means
        // this replaces the "saving" span's own status region in the same slot
        // rather than inserting a second, assertive one next to it. #218 is
        // about a polite region nested inside an assertive one; the settings
        // indicator stays one flat region.
        role="status"
        data-save-status="stalled"
      >
        {t("settings.saveStalled", voice)}
      </span>
    );
  if (status === "error")
    return (
      <span
        // #109 — `text-red-600` is 4.48:1 at 12px on the light --background: it
        // fails AA by 0.02, which is exactly why nobody caught it by eye.
        // red-700 is 6.04:1, matching the error red already used by
        // status-pill.tsx, people-panel.tsx and delete-account.tsx.
        className="text-xs text-red-700 dark:text-red-400"
        role="alert"
        data-save-status="error"
      >
        {t("settings.saveError", voice)}
      </span>
    );
  return null;
}
