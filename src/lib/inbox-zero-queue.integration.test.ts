/**
 * #251 review — the two shapes of "still needs triage" must agree.
 *
 * `maybeAwardInboxZero` counts the queue in SQL (`inboxZeroQueueWhere`);
 * `deleteBrainDumpItem` asks whether the row it just removed was in that queue,
 * and can only ask in memory (`countsTowardInboxZero`), because by the time it
 * asks, its own guarded `updateMany` has already cleared `completedAt`. Two
 * genuinely different questions, so two expressions — and the delete's own
 * comment was right that two copies of this predicate drifting apart would be
 * worse than the leak it was declining to fix.
 *
 * This file is what makes them one definition rather than two copies: it builds
 * every combination of the three terms as real rows and asserts that Postgres and
 * the row predicate select exactly the same set. Adding a term to one shape and
 * not the other fails here rather than shipping as "+15 points for deleting an
 * unfinished to-do".
 *
 * Real Postgres and not a unit test on purpose. The whole risk being managed is
 * that the SQL means something other than what the TypeScript means — a mocked
 * `count` would compare the predicate against itself.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { BrainDumpStatus } from "@/lib/constants";
import {
  inboxZeroQueueWhere,
  countsTowardInboxZero,
} from "@/lib/inbox-zero-queue";

const WS = "test-251-inbox-zero-queue-ws";
const prisma = new PrismaClient();

/** One instant for both shapes — comparing two clocks would prove nothing. */
const NOW = new Date();
const PAST = new Date(NOW.getTime() - 60_000);
const FUTURE = new Date(NOW.getTime() + 60_000);

/**
 * Every combination of the three terms the predicate reads, plus the two edge
 * cases on the snooze comparison: a snooze that has just elapsed is in the queue
 * (`lte`), one still to come is not.
 */
const CASES: {
  label: string;
  status: string;
  completedAt: Date | null;
  snoozedUntil: Date | null;
}[] = [];
for (const status of [
  BrainDumpStatus.Inbox,
  BrainDumpStatus.Triaged,
  BrainDumpStatus.Archived,
]) {
  for (const completedAt of [null, PAST]) {
    for (const snoozedUntil of [null, PAST, NOW, FUTURE]) {
      CASES.push({
        label: `${status}/${completedAt ? "completed" : "open"}/snooze=${
          snoozedUntil === null
            ? "none"
            : snoozedUntil === FUTURE
              ? "future"
              : snoozedUntil === NOW
                ? "now"
                : "past"
        }`,
        status,
        completedAt,
        snoozedUntil,
      });
    }
  }
}

beforeAll(async () => {
  await prisma.brainDumpItem.deleteMany({ where: { workspaceId: WS } });
  await prisma.workspace.deleteMany({ where: { id: WS } });
  await prisma.workspace.create({ data: { id: WS, kind: "guest" } });
  await prisma.brainDumpItem.createMany({
    data: CASES.map((c) => ({
      text: c.label,
      workspaceId: WS,
      status: c.status,
      completedAt: c.completedAt,
      snoozedUntil: c.snoozedUntil,
    })),
  });
});

afterAll(async () => {
  await prisma.brainDumpItem.deleteMany({ where: { workspaceId: WS } });
  await prisma.workspace.deleteMany({ where: { id: WS } });
  await prisma.$disconnect();
});

describe("the inbox-zero queue predicate, in both shapes (#251)", () => {
  it("selects the same rows in SQL as it does in memory", async () => {
    const inSql = (
      await prisma.brainDumpItem.findMany({
        where: inboxZeroQueueWhere(WS, NOW),
        select: { text: true },
      })
    )
      .map((r) => r.text)
      .sort();

    const inMemory = CASES.filter((c) => countsTowardInboxZero(c, NOW))
      .map((c) => c.label)
      .sort();

    // Non-empty on both sides before they are compared: two empty sets are equal
    // and would prove nothing, which is the shape of an unproven zero.
    expect(inMemory.length).toBeGreaterThan(0);
    expect(inSql.length).toBeGreaterThan(0);
    expect(inSql).toEqual(inMemory);
    // …and it really is a subset of the fixture, not all of it — otherwise a
    // predicate that returned `true` for everything would pass.
    expect(inSql.length).toBeLessThan(CASES.length);
  });

  it("scopes to the workspace on both sides", async () => {
    // The SQL shape carries `workspaceId` and the row shape cannot, which is why
    // the delete's gate is `AND`-ed with a workspace-scoped read rather than
    // standing alone. Asserted so that stays true of the SQL half at least.
    const other = await prisma.brainDumpItem.count({
      where: inboxZeroQueueWhere("some-other-workspace", NOW),
    });
    expect(other).toBe(0);
  });
});
