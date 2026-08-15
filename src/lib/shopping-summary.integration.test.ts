/**
 * #199 — the two claims about the inbox summary that only a real database can
 * settle.
 *
 * ## 1. The summary counts toward NOTHING
 *
 * The line is app-generated: the user did not type it. So it must not inflate the
 * inbox's own numbers, and one of those is not cosmetic —
 * `maybeAwardInboxZero` counts un-triaged inbox items, so a permanent generated
 * row in `BrainDumpItem` would make **inbox zero unreachable** for anybody who
 * keeps a shopping list, silently switching off a badge and a daily reward from
 * an unrelated feature.
 *
 * Keeping the summary in its own table makes that true by construction rather
 * than by an exclusion in each of the eighteen files that query `BrainDumpItem`.
 * "By construction" is exactly the kind of claim that is worth proving rather
 * than asserting, though — the whole point is that nothing had to be changed, and
 * a test is the only thing that can tell "nothing needed changing" from "we forgot
 * to change something". So: a workspace with a full shopping list and an empty
 * inbox still reaches inbox zero, awards the badge, and reports zero untriaged.
 *
 * ## 2. The two spellings of "still to buy" agree
 *
 * `shoppingRemainingCount` (in memory, over rows the /shopping page already
 * holds) and the `where` clause in `syncShoppingSummary` / the inbox page (in
 * SQL, because a count must not load the list) are one rule written twice. Two
 * spellings of one rule is a real risk and this is the cheapest way to close it:
 * build a list covering every combination of `done` × `savedForLater`, and assert
 * both spellings return the same number.
 *
 * Needs the real Postgres (CI wires up a service DB and runs `prisma migrate
 * deploy` first; locally `config/vitest.config.ts` forwards DATABASE_URL from
 * `.env` — only that one variable, by design: #84).
 */

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { BadgeKey, BrainDumpStatus, WorkspaceKind } from "@/lib/constants";
import { shoppingRemainingCount } from "@/lib/shopping";
import { maybeAwardInboxZero } from "@/lib/rewards";

const prisma = new PrismaClient();
const WS = "test-199-summary-ws";

/** Every combination of the two booleans, so neither spelling of the rule can
 *  pass by ignoring one of them. */
const ROWS = [
  { id: "s-1", text: "milk", done: false, savedForLater: false, order: 1 },
  { id: "s-2", text: "bread", done: false, savedForLater: false, order: 2 },
  { id: "s-3", text: "batteries", done: true, savedForLater: false, order: 3 },
  { id: "s-4", text: "frying pan", done: false, savedForLater: true, order: 4 },
  { id: "s-5", text: "lightbulbs", done: true, savedForLater: true, order: 5 },
];

async function wipe() {
  await prisma.shoppingSummary.deleteMany({ where: { workspaceId: WS } });
  await prisma.shoppingItem.deleteMany({ where: { workspaceId: WS } });
  await prisma.brainDumpItem.deleteMany({ where: { workspaceId: WS } });
  await prisma.rewardEvent.deleteMany({ where: { workspaceId: WS } });
  await prisma.badge.deleteMany({ where: { workspaceId: WS } });
  await prisma.streak.deleteMany({ where: { workspaceId: WS } });
  await prisma.workspace.deleteMany({ where: { id: WS } });
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

describe("the shopping list counts toward nothing in the inbox (#199)", () => {
  it("leaves inbox zero reachable with a full shopping list and a live summary", async () => {
    // The summary row exists and is showing — the state a stored generated
    // BrainDumpItem would have been in.
    await prisma.shoppingSummary.create({ data: { workspaceId: WS } });

    await maybeAwardInboxZero(WS);

    const badge = await prisma.badge.findFirst({
      where: { workspaceId: WS, key: BadgeKey.InboxZero },
    });
    expect(badge, "inbox zero was not awarded").not.toBeNull();
  });

  it("does not appear among the workspace's inbox items at all", async () => {
    await prisma.shoppingSummary.create({ data: { workspaceId: WS } });
    // The query every inbox surface makes — the page, the freshness clock, the
    // untriaged nav badge and the daily-review nudge all start from this table.
    const inbox = await prisma.brainDumpItem.findMany({
      where: { workspaceId: WS },
    });
    expect(inbox).toEqual([]);
  });

  it("still lets a REAL capture block inbox zero — the control", async () => {
    // Without this, the assertion above would pass just as happily if
    // maybeAwardInboxZero were broken, or if this workspace were somehow invisible.
    await prisma.shoppingSummary.create({ data: { workspaceId: WS } });
    await prisma.brainDumpItem.create({
      data: { text: "something I typed", workspaceId: WS },
    });

    await maybeAwardInboxZero(WS);

    expect(
      await prisma.badge.findFirst({
        where: { workspaceId: WS, key: BadgeKey.InboxZero },
      }),
    ).toBeNull();
    // And the capture really is in the inbox bucket, so the block is for the right
    // reason.
    expect(
      await prisma.brainDumpItem.count({
        where: { workspaceId: WS, status: BrainDumpStatus.Inbox },
      }),
    ).toBe(1);
  });
});

describe("'still to buy' means the same thing in SQL and in memory (#199)", () => {
  it("agrees on a list covering every done × savedForLater combination", async () => {
    const rows = await prisma.shoppingItem.findMany({
      where: { workspaceId: WS },
    });
    const inSql = await prisma.shoppingItem.count({
      where: { workspaceId: WS, done: false, savedForLater: false },
    });

    expect(shoppingRemainingCount(rows)).toBe(inSql);
    // Pinned to the literal answer as well, so a change that broke BOTH spellings
    // in the same direction still fails. Two of the five rows are un-ticked and
    // not saved for later.
    expect(inSql).toBe(2);
  });

  it("agrees when nothing is left to buy", async () => {
    await prisma.shoppingItem.updateMany({
      where: { workspaceId: WS },
      data: { done: true },
    });
    const rows = await prisma.shoppingItem.findMany({
      where: { workspaceId: WS },
    });
    const inSql = await prisma.shoppingItem.count({
      where: { workspaceId: WS, done: false, savedForLater: false },
    });
    expect(shoppingRemainingCount(rows)).toBe(inSql);
    expect(inSql).toBe(0);
  });
});
