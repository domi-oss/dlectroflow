import crypto from "node:crypto";
import { prisma } from "@/lib/db";
import { buildIcsCalendar, scheduledStepEvents } from "@/lib/ics";
import { publicOrigin } from "@/lib/origin";
import { UserStatus } from "@/lib/constants";

/**
 * #154 — the per-user calendar subscription feed.
 *
 * A person pastes one URL into their calendar app and it stays in sync. Until
 * now the whole ICS surface was `/api/ics/[taskId]`: one download, one task, no
 * updates. This works with no Google account and no OAuth at all, which is the
 * half of the closed epic #29 that serves a self-hoster.
 *
 * ## The URL is the credential
 *
 * Calendar clients cannot present a session cookie — Google, Apple and Outlook
 * all fetch a subscription anonymously — so possession of the URL *is* the
 * authorization. Everything about this module follows from that:
 *
 *  - **256 bits from a CSPRNG.** `crypto.randomBytes` is the platform's CSPRNG;
 *    43 base64url characters carry 32 bytes. Guessing is not a strategy against
 *    2^256, which is why there is no lockout to design and no attempt counter to
 *    keep.
 *  - **Shape-checked before the database.** `isFeedTokenShape` runs on the raw
 *    path segment, so a probe that is not token-shaped never becomes a query.
 *  - **Rotation is one UPDATE.** The old token stops working on the very next
 *    request, because the only thing that ever made it work was a row matching
 *    it. There is no revocation list to converge and no TTL to wait out.
 *  - **The feed carries titles and times and nothing else.** No notes, no
 *    coaching transcripts, no account fields. The URL will end up in a calendar
 *    provider's logs and, quite possibly, in plain text on a phone.
 *
 * ## Why a stored random token, and not a signed one
 *
 * The obvious suggestion, and the one this codebase's own habits point at: the
 * guest and owner sessions are signed JWTs (`src/lib/auth/session.ts`), verified
 * with no database round trip, and `src/proxy.ts` forwards the SIGNED token
 * rather than a raw id precisely so nothing trusts an unverified value. Why is
 * this credential not the same shape?
 *
 * **Because a signed token cannot be revoked, and revocation is the feature.**
 * A JWT is valid because the signature says so; the only ways to stop honouring
 * one are to wait for its expiry or to keep a server-side list of the ones you
 * have withdrawn — and that list is this table, arrived at the long way round
 * with a second thing to keep in step. The issue's requirement is that
 * regenerating invalidates the old URL *immediately, not on a schedule*, and a
 * row that stops existing does that in one write with nothing left to converge.
 * An expiry is also the wrong behaviour here for an ordinary reason: a
 * subscription is meant to keep working for years, and a URL that silently dies
 * in a calendar nobody is looking at is a worse failure than one you revoke on
 * purpose.
 *
 * The property the signed-token pattern exists to protect is not lost, either.
 * Its point is that a caller must never be trusted for an id they supplied —
 * and nothing here trusts the token: it is looked up, and the row it finds is
 * what names the owner. There is no id in the URL to forge.
 *
 * ## This module owns the whole `prisma.calendarFeed` surface
 *
 * `src/lib/__tests__/scoping.harness.test.ts` pins that, the way it pins
 * `src/lib/google.ts` for `GoogleAuth`: a credential row nothing else can reach
 * has a blast radius of one file forever, rather than one file today. Every
 * function here takes the acting user's id, and **none of them accepts a row
 * id** — so there is nothing a caller could point at another account's feed. The
 * single exception is `resolveFeed`, which is keyed on the capability token
 * because that is the entire point of a capability, and the harness names it
 * explicitly rather than letting it slip through.
 */

/** Bytes of entropy behind a feed token. 32 = 256 bits. */
const FEED_TOKEN_BYTES = 32;

/** Encoded length of a feed token: ceil(32 * 8 / 6) unpadded base64url chars. */
export const FEED_TOKEN_CHARS = 43;

/**
 * `^…$` would not be enough on its own: in JavaScript `$` also matches *before*
 * a trailing newline, so `/^[A-Za-z0-9_-]{43}$/.test(tok + "\n")` is true. `\n`
 * in a value that reaches a header is a response-splitting shape, so the anchors
 * are `\A`-equivalent — `^` plus an explicit end-of-input `$` with no multiline
 * flag is still newline-permissive, hence the length check is done separately
 * and the character class is tested against the WHOLE string.
 */
const FEED_TOKEN_ALPHABET = /^[A-Za-z0-9_-]+$/;

/** A fresh capability token. CSPRNG, URL-safe, 256 bits. */
export function mintFeedToken(): string {
  return crypto.randomBytes(FEED_TOKEN_BYTES).toString("base64url");
}

