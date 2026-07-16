import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { prisma } from "@/lib/db";
import { touchStreakOnCompletion } from "./rewards";

// Real-DB proof for issue #21 P5.3: the read-decide-write in
// touchStreakOnCompletion must be serialised so concurrent
// first-completions-of-the-day can't double-file a StreakRecord or
// double-count the increment. Mocks can't demonstrate the interactive-tx
// row lock, so this fires genuinely concurrent calls against Postgres.

const WS = "test-ws-streak-race";

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
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
});

describe("touchStreakOnCompletion — concurrency safety (#21 P5.3)", () => {
  it("2 concurrent completions on a working day advance the streak exactly once", async () => {
    const now = new Date();
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);

    await prisma.streak.upsert({
      where: { workspaceId: WS },
      create: { id: WS, workspaceId: WS, current: 3, lastActiveWorkday: ymd(yesterday) },
      update: { current: 3, lastActiveWorkday: ymd(yesterday) },
    });

    await Promise.all([touchStreakOnCompletion(WS), touchStreakOnCompletion(WS)]);

    const streak = await prisma.streak.findUnique({ where: { workspaceId: WS } });
    expect(streak?.current).toBe(4); // advanced once, not twice
    expect(streak?.lastActiveWorkday).toBe(ymd(now));
    const records = await prisma.streakRecord.count({ where: { workspaceId: WS } });
    expect(records).toBe(0); // continue path files nothing
  });

  it("2 concurrent completions after a gap file at most one StreakRecord on reset", async () => {
    const now = new Date();
    const threeAgo = new Date(now);
    threeAgo.setDate(now.getDate() - 3);

    await prisma.streak.upsert({
      where: { workspaceId: WS },
      create: { id: WS, workspaceId: WS, current: 3, lastActiveWorkday: ymd(threeAgo) },
      update: { current: 3, lastActiveWorkday: ymd(threeAgo) },
    });

    await Promise.all([touchStreakOnCompletion(WS), touchStreakOnCompletion(WS)]);

    const streak = await prisma.streak.findUnique({ where: { workspaceId: WS } });
    expect(streak?.current).toBe(1); // reset to 1
    expect(streak?.lastActiveWorkday).toBe(ymd(now));
    const records = await prisma.streakRecord.findMany({ where: { workspaceId: WS } });
    expect(records).toHaveLength(1); // exactly one ended streak filed
    expect(records[0].length).toBe(3);
  });
});
