import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/lib/db";
import { prismaErrorsDuring } from "@/lib/__tests__/prisma-error-log";
import { UserStatus } from "@/lib/constants";
import {
  buildFeedIcs,
  createOwnFeed,
  disableOwnFeed,
  getOwnFeed,
  mintFeedToken,
  regenerateOwnFeed,
  resolveFeed,
  FEED_PAST_WINDOW_DAYS,
  type OwnFeed,
} from "./calendar-feed";

/**
 * #154 — the security tests for the calendar subscription feed, against real
 * Postgres.
 *
 * A capability URL is a credential that travels through third parties, so the
 * three properties it rests on are proved rather than argued:
 *
 *  1. **One account's token never reaches another account's content.** Same
 *     class of bug as #21, and the reason #129's export got the same treatment.
 *  2. **Regenerating invalidates the old token immediately** — not on a
 *     schedule, not at the next expiry.
 *  3. **A revoked account's feed stops serving**, because #153 freezes an
 *     account rather than deleting it, so the row survives.
 *
 * Every negative assertion has a control that must SEE the content, so a fixture
 * that silently failed to write cannot make the test pass vacuously.
 *
 * Verified to bite, each rule against the change that would break it:
 *  - Delete `where: { workspaceId }` from `buildFeedIcs` → "one account's feed
 *    never contains another account's step text" fails, reporting the leak.
 *  - Change `regenerateOwnFeed`'s `update` to `{ rotatedAt: new Date() }` → "the
 *    old token stops resolving the instant a new one is minted" fails.
 *  - Delete the `status` check from `resolveFeed` → "a revoked account's feed
 *    stops resolving" fails.
 *
 * Needs the real Postgres (CI wires up a service DB and runs `prisma migrate
 * deploy` first; locally `config/vitest.config.ts` forwards DATABASE_URL from
 * `.env` — only that one variable, by design: #84).
 */

const SUB_PREFIX = "test-154-feed-";
const WS_A = "test-154-feed-ws-a";
const WS_B = "test-154-feed-ws-b";

/** Distinctive on purpose — a substring search for "task" would match the
 *  calendar's own scaffolding. */
const A_STEP = "aardvark-private-feed-step";
const A_TASK = "aardvark-private-feed-task";
const B_STEP = "bandicoot-private-feed-step";

let userA = "";
let userB = "";
let userRevoked = "";

async function wipe() {
  await prisma.task.deleteMany({
    where: { workspaceId: { in: [WS_A, WS_B] } },
  });
  await prisma.workspace.deleteMany({ where: { id: { in: [WS_A, WS_B] } } });
  // CalendarFeed cascades from User, so deleting the accounts takes the feeds.
  await prisma.user.deleteMany({
    where: { providerSub: { startsWith: SUB_PREFIX } },
  });
}

async function makeAccount(sub: string, workspaceId: string, status: string) {
  const user = await prisma.user.create({
    data: { provider: "gitlab", providerSub: `${SUB_PREFIX}${sub}`, status },
  });
  await prisma.workspace.create({
    data: { id: workspaceId, kind: "user", userId: user.id },
  });
  return user.id;
}

beforeAll(async () => {
  await wipe();

  userA = await makeAccount("a", WS_A, UserStatus.Active);
  userB = await makeAccount("b", WS_B, UserStatus.Active);
  // A revoked account needs a workspace too, so the test proves the STATUS check
  // refuses it rather than the missing-workspace branch.
  userRevoked = await makeAccount(
    "revoked",
    "test-154-feed-ws-revoked",
    UserStatus.Revoked,
  );

  const taskA = await prisma.task.create({
    data: { title: A_TASK, workspaceId: WS_A },
  });
  await prisma.step.create({
    data: {
      taskId: taskA.id,
      text: A_STEP,
      order: 1,
      total: 1,
      estMinutes: 20,
      scheduledAt: new Date(),
    },
  });

  const taskB = await prisma.task.create({
    data: { title: "bandicoot-private-feed-task", workspaceId: WS_B },
  });
  await prisma.step.create({
    data: {
      taskId: taskB.id,
      text: B_STEP,
      order: 1,
      total: 1,
      estMinutes: 20,
      scheduledAt: new Date(),
    },
  });
});

