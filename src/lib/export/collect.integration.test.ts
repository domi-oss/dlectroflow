import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/lib/db";
import { collectExport } from "./collect";
import { exportFileEntries } from "./bundle";
import type { ExportSnapshot } from "./types";

/**
 * #129 — the security test for the data export.
 *
 * An export endpoint is a uniquely attractive IDOR target: it returns everything
 * about an account in one request, so a scoping mistake here does not leak a
 * field, it leaks a person's whole life. This codebase has shipped a
 * cross-workspace bug before (#21), which is why the guarantee is proved against
 * a real database rather than argued from the source.
 *
 * The assertion is deliberately the STRONGEST form available: render the entire
 * archive — all seven files — and check that none of the other workspace's
 * private strings appear anywhere in it. A per-field assertion would pass while a
 * leak sat in `export.json`'s coaching transcript, which is the most sensitive
 * content in the schema.
 *
 * Every test here has a control that must SEE the content, so a fixture that
 * silently failed to write cannot make the negative assertions pass vacuously.
 * The failure mode this guards against is the one that matters: a test proving
 * nothing while reporting green.
 *
 * Verified to bite. With `where: { workspaceId }` deleted from `task.findMany`
 * and `brainDumpItem.findMany` in `collect.ts`, this file fails with
 * "another workspace's export contains no trace of the first workspace's
 * content" reporting the leaked strings.
 *
 * Needs the real Postgres (CI wires up a service DB and runs `prisma migrate
 * deploy` first; locally `vitest.config.ts` forwards DATABASE_URL from `.env`).
 */

const WS_A = "test-129-export-a";
const WS_B = "test-129-export-b";
const SUB_PREFIX = "test-129-export-";

/** Strings that exist ONLY in workspace A. Distinctive on purpose: a substring
 *  search for "task" would match the CSV headers. */
const A_SECRETS = [
  "aardvark-private-task",
  "aardvark-private-step",
  "aardvark-private-inbox-item",
  "aardvark-private-coaching-message",
  "aardvark-private-spark",
  "aardvark-private-narrative",
];

/** The whole archive as one string — every file, concatenated. */
function renderedArchive(snapshot: ExportSnapshot): string {
  return exportFileEntries(snapshot)
    .map((entry) => String(entry.data))
    .join("\n");
}

async function wipe() {
  // Written out rather than looped over an array of delegates: Prisma's generated
  // delegates are each generic over their own args type, so a union of them has no
  // callable signature and `tsc` rejects the loop. Every one of these cascades from
  // Workspace anyway — deleting them explicitly is what keeps the suite re-runnable
  // after a failed run left rows behind.
  const workspaceId = { in: [WS_A, WS_B] };
  await prisma.dailySpark.deleteMany({ where: { workspaceId } });
  await prisma.dayRollup.deleteMany({ where: { workspaceId } });
  await prisma.rewardEvent.deleteMany({ where: { workspaceId } });
  await prisma.badge.deleteMany({ where: { workspaceId } });
  await prisma.streakRecord.deleteMany({ where: { workspaceId } });
  await prisma.streak.deleteMany({ where: { workspaceId } });
  await prisma.focusSession.deleteMany({ where: { workspaceId } });
  await prisma.brainDumpItem.deleteMany({ where: { workspaceId } });
  await prisma.task.deleteMany({ where: { workspaceId } });
  await prisma.settings.deleteMany({ where: { workspaceId } });
  await prisma.workspace.deleteMany({ where: { id: { in: [WS_A, WS_B] } } });
  await prisma.user.deleteMany({
    where: { providerSub: { startsWith: SUB_PREFIX } },
  });
}

