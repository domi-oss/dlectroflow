"use client";

import { useState } from "react";
import type { BucketId } from "./bucket";
import { t, type Voice, type StringKey } from "@/lib/strings";

// Menu order + the section string each bucket shows as its label.
const BUCKET_ORDER: BucketId[] = ["needsReview", "multiStep", "singleTask", "savedLater", "completed"];
const BUCKET_LABEL: Record<BucketId, StringKey> = {
  needsReview: "section.needsReview",
  multiStep: "section.multiStep",
  singleTask: "section.singleTask",
  savedLater: "section.savedLater",
  completed: "section.completed",
};

/**
 * Keyboard/screen-reader accessible "Move to…" menu — the non-pointer fallback
 * for drag. Shares the same move dispatch as drag (the parent's onMove →
 * moveItemToBucket), so the two paths can't diverge.
 */
export function MoveToMenu({
  currentBucket,
  voice,
  onMove,
}: {
  currentBucket: BucketId;
  voice: Voice;
  onMove: (target: BucketId) => void;
}) {
  const [open, setOpen] = useState(false);
  const targets = BUCKET_ORDER.filter((b) => b !== currentBucket);

  return (
    <span className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="text-muted-foreground hover:text-foreground rounded-md border px-2 py-1 text-xs"
      >
        {t("action.moveTo", voice)}
      </button>
      {open && (
        <span
          role="menu"
          className="bg-background absolute right-0 z-10 mt-1 flex min-w-40 flex-col rounded-md border p-1 text-xs shadow-md"
        >
          {targets.map((b) => (
            <button
              key={b}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                onMove(b);
              }}
              className="hover:bg-accent rounded px-2 py-1 text-left"
            >
              {t(BUCKET_LABEL[b], voice)}
            </button>
          ))}
        </span>
      )}
    </span>
  );
}
