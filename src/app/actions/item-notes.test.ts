/**
 * Action tests for `updateItemNotes` — the item grain of #44's note (#186).
 *
 * The sibling of `task-notes.ts` and `step-notes.ts`, and the assertions that
 * matter are the same two: **the scoped read is the authorization**, and the
 * ORDER of the two calls is what makes it one. `prisma.brainDumpItem.update` is
 * keyed on the unique id alone, so nothing in the write itself mentions the
 * workspace — if the `findFirst` ever stops gating it, this becomes an IDOR that
 * rewrites a stranger's note.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { prismaMock, revalidatePathMock, currentWorkspaceIdMock } = vi.hoisted(
  () => {
    const prismaMock = {
      brainDumpItem: {
        findFirst: vi.fn(),
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

beforeEach(() => {
  vi.clearAllMocks();
  currentWorkspaceIdMock.mockResolvedValue("owner");
  prismaMock.brainDumpItem.update.mockResolvedValue({});
});

describe("updateItemNotes (#186)", () => {
  it("scopes the read to the resolved workspace", async () => {
    prismaMock.brainDumpItem.findFirst.mockResolvedValueOnce({
      id: "i1",
      taskId: null,
    });
    const { updateItemNotes } = await import("./item-notes");
    await updateItemNotes("i1", "can under sink");
    expect(prismaMock.brainDumpItem.findFirst).toHaveBeenCalledWith({
      where: { id: "i1", workspaceId: "owner" },
      select: { id: true, taskId: true },
    });
  });

  it("gates the write on that read, in that order", async () => {
    // The order IS the authorization, because the update is keyed on the id
    // alone. Asserted rather than assumed, exactly as `task-notes.test.ts` does.
    const order: string[] = [];
    prismaMock.brainDumpItem.findFirst.mockImplementationOnce(async () => {
      order.push("read");
      return { id: "i1", taskId: null };
    });
    prismaMock.brainDumpItem.update.mockImplementationOnce(async () => {
      order.push("write");
      return {};
    });
    const { updateItemNotes } = await import("./item-notes");
    await updateItemNotes("i1", "note");
    expect(order).toEqual(["read", "write"]);
  });

  it("refuses another workspace's item without writing", async () => {
    prismaMock.brainDumpItem.findFirst.mockResolvedValueOnce(null);
    const { updateItemNotes } = await import("./item-notes");
    expect(await updateItemNotes("theirs", "note")).toEqual({
      ok: false,
      reason: "not_found",
    });
    expect(prismaMock.brainDumpItem.update).not.toHaveBeenCalled();
  });

  it("stores the NORMALISED note and returns it", async () => {
    // The field adopts what was stored, so returning the caller's input would
    // leave it displaying text the database does not have.
    prismaMock.brainDumpItem.findFirst.mockResolvedValueOnce({
      id: "i1",
      taskId: null,
    });
    const { updateItemNotes } = await import("./item-notes");
    const res = await updateItemNotes("i1", "  09:00\r\n\x00sharp  ");
    expect(prismaMock.brainDumpItem.update).toHaveBeenCalledWith({
      where: { id: "i1" },
      data: { notes: "09:00\nsharp" },
    });
    expect(res).toEqual({ ok: true, notes: "09:00\nsharp" });
  });

  it("folds an empty note back to NULL", async () => {
    // "" masquerading as a note puts a blank line in somebody's calendar entry.
    prismaMock.brainDumpItem.findFirst.mockResolvedValueOnce({
      id: "i1",
      taskId: null,
    });
    const { updateItemNotes } = await import("./item-notes");
    expect(await updateItemNotes("i1", "   ")).toEqual({
      ok: true,
      notes: null,
    });
    expect(prismaMock.brainDumpItem.update).toHaveBeenCalledWith({
      where: { id: "i1" },
      data: { notes: null },
    });
  });

  it("refuses a task-backed item — that grain is dead once triage has run", async () => {
    // `brainDumpItemToTaskData` COPIES the note onto the `Task`, and from then on
    // every note surface reads the task column. Writing this one would store an
    // edit nothing displays, which to the person is a save that silently did
    // nothing. The UI never mounts this control on a task-backed row; the guard
    // is here so the grain rule is enforced rather than merely observed.
    prismaMock.brainDumpItem.findFirst.mockResolvedValueOnce({
      id: "i1",
      taskId: "t1",
    });
    const { updateItemNotes } = await import("./item-notes");
    expect(await updateItemNotes("i1", "note")).toEqual({
      ok: false,
      reason: "wrong_grain",
    });
    expect(prismaMock.brainDumpItem.update).not.toHaveBeenCalled();
  });

  it("resolves rather than throws when the write fails", async () => {
    // Autosave has no submit button to re-enable: the field paints its error
    // affordance and stays editable. An unhandled rejection would instead throw a
    // server-action overlay over a page somebody is typing in.
    prismaMock.brainDumpItem.findFirst.mockResolvedValueOnce({
      id: "i1",
      taskId: null,
    });
    prismaMock.brainDumpItem.update.mockRejectedValueOnce(new Error("boom"));
    const { updateItemNotes } = await import("./item-notes");
    expect(await updateItemNotes("i1", "note")).toEqual({
      ok: false,
      reason: "error",
    });
  });

  it("revalidates every surface that renders an item note", async () => {
    // `/` and `/library` — both render inbox/pantry rows. NOT `/tasks/:id`: an
    // item in this grain has no task page to serve a stale note from.
    prismaMock.brainDumpItem.findFirst.mockResolvedValueOnce({
      id: "i1",
      taskId: null,
    });
    const { updateItemNotes } = await import("./item-notes");
    await updateItemNotes("i1", "note");
    expect(revalidatePathMock.mock.calls.map(([p]) => p).sort()).toEqual([
      "/",
      "/library",
    ]);
  });
});
