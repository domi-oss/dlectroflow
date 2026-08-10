import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";

/**
 * The delegate, not the database. `createOwnFeed`'s three statements are stubbed
 * so their ORDER and their arguments are observable, and so the one branch real
 * Postgres cannot be scheduled into can be entered on purpose — see the block at
 * the foot of this file. `upsert` is stubbed despite nothing calling it any
 * more: #223 replaced an empty-payload upsert here precisely because it is not
 * atomic, so a silent regression back to it is worth catching.
 */
const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    calendarFeed: {
      findUnique: vi.fn(),
      createManyAndReturn: vi.fn(),
      upsert: vi.fn(),
    },
  },
}));

vi.mock("@/lib/db", () => ({ prisma: prismaMock }));

import {
  FEED_TOKEN_CHARS,
  createOwnFeed,
  feedPath,
  feedUrl,
  isFeedTokenShape,
  mintFeedToken,
} from "./calendar-feed";

/**
 * #154 — the capability token, tested as the credential it is.
 *
 * A subscription URL cannot carry a session cookie, so the token IS the auth.
 * That makes three properties load-bearing rather than cosmetic: it comes from a
 * CSPRNG, it is long enough that guessing is not a strategy, and its shape is
 * checked before anything is done with it. The database surface — including that
 * a regenerate invalidates the old token immediately — is proved against real
 * Postgres in `calendar-feed.integration.test.ts`.
 */

