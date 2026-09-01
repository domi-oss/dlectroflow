import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AUTO_CANCEL_MODE,
  DEPLOY_TEMPLATES,
  MUST_ABANDON_JOBS,
  MUST_FINISH_JOBS,
  interruptiblePolicyGaps,
  parseAutoCancelOnNewCommit,
  parseJobInterruptible,
} from "./ci-interruptible";

const REPO_ROOT = join(__dirname, "..", "..");
const gitlabCiYml = readFileSync(join(REPO_ROOT, ".gitlab-ci.yml"), "utf8");

/**
 * A minimal file with the same SHAPE as the real one: the workflow mode, one job
 * that must be abandoned, one that must finish, and the template both deploy jobs
 * extend. Every negative case below is this file with one thing changed, so the
 * thing changed is the only candidate cause.
 */
function shapedFile(
  over: {
    mode?: string | null;
    review?: string | null;
    production?: string | null;
    stop?: string | null;
    base?: string | null;
  } = {},
): string {
  const key = (v: string | null | undefined) =>
    v === undefined || v === null ? [] : [`  interruptible: ${v}`];
  return [
    "workflow:",
    ...(over.mode === null
      ? []
      : [
          "  auto_cancel:",
          `    on_new_commit: ${over.mode ?? "interruptible"}`,
        ]),
    "  rules:",
    '    - if: "$CI_COMMIT_TAG"',
    ".deploy_base:",
    "  stage: deploy",
    ...key(over.base),
    "deploy_review:",
    "  extends: .deploy_base",
    ...key(over.review === undefined ? "true" : over.review),
    "  resource_group: review/$CI_MERGE_REQUEST_IID",
    "deploy_production:",
    "  extends: .deploy_base",
    ...key(over.production),
    "  resource_group: production",
    "stop_review:",
    "  extends: .deploy_base",
    ...key(over.stop),
    "  needs: []",
    "",
  ].join("\n");
}

describe("parseJobInterruptible", () => {
  it("reads an explicit true and an explicit false", () => {
    const yml = shapedFile({ production: "false" });
    expect(parseJobInterruptible(yml, "deploy_review")).toEqual({
      kind: "true",
    });
    expect(parseJobInterruptible(yml, "deploy_production")).toEqual({
      kind: "false",
    });
  });

  it("reports an absent key as absent rather than guessing the default", () => {
    // `absent` and `false` mean the same thing to GitLab but NOT to a reader, and
    // the real file leans on the difference: `deploy_production` documents the
    // absence as its protection, while four alert jobs say `false` out loud.
    expect(parseJobInterruptible(shapedFile(), "deploy_production")).toEqual({
      kind: "absent",
    });
  });

  it("does not read a YAML 1.1 truthy word as an absent key", () => {
    // GitLab parses this file with Ruby's YAML, which is 1.1: `yes`, `on` and `y`
    // are all **true**. Folding them into `absent` would report an interruptible
    // `deploy_production` as safe — a guard passing the exact defect it exists to
    // catch, and silently, which is the only kind that survives.
    for (const word of ["yes", "on", "y", "True", "1"]) {
      expect(
        parseJobInterruptible(
          shapedFile({ production: word }),
          "deploy_production",
        ),
        word,
      ).toEqual({ kind: "unknown", value: word });
    }
  });

  it("returns null for a job that is not in the file", () => {
    // Distinct from `absent`: a renamed job must not read as a safely-configured
    // one. This is the hole that would let the whole guard pass against nothing.
    expect(parseJobInterruptible(shapedFile(), "deploy_staging")).toBeNull();
  });

  it("survives an inline comment on the key it reads (#226)", () => {
    // `.gitlab-ci.yml` is in `.prettierignore` *because* it "relies on
    // hand-aligned inline comments", so annotating this line is an ordinary edit
    // that no formatter will undo — and every matcher in `ci-job-deps` broke on
    // one in three separate ways before #226.
    const yml = shapedFile().replace(
      "  interruptible: true",
      "  interruptible: true   # a superseded review deploy is worthless",
    );
    expect(yml).not.toBe(shapedFile());
    expect(parseJobInterruptible(yml, "deploy_review")).toEqual({
      kind: "true",
    });
  });

  it("ignores an `interruptible:` nested inside another mapping", () => {
    // Only a top-level key of the job block is the job's own setting. A deeper
    // one belongs to something else, and reading it would report the opposite of
    // the truth for a job that is in fact unprotected.
    const yml = [
      "deploy_production:",
      "  rules:",
      "    - if: '$CI_COMMIT_BRANCH == \"main\"'",
      "      interruptible: true",
      "next_job:",
      "",
    ].join("\n");
    expect(parseJobInterruptible(yml, "deploy_production")).toEqual({
      kind: "absent",
    });
  });

  it("does not mistake prose about the key for the key (#226 sibling)", () => {
    // The real block carries the sentence "Do not add `interruptible: true` to
    // this job." A matcher that searched anywhere in the body would read that
    // comment as the setting and pass while the job was unprotected — the
    // `tools-read-comments-as-code` failure, in the one place it matters most.
    const yml = shapedFile().replace(
      "deploy_production:",
      [
        "deploy_production:",
        "  # Do not add `interruptible: true` to this job.",
      ].join("\n"),
    );
    expect(parseJobInterruptible(yml, "deploy_production")).toEqual({
      kind: "absent",
    });
  });
});

