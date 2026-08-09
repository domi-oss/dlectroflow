/**
 * #199 — what `syncShoppingSummary`'s `upsert` actually does to a real row.
 *
 * The colocated unit test (`shopping-summary-sync.test.ts`) mocks
 * `prisma.shoppingSummary.upsert`, so it can only assert the PAYLOAD. That is the
 * right shape for the branch logic, but it means the `create` clause has never
 * been executed: a mocked upsert has neither a row nor an absent row, so
 * "existing row" and "no row yet" are the same test twice.
 *
 * The gap matters because the two clauses disagree on purpose. `update` consults
 * `resurface`; `create` does not mention `clearedAt` at all. **The first write
 * against a list whose summary row does not exist yet therefore takes a branch no
 * test had ever run** — and that state is reachable in exactly one way in
 * production: the day this ships, for every workspace that already has
 * `ShoppingItem` rows from !294.
 *
 * That is the same shape as the migration incident of 2026-08-07 (a data path
 * only ever exercised against tables in one state), so it is pinned here against
 * real Postgres rather than reasoned about.
 *
 * Assertions go through {@link shoppingSummaryVisible} rather than reading
 * `clearedAt`, because the question under test is "does the inbox show the line",
 * not "which value is in the column" — a test that asserted the column would keep
 * passing if the reader's meaning of it ever flipped.
 *
 * Needs the real Postgres (CI wires up a service DB and runs
 * `prisma migrate deploy` first; locally it uses your DATABASE_URL schema —
 * vitest does NOT read .env):
 *   set -a; . ./.env; set +a; npm run test
 */

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
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

  it("cannot create two rows when writes race from the no-row state", async () => {
    // The doc's claim for keying the upsert on the PRIMARY KEY: the loser's
    // insert collides and becomes an update instead of a second row. Both
    // `update` shapes are in the race, because the `resurface: false` one is
    // EMPTY and an empty update is the payload most likely to be handled by a
    // different code path inside Prisma.
    await Promise.all([
      syncShoppingSummary(WS, { resurface: true }),
      syncShoppingSummary(WS, { resurface: false }),
      syncShoppingSummary(WS, { resurface: true }),
      syncShoppingSummary(WS, { resurface: false }),
    ]);

    expect(
      await prisma.shoppingSummary.count({ where: { workspaceId: WS } }),
      "the upsert raced itself into more than one summary row",
    ).toBe(1);
    // From a clean no-row start the answer does not depend on who won: neither
    // clause dismisses anything.
    expect(await inboxLine()).toEqual({ count: 2 });
  });
});
