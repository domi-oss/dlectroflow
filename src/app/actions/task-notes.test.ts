import { describe, it, expect, vi, beforeEach } from "vitest";
import { TASK_NOTE_MAX_LENGTH } from "@/lib/task-notes";

// Hoisted mocks at the @/lib/db and @/lib/workspace boundary — the style
// schedule-intent.test.ts and google-schedule.push.test.ts both use. No real
// Postgres: the DB's own half of this feature is proved in
// src/lib/notes-length-check.integration.test.ts.
const { findFirstMock, updateMock, workspaceMock, revalidatePathMock } =
  vi.hoisted(() => ({
    findFirstMock: vi.fn(),
    updateMock: vi.fn(),
    workspaceMock: vi.fn(),
    revalidatePathMock: vi.fn(),
  }));

vi.mock("next/cache", () => ({ revalidatePath: revalidatePathMock }));
vi.mock("@/lib/db", () => ({
  prisma: { task: { findFirst: findFirstMock, update: updateMock } },
}));
vi.mock("@/lib/workspace", () => ({ currentWorkspaceId: workspaceMock }));

import { updateTaskNotes } from "./task-notes";

beforeEach(() => {
  vi.clearAllMocks();
  workspaceMock.mockResolvedValue("ws_1");
  findFirstMock.mockResolvedValue({ id: "t1" });
  updateMock.mockResolvedValue({});
});

describe("updateTaskNotes", () => {
  it("writes the normalised note and reports what was stored", async () => {
    // The caller gets the stored value back rather than assuming its own input
    // was kept: normalisation can trim, strip and clamp, and a field that keeps
    // showing text the database does not have is a lie the user acts on.
    const res = await updateTaskNotes("t1", "  Bring the Figma link  ");
    expect(res).toEqual({ ok: true, notes: "Bring the Figma link" });
    expect(updateMock).toHaveBeenCalledWith({
      where: { id: "t1" },
      data: { notes: "Bring the Figma link" },
    });
  });

  it("stores NULL for a cleared note, not an empty string", async () => {
    // The column's vocabulary: NULL is "no note", and it is what stops a blank
    // line being composed into somebody's calendar entry.
    const res = await updateTaskNotes("t1", "   \n  ");
    expect(res).toEqual({ ok: true, notes: null });
    expect(updateMock).toHaveBeenCalledWith({
      where: { id: "t1" },
      data: { notes: null },
    });
  });

  it("clamps an over-long note rather than letting the DB CHECK reject it", async () => {
    // The constraint is the backstop, not the error path: a rejected write
    // surfaces as a generic autosave failure with nothing the user can act on.
    const res = await updateTaskNotes(
      "t1",
      "x".repeat(TASK_NOTE_MAX_LENGTH * 2),
    );
    expect(res.ok && res.notes).toHaveLength(TASK_NOTE_MAX_LENGTH);
    const written = updateMock.mock.calls[0][0].data.notes as string;
    expect(written).toHaveLength(TASK_NOTE_MAX_LENGTH);
  });

  it("is workspace-scoped — the ownership check precedes the write (IDOR)", async () => {
    await updateTaskNotes("t1", "hi");
    expect(findFirstMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "t1", workspaceId: "ws_1" } }),
    );
    expect(findFirstMock.mock.invocationCallOrder[0]).toBeLessThan(
      updateMock.mock.invocationCallOrder[0],
    );
  });

  it("refuses a task in another workspace, writing nothing", async () => {
    // `update` is keyed on the id alone — Prisma cannot filter a unique update
    // by a relation field — so the preceding scoped read is the ENTIRE
    // authorization. If it ever stops gating the write this is an IDOR that
    // rewrites a stranger's note.
    findFirstMock.mockResolvedValue(null);
    const res = await updateTaskNotes("someone-elses-task", "mine now");
    expect(res).toEqual({ ok: false, reason: "not_found" });
    expect(updateMock).not.toHaveBeenCalled();
    expect(revalidatePathMock).not.toHaveBeenCalled();
  });

  it("invalidates the task page so a reload shows what was saved", async () => {
    await updateTaskNotes("t1", "hi");
    expect(revalidatePathMock).toHaveBeenCalledWith("/tasks/t1");
    expect(revalidatePathMock).toHaveBeenCalledWith("/");
  });

  it("invalidates EVERY list that renders the note, /library included", async () => {
    // Duo review (!270) found `/library` missing and was told by the comment
    // above the call that the Library was a deferral. That comment was true
    // when it was written and stopped being true two commits later: #44's
    // surface sweep mounted `TaskNoteRow` in `library-rows.tsx` and
    // `library-multistep.tsx`, and `library/page.tsx` selects `task.notes`
    // into the row. So the Library renders the value and must be invalidated
    // with the other two — one path too few is exactly #139.
    //
    // Asserted as a SET rather than three separate `toHaveBeenCalledWith`
    // lines, because the failure this guards against is an omission, and an
    // omission is invisible to an assertion that only looks at what is there.
    await updateTaskNotes("t1", "hi");
    expect(revalidatePathMock.mock.calls.map(([p]) => p).sort()).toEqual([
      "/",
      "/library",
      "/tasks/t1",
    ]);
  });

  it("invalidates the path from the ROW it authorised, not the argument", async () => {
    // Duo review (!270) read `revalidatePath(`/tasks/${taskId}`)` as arbitrary
    // path invalidation. It is not: the `findFirst` above is keyed on
    // `id: taskId`, so a returned row's `id` IS the argument, and a task the
    // workspace does not own returns early (asserted directly above — nothing
    // is revalidated on that path).
    //
    // The value is sourced from the row anyway, and this test locks that,
    // because it is the property the sibling `step-notes.ts` depends on and
    // the two actions should not have to be reasoned about differently. The
    // mock returns an id the caller did not pass, which cannot happen against
    // real Prisma — that is the point: the test fails if the path is ever
    // rebuilt from unvalidated input.
    findFirstMock.mockResolvedValue({ id: "t-from-db" });
    await updateTaskNotes("t-from-caller", "hi");
    expect(revalidatePathMock).toHaveBeenCalledWith("/tasks/t-from-db");
    expect(revalidatePathMock).not.toHaveBeenCalledWith("/tasks/t-from-caller");
  });

  it("reports a failed write instead of throwing at the client", async () => {
    // Autosave has no submit button to re-enable, so the action resolves with a
    // reason and the field paints its error affordance. An unhandled rejection
    // here would surface as a Next.js server-action error overlay.
    updateMock.mockRejectedValue(new Error("db down"));
    const res = await updateTaskNotes("t1", "hi");
    expect(res).toEqual({ ok: false, reason: "error" });
  });
});
