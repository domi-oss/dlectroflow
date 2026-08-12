import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  afterAll,
  beforeEach,
} from "vitest";
import { prisma } from "@/lib/db";
import { touchStreakOnCompletion } from "./rewards";

// Real-DB proof for issue #21 P5.3: the read-decide-write in
// touchStreakOnCompletion must be serialised so concurrent
// first-completions-of-the-day can't double-file a StreakRecord or
// double-count the increment. Mocks can't demonstrate the interactive-tx
// row lock, so this fires genuinely concurrent calls against Postgres.
//
// ── #233 — deleted, restored, and then found to be half a proof ─────────────
//
// `783a6bf` (`!330`, #251) deleted all 113 lines of this file and its commit
// body never mentioned doing so — that body is entirely about moving the
// inbox-zero predicate into `inbox-zero-queue.ts`. It merged as `ecde80f` and
// shipped. Restored because #233's severity table argues `logReward` is the
// only unguarded reward call by listing this lock as an equivalent defence, and
// an unproven defence cannot carry that argument. `rewards-streak.test.ts`
// holds the one assertion that makes a second silent deletion red the suite.
//
// The restore was verified the way this repo verifies a guard — by deleting the
// guard. Removing `FOR UPDATE` from the raw locking read at `rewards.ts:596`
// **must** red this file. Measured on the restored file as it stood, it only
// half did, and the reason is the whole design of the barrier below.
//
//  1. The reset test red 3 runs out of 3. Two unserialised callers each file a
//     `StreakRecord`, and 2 ≠ 1.
//  2. The continue test red 0 runs out of 4 — and not because its assertions
//     were weak. Instrumented, the two calls returned
//     `[{continued:true},{continued:false}]` **with the lock removed**: they
//     never overlapped at all. It is the first test in the file, so the Prisma
//     connection pool is cold, the second caller waits for the first's
//     connection, and the "concurrent" pair runs strictly sequentially. It was
//     passing because nothing raced, which is the exact shape of a green signal
//     that means nothing was looked at.
//
// `reopen-item.integration.test.ts` hit the same wall for #196 and recorded the
// answer: "a test that only fails when it is run alone is not a proof of
// anything, so the interleaving is arranged rather than hoped for." Same
// conclusion here, with one difference in where the barrier has to sit. That
// file parks a caller at the `$transaction` boundary, which is enough when the
// read being raced is outside the transaction. Here the read is INSIDE it —
// `tx.$queryRaw … FOR UPDATE` then `tx.streak.findUnique` — so parking at the
// boundary would prove nothing: the parked caller re-reads after the other has
// committed and correctly early-returns whether or not the lock exists. The
// window the lock closes is between that read and `tx.streak.update`, so that
// is where the park goes.
//
// Both tests also assert that the overlap they depend on actually happened
// (`maxLiveTx`). Without it a future change in pool behaviour would quietly
// return this file to passing vacuously, and the second time would be harder to
// notice than the first.

const WS = vi.hoisted(() => "test-ws-streak-race");

/**
 * One-shot park between a caller's locking read and its `Streak` write, plus an
 * observer for how many callers were genuinely inside a transaction at once.
 *
 * `wait` parks the FIRST caller to reach `tx.streak.update` and clears itself,
 * so the second runs straight through. `onPark` fires as that caller goes to
 * sleep, which is the signal each test waits on instead of a timer.
 *
 * `liveTx`/`maxLiveTx` count inside the transaction callback rather than around
 * the `$transaction` call, deliberately: a caller still queued for a connection
 * has read nothing and must not be counted as overlapping. With the lock in
 * place the second caller does reach the callback and then blocks on
 * `FOR UPDATE`, so a real overlap stays observable — which is what makes
 * `maxLiveTx === 2` a usable precondition on both sides of the mutation.
 */
const barrier = vi.hoisted(() => ({
  wait: null as Promise<void> | null,
  onPark: null as (() => void) | null,
  liveTx: 0,
  maxLiveTx: 0,
}));

vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db")>();

  // Only `tx.streak.update` is wrapped; every other delegate and method is the
  // real one, bound to its real receiver. Prisma's client is itself a Proxy and
  // reading through two of them with a rebound `this` is a trap this does not
  // need to walk into — the note `reopen-item.integration.test.ts` carries.
  const wrapTx = (realTx: object) =>
    new Proxy(realTx, {
      get(t, prop, recv) {
        if (prop !== "streak") {
          const value = Reflect.get(t, prop, recv);
          return typeof value === "function" ? value.bind(t) : value;
        }
        const streak = Reflect.get(t, prop, recv) as object;
        return new Proxy(streak, {
          get(s, p, r) {
            const value = Reflect.get(s, p, r);
            if (p !== "update") {
              return typeof value === "function" ? value.bind(s) : value;
            }
            const update = value as (...a: unknown[]) => Promise<unknown>;
            return async (...args: unknown[]) => {
              const wait = barrier.wait;
              if (wait) {
                barrier.wait = null; // one-shot — the next caller is not parked
                barrier.onPark?.();
                await wait;
              }
              return update.call(s, ...args);
            };
          },
        });
      },
    });

  const prisma = new Proxy(actual.prisma, {
    get(target, prop, receiver) {
      if (prop !== "$transaction") {
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      }
      const run = target.$transaction as unknown as (
        ...a: unknown[]
      ) => Promise<unknown>;
      return (...args: unknown[]) => {
        const [callback, ...rest] = args;
        // Only the interactive form takes a callback. The array form passes
        // straight through, so this mock cannot change what any other caller in
        // the tree does.
        if (typeof callback !== "function") return run.apply(target, args);
        const cb = callback as (tx: unknown) => Promise<unknown>;
        return run.call(
          target,
          async (realTx: object) => {
            barrier.liveTx += 1;
            barrier.maxLiveTx = Math.max(barrier.maxLiveTx, barrier.liveTx);
            try {
              return await cb(wrapTx(realTx));
            } finally {
              barrier.liveTx -= 1;
            }
          },
          ...rest,
        );
      };
    },
  });

  return { ...actual, prisma };
});

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
}

/**
 * Arrange the interleaving, then hand back the two return values.
 *
 * The first caller to reach its `Streak` write is parked. Release happens once
 * two callers have been inside a transaction simultaneously — never on a timer,
 * because a timer long enough to be reliable on a loaded CI runner is long
 * enough to slow every run of this file, and one short enough to be quick is
 * the flake. The bound is a deadline rather than the wait's exit condition, so
 * a genuine failure to overlap surfaces as `maxLiveTx` failing its assertion
 * inside the test rather than as a hang.
 */
