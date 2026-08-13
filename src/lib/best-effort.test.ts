/**
 * #257 — the shared post-commit swallow.
 *
 * What is pinned here is the primitive's contract, not any one call site: the
 * work's own answer comes back untouched on success, a rejection resolves to
 * `null` instead of propagating, and the failure leaves one greppable line
 * carrying the workspace. The five call sites and the reasoning for each are in
 * `src/app/actions/post-commit-bookkeeping.test.ts` and in `best-effort.ts`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { bestEffort, recordBookkeepingFailure } from "./best-effort";

const BOOM = "reward store went away";

let errorLog: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => errorLog.mockRestore());

/** The one line the swallow left behind, parsed. */
const line = () =>
  JSON.parse(String(errorLog.mock.calls[0][0])) as {
    tag: string;
    workspaceId: string;
    message: string;
    ts: string;
  };

describe("bestEffort", () => {
  it("hands the work's own answer back untouched", async () => {
    await expect(
      bestEffort("step_done_bookkeeping_failed", "ws-1", async () => ({
        current: 3,
      })),
    ).resolves.toEqual({ current: 3 });
    expect(errorLog).not.toHaveBeenCalled();
  });

  // The whole point: the caller carries on, and carries on with a value it can
  // branch on rather than an exception it has to translate.
  it("resolves to null on a rejection rather than propagating it", async () => {
    await expect(
      bestEffort("step_done_bookkeeping_failed", "ws-1", async () => {
        throw new Error(BOOM);
      }),
    ).resolves.toBeNull();
  });

  it("says so in the log, with the tag it was given and the workspace", async () => {
    await bestEffort("breakdown_points_failed", "ws-7", () =>
      Promise.reject(new Error(BOOM)),
    );
    expect(errorLog).toHaveBeenCalledTimes(1);
    expect(line().tag).toBe("breakdown_points_failed");
    expect(line().workspaceId).toBe("ws-7");
    expect(line().message).toContain(BOOM);
    expect(Date.parse(line().ts)).not.toBeNaN();
  });

  // A rejection is not always an Error — a thrown string, or a Prisma error
  // shape with no `message`, must still produce a readable line rather than
  // `[object Object]` swallowing the only diagnostic there is.
  it("reports a non-Error rejection as a string", async () => {
    await bestEffort("step_done_bookkeeping_failed", "ws-1", () =>
      Promise.reject("connection refused"),
    );
    expect(line().message).toBe("connection refused");
  });

  // Distinguishes "the work resolved with undefined" from "the work failed" for
  // a reader of the log, and keeps a void helper's success from looking like a
  // swallowed failure.
  it("does not log when the work resolves with nothing", async () => {
    await expect(
      bestEffort("first_focus_badge_failed", "ws-1", async () => {}),
    ).resolves.toBeUndefined();
    expect(errorLog).not.toHaveBeenCalled();
  });

  // A synchronous throw from the thunk itself — a caller that builds an argument
  // inside it, say — is the same failure and must not escape either.
  it("catches a thunk that throws before returning a promise", async () => {
    await expect(
      bestEffort("task_complete_points_failed", "ws-1", () => {
        throw new Error(BOOM);
      }),
    ).resolves.toBeNull();
    expect(line().message).toContain(BOOM);
  });
});

describe("recordBookkeepingFailure", () => {
  // The guard every logger in this repo carries (`recordLLMFailure`,
  // `recordAuthFailure`, `logShoppingBookkeepingFailure`), and it matters more
  // here than anywhere: this function is only ever reached from a catch block
  // that exists to keep a committed write from being reported as failed. An
  // observability fault that threw would undo the whole fix.
  it("never throws, even on an error it cannot read or serialise", () => {
    const hostile = {
      get message(): string {
        throw new Error("unreadable");
      },
    };
    expect(() =>
      recordBookkeepingFailure("step_done_bookkeeping_failed", "ws-1", hostile),
    ).not.toThrow();
  });

  it("survives a console.error that throws", () => {
    errorLog.mockImplementation(() => {
      throw new Error("stdout gone");
    });
    expect(() =>
      recordBookkeepingFailure(
        "step_done_bookkeeping_failed",
        "ws-1",
        new Error(BOOM),
      ),
    ).not.toThrow();
  });
});
