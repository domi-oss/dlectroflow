import { prisma } from "@/lib/db";
import { isOwnerRequest } from "@/lib/workspace";
import { UserRole } from "@/lib/constants";
import type { UserStatus } from "@/lib/constants";
import {
  userQuotaConfig,
  usageViewFor,
  type UserAiUsageView,
} from "@/lib/user-quota";

/**
 * #35 Phase B — the owner-only People read.
 *
 * The design's hard rule is "usage numbers only, never content", and this module
 * is where that has to be true in practice. Three properties hold it up:
 *
 *  1. It reads `User`, `UserAiUsage` and `Allowlist` — models that carry no
 *     `workspaceId` and therefore hold no content. No function here accepts a
 *     workspace id, so there is nothing for a caller to point somewhere else.
 *  2. `llmKeyEnc` IS NEVER SELECTED. "Do they have their own key?" is answered by
 *     a separate query that selects nothing but ids, so the ciphertext never
 *     enters this process's object graph — a mapping mistake or an over-eager
 *     `...spread` into a client component cannot leak what was never loaded.
 *  3. The owner check happens BEFORE the queries and the whole view is `null`
 *     for anyone else, so "forgot to gate the caller" cannot silently read
 *     everybody's numbers. `scoping.harness.test.ts` asserts (1) and (2)
 *     structurally, at source level.
 *
 * Impersonation was explicitly rejected in the design; nothing here takes a
 * workspace id, and there is deliberately no "view as user" path to add one to.
 */

/** One person, as the People panel shows them. No content, no key, no email. */
export type PersonView = {
  id: string;
  /** Provider username, when the provider gave us one. */
  handle: string | null;
  /** What to display: the handle, else a short id. NEVER the email. */
  label: string;
  provider: string;
  role: UserRole;
  status: UserStatus;
  aiPolicy: string;
  lastSeenAt: Date;
  /** The same numbers enforcement uses — see user-quota.ts. */
  usage: UserAiUsageView;
  /** Whether a key is set. A boolean, never the key. */
  hasOwnKey: boolean;
  /** Is this the signed-in owner's own row? (They may not revoke themselves.) */
  isSelf: boolean;
};

/** One invitation. `isOwnerSeed` is deliberately not part of this shape. */
export type InvitationView = {
  id: string;
  provider: string;
  identity: string;
  note: string | null;
  invitedAt: Date;
  claimed: boolean;
};

export type PeopleAdminView = {
  people: PersonView[];
  invitations: InvitationView[];
  /** The rolling window every usage figure above is measured over. */
  windowHours: number;
};

/** Display label for an account with no provider username. */
function labelFor(user: { id: string; handle: string | null }): string {
  return user.handle ?? `#${user.id.slice(0, 8)}`;
}

/**
 * Everything the owner-only People panel renders, or `null` when the caller is
 * not the owner.
 *
 * `selfId` is the signed-in owner's own user id, passed in rather than re-read
 * so the page performs one identity resolution for the whole render.
 */
export async function loadPeopleAdmin(
  selfId?: string,
): Promise<PeopleAdminView | null> {
  if (!(await isOwnerRequest())) return null;

  const { windowHours } = userQuotaConfig();

  const [users, withKeys, invitations] = await Promise.all([
    prisma.user.findMany({
      // Oldest account first — a stable order that does not shuffle as people
      // sign in. The OWNER is hoisted to the top afterwards, in code: doing it
      // here would mean `orderBy: { role: "desc" }`, which only works by the
      // alphabetical accident that "owner" > "member" and would silently break
      // the moment a third role existed. (It was `role: "asc"` — which sorted
      // the owner LAST, caught by eyeballing the !175 screenshots.)
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        provider: true,
        handle: true,
        role: true,
        status: true,
        aiPolicy: true,
        aiQuota: true,
        lastSeenAt: true,
        // The usage row itself, so the panel reports the same window
        // enforcement does without a query per person.
        aiUsage: { select: { count: true, windowStartedAt: true } },
      },
    }),
    // "Has a key" as a boolean, without ever loading the ciphertext. See (2) in
    // the module comment — this is the point of the second query.
    prisma.user.findMany({
      where: { llmKeyEnc: { not: null } },
      select: { id: true },
    }),
    prisma.allowlist.findMany({
      orderBy: { invitedAt: "desc" },
      select: {
        id: true,
        provider: true,
        identity: true,
        note: true,
        invitedAt: true,
        claimedAt: true,
      },
    }),
  ]);

  const keyed = new Set(withKeys.map((u) => u.id));
  // The owner's own row leads: it is theirs, it is the only one they cannot
  // revoke, and it is the one they look at first. A stable partition, so the
  // relative order of everybody else is untouched.
  const ordered = [
    ...users.filter((u) => u.role === UserRole.Owner),
    ...users.filter((u) => u.role !== UserRole.Owner),
  ];

  return {
    windowHours,
    people: ordered.map((u) => ({
      id: u.id,
      handle: u.handle,
      label: labelFor(u),
      provider: u.provider,
      role: u.role as UserRole,
      status: u.status as UserStatus,
      aiPolicy: u.aiPolicy,
      lastSeenAt: u.lastSeenAt,
      usage: usageViewFor(u.aiUsage, u.aiQuota, windowHours),
      hasOwnKey: keyed.has(u.id),
      isSelf: u.id === selfId,
    })),
    invitations: invitations.map((a) => ({
      id: a.id,
      provider: a.provider,
      identity: a.identity,
      note: a.note,
      invitedAt: a.invitedAt,
      claimed: a.claimedAt !== null,
    })),
  };
}
