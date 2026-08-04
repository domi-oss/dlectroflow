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
 * The token goes in the PATH, never a query string: a query string is the part
 * most likely to be logged verbatim by an intermediary.
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
 * Turn the feed on. **Idempotent** — an account that already has a feed gets the
 * one it has back, unchanged.
 *
 * That is a security property, not a convenience: if "create" minted a token
 * unconditionally, a double-click, a replayed form post or a stale tab would
 * silently revoke a URL that is working in somebody's calendar, and they would
 * find out days later when their week stopped updating. Rotation is a separate,
 * deliberately-named action.
 */
export async function createOwnFeed(userId: string): Promise<OwnFeed> {
  const existing = await prisma.calendarFeed.findUnique({
    where: { userId },
    select: { token: true },
  });
  if (existing) return existing;
  // `upsert` rather than `create` closes the race between the read above and
  // this write — two tabs pressing the button at once would otherwise make one
  // of them a P2002. `update: {}` keeps the loser's token, which is the same
  // idempotence the read is providing.
  return prisma.calendarFeed.upsert({
    where: { userId },
    create: { userId, token: mintFeedToken() },
    update: {},
    select: { token: true },
  });
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
