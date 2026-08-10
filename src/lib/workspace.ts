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
 * instead of 500, and every action file inherits the refusal without a line
 * changed. More to the point it fails closed for code that does not exist yet:
 * a future handler written knowing only about MissingWorkspaceError cannot
 * accidentally let a frozen account through, because there is no narrower
 * branch for it to miss.
 *
 * **The inheritance only reaches code this error can actually reach, and
 * {@link hasSession} is not that code (!305 review).** It resolves through
 * {@link resolveWorkspace}, which issues no query and so never learns the
 * status; the sole `throw` below is inside {@link currentWorkspaceId}, which
 * `hasSession` does not call. A frozen account's still-valid token therefore
 * keeps it `true`, and that is the intended answer — see that function, where
 * the trade is argued and what it opens is enumerated. It is written down HERE
 * too because "subclass of MissingWorkspaceError" reads like it covers every
 * refusal path in the app, and this one path it does not.
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

/**
 * A workspace's kind is a fact about the session that produced it, so it is
 * returned alongside the id rather than re-derived from the id's shape.
 *
 * #220 makes it a DISCRIMINATED UNION so `userId` can be non-optional on the
 * arm that has one. Written as one object with `userId?: string`, narrowing on
 * `kind === "user"` would leave the id possibly-undefined, and
 * `findUnique({ where: { id: undefined } })` type-checks happily against
 * Prisma's `UserWhereUniqueInput` — a status check that quietly throws
 * "needs at least one argument" instead of reading a status. It would fail
 * closed, but it would fail closed for the wrong reason and only at runtime.
 * The union makes the compiler the thing that guarantees it.
 */
export type ResolvedWorkspace =
  | {
      id: string;
      kind: typeof WorkspaceKind.User;
      /**
       * Whose account this is. Carried out of the token for the same reason
       * `kind` is: it is a fact about the session that produced this workspace,
       * and the alternative is re-deriving it with a query against the very row
       * we are about to write to. `userId` and `wsId` are signed together, so a
       * caller cannot mismatch them — which is what makes it safe to look an
       * account up by it.
       */
      userId: string;
    }
  | {
      id: string;
      kind: typeof WorkspaceKind.Guest;
      /** A guest sandbox belongs to nobody; `never` so the two arms stay
       *  distinguishable by more than their `kind` string. */
      userId?: never;
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
 * account's `status` is therefore invisible to it. Keeping it that way is the
 * point: `hasSession()` (#61) is built on this function precisely because it
 * touches no database, and a status check here would put a query on every
 * byte-range request of every audio seek. The check lives one level up, in
 * {@link currentWorkspaceId}, which is already making a round trip and is only
 * reached by callers that go on to read or write account data.
 *
 * That split is why `scoping.harness.test.ts` fails if any module outside this
 * file CALLS this function. It is exported — the module's own tests need it —
 * but it is not a public entry point, and reaching past `currentWorkspaceId()`
 * for a workspace id is exactly how a status-blind write path would come back.
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
    if (p?.kind === "user") {
      return { id: p.wsId, kind: WorkspaceKind.User, userId: p.userId };
    }
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
 * `kind` is passed in rather than inferred from the id: a workspace's kind is a
 * database fact, and with per-user workspaces there is no longer any id shape to
 * infer it from. Getting it wrong on a user workspace would stamp an
 * `expiresAt` and let the guest-retention purge sweep a real account's data.
 *
 * ## Do not add a `select` or an `include` to this upsert (#220)
 *
 * It has to stay a shape Prisma can compile to a single
 * `INSERT ... ON CONFLICT DO UPDATE`, because it races itself constantly: a
 * fresh guest sandbox's first navigation fires the shell, the page and its data
 * reads concurrently, all touching a workspace id that does not exist yet.
 * Atomicity is the only thing making that safe.
 *
 * #220's first attempt read the owner's `status` here through a nested relation
 * select, on the reasoning that a column on a query already being issued is
 * free. It is not. A relation select disqualifies the native upsert, Prisma
 * falls back to read-then-write, and the race returns — every loser raising
 * P2002. It passed every sequential test in the suite and took down every guest
 * page the moment requests overlapped, which is why
 * `touch-workspace-race.integration.test.ts` now overlaps them on purpose.
 *
 * So the status check lives in {@link currentWorkspaceId} as its own query. It
 * genuinely costs a round trip; the alternative cost an atomic write.
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
 * Hence best-effort — which cannot weaken anything, because the refusal it
 * accompanies is thrown by the CALLER, outside this try, and does not consult
 * the result. Failing to sign somebody out is a worse experience; it is not a
 * weaker gate.
 *
 * The catch is NOT bare, though it was until !305's review. Only the sealed jar
 * is expected here; anything else is a fault, and a fault absorbed by a catch
 * written for a different reason is one nobody ever hears about. See
 * {@link reportUnexpectedClearFailure}.
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
  } catch (err) {
    reportUnexpectedClearFailure(err);
  }
}

