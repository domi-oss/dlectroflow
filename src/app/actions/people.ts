"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { isOwnerRequest, currentUser } from "@/lib/workspace";
import { freezeAccount } from "@/lib/account-lifecycle";
import { AiPolicy } from "@/lib/constants";

/**
 * #35 Phase B — the owner-only People actions.
 *
 * These four writes are the entire mutable surface of the People panel, and each
 * one is gated on `isOwnerRequest()` independently: a server action is a public
 * POST endpoint, so gating the page that renders the form gates nothing.
 *
 * Two things are deliberately NOT writable from here:
 *
 *  • `Allowlist.isOwnerSeed` — the only thing that mints an owner, set solely by
 *    the deploy-time `OWNER_ALLOWLIST` seed (prisma/seed-allowlist.ts). The
 *    People panel invites members and must not be able to grant ownership at all.
 *  • `User.role` — for the same reason, from the other direction.
 *
 * No action here takes a workspace id, and none reads a content model, so the
 * design's "usage numbers only, never content" rule survives the write path too.
 */

/** Every action reports its outcome so the panel can say what happened. */
export type PeopleActionResult =
  | { ok: true }
  | {
      ok: false;
      error:
        | "not_allowed"
        | "invalid_identity"
        | "already_invited"
        | "invalid_policy"
        | "not_found"
        | "cannot_revoke_self";
    };

/**
 * Longest identity we will store. A provider username or an email; 320 is the
 * maximum length of an email address (64 local + @ + 255 domain), so anything
 * longer is not an identity anybody could sign in with.
 */
const MAX_IDENTITY_LENGTH = 320;

/** Longest note. Free text, so it is bounded rather than trusted. */
const MAX_NOTE_LENGTH = 200;

/**
 * Upper bound on a per-user quota, mirrored by the `User_aiQuota_check`
 * constraint (>= 0) and this clamp (<= 10000). A five-figure monthly breakdown
 * allowance is already far beyond any real use; the clamp exists so a typo in a
 * number field cannot quietly turn a capped account into an uncapped one.
 */
const MAX_AI_QUOTA = 10_000;

const NOT_ALLOWED = { ok: false, error: "not_allowed" } as const;

/**
 * Invite an identity.
 *
 * `identity` is stored lowercased and trimmed because that is exactly how
 * `provisionFromProfile` normalises an incoming OAuth profile before matching
 * (src/lib/auth/provisioning.ts) — the two have to agree or the invitation can
 * never be claimed. The provider comes from `AUTH_PROVIDER`, not from the form:
 * an invitation for a provider this instance cannot authenticate is unclaimable,
 * and letting the client choose invites exactly that mistake.
 */
export async function invitePerson(input: {
  identity: string;
  note?: string;
}): Promise<PeopleActionResult> {
  if (!(await isOwnerRequest())) return NOT_ALLOWED;

  const identity = input.identity.trim().toLowerCase();
  // A blank invitation is not a harmless no-op: `candidateIdentities` skips
  // empty values, but a stored "" would sit in the table looking like an invite
  // that nobody can explain.
  if (!identity || identity.length > MAX_IDENTITY_LENGTH) {
    return { ok: false, error: "invalid_identity" };
  }
  const note = input.note?.trim().slice(0, MAX_NOTE_LENGTH) || null;

  // The (provider, identity) unique index — an existing invitation is
  // information, not a failure, and this is the one of #158's four sites with
  // no concurrency in it at all: an owner inviting the same person twice is the
  // ordinary path, and it printed `prisma:error` every single time. Nothing
  // reads the created row, so `skipDuplicates` answers with a count instead:
  // 0 means the row was already there.
  //
  // `ON CONFLICT DO NOTHING` carries no conflict target, so ANY unique index on
  // Allowlist skips rather than raises — which is exactly what catching P2002
  // did (it matched the code, never the columns). `claimedById` is the only
  // other one, and it is not written here.
  const { count } = await prisma.allowlist.createMany({
    data: {
      provider: process.env.AUTH_PROVIDER ?? "gitlab",
      identity,
      note,
    },
    skipDuplicates: true,
  });
  if (count === 0) return { ok: false, error: "already_invited" };

  revalidatePath("/settings");
  return { ok: true };
}