/** Is this path segment even token-shaped? Runs before any database work. */
export function isFeedTokenShape(value: string): boolean {
  return (
    value.length === FEED_TOKEN_CHARS &&
    // Rejects a trailing newline that `$` alone would tolerate — see above.
    !/[\r\n]/.test(value) &&
    FEED_TOKEN_ALPHABET.test(value)
  );
}

/**
 * The feed's path. Defined here and mirrored by the `/api/ics/feed` entry in
 * `src/lib/auth/gate.ts`'s PUBLIC_PREFIXES — the same fact stated twice, with a
 * test on each side, because a feed the middleware redirects to /login is a feed
 * that silently stops working in everybody's calendar.
 */
export function feedPath(token: string): string {
  return `/api/ics/feed/${token}`;
}

/**
 * The absolute URL somebody pastes into their calendar app.
 *
 * `publicOrigin()` rather than the request's origin: this is a PERSISTED,
 * long-lived URL — the same reason the focus deep-link (#39) uses it — and
 * deriving it from a spoofable `Host` would let one request mint a URL pointing
 * at somebody else's hostname.
 *
 * The token goes in the PATH rather than a query string, but **do not read that
 * as "so it is not logged" — it is (#154 review).** Both deploy targets record
 * the whole request line, path included: `docker/Caddyfile` enables an access
 * log, and `charts/dlectroflow/templates/ingress.yaml` sets no `log-format`
 * override, so ingress-nginx's default applies and that contains `$request`.
 * Production keeps those entries for 30 days (`docs/deploy-runbook.md` §16).
 *
 * What the path buys is narrower and still worth having: a query string is the
 * part that leaks OUTWARD — into `Referer` headers, analytics, browser history
 * and third-party intermediaries — whereas a path in a URL nobody navigates to
 * from a page stays with the operator's own logs. The token is therefore a
 * credential with a KNOWN exposure, not a hidden one, which is why
 * `src/app/privacy/page.tsx` says so plainly, why the rotation control exists,
 * and why `docs/deploy-runbook.md` §15 lists these tokens among the things a
 * leak means rotating.
 */
export function feedUrl(token: string): string {
  return `${publicOrigin()}${feedPath(token)}`;
}

/** What Settings needs to render the card. No timestamps: the panel shows the
 *  URL and whether there is one, and audit columns are not UI. */
export type OwnFeed = { token: string };

/** The acting account's feed, or null if they have not turned one on. */
export async function getOwnFeed(userId: string): Promise<OwnFeed | null> {
  return prisma.calendarFeed.findUnique({
    where: { userId },
    select: { token: true },
  });
}

/**
 * The feed's audit timestamps for the data export, or `null` if there is no feed.
 *
 * ## The token is not selected, and that is the whole design of this function
 *
 * It would have been shorter to widen `getOwnFeed` and let the export drop the
 * field. Two reasons not to. First, the token is a **credential**: possession of
 * the URL is the entire authorization for reading somebody's scheduled work (see
 * the note on the model in `prisma/schema.prisma`), so a copy of it in a file the
 * reader may forward to somebody is the same mistake as exporting `llmKeyEnc` —
 * and unlike the OAuth tokens it is stored in plaintext, so there is not even a
 * cipher between the archive and a working capability. Second, an omission a
 * serialiser has to remember is an omission a refactor can drop; selecting only
 * the two timestamps means the token is absent from the export by CONSTRUCTION,
 * and nothing downstream has to be careful.
 *
 * Withholding it costs the reader nothing they cannot get: Settings renders the
 * live URL and can re-copy it, and this archive is not the route by which anybody
 * restores a feed. `/privacy` and the archive's own README both say so, and name
 * it as the third credential rather than leaving it as an unexplained absence.
 *
 * Lives in this module because `src/lib/__tests__/scoping.harness.test.ts` pins
 * the entire `prisma.calendarFeed` surface here — same reasoning as
 * `getOwnAiUsageRow` in `src/lib/user-quota.ts`, and recorded in
 * `src/lib/export/__tests__/model-coverage.test.ts`.
 */
export async function getOwnFeedTimestamps(
  userId: string,
): Promise<{ createdAt: Date; rotatedAt: Date | null } | null> {
  return prisma.calendarFeed.findUnique({
    where: { userId },
    select: { createdAt: true, rotatedAt: true },
  });
}

