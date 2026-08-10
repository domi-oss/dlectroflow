import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/lib/db";
import { gatherBreakdownContext } from "@/lib/breakdown-context";
import { generateTodayRollup } from "@/lib/rollup";

const A = "test-ws-A";
const B = "test-ws-B";

describe("workspace isolation", () => {
  beforeAll(async () => {
    await prisma.workspace.createMany({
      data: [
        { id: A, kind: "guest" },
        { id: B, kind: "guest" },
      ],
      skipDuplicates: true,
    });
    await prisma.brainDumpItem.create({
      data: { text: "secret-A", workspaceId: A },
    });
  });

  afterAll(async () => {
    await prisma.brainDumpItem.deleteMany({
      where: { workspaceId: { in: [A, B] } },
    });
    await prisma.workspace.deleteMany({ where: { id: { in: [A, B] } } });
    await prisma.$disconnect();
  });

  it("workspace B cannot see workspace A's item", async () => {
    const seen = await prisma.brainDumpItem.findMany({
      where: { workspaceId: B },
    });
    expect(seen).toHaveLength(0);
  });

  it("workspace A sees only its own item", async () => {
    const seen = await prisma.brainDumpItem.findMany({
      where: { workspaceId: A },
    });
    expect(seen.map((i) => i.text)).toEqual(["secret-A"]);
  });
});

// #35 Phase A — cross-workspace IDOR, through a real application read path
// rather than a hand-written query.
//
// gatherBreakdownContext is the primary subject: it is the app's egress
// boundary — whatever it returns is rendered into a prompt and sent to whatever
// LLM the deploy points at — and it reads brain dump items, tasks and steps
// under one workspace id. generateTodayRollup covers the third model the plan
// names, focus sessions. Each assertion fails if the corresponding
// `workspaceId` filter is deleted; verified by deleting one and watching this
// suite go red.
//
// Both fixtures are `kind: "guest"` so neither read path calls an LLM: this is
// a test about workspace scoping, and scoping has nothing to do with kind.
const OWNER_WS = "test-idor-owner";
const OTHER_WS = "test-idor-other";

describe("cross-workspace IDOR — the breakdown context read path", () => {
  /** OWNER_WS's task — its id is what OTHER_WS tries to name (#179). */
  let ownerTaskId = "";

  beforeAll(async () => {
    await prisma.workspace.createMany({
      data: [
        { id: OWNER_WS, kind: "guest" },
        { id: OTHER_WS, kind: "guest" },
      ],
      skipDuplicates: true,
    });

    // Populate OWNER_WS with all three kinds of content.
    await prisma.brainDumpItem.create({
      data: { text: "owner-private-item", workspaceId: OWNER_WS },
    });
    const task = await prisma.task.create({
      data: {
        title: "owner-private-task",
        workspaceId: OWNER_WS,
        // #179 — the breakdown coach now quotes this column, so it is part of
        // the IDOR surface: the task id it is keyed on arrives in the request
        // body, where anyone can put anybody's.
        notes: "owner-private-note",
      },
    });
    ownerTaskId = task.id;
    await prisma.step.create({
      data: {
        taskId: task.id,
        text: "owner-private-step",
        order: 1,
        total: 1,
        estMinutes: 10,
      },
    });
    await prisma.focusSession.create({
      data: {
        workspaceId: OWNER_WS,
        plannedMin: 25,
        durationMin: 25,
        endedAt: new Date(),
        outcome: "completed",
      },
    });
    await prisma.settings.create({
      data: { id: OWNER_WS, workspaceId: OWNER_WS, voice: "playful" },
    });
    await prisma.streak.create({
      data: { workspaceId: OWNER_WS, current: 7 },
    });
  });

  afterAll(async () => {
    await prisma.dayRollup.deleteMany({
      where: { workspaceId: { in: [OWNER_WS, OTHER_WS] } },
    });
    await prisma.dailySpark.deleteMany({
      where: { workspaceId: { in: [OWNER_WS, OTHER_WS] } },
    });
    await prisma.focusSession.deleteMany({
      where: { workspaceId: { in: [OWNER_WS, OTHER_WS] } },
    });
    await prisma.brainDumpItem.deleteMany({
      where: { workspaceId: { in: [OWNER_WS, OTHER_WS] } },
    });
    await prisma.task.deleteMany({
      where: { workspaceId: { in: [OWNER_WS, OTHER_WS] } },
    });
    await prisma.workspace.deleteMany({
      where: { id: { in: [OWNER_WS, OTHER_WS] } },
    });
  });

  it("the populated workspace's own context does contain its content (so the test can fail)", async () => {
    // Without this control every assertion below could pass simply because the
    // fixtures silently failed to write anything.
    const ctx = await gatherBreakdownContext(OWNER_WS);
    expect(ctx.voice).toBe("playful");
    expect(ctx.streak?.current).toBe(7);
    const own = Object.values(ctx.buckets ?? {}).reduce((a, b) => a + b, 0);
    expect(own).toBeGreaterThan(0);
    expect(ctx.recentBreakdowns?.length ?? 0).toBeGreaterThan(0);

    const rollup = await generateTodayRollup(OWNER_WS, true);
    expect(rollup.sessions).toBeGreaterThan(0);
    expect(rollup.focusMin).toBeGreaterThan(0);
  });

  it("another workspace's context leaks no brain dump items", async () => {
    const ctx = await gatherBreakdownContext(OTHER_WS);
    const total = Object.values(ctx.buckets ?? {}).reduce((a, b) => a + b, 0);
    expect(total).toBe(0);
  });

  it("another workspace's rollup leaks no focus sessions", async () => {
    const rollup = await generateTodayRollup(OTHER_WS, true);
    expect(rollup.sessions).toBe(0);
    expect(rollup.focusMin).toBe(0);
  });

  it("another workspace's context leaks no settings or streak", async () => {
    const ctx = await gatherBreakdownContext(OTHER_WS);
    // The populated workspace set voice "playful" and a 7-day streak; a
    // different workspace must see neither.
    expect(ctx.voice).not.toBe("playful");
    expect(ctx.streak?.current ?? 0).toBe(0);
  });

  it("no task or step text belonging to another workspace appears anywhere in the context", async () => {
    // The strongest form of the assertion: serialise the whole context and
    // check the other workspace's private strings are simply not in it.
    const serialised = JSON.stringify(await gatherBreakdownContext(OTHER_WS));
    expect(serialised).not.toContain("owner-private-item");
    expect(serialised).not.toContain("owner-private-task");
    expect(serialised).not.toContain("owner-private-step");
    expect(serialised).not.toContain("owner-private-note");
  });

  // ── #179 — the note read is keyed on a task id from the REQUEST BODY ───────
  it("the owner's own request does get the note (so the test below can fail)", async () => {
    const ctx = await gatherBreakdownContext(OWNER_WS, ownerTaskId);
    expect(ownerTaskId).not.toBe("");
    expect(ctx.note).toBe("owner-private-note");
  });

  it("naming another workspace's task id yields no note, not that task's note", async () => {
    // Delete the `workspaceId` term from the note read in breakdown-context.ts
    // and this goes red: `findFirst({ where: { id } })` on its own would hand
    // OTHER_WS the owner's note purely because it guessed the id.
    const ctx = await gatherBreakdownContext(OTHER_WS, ownerTaskId);
    expect(ctx.note).toBeNull();
    expect(JSON.stringify(ctx)).not.toContain("owner-private-note");
  });
});