/**
 * The opening clause of the message Next raises from a sealed cookie jar
 * (`ReadonlyRequestCookiesError`, in
 * `node_modules/next/dist/server/web/spec-extension/adapters/request-cookies.js`),
 * which is what both of Next 16's read-only throw sites construct.
 *
 * **Matching on English text is the least bad discriminator here, and the
 * alternatives were measured rather than assumed (!305 review).** Next exports
 * that class from no public entry point, so recognising it by type would take a
 * deep import of `next/dist/…` — and that would then be wrong rather than
 * merely ugly, because `app-page.runtime.prod.js` carries its own bundled copy
 * of the class: the identity a deep import binds is not the identity a page
 * render throws, so the check would read false on the one path it exists for.
 * Nothing else on the error survives either. Its constructor never assigns
 * `name`, so `err.name` is the generic `"Error"`, and the production bundle
 * minifies the class declaration itself down to a single letter, which takes
 * `err.constructor.name` with it. The message is the only part that reaches the
 * shipped runtime intact.
 *
 * Anchored on the opening clause and not the whole sentence because the
 * documentation URL after it moves between releases; a literal substring rather
 * than a pattern because there is no variation left to express, and this repo
 * builds no regex it does not need (see `log-retention.ts`).
 *
 * If a future Next rewords it, this stops matching and a frozen account's page
 * render logs one line per render saying so. That is the right direction to
 * fail — loud and traceable to this constant, rather than back to silently
 * discarding real faults.
 */
const SEALED_JAR_MESSAGE = "Cookies can only be modified";

/**
 * One structured, greppable line when the sign-out fails for a reason that is
 * NOT the sealed jar — the shape `google_disconnect_failed` and `llm_failure`
 * use, including the try/catch around the emission itself.
 *
 * `error` rather than `warn`: #158 is about handled outcomes printing as
 * faults, and every handled outcome here returns silently one line above. What
 * reaches `console.error` is by construction the residue — a throw from
 * `.delete` that nothing in this codebase anticipated — which is the same
 * category as `tokens_not_cleared`, the sibling best-effort clean-up in
 * `google.ts` that logs at error for exactly this reason.
 *
 * No account id, unlike that sibling. There it names a credential row an
 * operator has to go and delete by hand; here nothing persisted and there is no
 * per-account clean-up to point at, so the id would be identifying data logged
 * for no operational use.
 *
 * The classification sits INSIDE the try with the emission, not above it:
 * reading `err.message` is itself a property access on an object this code did
 * not construct, and an observability step must not become the response —
 * least of all on the path that is refusing a frozen account.
 */
