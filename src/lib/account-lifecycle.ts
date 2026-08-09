import { prisma } from "@/lib/db";
import { tryDisconnectGoogle } from "@/lib/google";
import { UserStatus } from "@/lib/constants";

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
 * `freezeAccount` below and not yet read by anything (Phase D owns that sweep),
 * and the final erasure is served by hand from the published contact address.
 * This function exists so that whatever finally deletes an account — the Phase D
 * purge job, an operator script, a self-service route — cannot do it the wrong
 * way by default; `account-lifecycle.test.ts` enforces that no other module in
 * `src/` deletes a `User` at all.
 */
export async function deleteAccount(userId: string): Promise<boolean> {
  // Best-effort by contract: `tryDisconnectGoogle` reports a failure rather
  // than raising it, so an unreachable Google can never block an erasure — the
  // request has a statutory clock on it, and the person can always withdraw the
  // grant at Google's own permissions page. Both failure modes are logged
  // there, and this is the path where the cascade earns its keep: if the tokens
  // could not be DELETED, the row still goes when the user does, two lines
  // below. What no cascade can do is the revoke, which is why it goes first.
  await tryDisconnectGoogle(userId);

  // `deleteMany`, not `delete`: deleting an account that is already gone is the
  // outcome the caller asked for, not a P2025 thrown into the middle of a batch.
  const { count } = await prisma.user.deleteMany({ where: { id: userId } });
  return count > 0;
}

/**
 * Freeze-then-purge window, in days. Phase D's sweep is what will act on
 * `purgeAfter`; until then the window is a RECOVERY period rather than a
 * countdown, and every piece of copy that mentions it says so (see
 * `src/components/settings/delete-account.tsx` and /privacy's retention list).
 */
export const PURGE_GRACE_DAYS = 30;

/**
 * #153 — freeze one account: withdraw its Google grant, stop it acting now, and
 * stamp the 30-day window its data is kept for.
 *
 * This lived inline in `revokePerson` (src/app/actions/people.ts) until a SECOND
 * caller needed it. It moved here rather than being written twice, because the
 * sequence has three properties that a re-implementation would lose one at a
 * time, and two of them are silent when lost:
 *
 *  1. THE GOOGLE REVOKE COMES FIRST, and it is a revoke AT GOOGLE, not a local
 *     token delete (#126). Whichever step runs first is the one that survives a
 *     crash between them, and "active account, no Google connection" is
 *     recoverable by reconnecting while "frozen account, live grant" is exactly
 *     the state this ordering exists to prevent: a frozen account resolves to
 *     `null` in `currentUser()` and can no longer reach its own Disconnect
 *     control, so the grant becomes one its owner cannot withdraw through the
 *     product. Consent that cannot be withdrawn as easily as it was given is
 *     what UK GDPR Art. 7(3) forbids.
 *  2. IT IS BEST-EFFORT ABOUT GOOGLE AND UNCONDITIONAL ABOUT THE FREEZE.
 *     `tryDisconnectGoogle` reports rather than raises, so an unreachable Google
 *     can never leave an account unfrozen — stopping access is the part that
 *     cannot wait. Both ways it can fall short are logged there
 *     (`google_disconnect_failed`, with the reason) rather than papered over.
 *  3. `status: active` IS PART OF THE FILTER, not merely something the caller
 *     checked. That is what makes a second freeze idempotent AND keeps the
 *     original `revokedAt`: re-revoking must not push the purge date out.
 *
 * The freeze takes effect on the NEXT REQUEST rather than at the next sign-in,
 * and #220 is the issue that made that true rather than merely written down.
 * This comment used to name `currentUser()` as the whole mechanism. It was
 * accurate about pages and roles and wrong about every write: only a minority of
 * the action files go through `currentUser()`, and the rest resolve a workspace
 * id and write — `currentWorkspaceId()`, which read the signed token and never
 * looked at `status`. So a frozen account kept writing for the 30 days its
 * cookie had left, while `people-panel.tsx` rendered it as "Revoked".
 *
 * Both halves re-read it now, and each pays for its own read:
 *
 *  - `currentUser()` selects `status` alongside `role` — pages, role checks and
 *    the identity in the header.
 *  - `currentWorkspaceId()` refuses a workspace whose owner is not active, with
 *    the status carried back on the `touchWorkspace` upsert it was issuing
 *    anyway, so the write path gained no round trip. It also clears the session
 *    cookie where the framework allows it, so the person is signed out rather
 *    than meeting silent failures. Both are in src/lib/workspace.ts, and
 *    `scoping.harness.test.ts` is what stops a third resolver appearing without
 *    the check.
 *
 * No data is touched: this schedules, it does not destroy. `deleteAccount` above
 * is the only thing in `src/` that destroys.
 *
 * Returns whether an ACTIVE account was frozen — false for an unknown id and
 * for one that was already revoked. The two are deliberately indistinguishable
 * from here; the caller knows which it asked for.
 */
export async function freezeAccount(userId: string): Promise<boolean> {
  await tryDisconnectGoogle(userId);

  const now = new Date();
  const { count } = await prisma.user.updateMany({
    where: { id: userId, status: UserStatus.Active },
    data: {
      status: UserStatus.Revoked,
      revokedAt: now,
      purgeAfter: new Date(now.getTime() + PURGE_GRACE_DAYS * 86_400_000),
    },
  });
  return count > 0;
}
