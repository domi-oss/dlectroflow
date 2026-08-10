/**
 * #199 — what `syncShoppingSummary` actually does to a real row when there is not
 * one yet.
 *
 * The colocated unit test mocks the delegate, so it asserts PAYLOADS. That is the
 * right shape for the branch logic and it is blind in two directions at once: a
 * mocked write has neither a row nor an absent row, so "existing row" and "no row
 * yet" are the same test twice, and a payload assertion cannot see what SQL Prisma
 * compiles it into. **The insert-a-row path had therefore never been executed
 * anywhere in the suite** — and it is reachable in production in exactly two
 * states, both of them described on `syncShoppingSummary` itself: the day this
 * ships over a list that already has `ShoppingItem` rows from !294, and a missed
 * sync afterwards.
 *
 * Same shape as the migration failure of 2026-08-07 — a data path only ever
 * exercised against tables in one state — so it is pinned here rather than
 * reasoned about. Both blind spots paid off immediately: the file was written to
 * confirm that `create` ignoring `resurface` is intended (it is), and the run
 * turned up a P2002 race in the branch that had looked fine, because
 * `upsert` with an EMPTY `update` silently stops being an atomic
 * `INSERT … ON CONFLICT` and becomes a read-then-insert.
 *
 * Assertions about visibility go through {@link shoppingSummaryVisible} rather
 * than reading `clearedAt`, because the question under test is "does the inbox
 * show the line", not "which value is in the column" — a test asserting the column
 * would keep passing if the reader's meaning of it ever flipped.
 *
 * Needs the real Postgres (CI wires up a service DB and runs
 * `prisma migrate deploy` first; locally it uses your DATABASE_URL schema —
 * vitest does NOT read .env):
 *   set -a; . ./.env; set +a; npm run test
 */

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { prismaErrorsDuring } from "@/lib/__tests__/prisma-error-log";
import { WorkspaceKind } from "@/lib/constants";
import { shoppingSummaryVisible } from "@/lib/shopping-summary";
import {
  clearShoppingSummary,
  syncShoppingSummary,
} from "@/lib/shopping-summary-sync";

const prisma = new PrismaClient();
const WS = "test-199-sync-ws";

/** Two still to buy, one ticked, one saved for later — so "the list is
 *  non-empty" and "the table is non-empty" cannot be confused for each other. */
const ROWS = [
  { id: "sy-1", text: "milk", done: false, savedForLater: false, order: 1 },
  { id: "sy-2", text: "bread", done: false, savedForLater: false, order: 2 },
  { id: "sy-3", text: "batteries", done: true, savedForLater: false, order: 3 },
  {
    id: "sy-4",
    text: "frying pan",
    done: false,
    savedForLater: true,
    order: 4,
  },
];

async function wipe() {
  await prisma.shoppingSummary.deleteMany({ where: { workspaceId: WS } });
  await prisma.shoppingItem.deleteMany({ where: { workspaceId: WS } });
  await prisma.workspace.deleteMany({ where: { id: WS } });
}

/** What the inbox would render right now, read the way the page reads it. */
async function inboxLine(): Promise<{ count: number } | null> {
  const [row, remaining] = await Promise.all([
    prisma.shoppingSummary.findUnique({ where: { workspaceId: WS } }),
    prisma.shoppingItem.count({
      where: { workspaceId: WS, done: false, savedForLater: false },
    }),
  ]);
  return shoppingSummaryVisible({ row, remaining });
}

beforeEach(async () => {
  await wipe();
  await prisma.workspace.create({
    data: { id: WS, kind: WorkspaceKind.Guest },
  });
  await prisma.shoppingItem.createMany({
    data: ROWS.map((r) => ({ ...r, workspaceId: WS })),
  });
});

afterAll(async () => {
  await wipe();
  await prisma.$disconnect();
});