describe("mintFeedToken (#154)", () => {
  it("is 256 bits of randomness, encoded as 43 base64url characters", () => {
    // 32 bytes → ceil(32 * 8 / 6) = 43 base64 characters, unpadded. Asserted on
    // the DECODED length as well: the character count alone would still pass if
    // the entropy were narrowed to hex or to a smaller byte count.
    const token = mintFeedToken();
    expect(token).toHaveLength(FEED_TOKEN_CHARS);
    expect(Buffer.from(token, "base64url")).toHaveLength(32);
  });

  it("is URL-safe — no +, / or = to be re-encoded by anything in the path", () => {
    for (let i = 0; i < 50; i++) {
      expect(mintFeedToken()).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  it("never repeats", () => {
    // Not a randomness test — a collision here means the generator is a constant
    // or a counter, which is the failure that would actually ship.
    const seen = new Set(Array.from({ length: 500 }, mintFeedToken));
    expect(seen.size).toBe(500);
  });

  it("passes its own shape check", () => {
    expect(isFeedTokenShape(mintFeedToken())).toBe(true);
  });
});

describe("isFeedTokenShape (#154)", () => {
  const valid = "a".repeat(FEED_TOKEN_CHARS);

  it("accepts a well-formed token", () => {
    expect(isFeedTokenShape(valid)).toBe(true);
  });

  it("rejects anything of the wrong length", () => {
    expect(isFeedTokenShape("")).toBe(false);
    expect(isFeedTokenShape("a".repeat(FEED_TOKEN_CHARS - 1))).toBe(false);
    expect(isFeedTokenShape("a".repeat(FEED_TOKEN_CHARS + 1))).toBe(false);
  });

  it("rejects characters that are not in the base64url alphabet", () => {
    // The point is not tidiness: this runs BEFORE the database, so a path
    // segment that is not a token never becomes a query at all.
    // Control characters are written as ESCAPES, never as literals — the rule
    // `src/app/actions/account.ts` states for its own CONTROL_CHARS pattern. A
    // literal one is invisible in a diff, which is the last property you want
    // in a validation test, and it turns the file binary as far as git is
    // concerned so the diff shows "Bin" instead of the change.
    const bad = ["/", ".", "%", "+", "=", " ", "\n", "\r", "'", "\u0000"];
    for (const ch of bad) {
      expect(
        isFeedTokenShape(valid.slice(1) + ch),
        `accepted ${JSON.stringify(ch)}`,
      ).toBe(false);
    }
  });

  it("rejects a traversal-shaped segment", () => {
    expect(isFeedTokenShape("../../etc/passwd")).toBe(false);
  });

  it("is not fooled by a newline, which anchors without the m flag would allow", () => {
    // /^[A-Za-z0-9_-]{43}$/ without care matches "…\n" because $ also matches
    // before a trailing newline in JS. A token that round-trips with a newline
    // attached would be a header-injection shape downstream.
    expect(isFeedTokenShape(valid + "\n")).toBe(false);
  });
});

describe("feedPath / feedUrl (#154)", () => {
  const ORIGINAL = process.env.PUBLIC_ORIGIN;
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.PUBLIC_ORIGIN;
    else process.env.PUBLIC_ORIGIN = ORIGINAL;
  });

  it("puts the token in the path, under the prefix the auth gate opens", () => {
    // The gate's PUBLIC_PREFIXES entry and this path are the same fact twice
    // over; `gate.test.ts` asserts the other half.
    expect(feedPath("abc")).toBe("/api/ics/feed/abc");
  });

  it("builds an absolute URL on the configured public origin", () => {
    process.env.PUBLIC_ORIGIN = "https://dlectroflow.dev";
    expect(feedUrl("abc")).toBe("https://dlectroflow.dev/api/ics/feed/abc");
  });

  it("does not double a slash when the origin carries a trailing one", () => {
    process.env.PUBLIC_ORIGIN = "https://dlectroflow.dev/";
    expect(feedUrl("abc")).toBe("https://dlectroflow.dev/api/ics/feed/abc");
  });

  it("puts the token in the PATH, never in a query string", () => {
    // A query string is the wrong place for a credential: it is the part most
    // likely to be logged verbatim by an intermediary, and the part a referrer
    // policy does not protect.
    process.env.PUBLIC_ORIGIN = "https://dlectroflow.dev";
    expect(feedUrl("abc")).not.toContain("?");
  });
});

/**
 * #223 — `createOwnFeed`'s read-back, including the branch a real database
 * cannot be made to take.
 *
 * The race itself is proved against real Postgres in
 * `calendar-feed.integration.test.ts`: four concurrent callers, five trials,
 * measured at 12 of 20 raising P2002 before the fix. What that harness cannot do
 * is CHOOSE which branch a caller lands on. Both of the branches below need the
 * insert to be skipped, and the second needs the winning row to be deleted
 * inside the window between the insert and the read-back — a third tab pressing
 * "turn my feed off" in the microseconds between two statements. There is no way
 * to schedule that, so it is forced here.
 *
 * `src/lib/db.ts`'s `firstUseByWorkspace` is the sibling this code is copied
 * from — same three statements, same throw in the same position — and
 * `db.test.ts` pins its version the same way, for the same reason.
 * `spark.ts` is the OTHER disposition: it falls back rather than throwing,
 * because it has a correct value in hand (the quote it just generated) and
 * serving it uncached is a complete answer. Nothing here has that. The token
 * this call minted was not stored, so returning it would hand somebody a URL
 * that resolves to nothing — a 404 in their calendar with no explanation — and
 * re-creating would resurrect a credential whose owner's most recent instruction
 * was to revoke it.
 */
describe("createOwnFeed's read-back (#223)", () => {
  const USER = "user-223";
  const WINNER = "w".repeat(FEED_TOKEN_CHARS);

  /** Every token `createOwnFeed` tried to write, in order. Two of the
   *  properties below are about that token NOT being the one handed back. */
  let minted: string[] = [];

  /**
   * `ON CONFLICT DO NOTHING` skipped this caller's insert: no row written,
   * nothing raised, an empty array back.
   */
  const insertSkipped = ({ data }: { data: { token: string } }) => {
    minted.push(data.token);
    return Promise.resolve([]);
  };

  beforeEach(() => {
    // reset, not clear: these delegates are queued with `mockResolvedValueOnce`,
    // and `clearAllMocks` resets the CALL LOG while leaving an unconsumed queue
    // — and any implementation — to bleed into the next test.
    vi.resetAllMocks();
    minted = [];
  });

  it("hands a losing caller the WINNER's token, not the one it minted", async () => {
    prismaMock.calendarFeed.findUnique
      // The leading read: still nothing there when this caller looked.
      .mockResolvedValueOnce(null)
      // The read-back, after the insert was skipped: the row that won.
      .mockResolvedValueOnce({ token: WINNER });
    prismaMock.calendarFeed.createManyAndReturn.mockImplementation(
      insertSkipped,
    );

    expect(await createOwnFeed(USER)).toEqual({ token: WINNER });

    // It really did mint one of its own and throw it away. Without this the
    // assertion above would also pass if the function had stopped minting.
    expect(minted).toHaveLength(1);
    expect(minted[0]).not.toBe(WINNER);
    expect(prismaMock.calendarFeed.createManyAndReturn).toHaveBeenCalledWith({
      // `skipDuplicates` is the load-bearing flag: it is what makes Prisma emit
      // `INSERT … ON CONFLICT DO NOTHING` instead of a plain insert that raises.
      data: { userId: USER, token: minted[0] },
      skipDuplicates: true,
      select: { token: true },
    });
    expect(prismaMock.calendarFeed.findUnique).toHaveBeenCalledTimes(2);
    expect(prismaMock.calendarFeed.upsert).not.toHaveBeenCalled();
  });

  it("throws when the row is created and then deleted before the read-back", async () => {
    // Both reads answer null: nothing when the caller looked, and nothing again
    // after the insert was skipped.
    prismaMock.calendarFeed.findUnique.mockResolvedValue(null);
    prismaMock.calendarFeed.createManyAndReturn.mockImplementation(
      insertSkipped,
    );

    // A plain string rather than a constructed regular expression: semgrep's
    // "regular expression with non-literal value" rule flags a pattern built
    // from a variable even inside a test, and asserting the whole sentence is
    // the stronger check anyway.
    await expect(createOwnFeed(USER)).rejects.toThrow(
      `CalendarFeed for user ${USER} vanished during creation — the feed was ` +
        `disabled concurrently. Nothing was minted; press create again.`,
    );

    // Not retried, on purpose: the account's most recent instruction was to turn
    // the feed OFF, and a second insert would resurrect the credential they had
    // just revoked. One insert, two reads, and no `upsert` regression.
    expect(prismaMock.calendarFeed.createManyAndReturn).toHaveBeenCalledTimes(
      1,
    );
    expect(prismaMock.calendarFeed.findUnique).toHaveBeenCalledTimes(2);
    expect(prismaMock.calendarFeed.upsert).not.toHaveBeenCalled();
  });

  it("raises something a caller can tell apart from a P2002 on this table", async () => {
    // The table can still raise a genuine unique violation — the integration
    // file's "a duplicate token still raises" forces one on the `token` index,
    // as the control on its own two zeroes. That one arrives as a
    // `PrismaClientKnownRequestError` carrying `code: "P2002"` and means the
    // opposite thing: a collision, not a revocation. This one is a plain Error
    // with no code, so `catch (e) { if (e.code === "P2002") … }` cannot swallow
    // a concurrent disable as a duplicate.
    prismaMock.calendarFeed.findUnique.mockResolvedValue(null);
    prismaMock.calendarFeed.createManyAndReturn.mockImplementation(
      insertSkipped,
    );

    const raised = await createOwnFeed(USER).then(
      () => undefined,
      (e: unknown) => e,
    );

    expect(raised).toBeInstanceOf(Error);
    expect((raised as Error).name).toBe("Error");
    expect((raised as { code?: string }).code).toBeUndefined();
  });

  it("keeps the minted token out of the error message", async () => {
    // The message reaches a log, and this module's whole design note is about a
    // capability token's exposure in logs being KNOWN and bounded. Naming the
    // account is what an operator needs; putting the token in as well would add
    // a fresh credential to the one channel that keeps entries for 30 days —
    // and it is not even a useful one, since it was never stored.
    prismaMock.calendarFeed.findUnique.mockResolvedValue(null);
    prismaMock.calendarFeed.createManyAndReturn.mockImplementation(
      insertSkipped,
    );

    const raised = await createOwnFeed(USER).then(
      () => undefined,
      (e: unknown) => e,
    );

    expect(raised).toBeInstanceOf(Error);
    // The control: a real 43-character token was minted, so the absence below is
    // not an empty string trivially "not contained" in the sentence.
    expect(minted).toHaveLength(1);
    expect(isFeedTokenShape(minted[0])).toBe(true);
    expect((raised as Error).message).not.toContain(minted[0]);
    // And it does name the account, which is the thing an operator can act on.
    expect((raised as Error).message).toContain(USER);
  });
});