afterAll(async () => {
  await prisma.workspace.deleteMany({
    where: { id: "test-154-feed-ws-revoked" },
  });
  await wipe();
});

describe("the feed token's lifecycle (#154)", () => {
  it("an account starts with no feed", async () => {
    expect(await getOwnFeed(userA)).toBeNull();
  });

  it("creating one mints a token that resolves to that account's workspace", async () => {
    const { token } = await createOwnFeed(userA);
    expect(await resolveFeed(token)).toEqual({
      userId: userA,
      workspaceId: WS_A,
    });
  });

  it("creating again is idempotent — a double-click never revokes a live URL", async () => {
    const first = await getOwnFeed(userA);
    const second = await createOwnFeed(userA);
    expect(second.token).toBe(first?.token);
  });

  it("the old token stops resolving the instant a new one is minted", async () => {
    const before = (await getOwnFeed(userA))!.token;
    const after = (await regenerateOwnFeed(userA)).token;

    expect(after).not.toBe(before);
    // The control: the NEW token works, so a null on the old one cannot be a
    // broken fixture reporting a passing revocation.
    expect(await resolveFeed(after)).toEqual({
      userId: userA,
      workspaceId: WS_A,
    });
    expect(await resolveFeed(before)).toBeNull();
  });

  it("records the rotation, so an incident can ask when the credential last changed", async () => {
    const row = await prisma.calendarFeed.findUnique({
      where: { userId: userA },
      select: { rotatedAt: true },
    });
    expect(row?.rotatedAt).toBeInstanceOf(Date);
  });

  it("turning the feed off stops the token resolving, and is safe to repeat", async () => {
    const token = (await getOwnFeed(userA))!.token;
    await disableOwnFeed(userA);

    expect(await getOwnFeed(userA)).toBeNull();
    expect(await resolveFeed(token)).toBeNull();
    // Turning off a feed that is already off is a no-op, not a thrown
    // RecordNotFound.
    await expect(disableOwnFeed(userA)).resolves.toBeUndefined();
  });

  it("refuses a token that is not even token-shaped, without a query", async () => {
    for (const probe of ["", "../../etc/passwd", "short", "x".repeat(200)]) {
      expect(await resolveFeed(probe)).toBeNull();
    }
  });

  it("refuses a well-shaped token that belongs to nobody", async () => {
    expect(await resolveFeed("z".repeat(43))).toBeNull();
  });
});

describe("cross-account isolation — the calendar feed (#154)", () => {
  it("one account's feed never contains another account's step text", async () => {
    const { token } = await createOwnFeed(userB);
    const resolved = await resolveFeed(token);
    expect(resolved).not.toBeNull();

    const ics = await buildFeedIcs({ workspaceId: resolved!.workspaceId });

    // Control first: B's own content IS in B's feed, so the negative below
    // cannot pass because nothing was written.
    expect(ics).toContain(B_STEP);
    expect(ics).not.toContain(A_STEP);
    expect(ics).not.toContain(A_TASK);
  });

  it("a revoked account's feed stops resolving, though the row survives the freeze", async () => {
    const { token } = await createOwnFeed(userRevoked);
    // The control: the row is really there, so a null resolve is the status
    // check refusing it rather than a fixture that never wrote.
    expect(await getOwnFeed(userRevoked)).not.toBeNull();
    expect(await resolveFeed(token)).toBeNull();
  });

  it("deleting an account destroys its feed with it", async () => {
    const doomed = await makeAccount(
      "doomed",
      "test-154-feed-ws-doomed",
      UserStatus.Active,
    );
    const { token } = await createOwnFeed(doomed);
    expect(await resolveFeed(token)).not.toBeNull();

    await prisma.user.delete({ where: { id: doomed } });

    expect(await resolveFeed(token)).toBeNull();
    expect(
      await prisma.calendarFeed.findUnique({
        where: { userId: doomed },
        select: { token: true },
      }),
    ).toBeNull();
  });
});