/**
 * Turn the feed on. **Idempotent** — an account that already has a feed gets the
 * one it has back, unchanged.
 *
 * That is a security property, not a convenience: if "create" minted a token
 * unconditionally, a double-click, a replayed form post or a stale tab would
 * silently revoke a URL that is working in somebody's calendar, and they would
 * find out days later when their week stopped updating. Rotation is a separate,
 * deliberately-named action.
 *
 * ## Why `createManyAndReturn`, and not the `upsert` that used to be here
 *
 * The read above is a TOCTOU: two tabs can both see no feed and both write. That
 * used to be answered by `upsert({ where, create, update: {} })`, with a comment
 * saying so — and it was **wrong** (#223). Prisma 6.19 only compiles an upsert to
 * a native `INSERT … ON CONFLICT` when the update payload is NON-EMPTY; with an
 * empty one it degrades to `BEGIN; SELECT; INSERT; COMMIT`, which is the same
 * read-then-insert the leading `findUnique` already was. Measured at 12 of 20
 * racing callers raising P2002, out of an action that has no branch for it.
 *
 * `createManyAndReturn` + `skipDuplicates` is the only Prisma API that compiles
 * to `INSERT … ON CONFLICT DO NOTHING` (#156, #158, and the note on `log` in
 * src/lib/db.ts). The loser inserts nothing, gets an empty array, and raises
 * nothing — which also matters because catching a P2002 would not have been
 * enough: Prisma's client logger prints a failed query strictly before any
 * `catch` sees it, so the caught version still reports an incident.
 *
 * **The read-back is not optional, and it is the security-relevant part.**
 * `createManyAndReturn` returns only the rows THIS statement inserted, so a
 * loser gets nothing back and must go and read the row that won. Returning the
 * token this call happened to mint instead would hand two tabs two different
 * feed URLs, only one of which resolves — a person pasting the other into their
 * calendar gets a 404 forever and no explanation.
 *
 * `ON CONFLICT DO NOTHING` carries no conflict target, so ANY unique index on
 * `CalendarFeed` skips rather than raises. That is `userId` (the PK, the case
 * this is for) and `token`. A token collision is a 2^-256 event and skipping it
 * is still the safe direction: nothing is overwritten, and the read-back returns
 * whatever is genuinely stored for this account — which, in that impossible
 * case, is nothing, and the throw below says so rather than inventing a URL.
 */
export async function createOwnFeed(userId: string): Promise<OwnFeed> {
  // The leading read stays. Every render of the Settings card that already has a
  // feed comes through here, and an indexed SELECT is cheaper than a speculative
  // insert Postgres has to conflict-check and discard.
  const existing = await prisma.calendarFeed.findUnique({
    where: { userId },
    select: { token: true },
  });
  if (existing) return existing;

  const [created] = await prisma.calendarFeed.createManyAndReturn({
    data: { userId, token: mintFeedToken() },
    skipDuplicates: true,
    select: { token: true },
  });
  if (created) return created;

  // DO NOTHING means somebody else got there first and their row is already
  // committed: Postgres blocks the conflicting insert on the unique index until
  // the winning transaction resolves, and only then decides to skip. So this
  // read cannot miss for timing reasons.
  const winner = await prisma.calendarFeed.findUnique({
    where: { userId },
    select: { token: true },
  });
  if (winner) return winner;

  // Which leaves one way to get here: the row was created and then DELETED
  // between the two statements — a third tab pressing "turn my feed off" inside
  // that window. Not retried on purpose. The person's most recent instruction
  // was to turn the feed OFF, and a silent re-create would resurrect a
  // credential they had just revoked; failing loudly leaves the account in the
  // state they last asked for and costs them one more click.
  throw new Error(
    `CalendarFeed for user ${userId} vanished during creation — the feed was ` +
      `disabled concurrently. Nothing was minted; press create again.`,
  );
}

/**
 * Mint a new token, invalidating the old one immediately.
 *
 * This is the ONLY way to revoke a capability URL, so it must be a real write
 * and not a flag: after this returns, the previous token matches no row and the
 * next poll from any client holding it is a 404. Nothing is cached in front of
 * the endpoint (see the route), so "immediately" means the next request.
 *
 * `upsert`, so regenerating from a page whose feed was deleted in another tab
 * turns it back on rather than throwing.
 */
export async function regenerateOwnFeed(userId: string): Promise<OwnFeed> {
  return prisma.calendarFeed.upsert({
    where: { userId },
    create: { userId, token: mintFeedToken() },
    update: { token: mintFeedToken(), rotatedAt: new Date() },
    select: { token: true },
  });
}

/**
 * Turn the feed off entirely.
 *
 * `deleteMany`, not `delete`: turning off a feed that is already off is a no-op
 * the person should experience as success, not as a thrown RecordNotFound —
 * the same reasoning `removeOwnLlmKey` gives.
 */
export async function disableOwnFeed(userId: string): Promise<void> {
  await prisma.calendarFeed.deleteMany({ where: { userId } });
}

/** Everything the endpoint needs to build a response, and nothing else. */
export type ResolvedFeed = { userId: string; workspaceId: string };

