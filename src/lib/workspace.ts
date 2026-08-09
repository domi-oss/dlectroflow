import { cookies, headers } from "next/headers";
import { prisma } from "@/lib/db";
import {
  verifySession,
  OWNER_COOKIE,
  GUEST_COOKIE,
  GUEST_WS_HEADER,
} from "@/lib/auth/session";
import { authConfig } from "@/lib/auth/config";
import { UserRole, UserStatus, WorkspaceKind } from "@/lib/constants";
import { guestSandboxTtlHours } from "@/lib/purge";

export class MissingWorkspaceError extends Error {
  constructor() {
    super("No workspace context on request");
    this.name = "MissingWorkspaceError";
  }
}

/**
 * #220 — the session is cryptographically valid, but the account behind it has
 * been frozen (`User.status = revoked`, see `freezeAccount`).
 *
 * A SUBCLASS of MissingWorkspaceError rather than a sibling, and that is the
 * load-bearing decision in this fix. Every handler that already narrows on
 * MissingWorkspaceError treats it as "no usable session and no workspace to
 * scope to", which is exactly the right answer here — `/api/export` answers 401
 * instead of 500, `hasSession()` would report false, and every action file
 * inherits the refusal without a line changed. More to the point it
 * fails closed for code that does not exist yet: a future handler written
 * knowing only about MissingWorkspaceError cannot accidentally let a frozen
 * account through, because there is no narrower branch for it to miss.
 *
 * The message stays deliberately uninformative for the same reason
 * `/api/export`'s 401 says "Not signed in": whoever holds the cookie already
 * knows whose it is, and nothing downstream should start rendering copy off an
 * exception type.
 */
export class RevokedAccountError extends MissingWorkspaceError {
  constructor() {
    super();
    this.name = "RevokedAccountError";
  }
}

/** A workspace's kind is a fact about the session that produced it, so it is
 *  returned alongside the id rather than re-derived from the id's shape. */
export type ResolvedWorkspace = {
  id: string;
  kind: typeof WorkspaceKind.User | typeof WorkspaceKind.Guest;
};

/** The signed-in account behind the current request, or null. */
export type CurrentUser = {
  id: string;
  role: UserRole;
  workspaceId: string;
  /** Which provider authenticated this session — `User.provider`. #74 requires
   *  it to be stated wherever identity is shown, so it travels with the
   *  identity rather than being re-derived from `AUTH_PROVIDER` (which is the
   *  CURRENT setting, not the one this account was provisioned under). */
  provider: string;
  /** Provider username, lowercased at the boundary; `null` when the provider
   *  withheld one (`AuthProfile.username` is optional). */
  handle: string | null;
};

/**
 * Which workspace does this request's tokens point at?
 *
 * **Token-level only, by design (#220).** This answers "what is signed here",
 * not "may this account act" — it performs no database read at all, and the
 * account's `status` is therefore invisible to it. The status check lives one
 * level up, in {@link currentWorkspaceId}, where a database round trip already
 * happens and can carry it for free; see the comment there for why it is not
 * here.
 *
 * That split is why this function is NOT exported beyond this module's own
 * tests, and why `scoping.harness.test.ts` fails if another module starts
 * calling it: reaching past `currentWorkspaceId()` for a workspace id is exactly
 * how a status-blind write path would come back.
 */
export async function resolveWorkspace(input: {
  owner?: string;
  guest?: string;
  header?: string;
}): Promise<ResolvedWorkspace> {
  const { sessionSecret } = authConfig();
  if (input.owner) {
    const p = await verifySession(input.owner, sessionSecret);
    // #35 Phase A: the signed-in account's OWN workspace, carried in the signed
    // token. Pre-accounts this returned the constant OWNER_WORKSPACE_ID, which
    // is exactly the binary this phase removes.
    if (p?.kind === "user") return { id: p.wsId, kind: WorkspaceKind.User };
  }
  if (input.guest) {
    const p = await verifySession(input.guest, sessionSecret);
    if (p?.kind === "guest") return { id: p.wsId, kind: WorkspaceKind.Guest };
  }
  if (input.header) {
    const p = await verifySession(input.header, sessionSecret);
    if (p?.kind === "guest") return { id: p.wsId, kind: WorkspaceKind.Guest };
  }
  throw new MissingWorkspaceError();
}

export async function resolveWorkspaceId(input: {
  owner?: string;
  guest?: string;
  header?: string;
}): Promise<string> {
  return (await resolveWorkspace(input)).id;
}

/** What {@link touchWorkspace} learned about the workspace on the way past. */
export type TouchedWorkspace = {
  /**
   * `User.status` of the account that owns this workspace, or null when no
   * account does — which is the normal, correct answer for a guest sandbox.
   *
   * A string rather than the `UserStatus` union: it comes back from Postgres,
   * where the column is a CHECK-constrained String (see `prisma/schema.prisma`
   * and `enum-constraint-sync`). Narrowing it here would be asserting a fact
   * about the database rather than reading one, and the caller compares it for
   * equality with `UserStatus.Active` anyway — which fails closed against a
   * value neither side has heard of.
   */
  ownerStatus: string | null;
};

