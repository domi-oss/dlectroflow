/**
 * Action tests for `createBrainDumpItem` — the CAPTURE half of #179.
 *
 * The inline note syntax lives or dies here: this is the one place a note can be
 * created at the speed of a thought, and a false positive silently removes text
 * somebody typed. The parser itself is exercised exhaustively in
 * `src/lib/braindump-note-syntax.test.ts`; what these assert is that the action
 * is wired to it at all, that the note goes through `normalizeTaskNote` on the
 * way to a CHECK-constrained column, and that Decision 1 survives the trip.
 *
 * ## #175 moved the write, and these tests deliberately still reach Postgres
 *
 * The action delegates to `writeCapture` (`src/lib/capture-write.ts`), which is
 * also what `POST /api/braindump` calls — one write path, one set of semantics.
 * `@/lib/capture-write` is therefore NOT mocked here: mocking it would leave
 * these cases asserting that one function calls another, and the #179 guarantee
 * they exist for (what actually lands in the two columns) would stop being
 * checked from the action at all. The delegate mocked is Prisma's, and the write
 * is `createManyAndReturn` + `skipDuplicates` rather than `create` — the
 * `INSERT … ON CONFLICT DO NOTHING` shape `src/lib/db.ts` argues for, so a
 * replayed capture cannot print `prisma:error` (#156, #158).
 *
 * Mirrors the vi.mock shape used in rename-item.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  prismaMock,
  revalidatePathMock,
  currentWorkspaceIdMock,
  touchStreakOnEngagementMock,
} = vi.hoisted(() => {
  const prismaMock = {
    brainDumpItem: {
      // The row the WINNER of an `ON CONFLICT DO NOTHING` gets back. A
      // non-queued capture carries no `clientKey`, and Postgres treats nulls as
      // distinct in a unique index, so this path always wins.
      createManyAndReturn: vi.fn().mockResolvedValue([{ id: "item-1" }]),
    },
  };
  return {
    prismaMock,
    revalidatePathMock: vi.fn(),
    currentWorkspaceIdMock: vi.fn().mockResolvedValue("owner"),
    touchStreakOnEngagementMock: vi.fn().mockResolvedValue(null),
  };
});
vi.mock("next/cache", () => ({ revalidatePath: revalidatePathMock }));
vi.mock("@/lib/db", () => ({ prisma: prismaMock }));
vi.mock("@/lib/workspace", () => ({
  currentWorkspaceId: currentWorkspaceIdMock,
  isOwnerRequest: vi.fn().mockResolvedValue(true),
  MissingWorkspaceError: class extends Error {},
}));
vi.mock("@/lib/rewards", () => ({
  maybeAwardInboxZero: vi.fn().mockResolvedValue(undefined),
  maybeAwardTenStepsDay: vi.fn().mockResolvedValue(undefined),
  logReward: vi.fn().mockResolvedValue(undefined),
  awardBadge: vi.fn().mockResolvedValue(undefined),
  touchStreakOnCompletion: vi.fn().mockResolvedValue(null),
  touchStreakOnEngagement: touchStreakOnEngagementMock,
}));

beforeEach(() => {
  vi.clearAllMocks();
  currentWorkspaceIdMock.mockResolvedValue("owner");
});

/** The `data` the one write was made with. */
const capturedData = () =>
  prismaMock.brainDumpItem.createManyAndReturn.mock.calls[0][0].data as Record<
    string,
    unknown
  >;

describe("createBrainDumpItem — the inline note syntax (#179)", () => {
  it("splits a trailing brace group into text and the note column", async () => {
    const { createBrainDumpItem } = await import("./braindump");
    await createBrainDumpItem(
      "water the office plants {can under sink needs a wash}",
    );
    expect(capturedData()).toEqual({
      text: "water the office plants",
      notes: "can under sink needs a wash",
      workspaceId: "owner",
      clientKey: null,
    });
  });

  it("stores a plain capture unchanged, with no note", async () => {
    const { createBrainDumpItem } = await import("./braindump");
    await createBrainDumpItem("  buy milk  ");
    expect(capturedData()).toEqual({
      text: "buy milk",
      notes: null,
      workspaceId: "owner",
      // #175 — a non-queued capture has no idempotency key, and must not invent
      // one: a value here would put every ordinary capture under
      // `BrainDumpItem_workspaceId_clientKey_key`, where the null keeps them all
      // distinct.
      clientKey: null,
    });
  });

  it("follows Decision 1 literally — only the LAST group is the note", async () => {
    const { createBrainDumpItem } = await import("./braindump");
    await createBrainDumpItem("fix {foo} {bar}");
    expect(capturedData()).toMatchObject({ text: "fix {foo}", notes: "bar" });
  });

  it("leaves a mid-string group in the text", async () => {
    const { createBrainDumpItem } = await import("./braindump");
    await createBrainDumpItem("fix the {foo} handler");
    expect(capturedData()).toMatchObject({
      text: "fix the {foo} handler",
      notes: null,
    });
  });

  it("keeps a group that would leave no text as literal text", async () => {
    // An item whose only content is hidden behind a note disclosure is not a
    // captured thought, so the parser refuses and the person sees what they
    // typed.
    const { createBrainDumpItem } = await import("./braindump");
    await createBrainDumpItem("{just a note}");
    expect(capturedData()).toMatchObject({
      text: "{just a note}",
      notes: null,
    });
  });

  it("normalises the note on the way to a CHECK-constrained column", async () => {
    // `normalizeTaskNote` is on the path, not left to `BrainDumpItem_notes_check`
    // — reaching the constraint from the writer that forgot surfaces to the user
    // as a generic failure with nothing they can act on.
    const { createBrainDumpItem } = await import("./braindump");
    await createBrainDumpItem("ring the dentist {09:00\r\n\x00sharp}");
    expect(capturedData()).toMatchObject({
      text: "ring the dentist",
      notes: "09:00\nsharp",
    });
  });

  it("clamps an over-long note rather than letting the column reject it", async () => {
    const { createBrainDumpItem } = await import("./braindump");
    const { TASK_NOTE_MAX_LENGTH } = await import("@/lib/task-notes");
    await createBrainDumpItem(`big paste {${"a".repeat(2500)}}`);
    expect([...(capturedData().notes as string)]).toHaveLength(
      TASK_NOTE_MAX_LENGTH,
    );
  });

  it("still no-ops on empty / whitespace-only input", async () => {
    const { createBrainDumpItem } = await import("./braindump");
    await createBrainDumpItem("   \n\t ");
    expect(prismaMock.brainDumpItem.createManyAndReturn).not.toHaveBeenCalled();
    // Not an engagement either — nothing was captured, so nothing may advance
    // the streak.
    expect(touchStreakOnEngagementMock).not.toHaveBeenCalled();
  });

  it("counts a capture WITH a note as one engagement, exactly as before", async () => {
    const { createBrainDumpItem } = await import("./braindump");
    await createBrainDumpItem("water the plants {can under sink}");
    expect(touchStreakOnEngagementMock).toHaveBeenCalledTimes(1);
    expect(revalidatePathMock).toHaveBeenCalledWith("/");
  });
});