describe("parseAutoCancelOnNewCommit", () => {
  it("reads the mode out of the workflow block", () => {
    expect(parseAutoCancelOnNewCommit(shapedFile())).toBe("interruptible");
    expect(
      parseAutoCancelOnNewCommit(shapedFile({ mode: "conservative" })),
    ).toBe("conservative");
  });

  it("returns null when the workflow block declares no auto_cancel", () => {
    expect(parseAutoCancelOnNewCommit(shapedFile({ mode: null }))).toBeNull();
  });

  it("survives an inline comment on the mode (#226)", () => {
    const yml = shapedFile().replace(
      "    on_new_commit: interruptible",
      "    on_new_commit: interruptible   # cancel only jobs that say they are safe",
    );
    expect(yml).not.toBe(shapedFile());
    expect(parseAutoCancelOnNewCommit(yml)).toBe("interruptible");
  });
});

describe("interruptiblePolicyGaps", () => {
  it("finds nothing wrong with a correctly configured file", () => {
    expect(interruptiblePolicyGaps(shapedFile())).toEqual([]);
  });

  it("flags a must-finish job that has been marked interruptible", () => {
    // The regression `!382` exists to prevent, stated directly: a
    // `deploy_production` carrying `interruptible: true` is a deploy that a second
    // merge can kill. Pipeline 2762854030 lost exactly that deploy.
    const gaps = interruptiblePolicyGaps(shapedFile({ production: "true" }));
    expect(gaps.join("\n")).toMatch(/deploy_production/);
    expect(gaps).toHaveLength(1);
  });

  it("flags an uninterpreted value on a must-finish job", () => {
    // The companion to the parser case above: `yes` is true to GitLab, so this
    // must be a gap and not a pass. Both directions are covered because a
    // must-abandon job with `yes` is equally unreadable.
    const gaps = interruptiblePolicyGaps(shapedFile({ production: "yes" }));
    expect(gaps.join("\n")).toMatch(/deploy_production.*yes.*uninterpreted/);
    expect(gaps).toHaveLength(1);
    expect(
      interruptiblePolicyGaps(shapedFile({ review: "yes" })).join("\n"),
    ).toMatch(/deploy_review/);
  });

  it("flags interruptible: true on a shared deploy template", () => {
    // The #145 lesson applied to this key. `deploy_production` and `stop_review`
    // both `extends: .deploy_base`, so a `true` on the TEMPLATE unprotects both
    // while each job's own block still reads `absent` — a silent false pass, and
    // the only shape of this defect that a per-job check cannot see.
    const gaps = interruptiblePolicyGaps(shapedFile({ base: "true" }));
    expect(gaps.join("\n")).toMatch(/\.deploy_base/);
    expect(gaps.length).toBeGreaterThan(0);
  });

  it("flags a must-abandon job that has lost its explicit true", () => {
    // Not symmetry for its own sake. Under `on_new_commit: interruptible` an
    // absent key means "run to completion", so a `deploy_review` without the key
    // deploys every superseded commit: 37 of these were cancelled unstarted in
    // the 16 days to 2026-09-01, i.e. 37 stale `helm upgrade`s that would
    // otherwise have run on billable Autopilot capacity.
    for (const v of [null, "false"] as const) {
      const gaps = interruptiblePolicyGaps(shapedFile({ review: v }));
      expect(gaps.join("\n"), `review: ${v}`).toMatch(/deploy_review/);
    }
  });

  it("flags the wrong auto_cancel mode, and its absence", () => {
    // Every per-job value above is only honoured under `interruptible`. Under
    // `conservative` GitLab treats an unstarted job as interruptible "regardless
    // of the job's configuration", which is the whole bug — so losing the mode
    // silently voids the other assertions rather than tripping them.
    for (const mode of ["conservative", "none", null] as const) {
      const gaps = interruptiblePolicyGaps(shapedFile({ mode }));
      expect(gaps.join("\n"), `mode: ${mode}`).toMatch(/on_new_commit/);
    }
  });

  it("flags a job that has vanished from the file", () => {
    const yml = shapedFile().replace("deploy_production:", "deploy_prod:");
    expect(interruptiblePolicyGaps(yml).join("\n")).toMatch(
      /deploy_production.*(missing|not found)/i,
    );
  });
});

