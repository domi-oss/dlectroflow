"use client";

import { t } from "@/lib/strings";
import type { Voice } from "@/lib/strings";

/**
 * The secondary "Complete" button every inbox bucket row shows — one source for
 * its styling instead of many copies. Shared with the TaskSteps step rows so a
 * step's Complete affordance is visually identical to an inbox row's. Takes the
 * resolved `voice` (label via `t("action.complete", voice)`) + an `onClick`.
 */
export function CompleteButton({ voice, onClick }: { voice: Voice; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="hover:bg-accent rounded-md border px-2.5 py-1"
    >
      {t("action.complete", voice)}
    </button>
  );
}
