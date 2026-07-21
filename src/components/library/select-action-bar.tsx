"use client";
import { useState } from "react";
import { t, type Voice } from "@/lib/strings";

/**
 * Sticky bulk-action bar shown while selecting. Delete is a two-step confirm
 * mirroring the row delete: first tap swaps to "Delete these? · Confirm ·
 * Cancel". Actions are disabled while none are selected or a call is pending.
 */
export function SelectActionBar({
  count,
  voice,
  pending,
  onComplete,
  onSaveForLater,
  onDelete,
}: {
  count: number;
  voice: Voice;
  pending: boolean;
  onComplete: () => void;
  onSaveForLater: () => void;
  onDelete: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const disabled = count === 0 || pending;
  return (
    <div className="bg-secondary/60 sticky bottom-2 z-10 flex items-center gap-2 rounded-lg border px-3 py-2 text-sm backdrop-blur">
      <span className="font-medium">
        {count} {t("lib.selected", voice)}
      </span>
      <span className="flex-1" />
      {confirming ? (
        <>
          <span className="text-muted-foreground">
            {t("lib.deleteConfirm", voice)}
          </span>
          <button
            className="text-destructive rounded-md px-2.5 py-1 font-medium disabled:opacity-50"
            disabled={disabled}
            onClick={() => {
              setConfirming(false);
              onDelete();
            }}
          >
            {t("action.delete", voice)}
          </button>
          <button
            className="text-muted-foreground rounded-md px-2.5 py-1"
            onClick={() => setConfirming(false)}
          >
            {t("action.cancel", voice)}
          </button>
        </>
      ) : (
        <>
          <button
            className="hover:bg-accent rounded-md border px-2.5 py-1 disabled:opacity-50"
            disabled={disabled}
            onClick={onComplete}
          >
            {t("action.complete", voice)}
          </button>
          <button
            className="hover:bg-accent rounded-md border px-2.5 py-1 disabled:opacity-50"
            disabled={disabled}
            onClick={onSaveForLater}
          >
            {t("action.saveForLater", voice)}
          </button>
          <button
            className="text-destructive rounded-md border px-2.5 py-1 disabled:opacity-50"
            disabled={disabled}
            onClick={() => setConfirming(true)}
          >
            {t("action.delete", voice)}
          </button>
        </>
      )}
    </div>
  );
}