async function twoConcurrentCompletions() {
  let release!: () => void;
  barrier.wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const parked = new Promise<void>((resolve) => {
    barrier.onPark = resolve;
  });

  const running = Promise.all([
    touchStreakOnCompletion(WS),
    touchStreakOnCompletion(WS),
  ]);

  await parked;
  // The second caller has to have got inside its own transaction, or there is
  // no race to observe and releasing here would prove nothing. Under the lock
  // it is sitting in `FOR UPDATE`; without the lock it may already have run to
  // completion, and `maxLiveTx` records that it overlapped either way.
  const deadline = Date.now() + 10_000;
  while (barrier.maxLiveTx < 2 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  release();
  return running;
}

beforeAll(async () => {
  await prisma.workspace.upsert({
    where: { id: WS },
    create: { id: WS, kind: "guest" },
    update: {},
  });
  // Every ISO weekday counts as a working day, so "today" and "yesterday"
  // always qualify — the test is deterministic regardless of the day it runs.
  await prisma.settings.upsert({
    where: { workspaceId: WS },
    create: { id: WS, workspaceId: WS, workingDays: "1,2,3,4,5,6,7" },
    update: { workingDays: "1,2,3,4,5,6,7" },
  });

  // #233 — force the engine to hold two connections before anything measures
  // concurrency. A cold pool is what made the restored continue test a no-op:
  // the second caller waits for the first's connection, so `Promise.all`
  // produces two sequential calls and every assertion about serialisation
  // passes with the lock doing none of the work. Two deliberately overlapping
  // transactions are what open the second connection — a pair of plain queries
  // can be served one after the other on a single one.
  await Promise.all([
    prisma.$transaction(async (tx) => {
      // `::text` because `pg_sleep` returns `void` and Prisma cannot
      // deserialize that column type — it fails the whole suite, not the query.
      await tx.$queryRaw`SELECT pg_sleep(0.05)::text`;
    }),
    prisma.$transaction(async (tx) => {
      // `::text` because `pg_sleep` returns `void` and Prisma cannot
      // deserialize that column type — it fails the whole suite, not the query.
      await tx.$queryRaw`SELECT pg_sleep(0.05)::text`;
    }),
  ]);
});

afterAll(async () => {
  await prisma.streakRecord.deleteMany({ where: { workspaceId: WS } });
  await prisma.badge.deleteMany({ where: { workspaceId: WS } });
  await prisma.streak.deleteMany({ where: { workspaceId: WS } });
  await prisma.settings.deleteMany({ where: { workspaceId: WS } });
  await prisma.workspace.deleteMany({ where: { id: WS } });
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.streakRecord.deleteMany({ where: { workspaceId: WS } });
  await prisma.badge.deleteMany({ where: { workspaceId: WS } });
  barrier.wait = null;
  barrier.onPark = null;
  barrier.liveTx = 0;
  barrier.maxLiveTx = 0;
});

describe("touchStreakOnCompletion — concurrency safety (#21 P5.3)", () => {
  it("2 concurrent completions on a working day advance the streak exactly once", async () => {
    const now = new Date();
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);

    await prisma.streak.upsert({
      where: { workspaceId: WS },
      create: {
        id: WS,
        workspaceId: WS,
        current: 3,
        lastActiveWorkday: ymd(yesterday),
      },
      update: { current: 3, lastActiveWorkday: ymd(yesterday) },
    });

    const results = await twoConcurrentCompletions();

    // #233 — the precondition, asserted rather than assumed. Nothing below is
    // evidence about the lock unless the two callers really were inside a
    // transaction at the same time.
    expect(barrier.maxLiveTx).toBe(2);

    const streak = await prisma.streak.findUnique({
      where: { workspaceId: WS },
    });
    expect(streak?.current).toBe(4); // advanced once, not twice
    expect(streak?.lastActiveWorkday).toBe(ymd(now));
    const records = await prisma.streakRecord.count({
      where: { workspaceId: WS },
    });
    expect(records).toBe(0); // continue path files nothing

    // #233 — the assertions that can see the lock on THIS path. The stored
    // state cannot: both callers compute the absolute value `4` from the same
    // read, so an unserialised pair still leaves `current === 4` and files no
    // record. Exactly one caller may report that it moved the streak; the other
    // blocks on the row lock, re-reads `lastActiveWorkday === today` and
    // returns `continued: false`. `continued` is not cosmetic — the streak
    // surfaces are driven off it, so two callers both claiming an extension is
    // the user-visible half of this race.
    //
    // Which caller wins is not deterministic, so these count rather than index:
    // a test that assumes an ordering Postgres never promised is a flake.
    expect(results.filter((r) => r?.continued === true)).toHaveLength(1);
    expect(results.filter((r) => r?.continued === false)).toHaveLength(1);
    // Both callers still see the settled length, so neither returns a stale
    // streak to whatever is about to render it.
    expect(results.map((r) => r?.current)).toEqual([4, 4]);
    // A continue is not a fresh start on either side. `freshStart` awards the
    // once-ever `comeback` badge, and the loser must not claim one.
    expect(results.filter((r) => r?.freshStart === true)).toHaveLength(0);
  });

  it("2 concurrent completions after a gap file at most one StreakRecord on reset", async () => {
    const now = new Date();
    const threeAgo = new Date(now);
    threeAgo.setDate(now.getDate() - 3);

    await prisma.streak.upsert({
      where: { workspaceId: WS },
      create: {
        id: WS,
        workspaceId: WS,
        current: 3,
        lastActiveWorkday: ymd(threeAgo),
      },
      update: { current: 3, lastActiveWorkday: ymd(threeAgo) },
    });

    const results = await twoConcurrentCompletions();

    expect(barrier.maxLiveTx).toBe(2);

    const streak = await prisma.streak.findUnique({
      where: { workspaceId: WS },
    });
    expect(streak?.current).toBe(1); // reset to 1
    expect(streak?.lastActiveWorkday).toBe(ymd(now));
    const records = await prisma.streakRecord.findMany({
      where: { workspaceId: WS },
    });
    expect(records).toHaveLength(1); // exactly one ended streak filed
    expect(records[0].length).toBe(3);

    // #233 — the return-value half, for the same reason as the continue path.
    // `freshStart` awards the once-ever `comeback` badge, so two callers both
    // claiming one is reportable even where the stored state came out right. On
    // this path the park sits after the loser's `StreakRecord` create, so an
    // unserialised pair reds on this and on the count above.
    expect(results.filter((r) => r?.freshStart === true)).toHaveLength(1);
    expect(results.filter((r) => r?.freshStart === false)).toHaveLength(1);
    expect(results.map((r) => r?.current)).toEqual([1, 1]);
  });
});
