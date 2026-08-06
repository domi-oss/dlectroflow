import { describe, it, expect, vi, beforeEach } from "vitest";
import { TASK_NOTE_MAX_LENGTH } from "@/lib/task-notes";

// Hoisted mocks at the @/lib/db and @/lib/workspace boundary, matching
// step-edit.test.ts — the file that covers this action's nearest siblings
// (`renameStep`, `updateStepEstimate`) and pins the same scoping shape.
const { findFirstMock, updateMock, workspaceMock, revalidatePathMock } =
  vi.hoisted(() => ({
    findFirstMock: vi.fn(),
    updateMock: vi.fn(),
    workspaceMock: vi.fn(),
    revalidatePathMock: vi.fn(),
  }));

vi.mock("next/cache", () => ({ revalidatePath: revalidatePathMock }));
vi.mock("@/lib/db", () => ({
  prisma: { step: { findFirst: findFirstMock, update: updateMock } },
}));
vi.mock("@/lib/workspace", () => ({ currentWorkspaceId: workspaceMock }));

import { updateStepNotes } from "./step-notes";

beforeEach(() => {
  vi.clearAllMocks();
  workspaceMock.mockResolvedValue("ws_1");
  findFirstMock.mockResolvedValue({ id: "s1", taskId: "t1" });
  updateMock.mockResolvedValue({});
});

describe("updateStepNotes", () => {
  it("writes the normalised note and reports what was stored", async () => {
    const res = await updateStepNotes("s1", "  call Sam first  ");
    expect(res).toEqual({ ok: true, notes: "call Sam first" });
    expect(updateMock).toHaveBeenCalledWith({
      where: { id: "s1" },
      data: { notes: "call Sam first" },
    });
  });

  it("stores NULL for a cleared note, not an empty string", async () => {
    const res = await updateStepNotes("s1", "  \n ");
    expect(res).toEqual({ ok: true, notes: null });
    expect(updateMock).toHaveBeenCalledWith({
      where: { id: "s1" },
      data: { notes: null },
    });
  });

  it("shares the task-level bound rather than declaring a second one", async () => {
    // One constant, two columns, two CHECK constraints with the same number.
    // A step-specific bound would be a second thing to keep in sync with
    // Google's cap for no benefit.
    const res = await updateStepNotes(
      "s1",
      "x".repeat(TASK_NOTE_MAX_LENGTH * 2),
    );
    expect(res.ok && res.notes).toHaveLength(TASK_NOTE_MAX_LENGTH);
  });

  it("scopes THROUGH the parent task's workspace, and gates the write on it", async () => {
    // A Step has no `workspaceId` of its own; it is reached through its task,
    // which is the idiom `renameStep` and `completeStep` already use. Getting
    // this wrong is an IDOR that annotates a stranger's step.
    await updateStepNotes("s1", "hi");
    expect(findFirstMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "s1", task: { workspaceId: "ws_1" } },
      }),
    );
    expect(findFirstMock.mock.invocationCallOrder[0]).toBeLessThan(
      updateMock.mock.invocationCallOrder[0],
    );
  });

  it("refuses a step in another workspace, writing nothing", async () => {
    findFirstMock.mockResolvedValue(null);
    const res = await updateStepNotes("someone-elses-step", "mine now");
    expect(res).toEqual({ ok: false, reason: "not_found" });
    expect(updateMock).not.toHaveBeenCalled();
    expect(revalidatePathMock).not.toHaveBeenCalled();
  });

  it("invalidates the task page the step belongs to, using the row's OWN taskId", async () => {
    // From the scoped read, never from a caller-supplied id: a `taskId`
    // parameter would let a caller invalidate an arbitrary path, and would be a
    // second thing that has to be checked against the workspace.
    findFirstMock.mockResolvedValue({ id: "s1", taskId: "t-parent" });
    await updateStepNotes("s1", "hi");
    expect(revalidatePathMock).toHaveBeenCalledWith("/tasks/t-parent");
    expect(revalidatePathMock).toHaveBeenCalledWith("/");
  });

  it("invalidates EVERY list that renders the note, /library included", async () => {
    // The twin of the task action's assertion, and for the same reason: the
    // Library's expanded multi-step row renders `TaskSteps`, which mounts a
    // `StepNote` per step, and `library/page.tsx` selects `s.notes` into it.
    // A step note saved from there has to survive a client-side navigation
    // away and back (!270).
    findFirstMock.mockResolvedValue({ id: "s1", taskId: "t-parent" });
    await updateStepNotes("s1", "hi");
    expect(revalidatePathMock.mock.calls.map(([p]) => p).sort()).toEqual([
      "/",
      "/library",
      "/tasks/t-parent",
    ]);
  });

  it("reports a failed write instead of throwing at the client", async () => {
    updateMock.mockRejectedValue(new Error("db down"));
    const res = await updateStepNotes("s1", "hi");
    expect(res).toEqual({ ok: false, reason: "error" });
  });
});
