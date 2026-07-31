import { prisma } from "@/lib/db";

/**
 * #111 — "has this workspace EVER held anything?", which is the only honest way
 * to tell a NEW account from an EMPTIED one.
 *
 * Counting what is on screen cannot answer it. The inbox page's own query
 * excludes archived items, and captures are HARD-deleted (see
 * deleteBrainDumpItem), so "captured three things and deleted them all" and
 * "signed in five seconds ago" both render zero rows. Getting that wrong in the
 * generous direction is the worse error: telling someone who really did have
 * data that their account is "new" is the exact data-loss ambiguity #74/#100
 * exist to remove.
 *
 * So this asks four tables, each for a different reason:
 *
 *  • `brainDumpItem` — captures of ANY status, archived and completed included.
 *    An account that finished everything still has everything.
 *  • `task` — a Task can outlive the capture it came from (`BrainDumpItem.taskId`
 *    is `onDelete: SetNull`), so content can exist with no item pointing at it.
 *  • `rewardEvent` — the trace deletion does NOT remove. Deleting the last item
 *    runs `maybeAwardInboxZero()`, which writes one; so does every completed
 *    step, confirmed breakdown and finished session. This is what catches the
 *    account that emptied itself completely.
 *  • `badge` — awarded once ever and never deleted; the longest-lived trace of
 *    all, and the backstop if a reward-event retention policy ever appears.
 *
 * Four round trips, so the CALLER decides when to ask: the inbox page only calls
 * this when it has already rendered zero items for a signed-in account, which is
 * the one request where the answer changes anything. Every probe is
 * workspace-scoped (the scoping invariant) and selects the id only — this is a
 * "does a row exist" question and has no business reading a capture's text.
 */
export async function workspaceHasHistory(
  workspaceId: string,
): Promise<boolean> {
  const [item, task, reward, badge] = await Promise.all([
    prisma.brainDumpItem.findFirst({
      where: { workspaceId },
      select: { id: true },
    }),
    prisma.task.findFirst({ where: { workspaceId }, select: { id: true } }),
    prisma.rewardEvent.findFirst({
      where: { workspaceId },
      select: { id: true },
    }),
    prisma.badge.findFirst({ where: { workspaceId }, select: { id: true } }),
  ]);
  return [item, task, reward, badge].some((row) => row !== null);
}

/**
 * #111 — should an empty inbox read as "new account" or as "inbox zero"?
 *
 * Pure, so the distinction the issue is actually about is testable without a
 * database. Note what is NOT an input: whether anyone is signed in. A guest has
 * no account to name and already gets the sandbox banner, so the caller keeps
 * that decision (it holds the identity; this holds the emptiness).
 */
export function emptyInboxIsNewAccount({
  visibleItems,
  hasHistory,
  firstRunPreview,
}: {
  /** Rows the inbox is about to render — the page's post-filter count. */
  visibleItems: number;
  /** `workspaceHasHistory()`, or `false` when the caller skipped the query. */
  hasHistory: boolean;
  /**
   * Settings' first-run preview (#8) shows the inbox "as a brand-new workspace
   * would see it" while the real rows stay in the database. It has to win over
   * both other inputs, or the preview would be the one first-run surface a
   * brand-new workspace never sees.
   */
  firstRunPreview: boolean;
}): boolean {
  if (firstRunPreview) return true;
  return visibleItems === 0 && !hasHistory;
}
