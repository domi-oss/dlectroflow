// Pure derivation — no React, no DB — so the resume-banner target step is
// unit-testable in a plain node env (mirrors bucket.ts).

import type { Item } from "@/components/inbox/bucket";

export type ResumeStepTarget = { id: string; text: string };

/**
 * First resumable, NOT-done step across `items` (assumed createdAt-desc,
 * matching the Inbox page's query order), or null if none.
 *
 * `resumable` means "has an unfinished FocusSession" — a heuristic, not a
 * true pause/resume (see #25). After a pause→resume→complete cycle the
 * step's *original* FocusSession is never closed (only the resumed
 * session's row is), so a COMPLETED step can still read `resumable: true`.
 * The `!st.done` guard here keeps the Inbox resume banner from pointing at
 * a step that's already finished — task-steps.tsx guards the same way.
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
