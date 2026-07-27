import { describe, it, expect, vi, beforeEach } from "vitest";

const { findUniqueMock } = vi.hoisted(() => ({ findUniqueMock: vi.fn() }));

vi.mock("@/lib/db", () => ({
  prisma: { workspace: { findUnique: findUniqueMock } },
}));

import { isGuestWorkspace } from "./workspace-kind";

// #35 Phase A rewrote this check. It used to be `workspaceId !== "owner"` — a
// pure string comparison that only worked while exactly one non-guest workspace
// existed. Now the kind is read from the database, because every account's
// workspace id is opaque.
beforeEach(() => vi.clearAllMocks());

describe("isGuestWorkspace", () => {
  it("a user workspace is not a guest", async () => {
    findUniqueMock.mockResolvedValue({ kind: "user" });
    expect(await isGuestWorkspace("ws-anything")).toBe(false);
  });

  it("a guest workspace is a guest", async () => {
    findUniqueMock.mockResolvedValue({ kind: "guest" });
    expect(await isGuestWorkspace("abc-123")).toBe(true);
  });

  it("an unknown workspace fails closed and is treated as a guest", async () => {
    // Every caller gates a privileged capability on this (calling the LLM,
    // sending mail). Guessing "guest" costs a fallback quote; guessing the
    // other way spends the instance's API budget or emails a stranger.
    findUniqueMock.mockResolvedValue(null);
    expect(await isGuestWorkspace("does-not-exist")).toBe(true);
  });

  it("the legacy pre-accounts 'owner' workspace is treated as a guest", async () => {
    // The one workspace still carrying kind "owner" is the abandoned
    // pre-accounts row (exported and purged by hand in Phase D). Nothing signs
    // in to it any more, so it gets no privileged capabilities.
    findUniqueMock.mockResolvedValue({ kind: "owner" });
    expect(await isGuestWorkspace("owner")).toBe(true);
  });

  it("looks the workspace up by id", async () => {
    findUniqueMock.mockResolvedValue({ kind: "user" });
    await isGuestWorkspace("ws-7");
    expect(findUniqueMock).toHaveBeenCalledWith({
      where: { id: "ws-7" },
      select: { kind: true },
    });
  });
});
