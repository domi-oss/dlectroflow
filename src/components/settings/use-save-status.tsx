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
        className="text-xs text-green-600 dark:text-green-400"
        role="status"
        data-save-status="saved"
      >
        {t("settings.saved", voice)}
      </span>
    );
  if (status === "error")
    return (
      <span
        className="text-xs text-red-600 dark:text-red-400"
        role="alert"
        data-save-status="error"
      >
        {t("settings.saveError", voice)}
      </span>
    );
  return null;
}
