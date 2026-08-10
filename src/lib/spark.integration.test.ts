import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/lib/db";
import { prismaErrorsDuring } from "@/lib/__tests__/prisma-error-log";
import { WorkspaceKind } from "@/lib/constants";
import { getTodaySpark } from "./spark";

/**
 * #223 — the second `upsert` whose empty update payload does not do what its
 * comment said it did.
 *
 * `update: {}, // if two requests race, keep the first` reads as a considered
 * answer to the concurrency question. It is not one. Prisma 6.19 compiles an
 * upsert to a native `INSERT … ON CONFLICT` **only when the update payload is
 * non-empty**; with an empty one it degrades to `BEGIN; SELECT; INSERT; COMMIT`
 * — a read-then-insert at READ COMMITTED, exactly the shape of the `findUnique`
 * above it. Two requests from the no-row state both insert, and the loser
 * raises P2002 out of the dashboard render.
 *
 * Run against the pre-fix `upsert`, the first assertion below captured
 * **12 of 20 racing calls rejecting with P2002** (5 trials x 4 callers,
 * 2026-08-09), and the same number of `prisma:error` lines. The zeroes are a
 * measurement, not an untested green — and the last test in the file keeps
 * proving this harness can see a non-zero at all, because "no error" and
 * "nothing was looked at" are the same output otherwise.
 *
 * Needs real Postgres, and that is the whole point: `spark.test.ts` mocks the
 * Prisma delegate, so "row exists" and "no row yet" are the same test twice and
 * no payload assertion can observe which SQL Prisma emits.
 *
 * Guest workspaces throughout. `quoteFor` short-circuits to a canned line for a
 * guest (`isGuestWorkspace`), so nothing here reaches an LLM, needs a key, or
 * depends on a network — and the fallback is drawn at random from eight, which
 * is what makes "every caller returned the winner's quote" a real assertion
 * rather than a tautology.
 */

const WS_PREFIX = "itest-223-spark";

// A first-use race can only happen once per (workspace, date), so one trial
// would be a single coin flip. Five workspaces, each with four concurrent
// readers, makes a lost race effectively certain — and a run that did serialise
// completely still passes, correctly; it just proves less that time.
const TRIALS = 5;
const CONCURRENCY = 4;
const workspaceIds = Array.from(
  { length: TRIALS },
  (_, i) => `${WS_PREFIX}-${i}`,
);

async function cleanup() {
  // DailySpark cascades from Workspace, so this clears both.
  await prisma.workspace.deleteMany({
    where: { id: { startsWith: WS_PREFIX } },
  });
}

beforeAll(async () => {
  await cleanup();
  await prisma.workspace.createMany({
    data: workspaceIds.map((id) => ({ id, kind: WorkspaceKind.Guest })),
  });
  // Open the connection pool before timing matters. Prisma connects lazily, so
  // the very first burst serialises on the handshake and would not race at all.
  await Promise.all(
    Array.from({ length: CONCURRENCY }, () => prisma.workspace.count()),
  );
});

afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

describe("getTodaySpark under genuine concurrency (#223)", () => {
  it("four concurrent first requests of the day: none raises", async () => {
    const trials: PromiseSettledResult<{ quote: string; source: string }>[][] =
      [];

    const errors = await prismaErrorsDuring(async () => {
      for (const workspaceId of workspaceIds) {
        trials.push(
          await Promise.allSettled(
            Array.from({ length: CONCURRENCY }, () =>
              getTodaySpark(workspaceId),
            ),
          ),
        );
      }
    });

    // 1. The defect: P2002 escaping into the render. Mapped to the Prisma error
    //    CODE rather than counted, so a failure names it instead of printing
    //    "expected 12 to be 0".
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

    // 2. And nothing printed at error level either. Prisma's client logger fires
    //    BEFORE any `catch` (the note on `log` in src/lib/db.ts), so a fix that
    //    merely swallowed the throw would still fail here.
    expect(errors).toEqual([]);

    // 3. Every caller got the row that is actually stored — "keep the first" is
    //    the property the old comment claimed, and the only way to hold it is to
    //    return the winner's row rather than the quote this call generated.
    for (const [i, trial] of trials.entries()) {
      const stored = await prisma.dailySpark.findFirst({
        where: { workspaceId: workspaceIds[i] },
        select: { quote: true, source: true },
      });
      expect(stored).not.toBeNull();
      const returned = new Set(
        trial.map((r) =>
          r.status === "fulfilled" ? r.value.quote : "(threw)",
        ),
      );
      expect([...returned]).toEqual([stored!.quote]);
    }

    // 4. Exactly one row per workspace, so none of the above passed because the
    //    conversion quietly stopped writing.
    expect(
      await prisma.dailySpark.count({
        where: { workspaceId: { startsWith: WS_PREFIX } },
      }),
    ).toBe(TRIALS);
  });

  it("a second call the same day re-reads rather than re-generating", async () => {
    // The behaviour the cache exists for, pinned across the conversion: the row
    // written by the burst above is what a later request gets back, unchanged.
    const [workspaceId] = workspaceIds;
    const stored = await prisma.dailySpark.findFirst({
      where: { workspaceId },
      select: { quote: true, source: true },
    });

    expect(await getTodaySpark(workspaceId)).toEqual({
      quote: stored!.quote,
      source: stored!.source,
    });
    expect(await prisma.dailySpark.count({ where: { workspaceId } })).toBe(1);
  });

  it("a duplicate (workspace, date) still raises — the control on the zeroes", async () => {
    // "No P2002" and "no prisma:error" are also what a harness that watched
    // nothing reports. This drives the same two channels to a non-zero, on the
    // very index the conversion relies on `ON CONFLICT DO NOTHING` skipping.
    const [workspaceId] = workspaceIds;
    const row = (await prisma.dailySpark.findFirst({
      where: { workspaceId },
      select: { date: true },
    }))!;

    let rejection: unknown;
    const errors = await prismaErrorsDuring(async () => {
      rejection = await prisma.dailySpark
        .create({
          data: {
            workspaceId,
            date: row.date,
            quote: "a deliberate duplicate",
            source: "fallback",
          },
        })
        .then(
          () => undefined,
          (e: unknown) => e,
        );
    });

    expect(rejection).toMatchObject({ code: "P2002" });
    expect(errors).toHaveLength(1);
    // Assert on the COLUMNS, not on the rendered call: Prisma prints the
    // invocation as `.create()` (without the delegate) when the call spans
    // several source lines, which is a formatting detail, not the signal.
    expect(errors[0]).toContain("(`workspaceId`,`date`)");
  });
});