describe("the repo's own .gitlab-ci.yml", () => {
  it("sets auto_cancel.on_new_commit to interruptible", () => {
    // The fix itself. Without this line `deploy_production` is cancelled while
    // unstarted however it is configured, which is how two production deploys
    // went missing quietly.
    expect(parseAutoCancelOnNewCommit(gitlabCiYml)).toBe(AUTO_CANCEL_MODE);
  });

  it("has no interruptible policy gaps", () => {
    expect(interruptiblePolicyGaps(gitlabCiYml)).toEqual([]);
  });

  it("names only jobs that really are in the file", () => {
    // "No gaps" is equally true of a file with no deploy jobs and of a parser
    // that matched nothing, so the derivation has to be shown to be non-empty —
    // the same floor `ci-schedule-guards` keeps under `guardParityGaps`.
    const named = [
      ...MUST_FINISH_JOBS,
      ...MUST_ABANDON_JOBS,
      ...DEPLOY_TEMPLATES,
    ];
    expect(named.length).toBeGreaterThan(3);
    for (const job of named) {
      expect(
        parseJobInterruptible(gitlabCiYml, job),
        `${job} is named in this module's policy but is not in .gitlab-ci.yml`,
      ).not.toBeNull();
    }
  });

  it("never marks a must-finish job interruptible, directly or by inheritance", () => {
    for (const job of [...MUST_FINISH_JOBS, ...DEPLOY_TEMPLATES]) {
      expect(
        parseJobInterruptible(gitlabCiYml, job),
        `${job} must never be interruptible: true — a second merge would cancel it`,
      ).not.toEqual({ kind: "true" });
    }
  });

  it("keeps deploy_production's interruptible key absent", () => {
    // Today's state, pinned deliberately. An explicit `interruptible: false` is
    // equally safe and would be a fine change — if this fails because someone
    // made it, update this expectation. What must not change silently is the
    // THIRD option, and `never marks a must-finish job interruptible` above is
    // the assertion that catches it.
    expect(parseJobInterruptible(gitlabCiYml, "deploy_production")).toEqual({
      kind: "absent",
    });
  });

  it("keeps deploy_review's interruptible: true explicit", () => {
    expect(parseJobInterruptible(gitlabCiYml, "deploy_review")).toEqual({
      kind: "true",
    });
  });

  it("every assertion above survives an inline comment on the lines it reads (#226)", () => {
    // #226's recurring cost reproduced against the real file, in the same shape
    // `ci-job-deps.test.ts` uses: the mutation must be shown to have happened,
    // or a helper that matched nothing would leave the assertions passing against
    // an unmodified file — green, and testing the opposite of what it claims.
    let applied = 0;
    const annotated = gitlabCiYml
      .split("\n")
      .map((line) => {
        if (
          /^(  interruptible:\s*\S+|    on_new_commit:\s*\S+)\s*$/.test(line)
        ) {
          applied += 1;
          return `${line}   # why`;
        }
        return line;
      })
      .join("\n");

    // A floor with headroom, not a census. "More than nothing was found" and
    // "this is how many there are" are different assertions and only the second
    // goes stale — and an exact count here would red this test whenever an
    // unrelated job's key changed, blaming #226 for something else entirely.
    // There were 11 annotatable lines on 2026-09-01.
    expect(
      applied,
      "expected to annotate several interruptible: lines plus on_new_commit: — has the file been reformatted?",
    ).toBeGreaterThanOrEqual(6);
    expect(annotated).not.toBe(gitlabCiYml);

    // The floor above says the mutation was substantial; these say it landed on
    // the two lines the assertions below actually read. Without them the helper
    // could annotate ten irrelevant lines and still prove nothing.
    expect(annotated).toContain(
      `    on_new_commit: ${AUTO_CANCEL_MODE}   # why`,
    );
    expect(annotated).toContain("  interruptible: true   # why");

    expect(parseAutoCancelOnNewCommit(annotated)).toBe(AUTO_CANCEL_MODE);
    expect(interruptiblePolicyGaps(annotated)).toEqual([]);
    expect(parseJobInterruptible(annotated, "deploy_review")).toEqual({
      kind: "true",
    });
  });
});
