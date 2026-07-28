import { prisma } from "@/lib/db";
import { WorkspaceKind } from "@/lib/constants";

/**
 * Is this workspace a guest sandbox?
 *
 * #35 Phase A replaced the synchronous `workspaceId !== OWNER_WORKSPACE_ID`
 * version. That one only worked because there was exactly one non-guest
 * workspace with a magic id; with per-user workspaces every id is opaque, and
 * the old check would have quietly classified every signed-in account as a
 * guest — no AI narrative, no round-up email, a blanked email field on save.
 *
 * So the answer comes from the database, where the workspace's kind now lives.
 * Deliberately kept in its own module (rather than on `@/lib/workspace`) so the
 * pure data-layer callers — spark, rollup, focus — don't pull `next/headers`
 * into their import graph.
 *
 * Fails CLOSED: an unknown workspace is treated as a guest, because every
 * caller uses this to gate a privileged capability (calling the LLM, sending
 * mail). Guessing "guest" costs a fallback quote; guessing wrong the other way
 * spends the instance's API budget or emails a stranger.
 */
export async function isGuestWorkspace(workspaceId: string): Promise<boolean> {
  const ws = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { kind: true },
  });
  return ws?.kind !== WorkspaceKind.User;
}
