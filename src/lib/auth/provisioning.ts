import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import type { AuthProfile } from "@/lib/auth/providers";
import { UserRole, UserStatus, WorkspaceKind } from "@/lib/constants";
import type { UserRole as UserRoleValue } from "@/lib/constants";

/**
 * #35 Phase A — the allowlist → account decision, in one testable place.
 *
 * This is the security boundary of the accounts feature. It lives outside the
 * OAuth callback so the deny paths can be driven directly against a real
 * database (see provisioning.integration.test.ts), including the assertion that
 * matters most: a denial creates no `User` row at all.
 */
export type ProvisionResult =
  | {
      ok: true;
      userId: string;
      workspaceId: string;
      role: UserRoleValue;
    }
  | { ok: false; reason: "not_invited" | "revoked" };

/**
 * The identities an invitation may have been typed as, most specific first.
 *
 * `subject` is included deliberately. The env var this allowlist is seeded from
 * documents itself as "GitLab numeric user id" (.env.example), i.e. the
 * subject — so matching username/email only, as the design sketched it, would
 * seed the owner's own invitation in a form that could never match and lock
 * them out of their instance on the first deploy. An invite typed as a stable
 * provider id is a legitimate invite, and a stricter one than a username.
 */
function candidateIdentities(profile: AuthProfile): string[] {
  const raw = [profile.username, profile.email, profile.subject];
  const seen = new Set<string>();
  for (const value of raw) {
    const v = value?.trim().toLowerCase();
    if (v) seen.add(v);
  }
  return [...seen];
}

/** Shape returned to the caller for an account that already exists. */
function resultFor(user: {
  id: string;
  role: string;
}): Omit<Extract<ProvisionResult, { ok: true }>, "workspaceId"> {
  return {
    ok: true,
    userId: user.id,
    role: user.role as UserRoleValue,
  };
}

/**
 * Resolve an OAuth profile to an account, creating one only if an unclaimed
 * invitation matches.
 *
 * Callers MUST render the same message for both failure reasons — a distinct
 * "you were revoked" would let anyone probe whether an identity is known to the
 * instance. See the OAuth callback.
 */
export async function provisionFromProfile(
  provider: string,
  profile: AuthProfile,
): Promise<ProvisionResult> {
  return provision(provider, profile, 0);
}

// A lost race is re-driven from the top exactly once: the second pass either
// finds the account the winner created (same human, two tabs) or finds the
// invitation claimed by somebody else and denies. `attempt` bounds it so a
// pathological state can't spin.
const MAX_RACE_RETRIES = 1;

