import { describe, it, expect, vi, beforeEach } from "vitest";

// #118 Phase C — the credential is resolved BY the acting account's id, so these
// tests assert the argument `getValidAccessToken` is called with, not merely
// that a token was fetched: reaching another user's row and reaching your own
// look identical from the return value, and only one of them is acceptable.
const { getValidAccessToken, patchGoogleTask, currentUser } = vi.hoisted(
  () => ({
    getValidAccessToken: vi.fn(),
    patchGoogleTask: vi.fn(),
    currentUser: vi.fn(),
  }),
);
vi.mock("@/lib/google", () => ({ getValidAccessToken, patchGoogleTask }));
vi.mock("@/lib/workspace", () => ({ currentUser }));

import {
  actingUserGoogleToken,
  completeGoogleTaskForTask,
} from "./google-task-sync";

const SCHEDULED = { googleTaskId: "g-task", googleTaskListId: "l1" };

beforeEach(() => {
  vi.clearAllMocks();
  currentUser.mockResolvedValue({ id: "user-owner" });
  getValidAccessToken.mockResolvedValue("tok");
  patchGoogleTask.mockResolvedValue(true);
});

describe("actingUserGoogleToken", () => {
  it("resolves the credential of the signed-in account, keyed on its own id", async () => {
    await expect(actingUserGoogleToken()).resolves.toBe("tok");
    expect(getValidAccessToken).toHaveBeenCalledWith("user-owner");
  });

  it("returns null for a caller with no account, without touching the store", async () => {
    currentUser.mockResolvedValueOnce(null);
    await expect(actingUserGoogleToken()).resolves.toBeNull();
    expect(getValidAccessToken).not.toHaveBeenCalled();
  });
});

describe("completeGoogleTaskForTask (#195)", () => {
  it("PATCHes the task's own Google Task to completed", async () => {
    await expect(completeGoogleTaskForTask(SCHEDULED)).resolves.toBe(true);
    expect(patchGoogleTask).toHaveBeenCalledWith("tok", "l1", "g-task", {
      status: "completed",
    });
  });

  it("reports false when Google refuses the PATCH", async () => {
    patchGoogleTask.mockResolvedValueOnce(false);
    await expect(completeGoogleTaskForTask(SCHEDULED)).resolves.toBe(false);
  });

  // Both halves of the id are required: a list id with no task id (or the
  // reverse) cannot address a Google task, and a half-written pair should skip
  // rather than build a URL out of `undefined`.
  it.each([
    ["neither", { googleTaskId: null, googleTaskListId: null }],
    ["no task id", { googleTaskId: null, googleTaskListId: "l1" }],
    ["no list id", { googleTaskId: "g-task", googleTaskListId: null }],
  ])("skips before any credential lookup when there is %s", async (_, task) => {
    await expect(completeGoogleTaskForTask(task)).resolves.toBe(false);
    expect(currentUser).not.toHaveBeenCalled();
    expect(patchGoogleTask).not.toHaveBeenCalled();
  });

  it("skips when the acting account has no Google credential", async () => {
    getValidAccessToken.mockResolvedValueOnce(null);
    await expect(completeGoogleTaskForTask(SCHEDULED)).resolves.toBe(false);
    expect(patchGoogleTask).not.toHaveBeenCalled();
  });

  // The best-effort contract has to be structural, not a convention each caller
  // remembers: a completion the user asked for must not fail because Google is
  // unreachable or a refresh token has gone stale. Both throwing surfaces are
  // covered because they are different code paths, and only one of them
  // (`patchGoogleTask`) is obvious from the call site.
  it("swallows a thrown PATCH rather than failing the completion", async () => {
    patchGoogleTask.mockRejectedValueOnce(new Error("network down"));
    await expect(completeGoogleTaskForTask(SCHEDULED)).resolves.toBe(false);
  });

  it("swallows a thrown credential lookup too", async () => {
    getValidAccessToken.mockRejectedValueOnce(new Error("refresh failed"));
    await expect(completeGoogleTaskForTask(SCHEDULED)).resolves.toBe(false);
    expect(patchGoogleTask).not.toHaveBeenCalled();
  });
});
