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

/**
 * Record activity on a workspace, creating it if this is the first sighting.
 *
 * `kind` is now passed in rather than inferred from the id: a workspace's kind
 * is a database fact, and with per-user workspaces there is no longer any id
 * shape to infer it from. Getting it wrong on a user workspace would stamp an
 * `expiresAt` and let the guest-retention purge sweep a real account's data.
 */
export async function touchWorkspace(
  id: string,
  kind: ResolvedWorkspace["kind"],
): Promise<void> {
  const expiresAt =
    kind === WorkspaceKind.Guest
      ? new Date(Date.now() + guestSandboxTtlHours() * 3600_000)
      : null;
  await prisma.workspace.upsert({
    where: { id },
    create: { id, kind, lastSeenAt: new Date(), expiresAt },
    update: { kind, lastSeenAt: new Date() }, // don't extend TTL on touch
  });
}

export async function currentWorkspaceId(): Promise<string> {
  const jar = await cookies();
  const hdrs = await headers();
  const ws = await resolveWorkspace({
    owner: jar.get(OWNER_COOKIE)?.value,
    guest: jar.get(GUEST_COOKIE)?.value,
    header: hdrs.get(GUEST_WS_HEADER) ?? undefined,
  });
  await touchWorkspace(ws.id, ws.kind);
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