describe("the first sync for a workspace that has no summary row yet (#199)", () => {
  it("starts a pre-existing list SHOWING, even for a write that passed resurface: false", async () => {
    // The rollout case, exactly: items from !294 are already there, no summary
    // row exists, and the first write to reach this code is a non-growing one —
    // a rename, a tick, a save-for-later.
    expect(await inboxLine(), "precondition: no row means no line").toBeNull();

    await syncShoppingSummary(WS, { resurface: false });

    // Showing is the RIGHT answer, and `resurface` is not being ignored to get
    // it: `resurface: false` means "this write is not a reason to UN-DISMISS",
    // and a row that does not exist carries no dismissal to preserve. A
    // non-empty list nobody has dismissed shows its line.
    expect(await inboxLine()).toEqual({ count: 2 });
  });

  it("starts it showing for a growing write too — the ordinary first add", async () => {
    await syncShoppingSummary(WS, { resurface: true });
    expect(await inboxLine()).toEqual({ count: 2 });
  });

  it("still honours a dismissal once the row exists — the control", async () => {
    // Without this, the two above would read the same on an implementation that
    // had simply lost the ability to hide the line at all.
    await syncShoppingSummary(WS, { resurface: false });
    await clearShoppingSummary(WS);
    expect(await inboxLine(), "dismissing did not hide the line").toBeNull();

    await syncShoppingSummary(WS, { resurface: false });
    expect(
      await inboxLine(),
      "a non-growing write resurrected a dismissed summary",
    ).toBeNull();

    await syncShoppingSummary(WS, { resurface: true });
    expect(await inboxLine(), "a growing write did not bring it back").toEqual({
      count: 2,
    });
  });

  it("self-heals rather than duplicating when the row is missing mid-life", async () => {
    // `shopping-summary.ts` promises that a list outliving its row is repaired
    // by the next write. That is the same `create` branch, reached without a
    // deploy: nothing else in the suite proves the promise.
    await syncShoppingSummary(WS, { resurface: true });
    await prisma.shoppingSummary.deleteMany({ where: { workspaceId: WS } });

    await syncShoppingSummary(WS, { resurface: false });

    expect(await inboxLine()).toEqual({ count: 2 });
    expect(
      await prisma.shoppingSummary.count({ where: { workspaceId: WS } }),
    ).toBe(1);
  });

  it("takes the row away again once nothing is left to buy", async () => {
    await syncShoppingSummary(WS, { resurface: true });
    await prisma.shoppingItem.updateMany({
      where: { workspaceId: WS },
      data: { done: true },
    });

    await syncShoppingSummary(WS, { resurface: false });

    expect(await inboxLine()).toBeNull();
    expect(
      await prisma.shoppingSummary.count({ where: { workspaceId: WS } }),
    ).toBe(0);
  });

  it("cannot create two rows when a growing write is in the race", async () => {
    // The mixed race. This one passes on the `upsert`-for-everything version
    // too, and saying so matters: it is the test that MISSED the defect below,
    // because a `resurface: true` caller wins often enough to put the row there
    // before the non-growing callers look for it.
    await Promise.all([
      syncShoppingSummary(WS, { resurface: true }),
      syncShoppingSummary(WS, { resurface: false }),
      syncShoppingSummary(WS, { resurface: true }),
      syncShoppingSummary(WS, { resurface: false }),
    ]);

    expect(
      await prisma.shoppingSummary.count({ where: { workspaceId: WS } }),
      "the sync raced itself into more than one summary row",
    ).toBe(1);
    // From a clean no-row start the answer does not depend on who won: neither
    // path dismisses anything.
    expect(await inboxLine()).toEqual({ count: 2 });
  });

  it("does not raise when only NON-GROWING writes race from the no-row state", async () => {
    // The case the mixed race above cannot see, and the one the rollout window
    // actually produces: a pre-existing list, no summary row, and two ticks or a
    // tick and a rename landing together. Every caller is `resurface: false`, so
    // nobody creates the row early and they all reach the create path at once.
    //
    // Asserted the way #158 asserts this class — a duplicate must not be RAISED,
    // not merely caught. `log: ["error"]` in `src/lib/db.ts` prints a failed
    // query before any `catch` can see it, so a P2002 here is indistinguishable
    // in production logs from a real incident even if the code recovers.
    //
    // Five trials of four, for the reason `handled-p2002.integration.test.ts`
    // gives: one trial is a single coin flip.
    const TRIALS = 5;
    const CONCURRENCY = 4;
    const rejections: string[] = [];

    const logged = await prismaErrorsDuring(async () => {
      for (let trial = 0; trial < TRIALS; trial++) {
        await prisma.shoppingSummary.deleteMany({ where: { workspaceId: WS } });

        const settled = await Promise.allSettled(
          Array.from({ length: CONCURRENCY }, () =>
            syncShoppingSummary(WS, { resurface: false }),
          ),
        );
        for (const outcome of settled) {
          if (outcome.status === "rejected") {
            rejections.push(String(outcome.reason?.code ?? outcome.reason));
          }
        }

        expect(
          await prisma.shoppingSummary.count({ where: { workspaceId: WS } }),
          "the race left the workspace without exactly one summary row",
        ).toBe(1);
      }
    });

    // The user-visible stake: the item write has already committed by the time
    // the sync runs, so a throw here fails a rename or a tick that actually
    // succeeded.
    expect(rejections, "a non-growing shopping write lost the race").toEqual(
      [],
    );
    expect(logged, "Prisma printed an error for a duplicate").toEqual([]);
  });
});
