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
 * **The invitation pair was verified the same way, and the result changed what
 * had to be written.** Replacing `allowlist.findUnique({ where: { claimedById:
 * userId } })` with `allowlist.findFirst({ where: {} })` — a genuinely unscoped
 * read of a table holding a private note about every invited person — failed
 * exactly ONE of the two tests: "and the invitation scoping is symmetric". The
 * other direction PASSED, because `findFirst` with no filter returned the first
 * row in the table, which happened to be that account's own.
 *
 * So a single-direction test would have reported green on a completely unscoped
 * read. The symmetry is not thoroughness here, it is the entire mechanism, and
 * that generalises to any `findFirst`-shaped leak: whichever account's row sorts
 * first gets a correct answer by luck. The same reasoning is why the
 * workspace-content checks above are also written in both directions.
 *
 * Needs the real Postgres (CI wires up a service DB and runs `prisma migrate
 * deploy` first; locally `config/vitest.config.ts` forwards DATABASE_URL from
 * `.env` — only that one variable, by design: #84).
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

  /** A's calendar feed token. A CREDENTIAL — possession of it is read access to
   *  their scheduled work — so the archive must not contain it anywhere. */
  const A_FEED_TOKEN = `${"a".repeat(20)}-aardvark-feed-capability-token`;

  async function wipeAccountRecords() {
    // `Allowlist.claimedBy` is `onDelete: SetNull`, so deleting the users leaves
    // orphaned invitation rows behind and the next run's `findUnique` on
    // `claimedById` would still be clean but the unique `(provider, identity)`
    // insert would fail. Deleted by identity prefix for that reason.
    await prisma.allowlist.deleteMany({
      where: { identity: { startsWith: SUB_PREFIX } },
    });
    // These two cascade from User, but the suite has to be re-runnable after a
    // failed run left rows behind — same reasoning as `wipe()` above.
    await prisma.user.deleteMany({
      where: { providerSub: { startsWith: SUB_PREFIX } },
    });
  }

  beforeAll(async () => {
    await wipeAccountRecords();
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

    // ── The account-scoped records, for BOTH accounts ────────────────────────
    //
    // Both, because `Allowlist` is the one table here that the scoping harness
    // cannot police — it links to `User` through `claimedById` rather than a
    // `userId` column, so `scanUserScope` never sees the read at all. The only
    // evidence the new query is scoped is a second account's row sitting in the
    // same table with a distinctive note in it.
    await prisma.allowlist.createMany({
      data: [
        {
          provider: "gitlab",
          identity: `${SUB_PREFIX}a`,
          note: "aardvark-private-invitation-note",
          claimedById: a.id,
          claimedAt: new Date(),
        },
        {
          provider: "gitlab",
          identity: `${SUB_PREFIX}b`,
          note: "badger-private-invitation-note",
          claimedById: b.id,
          claimedAt: new Date(),
        },
      ],
    });
    await prisma.userAiUsage.create({ data: { userId: a.id, count: 4 } });
    await prisma.calendarFeed.create({
      data: { userId: a.id, token: A_FEED_TOKEN },
    });
  });

  afterAll(async () => {
    await prisma.workspace.deleteMany({
      where: { id: { in: [`${WS_A}-u`, `${WS_B}-u`] } },
    });
    await wipeAccountRecords();
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

  // ── The four account records, against a real database ─────────────────────

  it("carries the account's own invitation note, and not the other account's", async () => {
    // The reason this test exists rather than only the unit ones: `Allowlist` is
    // read by `claimedById`, and that is a key `scoping.harness.test.ts` cannot
    // police — it keys on a `userId` COLUMN, which this table does not have. So
    // the ONLY evidence the read is scoped is a second account's invitation
    // sitting in the same table and staying out of this archive.
    const snapshot = await collectExport({
      workspaceId: `${WS_A}-u`,
      userId: userA,
    });
    // The control first: the note really is in this archive, so the negative
    // assertion below cannot pass because nothing was read at all.
    expect(snapshot.accountRecords.invitation?.note).toBe(
      "aardvark-private-invitation-note",
    );
    const archive = renderedArchive(snapshot);
    expect(archive).toContain("aardvark-private-invitation-note");
    expect(
      archive,
      "another account's invitation note reached this account's export",
    ).not.toContain("badger-private-invitation-note");
  });

  it("and the invitation scoping is symmetric", async () => {
    const archive = renderedArchive(
      await collectExport({ workspaceId: `${WS_B}-u`, userId: userB }),
    );
    expect(archive).toContain("badger-private-invitation-note");
    expect(archive).not.toContain("aardvark-private-invitation-note");
  });

  it("carries the AI usage counter and the feed timestamps, but NEVER the feed token", async () => {
    const snapshot = await collectExport({
      workspaceId: `${WS_A}-u`,
      userId: userA,
    });
    // Controls: both rows were read, so the token assertion is about the export
    // and not about an empty snapshot.
    expect(snapshot.accountRecords.aiUsage?.count).toBe(4);
    expect(snapshot.accountRecords.calendarFeed?.createdAt).toBeInstanceOf(
      Date,
    );
    expect(snapshot.accountRecords.calendarFeed?.rotatedAt).toBeNull();

    // The token is the third credential. Unlike the OAuth tokens and the LLM key
    // it is stored in PLAINTEXT, so there is not even a cipher between an archive
    // and a working read capability on the reader's scheduled work — which is why
    // `getOwnFeedTimestamps` never selects the column rather than leaving it to a
    // serialiser to drop.
    // The VALUE, not the word: the archive's README explains that OAuth tokens
    // are excluded, so asserting the string "token" is absent would fail on the
    // documentation of the very property being tested. `json.test.ts` covers the
    // key-name half against the parsed document, where prose cannot interfere.
    const archive = renderedArchive(snapshot);
    expect(
      archive,
      "the calendar feed's capability token reached the export",
    ).not.toContain(A_FEED_TOKEN);
  });

  it("gives a guest sandbox null account records rather than another account's", async () => {
    // A guest has no `userId`, and every one of these reads is behind that check.
    // The rows exist in the tables, so this is a real assertion about the branch
    // and not about an empty database.
    const snapshot = await collectExport({
      workspaceId: `${WS_A}-u`,
      userId: null,
    });
    expect(snapshot.accountRecords).toEqual({
      invitation: null,
      aiUsage: null,
      calendarFeed: null,
    });
    expect(snapshot.account).toBeNull();
    const archive = renderedArchive(snapshot);
    expect(archive).not.toContain("aardvark-private-invitation-note");
    expect(archive).not.toContain(A_FEED_TOKEN);
  });

  it("exports the account columns this sweep added, with their values", async () => {
    // `model-coverage.test.ts` asserts the SELECT lists them; this asserts the
    // values arrive, against a row where each one is set to something visible. The
    // two are not the same claim — a select can name a column that a later mapping
    // drops.
    //
    // Named for the six columns it actually checks. It used to say "every User
    // column the schema has", which was a completeness claim over a hand-written
    // list — the defect this MR exists to remove, in one of its own new tests. It
    // caught a dropped `lastSeenAt` because that column is on the list and was
    // blind to a dropped `provider` because it is not. Every column IS covered,
    // from `Prisma.dmmf`, by `model-coverage.test.ts`; that is the guard with the
    // completeness obligation, and this one is deliberately a value spot-check.
    const revokedAt = new Date("2026-08-10T09:00:00.000Z");
    await prisma.user.update({
      where: { id: userB },
      data: {
        status: "revoked",
        revokedAt,
        purgeAfter: new Date("2026-09-09T09:00:00.000Z"),
        llmProvider: "anthropic",
        displayName: "Badger",
      },
    });
    const snapshot = await collectExport({
      workspaceId: `${WS_B}-u`,
      userId: userB,
    });
    expect(snapshot.account?.providerSub).toBe(`${SUB_PREFIX}b`);
    expect(snapshot.account?.status).toBe("revoked");
    expect(snapshot.account?.revokedAt?.toISOString()).toBe(
      revokedAt.toISOString(),
    );
    expect(snapshot.account?.purgeAfter).toBeInstanceOf(Date);
    expect(snapshot.account?.llmProvider).toBe("anthropic");
    expect(snapshot.account?.lastSeenAt).toBeInstanceOf(Date);
    // And the workspace's own last-seen, which is the second of the two columns
    // with that name and was omitted while the account's was being added.
    expect(snapshot.workspace.lastSeenAt).toBeInstanceOf(Date);
  });
});