async function provision(
  provider: string,
  profile: AuthProfile,
  attempt: number,
): Promise<ProvisionResult> {
  const existing = await prisma.user.findUnique({
    where: {
      provider_providerSub: { provider, providerSub: profile.subject },
    },
    include: { workspace: { select: { id: true } } },
  });

  if (existing) {
    // Never silently re-provision a revoked account: revocation must survive a
    // fresh OAuth round trip, and must win even if an invitation still exists.
    if (existing.status === UserStatus.Revoked) {
      return { ok: false, reason: "revoked" };
    }
    const updated = await prisma.user.update({
      where: { id: existing.id },
      data: {
        lastSeenAt: new Date(),
        // Keep the last known values if the provider stops returning one,
        // rather than blanking a handle we already had.
        ...(profile.username ? { handle: profile.username } : {}),
        ...(profile.email ? { email: profile.email } : {}),
      },
      select: { id: true, role: true },
    });
    // Self-heal a user whose workspace is missing (an interrupted first
    // sign-in, or a hand-repaired database) rather than throwing a 500 at
    // someone who is legitimately signed in.
    const workspaceId =
      existing.workspace?.id ?? (await ensureWorkspace(existing.id));
    return { ...resultFor(updated), workspaceId };
  }

  const identities = candidateIdentities(profile);
  if (identities.length === 0) return { ok: false, reason: "not_invited" };

  const invite = await prisma.allowlist.findFirst({
    where: { provider, identity: { in: identities }, claimedById: null },
    // Deterministic pick when a person was invited twice (say by username and
    // by email): the oldest invitation is the one that gets claimed.
    orderBy: { invitedAt: "asc" },
    select: { id: true, isOwnerSeed: true },
  });
  if (!invite) {
    // Not necessarily a denial. The user lookup and this one are two separate
    // reads, so a concurrent first sign-in for the SAME subject can commit
    // between them: the first read saw no account, this one sees the invitation
    // already claimed. Re-drive once if an account for this subject now exists —
    // otherwise the second tab of the same human gets told they weren't invited.
    if (attempt < MAX_RACE_RETRIES && (await userExists(provider, profile))) {
      return provision(provider, profile, attempt + 1);
    }
    return { ok: false, reason: "not_invited" };
  }

  try {
    return await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          provider,
          providerSub: profile.subject,
          handle: profile.username,
          email: profile.email,
          // The ONLY path that mints an owner, and it reads a dedicated
          // boolean set solely by the deploy-time OWNER_ALLOWLIST seed.
          role: invite.isOwnerSeed ? UserRole.Owner : UserRole.Member,
        },
        select: { id: true, role: true },
      });
      const ws = await tx.workspace.create({
        data: { kind: WorkspaceKind.User, userId: user.id },
        select: { id: true },
      });
      // updateMany with `claimedById: null` still in the filter closes the
      // window between the findFirst above and this write: if a concurrent
      // sign-in claimed the same invitation first, this matches zero rows and
      // the throw rolls the whole transaction back, user included.
      const claimed = await tx.allowlist.updateMany({
        where: { id: invite.id, claimedById: null },
        data: { claimedById: user.id, claimedAt: new Date() },
      });
      if (claimed.count !== 1) {
        throw new InviteAlreadyClaimedError();
      }
      return {
        ok: true as const,
        userId: user.id,
        workspaceId: ws.id,
        role: user.role as UserRoleValue,
      };
    });
  } catch (err) {
    // Both failures mean "a concurrent sign-in got there first": either it
    // claimed this invitation (InviteAlreadyClaimedError) or it created the
    // account under the unique (provider, providerSub) index (P2002). Neither
    // is an error condition — re-drive once and let the second pass decide. If
    // the winner is the same human's other tab it resolves to their account; if
    // it was somebody else claiming the invite, it denies with not_invited.
    const lostRace =
      err instanceof InviteAlreadyClaimedError ||
      (err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === "P2002");
    if (lostRace && attempt < MAX_RACE_RETRIES) {
      return provision(provider, profile, attempt + 1);
    }
    if (lostRace) return { ok: false, reason: "not_invited" };
    throw err;
  }
}

/**
 * Create the missing workspace for an existing account, tolerating a race.
 *
 * `Workspace.userId` is unique, so two concurrent sign-ins can never produce
 * two workspaces — but without this the loser's `create` rejects with P2002 and
 * the user gets a 500 on sign-in (Duo review, !169). Re-read instead: the
 * winner's row is the answer for both.
 */
async function ensureWorkspace(userId: string): Promise<string> {
  try {
    const ws = await prisma.workspace.create({
      data: { kind: WorkspaceKind.User, userId },
      select: { id: true },
    });
    return ws.id;
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      const ws = await prisma.workspace.findUnique({
        where: { userId },
        select: { id: true },
      });
      if (ws) return ws.id;
    }
    throw err;
  }
}

/** Cheap indexed existence check used only on the deny path (see above). */
async function userExists(
  provider: string,
  profile: AuthProfile,
): Promise<boolean> {
  const found = await prisma.user.findUnique({
    where: {
      provider_providerSub: { provider, providerSub: profile.subject },
    },
    select: { id: true },
  });
  return found !== null;
}

class InviteAlreadyClaimedError extends Error {
  constructor() {
    super("invitation was claimed concurrently");
    this.name = "InviteAlreadyClaimedError";
  }
}

/** Re-exported so callers can compare against the canonical value set. */
export { UserRole };
