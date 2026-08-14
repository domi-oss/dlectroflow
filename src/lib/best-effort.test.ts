/**
 * #257 — the shared post-commit swallow.
 *
 * What is pinned here is the primitive's contract, not any one call site: the
 * work's own answer comes back untouched under `{ ok: true, value }`, a rejection
 * becomes `{ ok: false }` instead of propagating, and the failure leaves one
 * greppable line carrying the workspace. **`ok` rather than a bare `T | null`,
 * because a thunk that succeeds by returning `null` is not a failure** — the
 * contract test below carries the case that forced it. The five call sites and the
 * reasoning for each are in `src/app/actions/post-commit-bookkeeping.test.ts` and
 * in `best-effort.ts`.
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
    ).resolves.toEqual({ ok: true, value: { current: 3 } });
    expect(errorLog).not.toHaveBeenCalled();
  });

  // The whole point: the caller carries on, and carries on with a value it can
  // branch on rather than an exception it has to translate.
  it("reports not-ok on a rejection rather than propagating it", async () => {
    await expect(
      bestEffort("step_done_bookkeeping_failed", "ws-1", async () => {
        throw new Error(BOOM);
      }),
    ).resolves.toEqual({ ok: false });
  });

  /**
   * ── A SUCCESSFUL `null` is not a failure (Duo review, `!339`) ──────────────
   *
   * The primitive used to answer `T | null` and collapse the two, which was fine
   * until a caller needed to tell them apart. `completeFocus` did: it reports a
   * points figure, and the figure is only true if the payout actually banked.
   * `rewardStepDone` returns `StreakUpdate | null` and `null` is a **success** —
   * the streak was already credited today — so a caller reading the value could
   * not distinguish "already credited" from "the write is gone", and either
   * over-claimed points on a failure or zeroed them on an ordinary second session.
   *
   * Hence the outcome shape. This pair is the entire contract, and every other
   * assertion in this file rests on it.
   */
  it("distinguishes a thunk that resolved null from one that threw", async () => {
    await expect(
      bestEffort("focus_step_reward_failed", "ws-1", async () => null),
    ).resolves.toEqual({ ok: true, value: null });

    await expect(
      bestEffort("focus_step_reward_failed", "ws-1", async () => {
        throw new Error(BOOM);
      }),
    ).resolves.toEqual({ ok: false });
  });

  // The failure branch carries no `value` at all, rather than `value: null` —
  // otherwise a caller reading `.value` gets the same collapse back, one property
  // deeper, and TypeScript would not stop it.
  it("carries no value on the failure branch", async () => {
    const outcome = await bestEffort(
      "focus_step_reward_failed",
      "ws-1",
      async () => "banked",
    );
    expect(Object.hasOwn(outcome, "value")).toBe(true);

    const failed = await bestEffort("focus_step_reward_failed", "ws-1", () =>
      Promise.reject(new Error(BOOM)),
    );
    expect(Object.hasOwn(failed, "value")).toBe(false);
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
    ).resolves.toEqual({ ok: true, value: undefined });
    expect(errorLog).not.toHaveBeenCalled();
  });

  // A synchronous throw from the thunk itself — a caller that builds an argument
  // inside it, say — is the same failure and must not escape either.
  it("catches a thunk that throws before returning a promise", async () => {
    await expect(
      bestEffort("task_complete_points_failed", "ws-1", () => {
        throw new Error(BOOM);
      }),
    ).resolves.toEqual({ ok: false });
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
    ).resolves.toEqual({ ok: false });

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
  it("still reports not-ok on a defect, so the write is not reported failed", async () => {
    await expect(
      bestEffort("first_focus_badge_failed", "ws-2", () =>
        Promise.reject(new TypeError("not a function")),
      ),
    ).resolves.toEqual({ ok: false });
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

  /** `bestEffort("tag", ws, () => …)`, capturing the tag and the thunk body. */
  const CALL_SITE =
    /bestEffort\(\s*"([a-z0-9_]+)"\s*,\s*\w+\s*,\s*(?:async\s*)?\(\)\s*=>\s*([\s\S]{0,200}?)\)[,;]/g;

  const actionSources = () =>
    read("../app/actions/focus.ts") + read("../app/actions/breakdown.ts");

  /** Every parsed call site, as [tag, thunk body] pairs. */
  const parsedSites = () => [...actionSources().matchAll(CALL_SITE)];

  /** Those whose thunk reaches a bundling callee, as [tag, callee] pairs. */
  const callSites = () => {
    const out: { tag: string; callee: string }[] = [];
    for (const m of parsedSites()) {
      // `includes` rather than a built `new RegExp`: the two names cannot collide
      // as substrings, and `regexp-source-hygiene` stands in for a demoted SAST
      // rule (#234) that a pattern interpolating a variable would engage for no
      // benefit here.
      const callee = BUNDLING.find((b) => m[2].includes(`${b}(`));
      if (callee) out.push({ tag: m[1], callee });
    }
    return out;
  };

  const UNION_DECL = "export type BookkeepingTag =";
  /**
   * The union's own terminator: the `;` that closes the declaration, recognised
   * by the quoted member it follows.
   *
   * Not simply "the first `;` after the declaration" — a docblock inside the
   * union already carries prose punctuation ("residual as that member;
   * `rewardStepDone`'s docblock"), which lands that boundary 279 characters
   * early. Requiring the semicolon to terminate a `| "tag"` member is what makes
   * it structural rather than lexical, and the shape occurs exactly once in the
   * file.
   */
  const UNION_END = /\|\s*"[a-z0-9_]+"\s*;/;
  /**
   * The end of the declaration itself: the first line after the header that does
   * not continue it. A TS union's members are indented under the `export type`
   * line, so a line starting at column zero — or a blank one — is the next
   * statement.
   *
   * The search for the terminator is bounded by this, or an *unterminated*
   * declaration latches onto the first member-shaped `| "tag";` further down the
   * file and reports a bogus union instead of throwing. Found by the synthetic
   * fixture below, which carries exactly that decoy in its prose.
   */
  const UNION_OUTDENT = /\n(?=[^ \t])/;

  /**
   * The `BookkeepingTag` declaration's own text, terminating member included.
   *
   * Both boundaries throw when they are not found, and that is the point rather
   * than defensive habit — see the `describe("the union boundary")` block below
   * for the failure this replaces. Nothing here names a member, so renaming a tag
   * or appending one cannot reach this code.
   */
  const bookkeepingUnion = (src: string) => {
    const start = src.indexOf(UNION_DECL);
    if (start === -1) {
      throw new Error(
        `markedTags(): no \`${UNION_DECL}\` declaration in best-effort.ts — ` +
          "the guard cannot read the union it exists to check",
      );
    }
    const rest = src.slice(start);
    const afterHeader = rest.indexOf("\n") + 1;
    const outdent = UNION_OUTDENT.exec(rest.slice(afterHeader));
    const decl = outdent
      ? rest.slice(0, afterHeader + outdent.index + 1)
      : rest;

    const end = UNION_END.exec(decl);
    if (!end) {
      throw new Error(
        "markedTags(): found the `BookkeepingTag` declaration but no " +
          'terminator (`| "tag";`) closing it — the guard cannot bound the union',
      );
    }
    // The terminating member is INSIDE the body: excluding it hid a ⚠️ on the
    // last member, which would report a correctly-marked site as unmarked.
    return src.slice(start, start + end.index + end[0].length);
  };

  /** Each `| "tag"` member, with the text between it and the member before it. */
  const unionMembers = (src: string) => {
    const union = bookkeepingUnion(src);
    const member = /\|\s*"([a-z0-9_]+)"/g;
    const out: { tag: string; preamble: string }[] = [];
    let cursor = 0;
    for (let m = member.exec(union); m; m = member.exec(union)) {
      out.push({ tag: m[1], preamble: union.slice(cursor, m.index) });
      cursor = m.index + m[0].length;
    }
    return out;
  };

  // Tags whose union member carries the ⚠️ marker. Each member is a docblock
  // followed by `| "tag"`, and "its own docblock" is bounded at the member before
  // it: a member carrying no docblock must not inherit its predecessor's marker,
  // or the ⚠️ stops meaning anything the first time one is dropped.
  const markedTags = (src: string) =>
    new Set(
      unionMembers(src)
        .filter(({ preamble }) => {
          const docStart = preamble.lastIndexOf("/**");
          return docStart >= 0 && preamble.slice(docStart).includes("⚠️");
        })
        .map(({ tag }) => tag),
    );

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

  /**
   * The completeness control `callSites()` did not have, counted on the defect's
   * own axis rather than on the outcome.
   *
   * `CALL_SITE` bounds the thunk body at 200 characters and requires a `,` or `;`
   * terminator, so a site it cannot parse is simply **absent** — and every
   * assertion here is about the three bundling tags, which a missing FOURTH site
   * would not disturb. `sites.length >= 3` cannot see that either. So: every
   * `bestEffort(` in the two action files must be one the parser saw.
   *
   * The second half pins the property `DEFECT_TAG`'s docblock in `best-effort.ts`
   * says `!339` restored and wants to keep — one union member per call site,
   * which is the whole reason the defect marker is deliberately not a member.
   * Nothing tested it, so an orphaned member (or an unlisted site) was free.
   */
  it("sees every bestEffort call, and one union member per site", () => {
    const calls = actionSources().split("bestEffort(").length - 1;
    const parsed = parsedSites().map((m) => m[1]);

    expect(calls).toBeGreaterThan(0);
    expect(parsed).toHaveLength(calls);

    const members = unionMembers(read("./best-effort.ts")).map((m) => m.tag);
    expect([...parsed].sort()).toEqual([...members].sort());
  });

  /**
   * ── The parser was blind to its own defect class (Duo review, `!339`) ───────
   *
   * `CALL_SITE`'s body capture is non-greedy and ends at the first `)` followed by
   * `,` or `;`, so a **block-bodied** thunk truncates at its first statement:
   *
   * ```
   * bestEffort(tag, ws, async () => {
   *   await logReward(ws, RewardType.StepDone);   // <- capture stops inside here
   *   await rewardStepDone(ws);                   // <- never seen
   * });
   * ```
   *
   * Measured: the captured body is `'{ await logReward(workspaceId, RewardType.StepDone'`
   * and `includes("rewardStepDone(")` is `false`. The site is still *matched*, so
   * the completeness count above is satisfied and the tag↔member bijection holds —
   * the marker requirement is simply never applied to it.
   *
   * **That shape is not a hypothetical: a block body with two statements is
   * exactly the bundle this whole block exists to catch**, so the one call-site
   * form the guard most needed to see was the one it could not read.
   *
   * Forbidden rather than parsed, because the one-call-per-consequence rule on
   * `bestEffort` forbids it anyway — a thunk with two statements is two
   * consequences under one tag. If a single-consequence block body is ever
   * genuinely wanted, the fix is to teach the parser, not to delete this.
   */
  it("has no block-bodied thunk, which the body capture cannot read", () => {
    const blockThunk =
      /bestEffort\(\s*"[a-z0-9_]+"\s*,\s*\w+\s*,\s*(?:async\s*)?\(\)\s*=>\s*\{/;
    expect(actionSources()).not.toMatch(blockThunk);
  });

  it("marks every tag that wraps a bundling callee", () => {
    const marked = markedTags(read("./best-effort.ts"));
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
    expect(
      [...markedTags(read("./best-effort.ts"))].filter((t) => !wrapping.has(t)),
    ).toEqual([]);
  });

  /**
   * ── The guard's own boundary must fail loudly (Duo review, `!339`) ─────────
   *
   * `markedTags` bounded the union with `src.indexOf('| "first_focus_badge_failed";')`
   * and handed the result straight to `slice`. Rename that tag, or append a member
   * after it so it is no longer last, and the lookup is `-1` — which `slice` does
   * **not** reject: JS reads a negative `end` as `length + end`, so the "union"
   * silently became the rest of the file.
   *
   * Measured on the real file: 2,344 characters of union became 13,910, and
   * `markedTags` still returned the same three tags, so `marked.size > 0` — the
   * only control the block had — stayed satisfied. A drift guard that degrades
   * into a whole-file grep without saying so is the exact failure it was written
   * to catch, one level up.
   *
   * Both boundaries now throw, and the end one is derived from the union's own
   * terminator (`| "…";`) rather than from a named member, so appending or
   * renaming a tag cannot reach this code at all. The naive structural form Duo
   * suggested — the first `;` after the declaration — was tried and rejected on
   * evidence: a docblock inside the union already contains prose punctuation
   * ("residual as that member; `rewardStepDone`'s docblock"), so that boundary
   * lands 279 characters early **today**. Requiring the `;` to terminate a
   * quoted member is what makes it safe, and that pattern occurs exactly once in
   * the file.
   *
   * These exercise the parsing on synthetic input, which is the shape every
   * file-parsing guard in this repo follows (`CLAUDE.md`) and the only way the
   * failure mode can be demonstrated rather than asserted.
   */
  describe("the union boundary", () => {
    const PLAIN =
      '  /** `beginFocus` — an ordinary payout. */\n  | "plain_failed"';
    const MARKED =
      '  /**\n   * `completeStep` — a bundle.\n   *\n   * ⚠️ **Deliberately bundled.**\n   */\n  | "bundled_failed"';

    /**
     * A miniature `best-effort.ts`: the declaration, the members given, and prose
     * below it carrying both a ⚠️ and a member-shaped string — the two things a
     * runaway slice would wrongly pull in.
     */
    const synthetic = (members: string) =>
      [
        'import { thing } from "./thing";',
        "",
        "export type BookkeepingTag =",
        members,
        "",
        '/** ⚠️ Prose below the union, mentioning | "escaped_failed"; in passing. */',
        'export const DEFECT_TAG = "bookkeeping_defect";',
        "",
      ].join("\n");

    // The control: without this, every assertion below could be satisfied by a
    // helper that throws unconditionally or returns nothing.
    it("CONTROL: reads a synthetic union, marking only the marked member", () => {
      expect([...markedTags(synthetic(`${PLAIN}\n${MARKED};`))]).toEqual([
        "bundled_failed",
      ]);
    });

    it("throws when the declaration is absent rather than parsing nothing", () => {
      const renamedType = synthetic(`${PLAIN}\n${MARKED};`).replace(
        "export type BookkeepingTag =",
        "export type BookkeepingFailureTag =",
      );
      expect(() => markedTags(renamedType)).toThrow(/BookkeepingTag/);
    });

    it("throws when the union has no terminator rather than running past it", () => {
      // The declaration is there; nothing closes it. The old code produced a
      // negative `end` here and returned most of the file.
      const unterminated = synthetic(`${PLAIN}\n${MARKED}`);
      expect(() => markedTags(unterminated)).toThrow(/terminator/i);
    });

    // The scenario Duo named, run against the real file: a new member appended
    // after the previously-last one.
    it("does not widen past the union when a new member is appended last", () => {
      const grown = read("./best-effort.ts").replace(
        /\|\s*"([a-z0-9_]+)"\s*;/,
        '| "$1"\n  /** `beginFocus` — a brand new payout. */\n  | "brand_new_payout_failed";',
      );
      const union = bookkeepingUnion(grown);

      expect(union).toContain('| "brand_new_payout_failed";');
      // The old code swallowed everything below the union, including these.
      expect(union).not.toContain("export function recordBookkeepingFailure");
      expect(union).not.toContain("export async function bestEffort");
      // …and the marker set is unchanged by an unmarked addition.
      expect([...markedTags(grown)].sort()).toEqual(
        [...markedTags(read("./best-effort.ts"))].sort(),
      );
    });

    // The terminating member is INSIDE the body. The sentinel version sliced to
    // just before it, so a ⚠️ on the last member was invisible — the guard would
    // then report a correctly-marked site as unmarked and red for a false reason.
    it("sees a marker on the last member", () => {
      expect([...markedTags(synthetic(`${PLAIN}\n${MARKED};`))]).toContain(
        "bundled_failed",
      );
    });

    // A member with no docblock of its own must not inherit its predecessor's
    // marker, or the ⚠️ stops meaning anything the moment a docblock is dropped.
    it("does not let a member inherit the previous member's marker", () => {
      const marked = markedTags(
        synthetic(`${MARKED}\n  | "undocumented_failed";`),
      );
      expect([...marked]).toEqual(["bundled_failed"]);
    });
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