/**
 * #223 — the race the module's own comment claimed to have closed.
 *
 * `upsert({ where, create, update: {} })` reads as atomic and is not. Prisma
 * 6.19 only compiles an upsert to `INSERT … ON CONFLICT` when the update payload
 * is NON-EMPTY; with `update: {}` it degrades to `BEGIN; SELECT; INSERT; COMMIT`
 * — a read-then-insert at READ COMMITTED, which is the very shape the leading
 * `findUnique` was written to be safe against. Two tabs pressing "create my
 * feed" therefore both insert, and the loser raises P2002 out of the server
 * action after the person has been told to expect a URL.
 *
 * Run against the pre-fix `upsert`, this file's first assertion captured
 * **12 of 20 racing calls rejecting with P2002** (5 trials x 4 callers,
 * 2026-08-09) and 12 matching `prisma:error` lines. So the zeroes below are a
 * measurement, not an untested green — and `a duplicate token still raises`
 * keeps proving that this harness can see a non-zero at all.
 *
 * The token identity assertion is the security half. `createMany` answers with
 * a count rather than a row, so the conversion has to read the winner's row
 * back; returning the token THIS call tried to mint would hand two tabs
 * different feed URLs, one of which resolves to nothing.
 *
 * Not folded into `__tests__/handled-p2002.integration.test.ts` even though it
 * shares that file's harness: those four sites handled their duplicate and only
 * logged it, whereas these two raise it at the caller, and the property proved
 * here — every racing caller gets the WINNER's capability token — is specific to
 * this module and belongs beside the credential it guards. The cross-cutting
 * protection for this class is `empty-upsert-hygiene`, which is a grep the
 * moment a third site appears rather than a test somebody has to remember.
 */
const RACE_TRIALS = 5;
const RACE_CONCURRENCY = 4;

