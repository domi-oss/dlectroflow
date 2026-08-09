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
  completeGoogleTaskForStep,
  reopenGoogleTaskForStep,
  completeGoogleTasksForItem,
  reopenGoogleTasksForItem,
  GOOGLE_SYNC_CONCURRENCY,
} from "./google-task-sync";

const SCHEDULED = { googleTaskId: "g-task", googleTaskListId: "l1" };

/** A step carrying its own Google ids, numbered so a fan-out is countable. */
function step(n: number) {
  return { googleTaskId: `g-step-${n}`, googleTaskListId: "l1" };
}

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

/**
 * #209 — the step grain moved here from `focus.ts`, because `braindump.ts`
 * needs it and a `"use server"` module cannot lend a private helper out. Its
 * behaviour is unchanged, so these re-pin the contract at its new address
 * rather than describing anything new.
 */
describe("completeGoogleTaskForStep (#209)", () => {
  it("PATCHes the step's own Google Task to completed", async () => {
    await expect(completeGoogleTaskForStep(step(1))).resolves.toBe(true);
    expect(patchGoogleTask).toHaveBeenCalledWith("tok", "l1", "g-step-1", {
      status: "completed",
    });
  });

  it("skips a step carrying no ids, before any credential lookup", async () => {
    await expect(
      completeGoogleTaskForStep({ googleTaskId: null, googleTaskListId: null }),
    ).resolves.toBe(false);
    expect(currentUser).not.toHaveBeenCalled();
  });

  it("swallows a thrown PATCH rather than failing the completion", async () => {
    patchGoogleTask.mockRejectedValueOnce(new Error("network down"));
    await expect(completeGoogleTaskForStep(step(1))).resolves.toBe(false);
  });
});

/**
 * #196 — the reopen twin moved too, and this is a real behaviour change on the
 * way: in `focus.ts` it had no try/catch and `uncompleteStep` wrapped the call
 * site instead. That made "best-effort" a property of one caller rather than of
 * the helper, so `reopenItem` — the second caller, arriving here — would have
 * inherited the promise without the protection. The swallow is structural now,
 * exactly as `!288` made it for the completion twins.
 */
describe("reopenGoogleTaskForStep (#196)", () => {
  it("PATCHes the step's own Google Task back to needsAction", async () => {
    await expect(reopenGoogleTaskForStep(step(1))).resolves.toBe(true);
    expect(patchGoogleTask).toHaveBeenCalledWith("tok", "l1", "g-step-1", {
      status: "needsAction",
    });
  });

  it("swallows a thrown PATCH rather than failing the un-complete", async () => {
    patchGoogleTask.mockRejectedValueOnce(new Error("network down"));
    await expect(reopenGoogleTaskForStep(step(1))).resolves.toBe(false);
  });

  it("swallows a thrown credential lookup too", async () => {
    getValidAccessToken.mockRejectedValueOnce(new Error("refresh failed"));
    await expect(reopenGoogleTaskForStep(step(1))).resolves.toBe(false);
    expect(patchGoogleTask).not.toHaveBeenCalled();
  });

  it("skips a step carrying no ids, before any credential lookup", async () => {
    await expect(
      reopenGoogleTaskForStep({ googleTaskId: null, googleTaskListId: null }),
    ).resolves.toBe(false);
    expect(currentUser).not.toHaveBeenCalled();
  });
});

/**
 * #209 / #196 — a to-do closed or reopened from the INBOX moves both grains at
 * once: `Task.googleTaskId` if it was scheduled while stepless, and one Google
 * task per step if it was scheduled after a breakdown. The two are always
 * different Google tasks (see `completeGoogleTaskForTask`), so both are patched
 * and neither implies the other.
 */
