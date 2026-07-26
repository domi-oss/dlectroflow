// Pure derivation — no React, no DB — so the resume-banner target step is
// unit-testable in a plain node env (mirrors bucket.ts).

import type { Item } from "@/components/inbox/bucket";

export type ResumeStepTarget = { id: string; text: string };

/**
 * First resumable, NOT-done step across `items` (assumed createdAt-desc,
 * matching the Inbox page's query order), or null if none.
 *
 * `resumable` means the step has a TRULY PAUSED FocusSession (`pausedAt` set)
 * — true pause/resume (#27), not the old "has an unfinished session"
 * heuristic. `completeFocus`/`beginFocus` always close out the session they
 * touch, so a done step's session should already be ended; the `!st.done`
 * guard here is defense-in-depth (kept from the pre-#27 heuristic) rather
 * than the load-bearing fix — task-steps.tsx guards the same way.
 */
export function firstResumableStep(
  items: Pick<Item, "steps">[],
): ResumeStepTarget | null {
  for (const it of items) {
    const s = it.steps.find((st) => st.resumable && !st.done);
    if (s) return { id: s.id, text: s.text };
  }
  return null;
}
