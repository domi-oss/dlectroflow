import { prisma } from "@/lib/db";
import { tryDisconnectGoogle } from "@/lib/google";

/**
 * #126 — deleting an account, and the ONE place allowed to do it.
 *
 * The schema already destroys everything an account owns when its `User` row
 * goes: the workspace and all the content under it, the AI meter, and the
 * Google credential all cascade (`prisma/schema.prisma`), and the allowlist row
 * survives with its `claimedById` set to NULL because the invitation is still a
 * fact. That made `prisma.user.delete` look like a complete deletion. It is not
 * — one thing an account owns is not in this database at all.
 *
 * A cascade removes the stored Google TOKEN. It cannot remove the GRANT, which
 * lives in the person's own Google account and stays listed as active until
 * somebody tells Google otherwise. Deleting the row first destroys the only
 * credential that could have revoked it, so the grant becomes permanently
 * unwithdrawable from this end — and the account it belonged to no longer
 * exists to notice. That is the deletion half of #126.
 *
 * So the order is revoke, then delete. The FK cascade is the BACKSTOP that
 * guarantees no token survives the account; it is not the mechanism by which
 * the connection is ended.
 *
 * There is deliberately no UI behind this. `User.purgeAfter` is written by
 * `revokePerson` and not yet read by anything (Phase D owns that sweep), and
 * erasure requests are served by hand from the published contact address. This
 * function exists so that whatever finally deletes an account — the Phase D
 * purge job, an operator script, a self-service route — cannot do it the wrong
 * way by default; `account-lifecycle.test.ts` enforces that no other module in
 * `src/` deletes a `User` at all.
 */
export async function deleteAccount(userId: string): Promise<boolean> {
  // Best-effort by contract: `tryDisconnectGoogle` reports a failure rather
  // than raising it, so an unreachable Google can never block an erasure — the
  // request has a statutory clock on it, and the person can always withdraw the
  // grant at Google's own permissions page. A failure is logged there.
  await tryDisconnectGoogle(userId);

  // `deleteMany`, not `delete`: deleting an account that is already gone is the
  // outcome the caller asked for, not a P2025 thrown into the middle of a batch.
  const { count } = await prisma.user.deleteMany({ where: { id: userId } });
  return count > 0;
}
