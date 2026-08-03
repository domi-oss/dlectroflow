"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { t, type Voice } from "@/lib/strings";

export type SaveStatus = "idle" | "saving" | "saved" | "error";

/**
 * Transient auto-save status. `markSaved()` shows the "Saved ✓" affordance and
 * fades it back to idle after `fadeMs`; `markError()` sticks until the next
 * save attempt (so a failed write stays visible while the field stays editable).
 */
export function useSaveStatus(fadeMs = 2000) {
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
  }, []);
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
