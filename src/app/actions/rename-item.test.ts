/**
 * Action tests for renameItem (✎ edit title on any inbox row).
 * Renaming keeps a linked task's title in sync (editor/timer never show a
 * stale name); empty/whitespace input is a no-op.
 *
 * Mirrors the vi.mock shape used in request-breakdown.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { prismaMock, revalidatePathMock, currentWorkspaceIdMock } = vi.hoisted(
  () => {
    const prismaMock = {
      brainDumpItem: {
        findFirst: vi.fn(),
        update: vi.fn().mockResolvedValue({}),
      },
      task: {
        update: vi.fn().mockResolvedValue({}),
      },
    };
    return {
      prismaMock,
      revalidatePathMock: vi.fn(),
      currentWorkspaceIdMock: vi.fn().mockResolvedValue("owner"),
    };
  },
);
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
}));

beforeEach(() => {
  vi.clearAllMocks();
  currentWorkspaceIdMock.mockResolvedValue("owner");
});

describe("renameItem", () => {
  /**
   * A stored row as the action reads it. `text`, `notes` and the task's `notes`
   * are all load-bearing now: #179 makes a rename a re-parse, so the action has
   * to know what was already there before it can tell an edit from an unchanged
   * save.
   */
  const stored = (over: Record<string, unknown> = {}) => ({
    id: "i1",
    text: "old name",
    notes: null,
    taskId: null,
    task: null,
    ...over,
  });

  it("no-ops on empty / whitespace-only input", async () => {
    const { renameItem } = await import("./braindump");
    await renameItem("i1", "   ");
    expect(prismaMock.brainDumpItem.findFirst).not.toHaveBeenCalled();
    expect(prismaMock.brainDumpItem.update).not.toHaveBeenCalled();
  });

  it("no-ops when the item is missing (workspace-scoped)", async () => {
    prismaMock.brainDumpItem.findFirst.mockResolvedValueOnce(null);
    const { renameItem } = await import("./braindump");
    await renameItem("nope", "new name");
    expect(prismaMock.brainDumpItem.update).not.toHaveBeenCalled();
  });

  it("renames the item (trimmed) and revalidates the surfaces that show it", async () => {
    prismaMock.brainDumpItem.findFirst.mockResolvedValueOnce(stored());
    const { renameItem } = await import("./braindump");
    await renameItem("i1", "  new name  ");
    expect(prismaMock.brainDumpItem.update).toHaveBeenCalledWith({
      where: { id: "i1" },
      data: { text: "new name", notes: null },
    });
    expect(prismaMock.task.update).not.toHaveBeenCalled();
    expect(revalidatePathMock).toHaveBeenCalledWith("/");
    // `/library` because a rename can now change a NOTE, and `updateTaskNotes`
    // already treats the Library as a surface that renders one. A note edited
    // here and stale there is the #139 class of bug.
    expect(revalidatePathMock).toHaveBeenCalledWith("/library");
  });

  it("keeps a linked task's title in sync and revalidates its page", async () => {
    prismaMock.brainDumpItem.findFirst.mockResolvedValueOnce(
      stored({ taskId: "t1", task: { notes: null } }),
    );
    const { renameItem } = await import("./braindump");
    await renameItem("i1", "new name");
    expect(prismaMock.task.update).toHaveBeenCalledWith({
      where: { id: "t1" },
      data: { title: "new name", notes: null },
    });
    expect(revalidatePathMock).toHaveBeenCalledWith("/tasks/t1");
    expect(revalidatePathMock).toHaveBeenCalledWith("/");
  });

  // ── #179 — the rename is a re-parse, so it is also the erosion path ────────
  describe("the inline note syntax (#179)", () => {
    it("splits a trailing group into the note column", async () => {
      prismaMock.brainDumpItem.findFirst.mockResolvedValueOnce(stored());
      const { renameItem } = await import("./braindump");
      await renameItem("i1", "water the plants {can under sink}");
      expect(prismaMock.brainDumpItem.update).toHaveBeenCalledWith({
        where: { id: "i1" },
        data: { text: "water the plants", notes: "can under sink" },
      });
    });

    it("follows Decision 1 literally — only the LAST group is the note", async () => {
      prismaMock.brainDumpItem.findFirst.mockResolvedValueOnce(stored());
      const { renameItem } = await import("./braindump");
      await renameItem("i1", "fix {foo} {bar}");
      expect(prismaMock.brainDumpItem.update).toHaveBeenCalledWith({
        where: { id: "i1" },
        data: { text: "fix {foo}", notes: "bar" },
      });
    });

    it("an UNCHANGED save writes back exactly what was stored", async () => {
      // The pre-filled value is `inlineNoteSource`'s reconstruction, so this is
      // the string the edit field actually hands back when nobody types.
      prismaMock.brainDumpItem.findFirst.mockResolvedValueOnce(
        stored({ text: "fix {foo}", notes: "bar" }),
      );
      const { renameItem } = await import("./braindump");
      await renameItem("i1", "fix {foo} {bar}");
      expect(prismaMock.brainDumpItem.update).toHaveBeenCalledWith({
        where: { id: "i1" },
        data: { text: "fix {foo}", notes: "bar" },
      });
    });

    it("does not erode when the field held only the stored TEXT", async () => {
      // The erosion bug, at the layer it happened. Before the save layer existed
      // this wrote text `fix` and note `foo`, losing a group of text AND
      // replacing the note `bar`. Every subsequent save took another group.
      prismaMock.brainDumpItem.findFirst.mockResolvedValueOnce(
        stored({ text: "fix {foo}", notes: "bar" }),
      );
      const { renameItem } = await import("./braindump");
      await renameItem("i1", "fix {foo}");
      expect(prismaMock.brainDumpItem.update).toHaveBeenCalledWith({
        where: { id: "i1" },
        data: { text: "fix {foo}", notes: "bar" },
      });
    });

    it("keeps the note when the edit leaves no trailing group", async () => {
      prismaMock.brainDumpItem.findFirst.mockResolvedValueOnce(
        stored({ text: "water the plants", notes: "can under sink" }),
      );
      const { renameItem } = await import("./braindump");
      await renameItem("i1", "water the plants today");
      expect(prismaMock.brainDumpItem.update).toHaveBeenCalledWith({
        where: { id: "i1" },
        data: { text: "water the plants today", notes: "can under sink" },
      });
    });

    it("normalises the note on the way in", async () => {
      // `normalizeTaskNote` is on this path, not just on the capture one — the
      // C0 sweep and the 2000-code-point clamp are what `BrainDumpItem_notes_check`
      // is asserted against, and reaching the CHECK from here would surface as a
      // generic "could not save".
      prismaMock.brainDumpItem.findFirst.mockResolvedValueOnce(stored());
      const { renameItem } = await import("./braindump");
      await renameItem("i1", "ring the dentist {09:00\x00 sharp}");
      expect(prismaMock.brainDumpItem.update).toHaveBeenCalledWith({
        where: { id: "i1" },
        data: { text: "ring the dentist", notes: "09:00 sharp" },
      });
    });

    it("writes the TASK's note for a task-backed row, not the item's", async () => {
      // The live grain. `brainDumpItemToTaskData` copies the item note into
      // `Task.notes` at triage, and every note SURFACE reads the task column
      // from then on — so writing the item column here would store an edit
      // nothing displays, and re-showing the item column in the field would
      // silently revert a note edited through `NoteField`.
      prismaMock.brainDumpItem.findFirst.mockResolvedValueOnce(
        stored({
          taskId: "t1",
          notes: "stale item copy",
          task: { notes: "live" },
        }),
      );
      const { renameItem } = await import("./braindump");
      await renameItem("i1", "old name {fresh}");
      expect(prismaMock.brainDumpItem.update).toHaveBeenCalledWith({
        where: { id: "i1" },
        data: { text: "old name" },
      });
      expect(prismaMock.task.update).toHaveBeenCalledWith({
        where: { id: "t1" },
        data: { title: "old name", notes: "fresh" },
      });
    });

    it("reads the TASK's note when deciding whether a save changed anything", async () => {
      // Same grain rule from the other side: the field was pre-filled from
      // `Task.notes`, so an unchanged save has to compare against that.
      prismaMock.brainDumpItem.findFirst.mockResolvedValueOnce(
        stored({
          text: "fix {foo}",
          taskId: "t1",
          notes: null,
          task: { notes: "bar" },
        }),
      );
      const { renameItem } = await import("./braindump");
      await renameItem("i1", "fix {foo} {bar}");
      expect(prismaMock.task.update).toHaveBeenCalledWith({
        where: { id: "t1" },
        data: { title: "fix {foo}", notes: "bar" },
      });
    });

    it("loads the task's note in the SAME workspace-scoped read", async () => {
      // Not a second query, and not an unscoped one: the note it compares
      // against has to come through the same ownership gate as the item.
      prismaMock.brainDumpItem.findFirst.mockResolvedValueOnce(stored());
      const { renameItem } = await import("./braindump");
      await renameItem("i1", "new name");
      expect(prismaMock.brainDumpItem.findFirst).toHaveBeenCalledWith({
        where: { id: "i1", workspaceId: "owner" },
        include: { task: { select: { notes: true } } },
      });
    });
  });
});