describe("cross-workspace isolation — the data export", () => {
  beforeAll(async () => {
    await wipe();
    await prisma.workspace.createMany({
      data: [
        { id: WS_A, kind: "guest" },
        { id: WS_B, kind: "guest" },
      ],
    });

    // Workspace A: every kind of content the export reads.
    const task = await prisma.task.create({
      data: {
        title: "aardvark-private-task",
        workspaceId: WS_A,
        scheduleDueAt: new Date(),
        schedulePriority: "high",
      },
    });
    await prisma.step.create({
      data: {
        taskId: task.id,
        text: "aardvark-private-step",
        order: 1,
        total: 1,
        estMinutes: 10,
        scheduledAt: new Date(),
        estimateHistory: "[5,10]",
      },
    });
    await prisma.breakdownTurn.create({
      data: {
        taskId: task.id,
        role: "assistant",
        message: "aardvark-private-coaching-message",
      },
    });
    await prisma.brainDumpItem.create({
      data: { text: "aardvark-private-inbox-item", workspaceId: WS_A },
    });
    await prisma.focusSession.create({
      data: {
        workspaceId: WS_A,
        plannedMin: 25,
        durationMin: 25,
        endedAt: new Date(),
        outcome: "completed",
      },
    });
    await prisma.settings.create({
      data: { id: WS_A, workspaceId: WS_A, voice: "playful" },
    });
    await prisma.streak.create({ data: { workspaceId: WS_A, current: 9 } });
    await prisma.badge.create({
      data: { workspaceId: WS_A, key: "first_breakdown" },
    });
    await prisma.rewardEvent.create({
      data: { workspaceId: WS_A, type: "step_done", points: 10 },
    });
    await prisma.dayRollup.create({
      data: {
        workspaceId: WS_A,
        date: "2026-08-01",
        narrative: "aardvark-private-narrative",
      },
    });
    await prisma.dailySpark.create({
      data: {
        workspaceId: WS_A,
        date: "2026-08-01",
        quote: "aardvark-private-spark",
        source: "fallback",
      },
    });

    // Workspace B: content of its own, so neither direction is a test against an
    // empty set.
    await prisma.brainDumpItem.create({
      data: { text: "badger-private-inbox-item", workspaceId: WS_B },
    });
  });

  afterAll(async () => {
    await wipe();
  });

  it("the populated workspace's own export DOES contain its content (so the test can fail)", async () => {
    // The control. Without it, every assertion below would pass if the fixtures
    // silently wrote nothing — a green suite proving that nothing was looked at.
    const archive = renderedArchive(
      await collectExport({ workspaceId: WS_A, userId: null }),
    );
    for (const secret of A_SECRETS) {
      expect(archive, `${secret} is missing from its OWN export`).toContain(
        secret,
      );
    }
  });

  it("another workspace's export contains no trace of the first workspace's content", async () => {
    const archive = renderedArchive(
      await collectExport({ workspaceId: WS_B, userId: null }),
    );
    const leaked = A_SECRETS.filter((secret) => archive.includes(secret));
    expect(leaked).toEqual([]);
  });

  it("and the leak check is symmetric", async () => {
    const archive = renderedArchive(
      await collectExport({ workspaceId: WS_A, userId: null }),
    );
    expect(archive).not.toContain("badger-private-inbox-item");
  });

  it("another workspace's export sees none of the first one's rows at all", async () => {
    // The counted form of the same property, in case a future serialiser stops
    // rendering some field into text.
    const snapshot = await collectExport({ workspaceId: WS_B, userId: null });
    expect(snapshot.tasks).toEqual([]);
    expect(snapshot.focusSessions).toEqual([]);
    expect(snapshot.gamification.badges).toEqual([]);
    expect(snapshot.gamification.rewardEvents).toEqual([]);
    expect(snapshot.gamification.dayRollups).toEqual([]);
    expect(snapshot.gamification.dailySparks).toEqual([]);
    expect(snapshot.gamification.streakRecords).toEqual([]);
    expect(snapshot.gamification.streak).toBeNull();
    expect(snapshot.settings).toBeNull();
    // Its own item is there, which is what makes the emptiness above meaningful.
    expect(snapshot.inbox.map((i) => i.text)).toEqual([
      "badger-private-inbox-item",
    ]);
  });

  it("steps and coaching turns are scoped through their task, not fetched globally", async () => {
    // Neither model carries a workspaceId, so they are the two that could only be
    // scoped by reaching them through the task read. This asserts they were.
    const snapshot = await collectExport({ workspaceId: WS_A, userId: null });
    expect(snapshot.tasks).toHaveLength(1);
    expect(snapshot.tasks[0].steps.map((s) => s.text)).toEqual([
      "aardvark-private-step",
    ]);
    expect(snapshot.tasks[0].turns.map((t) => t.message)).toEqual([
      "aardvark-private-coaching-message",
    ]);
  });

  it("does not create a settings or streak row as a side effect of exporting", async () => {
    // `getSettings()`/`getStreak()` create on first use (#156); the export must
    // not, or reading your data would modify it.
    await collectExport({ workspaceId: WS_B, userId: null });
    expect(
      await prisma.settings.findUnique({ where: { workspaceId: WS_B } }),
    ).toBeNull();
    expect(
      await prisma.streak.findUnique({ where: { workspaceId: WS_B } }),
    ).toBeNull();
  });

  it("an empty workspace still produces every file, all of them valid", async () => {
    const snapshot = await collectExport({ workspaceId: WS_B, userId: null });
    const entries = exportFileEntries(snapshot);
    expect(entries.map((e) => e.name)).toEqual([
      "README.md",
      "tasks.md",
      "tasks.csv",
      "steps.csv",
      "inbox.csv",
      "scheduled.ics",
      "export.json",
    ]);
    const byName = new Map(entries.map((e) => [e.name, String(e.data)]));
    expect(() => JSON.parse(byName.get("export.json")!)).not.toThrow();
    expect(byName.get("scheduled.ics")).toContain("END:VCALENDAR");
    expect(byName.get("steps.csv")).toBe(
      "id,task_id,order,total,text,est_minutes,done,scheduled_at\r\n",
    );
  });
});

