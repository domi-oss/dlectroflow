/**
 * Action tests for breakdown.ts › ejectStepToInbox — moving a step back to
 * the inbox "needs review" bucket as its own item and renumbering the rest.
 * Mocks mirror braindump.test.ts: next/cache, @/lib/db, @/lib/workspace.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { prismaMock, revalidatePathMock, currentWorkspaceIdMock } = vi.hoisted(() => {
  const prismaMock = {
    step: {
      findFirst: vi.fn(),
      delete: vi.fn().mockResolvedValue({}),
      findMany: vi.fn(),
      update: vi.fn().mockImplementation((args) => Promise.resolve(args)),
    },
    brainDumpItem: {
      create: vi.fn().mockResolvedValue({ id: "new-item" }),
    },
    $transaction: vi.fn((ops: unknown[]) => Promise.all(ops as Promise<unknown>[])),
  };
  return {
    prismaMock,
    revalidatePathMock: vi.fn(),
    currentWorkspaceIdMock: vi.fn().mockResolvedValue("owner"),
  };
});

vi.mock("next/cache", () => ({ revalidatePath: revalidatePathMock }));
vi.mock("@/lib/db", () => ({ prisma: prismaMock }));
vi.mock("@/lib/workspace", () => ({
  currentWorkspaceId: currentWorkspaceIdMock,
  isOwnerRequest: vi.fn().mockResolvedValue(true),
  MissingWorkspaceError: class MissingWorkspaceError extends Error {},
}));

describe("breakdown.ts › ejectStepToInbox", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentWorkspaceIdMock.mockResolvedValue("owner");
    prismaMock.step.findFirst.mockResolvedValue({
      id: "s2",
      taskId: "t1",
      text: "book the venue",
      order: 2,
    });
    // Remaining steps after s2 is deleted, in current order.
    prismaMock.step.findMany.mockResolvedValue([
      { id: "s1", order: 1 },
      { id: "s3", order: 3 },
    ]);
  });

  it("is workspace-scoped and no-ops when the step isn't the caller's", async () => {
    prismaMock.step.findFirst.mockResolvedValueOnce(null);
    const { ejectStepToInbox } = await import("./breakdown");
    const res = await ejectStepToInbox("s2");
    expect(res).toBeNull();
    expect(prismaMock.step.findFirst.mock.calls[0][0].where).toEqual({
      id: "s2",
      task: { workspaceId: "owner" },
    });
    expect(prismaMock.brainDumpItem.create).not.toHaveBeenCalled();
    expect(prismaMock.step.delete).not.toHaveBeenCalled();
  });

  it("creates a needs-review inbox item from the step text", async () => {
    const { ejectStepToInbox } = await import("./breakdown");
    await ejectStepToInbox("s2");
    expect(prismaMock.brainDumpItem.create).toHaveBeenCalledTimes(1);
    expect(prismaMock.brainDumpItem.create.mock.calls[0][0].data).toMatchObject({
      text: "book the venue",
      workspaceId: "owner",
      status: "inbox",
    });
  });

  it("deletes the step and renumbers the remaining ones contiguously", async () => {
    const { ejectStepToInbox } = await import("./breakdown");
    const res = await ejectStepToInbox("s2");

    expect(prismaMock.step.delete).toHaveBeenCalledWith({ where: { id: "s2" } });
    // s1 → order 1/total 2, s3 → order 2/total 2
    const updates = prismaMock.step.update.mock.calls.map((c) => c[0]);
    expect(updates).toEqual([
      { where: { id: "s1" }, data: { order: 1, total: 2 } },
      { where: { id: "s3" }, data: { order: 2, total: 2 } },
    ]);
    expect(res).toEqual({ taskId: "t1", remaining: 2 });
  });

  it("reports remaining:0 when the last step is extracted", async () => {
    prismaMock.step.findMany.mockResolvedValueOnce([]);
    const { ejectStepToInbox } = await import("./breakdown");
    const res = await ejectStepToInbox("s2");
    expect(res).toEqual({ taskId: "t1", remaining: 0 });
    expect(prismaMock.step.update).not.toHaveBeenCalled();
  });

  it("revalidates the task page and the inbox", async () => {
    const { ejectStepToInbox } = await import("./breakdown");
    await ejectStepToInbox("s2");
    expect(revalidatePathMock).toHaveBeenCalledWith("/tasks/t1");
    expect(revalidatePathMock).toHaveBeenCalledWith("/inbox");
  });
});
