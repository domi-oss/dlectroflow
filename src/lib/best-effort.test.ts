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
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  bestEffort,
  recordBookkeepingFailure,
  DEFECT_TAG,
} from "./best-effort";

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
    /** Present only on a defect line, where `tag` is the defect marker. */
    site?: string;
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

  /**
   * ── A BUG and a BLIP must not look the same (Duo review, `!339`) ───────────
   *
   * Every rejection used to funnel into one tag, so a `TypeError` from a bad
   * refactor at a call site was indistinguishable from a database blip: swallowed,
   * `null` returned, one log line that reads like an expected transient failure.
   * No crash, no exception-tracker signal, and no test failure unless the test
   * happened to assert on the tag.
   *
   * Reachability is the recurring-cost kind rather than the user kind: these call
   * sites were edited three times in one day, and a fourth edit mistyping a
   * property name produces exactly this.
   *
   * **A distinct tag rather than a re-throw, and the re-throw is not a matter of
   * taste — it would reintroduce #257.** The payout runs *after* its write
   * committed, so an exception escaping here propagates out of the server action
   * and tells the person their work failed over a row that is in the database.
   * That the cause was a bug rather than a blip changes nothing about the row. So
   * a re-throw would turn "payout silently unpaid" into "payout unpaid AND the
   * write falsely reported failed", which is strictly worse.
   *
   * The tag stays the entire value of the line: ONE tag identifies every
   * programmer fault across all sites, so a single filter catches them, and the
   * site travels in its own field rather than being spliced into the tag (which
   * would square the union).
   */
  it("tags a TypeError as a defect, not as an operational failure", async () => {
    await expect(
      bestEffort("focus_step_reward_failed", "ws-2", async () => {
        // The shape a mistyped property produces at a real call site.
        const broken = undefined as unknown as { nope: () => void };
        broken.nope();
      }),
    ).resolves.toBeNull();

    expect(line().tag).toBe("bookkeeping_defect");
    // The site is still recoverable — it moves to its own field.
    expect(line().site).toBe("focus_step_reward_failed");
  });

  it("tags a ReferenceError and a SyntaxError as defects too", async () => {
    await bestEffort("breakdown_points_failed", "ws-2", () =>
      Promise.reject(new ReferenceError("x is not defined")),
    );
    expect(line().tag).toBe("bookkeeping_defect");

    errorLog.mockClear();
    await bestEffort("breakdown_points_failed", "ws-2", () =>
      Promise.reject(new SyntaxError("unexpected token")),
    );
    expect(line().tag).toBe("bookkeeping_defect");
  });

  /**
   * THE CONTROL, and the half that keeps this from becoming "tag everything a
   * defect": an ordinary operational rejection must keep its per-site tag, or the
   * three splits this MR made are undone at the logger.
   */
  it("CONTROL: an operational rejection keeps its own per-site tag", async () => {
    await bestEffort("breakdown_badge_failed", "ws-2", () =>
      Promise.reject(new Error("connection terminated unexpectedly")),
    );
    expect(line().tag).toBe("breakdown_badge_failed");
    expect(line().site).toBeUndefined();
  });

  // A Prisma error is operational despite being a subclass of Error, and a plain
  // thrown string carries no shape at all — neither may be called a defect.
  it("CONTROL: a non-Error rejection is not a defect", async () => {
    await bestEffort("breakdown_badge_failed", "ws-2", () =>
      Promise.reject("connection refused"),
    );
    expect(line().tag).toBe("breakdown_badge_failed");
  });

  // A defect must still not report the committed write as failed — #257 itself.
  it("still resolves to null on a defect, so the write is not reported failed", async () => {
    await expect(
      bestEffort("first_focus_badge_failed", "ws-2", () =>
        Promise.reject(new TypeError("not a function")),
      ),
    ).resolves.toBeNull();
  });
});

/**
 * ── The exception list must not go stale (Duo review, `!339`, 4th recurrence) ──
 *
 * `best-effort.ts` claimed ONE deliberately-bundled tag when there were three, and
 * an incomplete list undermines the invariant it exists to protect: a future
 * maintainer reading "any other bundled thunk is a bug" could "fix" a correct site.
 *
 * This is the cheap half of a guard, deliberately not a new hygiene module. It
 * derives the tags that WRAP a bundling callee from the call sites, and requires
 * each to carry the ⚠️ marker on its union member — so adding a `bestEffort` call
 * around `rewardStepDone` or `touchStreakOnEngagement` without marking it fails
 * here rather than in a review six rounds later.
 *
 * It does not re-derive which callees bundle; that lives in their docblocks and
 * changing it is a deliberate act. What it pins is the part that silently drifted.
 */