describe("completeGoogleTasksForItem (#209)", () => {
  it("patches the task's own Google Task AND every step it is given", async () => {
    await expect(
      completeGoogleTasksForItem(SCHEDULED, [step(1), step(2)]),
    ).resolves.toBe(3);
    expect(patchGoogleTask).toHaveBeenCalledWith("tok", "l1", "g-task", {
      status: "completed",
    });
    for (const n of [1, 2]) {
      expect(patchGoogleTask).toHaveBeenCalledWith("tok", "l1", `g-step-${n}`, {
        status: "completed",
      });
    }
  });

  it("counts only the patches Google actually accepted", async () => {
    patchGoogleTask.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await expect(
      completeGoogleTasksForItem(null, [step(1), step(2)]),
    ).resolves.toBe(1);
  });

  // The grains are independent: a task broken down after it was scheduled has
  // steps with ids and a task without one, and the reverse for a stepless to-do
  // that later grew steps locally.
  it("patches the steps even when the task carries no Google id", async () => {
    await expect(
      completeGoogleTasksForItem(
        { googleTaskId: null, googleTaskListId: null },
        [step(1)],
      ),
    ).resolves.toBe(1);
    expect(patchGoogleTask).toHaveBeenCalledTimes(1);
  });

  it("takes no credential at all for a to-do with nothing scheduled", async () => {
    await expect(
      completeGoogleTasksForItem(
        { googleTaskId: null, googleTaskListId: null },
        [{ googleTaskId: null, googleTaskListId: null }],
      ),
    ).resolves.toBe(0);
    expect(currentUser).not.toHaveBeenCalled();
    expect(patchGoogleTask).not.toHaveBeenCalled();
  });

  // "One slow or failing step must not abandon the rest" (#209). Each patch
  // swallows its own failure, so the fan-out cannot reject part-way and leave
  // later steps unattempted.
  it("one failing step does not abandon the rest", async () => {
    patchGoogleTask.mockRejectedValueOnce(new Error("network down"));
    await expect(
      completeGoogleTasksForItem(null, [step(1), step(2), step(3)]),
    ).resolves.toBe(2);
    expect(patchGoogleTask).toHaveBeenCalledTimes(3);
  });
});

describe("reopenGoogleTasksForItem (#196)", () => {
  it("patches the task and every step it is given back to needsAction", async () => {
    await expect(reopenGoogleTasksForItem(SCHEDULED, [step(1)])).resolves.toBe(
      2,
    );
    expect(patchGoogleTask).toHaveBeenCalledWith("tok", "l1", "g-task", {
      status: "needsAction",
    });
    expect(patchGoogleTask).toHaveBeenCalledWith("tok", "l1", "g-step-1", {
      status: "needsAction",
    });
  });
});

/**
 * #209 asked whether the patches run in parallel and the answer is "yes, but
 * bounded". Sequential costs a round trip per step and the PATCH deadline is
 * 10 s, so a twenty-step to-do could hold a server action for over three
 * minutes. Unbounded is the other bad answer: `bulkBrainDumpAction` already
 * loops over items, and firing every step of a large breakdown at once is a
 * burst Google answers with 429s that this module then swallows — the user
 * silently loses syncs instead of waiting a moment for them.
 */
describe("the fan-out is parallel AND bounded", () => {
  /**
   * Hold every PATCH open until released, so the in-flight count can be read at
   * its peak rather than inferred from timing.
   *
   * `run` drives the whole fan-out to completion: it releases whatever is
   * waiting and yields a macrotask, repeatedly, until the pool's own promise
   * settles. Draining only while something is already parked deadlocks — each
   * worker awaits `actingUserGoogleToken()` before it reaches its first patch,
   * so at the instant the pool is kicked off nothing is parked yet.
   */
  function gatedPatch() {
    let inFlight = 0;
    let peak = 0;
    const parked: (() => void)[] = [];
    patchGoogleTask.mockImplementation(() => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      return new Promise<boolean>((resolve) => {
        parked.push(() => {
          inFlight -= 1;
          resolve(true);
        });
      });
    });
    return {
      peak: () => peak,
      async run(pool: Promise<number>): Promise<number> {
        let settled = false;
        void pool.then(
          () => (settled = true),
          () => (settled = true),
        );
        while (!settled) {
          parked.splice(0).forEach((release) => release());
          await new Promise((r) => setTimeout(r, 0));
        }
        return pool;
      },
    };
  }

  it("runs more than one patch at a time", async () => {
    const gate = gatedPatch();
    const refs = Array.from({ length: GOOGLE_SYNC_CONCURRENCY + 4 }, (_, i) =>
      step(i),
    );
    await gate.run(completeGoogleTasksForItem(null, refs));
    expect(gate.peak()).toBeGreaterThan(1);
  });

  it("never exceeds GOOGLE_SYNC_CONCURRENCY in flight", async () => {
    const gate = gatedPatch();
    const refs = Array.from({ length: GOOGLE_SYNC_CONCURRENCY * 3 }, (_, i) =>
      step(i),
    );
    // The task's own Google task shares the same pool as the steps, so it is
    // bounded with them rather than being a free extra connection.
    await expect(
      gate.run(completeGoogleTasksForItem(SCHEDULED, refs)),
    ).resolves.toBe(GOOGLE_SYNC_CONCURRENCY * 3 + 1);
    expect(gate.peak()).toBeLessThanOrEqual(GOOGLE_SYNC_CONCURRENCY);
  });

  it("does not open a worker per ref when there are fewer refs than the bound", async () => {
    const gate = gatedPatch();
    await gate.run(completeGoogleTasksForItem(null, [step(1), step(2)]));
    expect(gate.peak()).toBeLessThanOrEqual(2);
  });
});