/**
 * Record activity on a workspace, creating it if this is the first sighting,
 * and report the status of the account that owns it.
 *
 * `kind` is passed in rather than inferred from the id: a workspace's kind is a
 * database fact, and with per-user workspaces there is no longer any id shape to
 * infer it from. Getting it wrong on a user workspace would stamp an
 * `expiresAt` and let the guest-retention purge sweep a real account's data.
 *
 * ## Why the status rides along here (#220)
 *
 * The obvious fix for #220 was a `prisma.user.findUnique` in
 * `resolveWorkspace`'s user branch. That branch does no database work at all, so
 * it would have added a whole round trip to every authenticated request — and it
 * would have added one to `hasSession()` too, whose entire reason to exist (#61)
 * is that it does none.
 *
 * This upsert, by contrast, ALREADY runs on every `currentWorkspaceId()` call.
 * Selecting the owner's status through the 1:1 `Workspace.user` relation is one
 * more column on a query that was being issued regardless: **zero extra round
 * trips**, and the status can never belong to a different request than the
 * workspace id being handed out, which two separate queries could allow.
 *
 * The relation is followed rather than `User` being read by the token's
 * `userId`, and that is strictly stronger: it proves the workspace this request
 * is about to write to is actually owned by an active account. A user token
 * pointing at a workspace with no owner row — a deleted account whose 30-day
 * cookie is still alive — reports null and is refused by the caller, where
 * before it silently got a workspace.
 */
export async function touchWorkspace(
  id: string,
  kind: ResolvedWorkspace["kind"],
): Promise<TouchedWorkspace> {
  const expiresAt =
    kind === WorkspaceKind.Guest
      ? new Date(Date.now() + guestSandboxTtlHours() * 3600_000)
      : null;
  const ws = await prisma.workspace.upsert({
    where: { id },
    create: { id, kind, lastSeenAt: new Date(), expiresAt },
    update: { kind, lastSeenAt: new Date() }, // don't extend TTL on touch
    select: { user: { select: { status: true } } },
  });
  return { ownerStatus: ws.user?.status ?? null };
}

/**
 * Sign the frozen account out, as far as the framework permits.
 *
 * #220 asked for a revoked session to be CLEARED rather than merely refused, so
 * the person is signed out instead of meeting silent failures until a 30-day
 * cookie expires. How much of that is achievable depends entirely on where the
 * refusal happens, and Next 16 draws that line, not us:
 *
 *  - In a **Server Function or Route Handler** the delete lands. The next
 *    request carries no owner cookie, `src/proxy.ts` mints a guest sandbox, and
 *    the app works normally for a signed-out visitor. This is the path that
 *    matters most, because it is the one a still-open tab and a scripted client
 *    keep hitting.
 *  - In a **Server Component render** it cannot: "Setting cookies is not
 *    supported during Server Component rendering"
 *    (`node_modules/next/dist/docs/01-app/03-api-reference/04-functions/cookies.md`),
 *    and Next enforces it by sealing the jar so `.delete` throws. Every page
 *    under `src/app/(app)/` and the shell layout resolve their workspace this
 *    way, so this is not a corner.
 *
 * Hence best-effort, and hence the bare catch — which cannot weaken anything,
 * because the refusal it accompanies is thrown by the CALLER, outside this
 * try, and does not consult the result. Failing to sign somebody out is a worse
 * experience; it is not a weaker gate.
 *
 * Bouncing a frozen person to /login with an explanation is the missing other
 * half, and it belongs at the gate rather than here — `src/proxy.ts` is the only
 * layer that sees the request before a page renders, and it has no Prisma client
 * to read a status with (Edge runtime). That is a separate change with a real
 * design question in it, not something to smuggle into a security fix.
 */
function clearOwnerSession(jar: Awaited<ReturnType<typeof cookies>>): void {
  try {
    jar.delete(OWNER_COOKIE);
  } catch {
    // Server Component render: the jar is read-only and this is expected.
  }
}

/**
 * The workspace every write in this app scopes itself to — and the one place
 * that decides a frozen account may not have one (#220).
 *
 * `currentUser()` has always re-read `status`, but only a minority of the action
 * files go through it; the rest resolve a workspace id and write, and
 * `braindump.ts` alone does so from nearly every function it exports. So a
 * revoked account holding a valid cookie kept writing while `people-panel.tsx`
 * rendered it as "Revoked". Enforcing it HERE, on the single helper the write
 * path already shares, is what makes the badge true without asking every action
 * file to remember — and what stops the next one from forgetting.
 *
 * (No count, deliberately: #220 was filed quoting "6 of 15 action files" and the
 * tree was already at 5 of 16 by the time the fix was written. Measure it with
 * `grep -l 'currentUser(' src/app/actions/*.ts` if the ratio ever matters again.)
 *
 * **Guests are untouched.** A guest sandbox has no `User` row to have a status,
 * so `ownerStatus` is null and the check does not apply to it. The condition is
 * written as "a user workspace whose owner is not active" rather than "the owner
 * is not active" precisely so that stays true by construction.
 *
 * **It fails closed.** If the status read itself fails, the upsert rejects and
 * that rejection propagates — there is no catch here and none is wanted. A
 * database outage must not read as "carry on"; `/api/export` already
 * distinguishes the two and answers 500 rather than 401 for exactly this case.
 * The same applies to a user workspace with no owner row at all: null is not
 * `active`, so it is refused.
 */