/**
 * Token → whose workspace this feed reads. The one lookup not keyed on a user
 * id, because the token is what the caller has.
 *
 * Two queries rather than one nested read, and the split is deliberate:
 *
 *  1. The credential row, by its unique token. Selects `userId` and nothing
 *     else — the route has no use for `createdAt`, and a credential lookup
 *     should not drag columns into an object graph for convenience.
 *  2. The owner, for `status` and their workspace id. **The status check is why
 *     this is not one query**: a revoked account (#153 freezes rather than
 *     deletes) keeps its `CalendarFeed` row, and a feed that kept serving after
 *     an account was frozen would be the longest-lived hole in the whole
 *     lifecycle. Checked on every request, on the same reasoning `currentUser()`
 *     gives for reading the role from the database rather than the token.
 *
 * `workspace` is a nested select on a 1:1 relation, which the harness cannot see
 * inside — stated because `collect.ts` warns about exactly that. It is safe here
 * for a reason that does not generalise: `Workspace` is the scoping SUBJECT, not
 * content, and the edge being followed is the ownership link from a row already
 * proved to belong to this user. No content is read here at all.
 */
export async function resolveFeed(token: string): Promise<ResolvedFeed | null> {
  if (!isFeedTokenShape(token)) return null;

  const feed = await prisma.calendarFeed.findUnique({
    where: { token },
    select: { userId: true },
  });
  if (!feed) return null;

  const owner = await prisma.user.findUnique({
    where: { id: feed.userId },
    select: { status: true, workspace: { select: { id: true } } },
  });
  if (!owner || owner.status !== UserStatus.Active || !owner.workspace) {
    return null;
  }

  return { userId: feed.userId, workspaceId: owner.workspace.id };
}

/**
 * How far back the feed reaches. Everything scheduled from 30 days ago onward,
 * with no upper bound.
 *
 * A subscription is not an archive — that is what #129's export is for. Without
 * a floor the response grows for the life of the account, and every byte of it
 * is a step title sitting in a calendar provider's storage. Thirty days keeps
 * the recent past legible ("what did I actually do last week") without carrying
 * somebody's entire history into a third party. The future is unbounded because
 * a plan is the thing a calendar is for.
 */
export const FEED_PAST_WINDOW_DAYS = 30;

/**
 * The feed body for one workspace.
 *
 * Workspace-scoped in its own arguments — `where: { workspaceId }` — which is
 * what the scoping harness polices. `Step` carries no `workspaceId`, so it is
 * reached THROUGH the scoped task read, the same idiom
 * `src/app/api/ics/[taskId]/route.ts` and `collect.ts` use.
 *
 * `select`, not the whole row: the feed must carry titles and times and nothing
 * more, and the way to guarantee that is to never read anything else. A future
 * column on `Task` or `Step` cannot leak into somebody's calendar by default.
 *
 * ## Two things it deliberately does not do
 *
 * **A finished step stays in the feed.** `Step.done` is not filtered on, and is
 * not even selected: the slot happened, and removing it would make the calendar
 * lie about the day it is describing. A person's calendar is a record of their
 * week as much as a plan for it, and a Tuesday that empties itself as it is
 * worked through is the wrong artefact.
 *
 * **`DTSTAMP` is the moment of the fetch, so two polls of unchanged data are not
 * byte-identical.** That is the opposite of the export's rule, which pins the
 * stamp so an archive is diffable — and it is fine here for a reason specific to
 * a subscription: clients reconcile a feed on `UID`, not on `DTSTAMP` or on the
 * body's bytes, and the response is `no-store`, so there is no conditional
 * request whose validator this could defeat. Stated rather than left as a
 * difference somebody has to spot.
 *
 * `now` and `stamp` are injectable so the body is deterministic under test.
 */
export async function buildFeedIcs(input: {
  workspaceId: string;
  now?: Date;
  stamp?: Date;
}): Promise<string> {
  const now = input.now ?? new Date();
  const since = new Date(now.getTime() - FEED_PAST_WINDOW_DAYS * 24 * 3600_000);

  const tasks = await prisma.task.findMany({
    where: { workspaceId: input.workspaceId },
    select: {
      id: true,
      title: true,
      parentEmoji: true,
      scheduleDueAt: true,
      steps: {
        select: {
          id: true,
          text: true,
          estMinutes: true,
          subtaskEmoji: true,
          scheduledAt: true,
        },
        orderBy: { order: "asc" },
      },
    },
    orderBy: { createdAt: "asc" },
  });

  return buildIcsCalendar({
    // UTC instants, not floating: these are the times work was really scheduled
    // for, so they must not drift with whatever timezone the subscriber's
    // calendar is set to.
    events: scheduledStepEvents(tasks, { since }),
    timeMode: "utc",
    calendarName: "dlectroflow",
    stamp: input.stamp,
  });
}