/**
 * Withdraw an UNCLAIMED invitation (a typo, or someone who never joined).
 *
 * `claimedById: null` stays in the filter deliberately. A claimed row is the
 * record that an account exists and how it got in; deleting it would drop that
 * trail while leaving the account signed in and working. Removing somebody who
 * has actually joined is `revokePerson`.
 */
export async function withdrawInvitation(
  id: string,
): Promise<PeopleActionResult> {
  if (!(await isOwnerRequest())) return NOT_ALLOWED;
  if (!id.trim()) return { ok: false, error: "not_found" };

  const res = await prisma.allowlist.deleteMany({
    where: { id, claimedById: null },
  });
  if (res.count === 0) return { ok: false, error: "not_found" };

  revalidatePath("/settings");
  return { ok: true };
}

/**
 * Set one account's AI policy and quota.
 *
 * `aiPolicy` is allowlist-validated against `AiPolicy` so a bad value can never
 * reach the DB (it mirrors the `User_aiPolicy_check` constraint), and the quota
 * is clamped to a whole number in `[0, MAX_AI_QUOTA]` to mirror
 * `User_aiQuota_check`. `updateMany` rather than `update` so a vanished account
 * reports a miss instead of throwing P2025 at the panel.
 */
export async function updatePersonAiPolicy(input: {
  userId: string;
  aiPolicy: string;
  aiQuota: number;
}): Promise<PeopleActionResult> {
  if (!(await isOwnerRequest())) return NOT_ALLOWED;

  if (!(Object.values(AiPolicy) as string[]).includes(input.aiPolicy)) {
    return { ok: false, error: "invalid_policy" };
  }
  const aiQuota = Number.isFinite(input.aiQuota)
    ? Math.min(MAX_AI_QUOTA, Math.max(0, Math.round(input.aiQuota)))
    : 0;

  const res = await prisma.user.updateMany({
    where: { id: input.userId },
    data: { aiPolicy: input.aiPolicy, aiQuota },
  });
  if (res.count === 0) return { ok: false, error: "not_found" };

  revalidatePath("/settings");
  return { ok: true };
}

/**
 * Revoke an account: withdraw its Google grant, freeze it now, and schedule its
 * data for purge in 30 days.
 *
 * The sequence itself is `freezeAccount` (src/lib/account-lifecycle.ts) — #153
 * gave it a second caller, so it moved next to `deleteAccount` where the rest of
 * the account lifecycle lives. Read its docblock for why the Google revoke comes
 * first, why the freeze runs whatever Google says, and why `status: active` is
 * in the filter. What stays HERE is the only part that is about this panel: who
 * is allowed to ask.
 *
 * The owner cannot revoke themselves: they are the only account that can manage
 * people, so freezing it would lock the instance's administration away with no
 * route back through the UI. #153's self-serve deletion carries the same refusal
 * for the same reason (`owner_cannot_delete` in src/app/actions/account.ts).
 *
 * The Google result is deliberately not surfaced to the owner. `false` is only
 * reachable when a token EXISTED, so a message about it would tell the owner
 * whether that member had connected Google — the one thing the People panel is
 * designed never to disclose (src/lib/people.ts, and the Privacy Policy's "does
 * not even disclose whether you have one").
 */
export async function revokePerson(
  userId: string,
): Promise<PeopleActionResult> {
  if (!(await isOwnerRequest())) return NOT_ALLOWED;

  const me = await currentUser();
  if (me && me.id === userId) {
    return { ok: false, error: "cannot_revoke_self" };
  }

  if (!(await freezeAccount(userId))) return { ok: false, error: "not_found" };

  revalidatePath("/settings");
  return { ok: true };
}