function reportUnexpectedClearFailure(err: unknown): void {
  try {
    if (err instanceof Error && err.message.includes(SEALED_JAR_MESSAGE)) {
      // Server Component render: the jar is read-only and this is expected.
      return;
    }
    console.error(
      JSON.stringify({
        tag: "session_clear_failed",
        message: err instanceof Error ? err.message : String(err),
        ts: new Date().toISOString(),
      }),
    );
  } catch {
    // Observability must never take the request down with it.
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
 * **Guests pay nothing.** The check is skipped on the kind of the resolved
 * workspace, before any query is issued — a guest sandbox has no account to have
 * a status, so it makes exactly the one round trip it always did. Branching on
 * the KIND rather than on a null status is also what keeps that true by
 * construction rather than by coincidence.
 *
 * **A signed-in request pays one extra round trip, and that is the honest
 * price.** It was meant to be free: the first attempt at #220 read the status
 * through a relation select on `touchWorkspace`'s existing upsert. That
 * disqualifies Prisma's single-statement upsert, and the read-then-write it
 * falls back to reintroduced a P2002 race that took down every guest page —
 * see the comment on `touchWorkspace`. A query that costs an atomic write is not
 * a free query. What the placement DOES still buy is `hasSession()` (#61) and
 * `resolveWorkspace()` staying free, which is the reason the check is not one
 * level down where the issue first proposed it.
 *
 * **The order matters.** The status is read BEFORE the touch, so a frozen
 * account does not stamp `lastSeenAt` on the way to being refused, and a deleted
 * account's live cookie does not cause `touchWorkspace` to re-create the
 * ownerless workspace the cascade just removed.
 *
 * **It fails closed.** If the status read itself fails, the query rejects and
 * that rejection propagates — there is no catch here and none is wanted. A
 * database outage must not read as "carry on"; `/api/export` already
 * distinguishes the two and answers 500 rather than 401 for exactly this case.
 * A missing row is refused for the same reason: `undefined` is not `active`.
 */
export async function currentWorkspaceId(): Promise<string> {
  const jar = await cookies();
  const hdrs = await headers();
  const ws = await resolveWorkspace({
    owner: jar.get(OWNER_COOKIE)?.value,
    guest: jar.get(GUEST_COOKIE)?.value,
    header: hdrs.get(GUEST_WS_HEADER) ?? undefined,
  });
  if (ws.kind === WorkspaceKind.User) {
    const owner = await prisma.user.findUnique({
      // `ws.userId` is a non-optional `string` on this arm of the union, and it
      // comes out of the same signed token as `ws.id`, so a caller can neither
      // omit it nor point it at somebody else. `select` is one column: nothing
      // here needs the account, only permission to continue.
      where: { id: ws.userId },
      select: { status: true },
    });
    if (owner?.status !== UserStatus.Active) {
      clearOwnerSession(jar);
      throw new RevokedAccountError();
    }
  }
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
 * **It does not check `User.status`, and that is a decision, not an oversight
 * (#220).** Checking it would mean a database read, which is the one thing this
 * function exists not to do. What a revoked account gets by passing it is the
 * lo-fi catalogue and the audio proxy (`src/app/api/focus-catalog/**`, its only
 * two callers) — public third-party media, no account data, nothing written.
 * Trading a read on every byte-range request of every seek for that is the wrong
 * side of the deal. Anything that reads or writes account data must go through
 * {@link currentWorkspaceId}, which does check, and `scoping.harness.test.ts`
 * names this function in `STATUS_BLIND_RESOLVERS` with that reason — so the
 * exemption is one somebody had to write down, and a fourth resolver appearing
 * without a status check fails the build rather than joining it quietly.
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
 *
 * **This is a session→workspace resolver in its own right, and rule 1 of
 * `scoping.harness.test.ts` now says so (!305 review).** It calls
 * {@link verifySession} itself and returns `workspaceId: p.wsId`, reaching
 * neither {@link resolveWorkspace} nor {@link resolveWorkspaceId} — which is
 * how it stayed invisible to a rule that looked for those two names. The status
 * check above was therefore correct by the care of whoever wrote it rather than
 * by anything enforced, and deleting it would have failed nothing. Rule 1 asks
 * about the property now, so this function is in its pinned set and the check is
 * load-bearing.
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