describe("the deliberately-bundled exception list stays complete", () => {
  const read = (p: string) =>
    readFileSync(join(__dirname, p), "utf8").replace(/\r\n/g, "\n");

  /** Callees that are themselves a bundle — see their docblocks in `rewards.ts`. */
  const BUNDLING = ["rewardStepDone", "touchStreakOnEngagement"];

  /** Every `bestEffort("tag", ws, () => callee(...))`, as [tag, callee] pairs. */
  const callSites = () => {
    const src =
      read("../app/actions/focus.ts") + read("../app/actions/breakdown.ts");
    const out: { tag: string; callee: string }[] = [];
    const re =
      /bestEffort\(\s*"([a-z0-9_]+)"\s*,\s*\w+\s*,\s*(?:async\s*)?\(\)\s*=>\s*([\s\S]{0,200}?)\)[,;]/g;
    for (let m = re.exec(src); m; m = re.exec(src)) {
      // `includes` rather than a built `new RegExp`: the two names cannot collide
      // as substrings, and `regexp-source-hygiene` stands in for a demoted SAST
      // rule (#234) that a pattern interpolating a variable would engage for no
      // benefit here.
      const callee = BUNDLING.find((b) => m[2].includes(`${b}(`));
      if (callee) out.push({ tag: m[1], callee });
    }
    return out;
  };

  /** Tags whose union member carries the ⚠️ marker. */
  const markedTags = () => {
    const src = read("./best-effort.ts");
    const union = src.slice(
      src.indexOf("export type BookkeepingTag ="),
      src.indexOf('| "first_focus_badge_failed";'),
    );
    // Each member is `/** … */ | "tag"`; a member is marked if its own docblock
    // contains the warning sign.
    return new Set(
      union
        .split(/\|\s*"/)
        .slice(1)
        .map((chunk, i, all) => ({
          tag: chunk.slice(0, chunk.indexOf('"')),
          doc: all[i - 1] ?? "",
        }))
        .filter((_, i) => i >= 0)
        .filter(({ tag }) => {
          const at = union.indexOf(`| "${tag}"`);
          const before = union.slice(0, at);
          const docStart = before.lastIndexOf("/**");
          return docStart >= 0 && before.slice(docStart).includes("⚠️");
        })
        .map(({ tag }) => tag),
    );
  };

  // The control: the extraction must actually find call sites, or an empty set
  // would make every assertion below vacuously true.
  it("finds the call sites that wrap a bundling callee", () => {
    const sites = callSites();
    expect(sites.length).toBeGreaterThanOrEqual(3);
    expect(sites.map((s) => s.tag).sort()).toEqual([
      "breakdown_streak_touch_failed",
      "focus_step_reward_failed",
      "step_done_bookkeeping_failed",
    ]);
  });

  it("marks every tag that wraps a bundling callee", () => {
    const marked = markedTags();
    // The control for the OTHER side: the marker extraction must find some.
    expect(marked.size).toBeGreaterThan(0);

    const unmarked = callSites()
      .filter(({ tag }) => !marked.has(tag))
      .map(({ tag, callee }) => `${tag} (wraps ${callee})`);
    expect(unmarked).toEqual([]);
  });

  // The converse, so the marker cannot be sprinkled on a site that does not need
  // it — which would make the ⚠️ meaningless by inflation.
  it("marks nothing that does not wrap a bundling callee", () => {
    const wrapping = new Set(callSites().map((s) => s.tag));
    expect([...markedTags()].filter((t) => !wrapping.has(t))).toEqual([]);
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

  /**
   * ── The fallback must still SAY something (relayed from `!334`, `!339`) ────
   *
   * `!334` found `logCaptureBookkeepingFailure`'s outer `catch` fully silent, and
   * this logger had the identical shape: the `catch` existed only to stop the
   * throw, so the one case it is reached for produced **no line at all**. That
   * inverts the function's whole purpose — a circular `error` value is exactly
   * when an operator most needs to know a payout was dropped, and it was the case
   * guaranteed to tell them nothing.
   *
   * `not.toThrow()` alone could not catch this — total silence satisfies it
   * perfectly. So these assert the tag actually reaches the log.
   *
   * **The trigger is a hostile `toString`, NOT a circular reference**, and the
   * first version of this test used a circular one and passed while proving
   * nothing. `!334`'s finding does not carry over literally: every field this
   * logger serialises is a string by construction — `tag` and `workspaceId` are
   * typed `string`, `ts` comes from `toISOString()`, and `message` is either a
   * `typeof`-checked string or `String(error)` — so a cycle in `error` never
   * reaches `JSON.stringify` at all. The docblock's claim that it did was wrong
   * and is corrected. What IS reachable is the value's own coercion throwing.
   */
  it("still emits the tag when the error cannot be coerced to a string", () => {
    const hostile = {
      toString(): string {
        throw new Error("uncoercible");
      },
    };

    expect(() =>
      recordBookkeepingFailure("task_complete_badge_failed", "ws-9", hostile),
    ).not.toThrow();

    expect(errorLog).toHaveBeenCalled();
    // JSON-free: the tag and the workspace as plain arguments, because building
    // the payload is the thing that just failed.
    expect(errorLog.mock.calls.flat().join(" ")).toContain(
      "task_complete_badge_failed",
    );
    expect(errorLog.mock.calls.flat().join(" ")).toContain("ws-9");
  });

  it("still emits the tag when the error's message cannot be read", () => {
    const hostile = {
      get message(): string {
        throw new Error("unreadable");
      },
    };
    recordBookkeepingFailure("breakdown_streak_touch_failed", "ws-3", hostile);
    expect(errorLog).toHaveBeenCalled();
    expect(errorLog.mock.calls.flat().join(" ")).toContain(
      "breakdown_streak_touch_failed",
    );
  });

  /**
   * The third trigger, and the most realistic of them: a **null-prototype**
   * rejection. `String(value)` raises `TypeError: Cannot convert object to
   * primitive value` because there is no inherited `toString`, and a
   * `Object.create(null)` bag is a shape real code produces.
   *
   * Note what must NOT happen: the `TypeError` raised *inside* this logger is not
   * the rejection's own shape, so the line must keep its per-site tag rather than
   * being relabelled a defect. `isDefect` inspects the value it was handed, and
   * runs before the guarded block, which is what keeps those two apart.
   */
  it("still emits the tag for a null-prototype rejection, where String() throws", () => {
    const bag = Object.create(null) as object;

    expect(() =>
      recordBookkeepingFailure("focus_session_bonus_failed", "ws-4", bag),
    ).not.toThrow();

    expect(errorLog).toHaveBeenCalledWith("focus_session_bonus_failed", "ws-4");
    // Two tiers, SAME tag — a grep that finds the structured line finds this one.
    expect(errorLog.mock.calls.flat()).not.toContain(DEFECT_TAG);
  });

  /**
   * Honest labelling: mostly a guard on the FIX rather than a control on the
   * defect. Its `not.toThrow()` half passed before the fallback existed too, since
   * the original empty catch also swallowed a throwing `console.error` — so that
   * half proves nothing about the defect. The `toHaveBeenCalledTimes(2)` half is
   * new and does red without the fallback, but what it pins is the fix's own
   * shape, not the bug.
   *
   * Kept because the fallback calls `console.error` a second time, so a transport
   * that threw once throws again, and an escape there would take down the request
   * the swallow exists to protect.
   */
  it("survives a console.error that throws in BOTH tiers", () => {
    errorLog.mockImplementation(() => {
      throw new Error("stdout gone");
    });
    // A SERIALISABLE error on purpose. With an unserialisable one, tier one throws
    // while building the payload and never reaches the transport, so only one call
    // is ever made — which is what this test asserted at first, wrongly. To
    // exercise both tiers the payload must succeed and `console.error` must be the
    // thing that fails.
    expect(() =>
      recordBookkeepingFailure(
        "focus_step_reward_failed",
        "ws-5",
        new Error(BOOM),
      ),
    ).not.toThrow();
    expect(errorLog).toHaveBeenCalledTimes(2);
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
