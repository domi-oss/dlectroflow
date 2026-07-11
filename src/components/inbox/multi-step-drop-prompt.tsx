"use client";

import { useEffect, useRef } from "react";
import { t, type Voice } from "@/lib/strings";

/**
 * Inline prompt shown when an item is dropped onto (or "Move to…"-ed into) the
 * Multi-step bucket: dropping can't silently create steps, so we ask whether to
 * break it down now (→ editor) or just save it for later. Escape cancels.
 */
export function MultiStepDropPrompt({
  itemText,
  voice,
  onBreakNow,
  onSaveLater,
  onCancel,
}: {
  itemText: string;
  voice: Voice;
  onBreakNow: () => void;
  onSaveLater: () => void;
  onCancel: () => void;
}) {
  const firstButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    // Focus the primary action on mount so keyboard/SR users land in the
    // dialog instead of staying on whatever triggered it.
    firstButtonRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t("prompt.breakNow", voice)}
      className="mt-2 space-y-2 rounded-md border bg-background px-3 py-2 text-xs shadow-sm"
    >
      <p className="text-muted-foreground break-words">{itemText}</p>
      <div className="flex flex-wrap gap-2">
        <button
          ref={firstButtonRef}
          type="button"
          onClick={onBreakNow}
          className="bg-primary text-primary-foreground rounded-md px-2.5 py-1 font-medium"
        >
          {t("prompt.breakNow", voice)}
        </button>
        <button type="button" onClick={onSaveLater} className="hover:bg-accent rounded-md border px-2.5 py-1">
          {t("prompt.saveInstead", voice)}
        </button>
        <button type="button" onClick={onCancel} className="text-muted-foreground hover:text-foreground rounded-md px-2.5 py-1">
          {t("action.cancel", voice)}
        </button>
      </div>
    </div>
  );
}