describe("createOwnFeed under genuine concurrency (#223)", () => {
  // A fresh account per trial: the no-row state exists exactly once per user, so
  // a single trial would be one coin flip. Five of them, each with four
  // concurrent callers, makes a lost race effectively certain — and a run that
  // did serialise completely still passes, correctly; it just proves less.
  const racers: string[] = [];

  beforeAll(async () => {
    for (let i = 0; i < RACE_TRIALS; i += 1) {
      const user = await prisma.user.create({
        data: {
          provider: "gitlab",
          providerSub: `${SUB_PREFIX}race-${i}`,
          status: UserStatus.Active,
        },
      });
      racers.push(user.id);
    }
    // Open the connection pool before timing matters. Prisma connects lazily, so
    // the very first burst serialises on the handshake and would not race.
    await Promise.all(
      Array.from({ length: RACE_CONCURRENCY }, () => prisma.user.count()),
    );
  });

  it("four tabs at once: none raises, and all four get the winner's token", async () => {
    const trials: PromiseSettledResult<OwnFeed>[][] = [];

    const errors = await prismaErrorsDuring(async () => {
      for (const userId of racers) {
        trials.push(
          await Promise.allSettled(
            Array.from({ length: RACE_CONCURRENCY }, () =>
              createOwnFeed(userId),
            ),
          ),
        );
      }
    });

    // 1. Nothing rejected. This is the defect: P2002 escaping into the action.
    //    Mapped to the Prisma error CODE rather than counted, so a failure says
    //    `["P2002", …]` — the defect by name — instead of "expected 15 to be 0".
    expect(
      trials
        .flat()
        .filter((r) => r.status === "rejected")
        .map((r) => {
          const reason = (r as PromiseRejectedResult).reason as {
            code?: string;
          };
          return reason?.code ?? String(reason).split("\n")[0];
        }),
    ).toEqual([]);

    // 2. Nothing printed at error level either. Prisma's client logger fires
    //    BEFORE any `catch` (see the note on `log` in src/lib/db.ts), so a
    //    conversion that merely swallowed the throw would still fail here.
    expect(errors).toEqual([]);

    // 3. Every caller was handed the token that is actually stored — not the one
    //    it tried to mint. A feed URL nobody's row matches is a 404 in somebody's
    //    calendar.
    for (const [i, trial] of trials.entries()) {
      const stored = await prisma.calendarFeed.findUnique({
        where: { userId: racers[i] },
        select: { token: true },
      });
      expect(stored).not.toBeNull();
      const returned = new Set(
        trial.map((r) =>
          r.status === "fulfilled" ? r.value.token : "(threw)",
        ),
      );
      expect([...returned]).toEqual([stored!.token]);
    }

    // 4. And exactly one row per account, so nothing above passed because the
    //    conversion quietly stopped writing.
    expect(
      await prisma.calendarFeed.count({ where: { userId: { in: racers } } }),
    ).toBe(RACE_TRIALS);
  });

  it("a duplicate token still raises — the control on the two zeroes above", async () => {
    // "No P2002" and "no prisma:error" both look identical to a harness that is
    // not watching anything. This forces the same two channels to report a
    // non-zero, using the OTHER unique index on the same table so the row a
    // racing caller wins is untouched.
    const victim = racers[0];
    const taken = (await prisma.calendarFeed.findUnique({
      where: { userId: victim },
      select: { token: true },
    }))!.token;

    const collider = await prisma.user.create({
      data: {
        provider: "gitlab",
        providerSub: `${SUB_PREFIX}race-collider`,
        status: UserStatus.Active,
      },
    });

    let rejection: unknown;
    const errors = await prismaErrorsDuring(async () => {
      rejection = await prisma.calendarFeed
        .create({ data: { userId: collider.id, token: taken } })
        .then(
          () => undefined,
          (e: unknown) => e,
        );
    });

    expect(rejection).toMatchObject({ code: "P2002" });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("token");
  });

  it("mints a distinct token per account, so identity above is not a constant", async () => {
    // The last way trial 3 could pass vacuously: if every account were handed the
    // same token, "all callers agree" would be free. Ten fresh mints, all
    // different, and every stored token distinct across the five accounts.
    const minted = new Set(Array.from({ length: 10 }, () => mintFeedToken()));
    expect(minted.size).toBe(10);

    const stored = await prisma.calendarFeed.findMany({
      where: { userId: { in: racers } },
      select: { token: true },
    });
    expect(new Set(stored.map((r) => r.token)).size).toBe(RACE_TRIALS);
  });
});

describe("what the feed body carries (#154)", () => {
  it("carries titles and times, and no other column of the row", async () => {
    const ics = await buildFeedIcs({ workspaceId: WS_A });
    expect(ics).toContain(A_STEP);
    // The row's other columns are never selected, so they cannot appear. Proved
    // on the one that would be most alarming: the step's own database id is in
    // the UID by design, but nothing carries a workspace id.
    expect(ics).not.toContain(WS_A);
  });

  it("drops work that finished before the past window opens", async () => {
    const stale = await prisma.task.create({
      data: { title: "stale-feed-task", workspaceId: WS_A },
    });
    await prisma.step.create({
      data: {
        taskId: stale.id,
        text: "stale-private-feed-step",
        order: 1,
        total: 1,
        estMinutes: 20,
        scheduledAt: new Date(
          Date.now() - (FEED_PAST_WINDOW_DAYS + 1) * 24 * 3600_000,
        ),
      },
    });

    const ics = await buildFeedIcs({ workspaceId: WS_A });
    // Control: today's step is still there, so the absence below is the window
    // and not an empty read.
    expect(ics).toContain(A_STEP);
    expect(ics).not.toContain("stale-private-feed-step");
  });
});