export async function currentWorkspaceId(): Promise<string> {
  const jar = await cookies();
  const hdrs = await headers();
  const ws = await resolveWorkspace({
    owner: jar.get(OWNER_COOKIE)?.value,
    guest: jar.get(GUEST_COOKIE)?.value,
    header: hdrs.get(GUEST_WS_HEADER) ?? undefined,
  });
  const { ownerStatus } = await touchWorkspace(ws.id, ws.kind);
  if (ws.kind === WorkspaceKind.User && ownerStatus !== UserStatus.Active) {
    clearOwnerSession(jar);
    throw new RevokedAccountError();
  }
  return ws.id;
}

/**
 * Is there a valid session of ANY kind behind this request — account or guest?
 *
 * The cheap sibling of {@link currentWorkspaceId}: it verifies the same signed
 * tokens and stops there, with no `touchWorkspace` and so no database round trip.
 *
 * That distinction is the reason it exists (#61). `currentWorkspaceId()` is right
 * for a page view, where one `lastSeenAt` write per navigation is the point. It
 * is wrong for a media byte-range request: a single track produces a handful and
 * every seek adds more, so gating the audio proxy on it would turn scrubbing a
 * lo-fi track into a write amplifier.
 *
 * Use it ONLY where the answer needed is "is this a real caller" and no user data
 * is read. Anything that touches workspace-scoped rows must resolve the workspace
 * properly — an unscoped query behind this gate is still an IDOR.
 *
 * **It does not check `User.status`, and that is a decision, not an oversight
 * (#220).** Checking it would mean a database read, which is the one thing this
 * function exists not to do. What a revoked account gets by passing it is the
 * lo-fi catalogue and the audio proxy (`src/app/api/focus-catalog/**`, its only
 * two callers) — public third-party media, no account data, nothing written.
 * Trading a read on every byte-range request of every seek for that is the wrong
 * side of the deal. Anything that reads or writes account data must go through
 * {@link currentWorkspaceId}, which does check, and `scoping.harness.test.ts`
 * pins this function as the single named exemption so a third caller has to
 * argue for itself.
 *
 * A missing or tampered token is `false`. Anything else rethrows, deliberately:
 * reporting an outage as "not signed in" sends somebody with a perfectly good
 * cookie off to re-authenticate, which is the trap `/api/export`'s 401 branch
 * documents.
 */
export async function hasSession(): Promise<boolean> {
  const jar = await cookies();
  const hdrs = await headers();
  try {
    await resolveWorkspace({
      owner: jar.get(OWNER_COOKIE)?.value,
      guest: jar.get(GUEST_COOKIE)?.value,
      header: hdrs.get(GUEST_WS_HEADER) ?? undefined,
    });
    return true;
  } catch (err) {
    if (err instanceof MissingWorkspaceError) return false;
    throw err;
  }
}

/**
 * The signed-in account behind this request, or null for guests/anonymous.
 *
 * The role is read from the database rather than carried in the token on
 * purpose: a role change (or a revocation) has to take effect on the NEXT
 * REQUEST, not whenever a 30-day cookie happens to expire. `status` is checked
 * here for the same reason — a revoked account stops being able to act
 * immediately, not at its next sign-in attempt.
 *
 * #100 adds `provider` and `handle` to the SAME select. Naming the signed-in
 * account in the header therefore costs no extra round trip, and — more to the
 * point — the handle shown can never belong to a different session than the role
 * being enforced, which a second lookup could allow.
 */
export async function currentUser(): Promise<CurrentUser | null> {
  const jar = await cookies();
  const token = jar.get(OWNER_COOKIE)?.value;
  if (!token) return null;
  const p = await verifySession(token, authConfig().sessionSecret);
  if (p?.kind !== "user") return null;
  const user = await prisma.user.findUnique({
    where: { id: p.userId },
    // `email` is deliberately NOT selected: nothing in the app displays it (see
    // people.ts and identity.ts), so it never enters the object graph a page's
    // props are built from.
    select: {
      id: true,
      role: true,
      status: true,
      provider: true,
      handle: true,
    },
  });
  if (!user || user.status !== UserStatus.Active) return null;
  return {
    id: user.id,
    role: user.role as UserRole,
    workspaceId: p.wsId,
    provider: user.provider,
    handle: user.handle,
  };
}

/**
 * Is this request made by the instance owner?
 *
 * Implemented in terms of currentUser() so there is exactly one query path and
 * one place where "signed in" and "is the owner" can be told apart — before
 * #35 they were the same thing, and every signed-in account would have been an
 * owner the moment a second person was invited.
 */
export async function isOwnerRequest(): Promise<boolean> {
  return (await currentUser())?.role === UserRole.Owner;
}