describe("the account block is the exporting account's own", () => {
  let userA = "";
  let userB = "";

  beforeAll(async () => {
    await prisma.user.deleteMany({
      where: { providerSub: { startsWith: SUB_PREFIX } },
    });
    const a = await prisma.user.create({
      data: {
        provider: "gitlab",
        providerSub: `${SUB_PREFIX}a`,
        handle: "aardvark-handle",
        email: "aardvark@example.test",
      },
    });
    const b = await prisma.user.create({
      data: {
        provider: "gitlab",
        providerSub: `${SUB_PREFIX}b`,
        handle: "badger-handle",
        email: "badger@example.test",
      },
    });
    userA = a.id;
    userB = b.id;
    await prisma.workspace.createMany({
      data: [
        { id: `${WS_A}-u`, kind: "user", userId: a.id },
        { id: `${WS_B}-u`, kind: "user", userId: b.id },
      ],
    });
  });

  afterAll(async () => {
    await prisma.workspace.deleteMany({
      where: { id: { in: [`${WS_A}-u`, `${WS_B}-u`] } },
    });
    await prisma.user.deleteMany({
      where: { providerSub: { startsWith: SUB_PREFIX } },
    });
  });

  it("names the exporting account and no other", async () => {
    const snapshot = await collectExport({
      workspaceId: `${WS_A}-u`,
      userId: userA,
    });
    expect(snapshot.account?.handle).toBe("aardvark-handle");
    const archive = renderedArchive(snapshot);
    expect(archive).toContain("aardvark-handle");
    expect(archive).not.toContain("badger-handle");
    expect(archive).not.toContain("badger@example.test");
    expect(userB).not.toBe("");
  });

  it("never carries the encrypted per-user LLM key", async () => {
    // The narrow `select` in collect.ts is what makes this true; this is the test
    // that fails if somebody widens it to the whole row. Written against a user
    // who HAS a key, so the assertion is about the export and not about the
    // column being empty.
    await prisma.user.update({
      where: { id: userA },
      data: { llmKeyEnc: "ciphertext-that-must-never-be-exported" },
    });
    const archive = renderedArchive(
      await collectExport({ workspaceId: `${WS_A}-u`, userId: userA }),
    );
    expect(archive).not.toContain("ciphertext-that-must-never-be-exported");
    expect(archive).not.toContain("llmKeyEnc");
  });
});
