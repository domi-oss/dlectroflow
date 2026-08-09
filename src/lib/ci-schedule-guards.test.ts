/**
 * `src/lib/ci-schedule-guards.ts` plus the real `.gitlab-ci.yml` (#191).
 *
 * Two halves, which is the shape `CLAUDE.md` prescribes for every file-parsing
 * guard here: the parser is exercised on **synthetic** input, so it can be shown
 * to fail, and one test reads the real file. The synthetic half is the part that
 * matters — the assertion that took over from a line-offset check has to be
 * demonstrably capable of catching a missing guard, or it is just a greener test.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  allGuardedFlags,
  blocksGuarding,
  guardParityGaps,
  guardedFlags,
  topLevelBlocks,
} from "./ci-schedule-guards";

const CI_YML = readFileSync(join(process.cwd(), ".gitlab-ci.yml"), "utf8");

/** Two jobs, both guarding both flags, plus each flag's own running rule. */
const BALANCED = `stages:
  - build

# A comment introducing the first job.
job_one:
  script:
    - echo one
  rules:
    - if: '$CI_PIPELINE_SOURCE == "schedule" && $FLAG_A == "true"'
      when: never
    - if: '$CI_PIPELINE_SOURCE == "schedule" && $FLAG_B == "true"'
      when: never
    - if: '$CI_PIPELINE_SOURCE == "schedule"'

job_two:
  rules:
    - if: '$CI_PIPELINE_SOURCE == "schedule" && $FLAG_A == "true"'
      when: never
    - if: '$CI_PIPELINE_SOURCE == "schedule" && $FLAG_B == "true"'
      when: never

flag_a_job:
  rules:
    - if: '$CI_PIPELINE_SOURCE == "schedule" && $FLAG_A == "true"'
`;

describe("topLevelBlocks", () => {
  it("splits on column-0 keys and keeps each block's own body", () => {
    const names = topLevelBlocks(BALANCED).map((b) => b.name);
    expect(names).toEqual(["stages", "job_one", "job_two", "flag_a_job"]);
    const one = topLevelBlocks(BALANCED).find((b) => b.name === "job_one");
    expect(one?.text).toContain("echo one");
    // job_two's rules must NOT have been absorbed into job_one, or a parity check
    // would pass by reading one big blob that happens to contain everything.
    expect(one?.text).not.toContain("job_two");
  });

  it("does not treat a column-0 comment as a key", () => {
    // If it did, the comment would open a block and the job below it would lose
    // its name — and a parity check keyed on block names would silently compare
    // nothing at all.
    expect(topLevelBlocks(BALANCED).map((b) => b.name)).not.toContain(
      "# A comment introducing the first job.",
    );
  });

  it("still names a top-level key that carries a trailing comment", () => {
    // Checked as part of #191's review of the trailing-comment hole in
    // `guardedFlags`: this sibling matcher does NOT share it, because the key
    // regex is a prefix test and the name is cut at the first colon. Pinned so
    // that stays true rather than being re-derived by the next reader.
    const yml = `ops_digest: # weekly, and the one block a missed guard is visible in
  rules:
    - if: '$CI_PIPELINE_SOURCE == "schedule" && $FLAG_A == "true"'
      when: never
`;
    const blocks = topLevelBlocks(yml);
    expect(blocks.map((b) => b.name)).toEqual(["ops_digest"]);
    expect(guardedFlags(blocks[0].text)).toEqual(new Set(["FLAG_A"]));
  });

  it("keeps an indented anchor's body with the anchor", () => {
    const yml = `.anchor_rules:
  rules:
    - if: '$CI_PIPELINE_SOURCE == "schedule" && $FLAG_A == "true"'
      when: never
`;
    expect(guardedFlags(topLevelBlocks(yml)[0].text)).toEqual(
      new Set(["FLAG_A"]),
    );
  });
});

describe("guardedFlags", () => {
  it("collects a flag whose rule entry says when: never", () => {
    const one = topLevelBlocks(BALANCED).find((b) => b.name === "job_one");
    expect(guardedFlags(one!.text)).toEqual(new Set(["FLAG_A", "FLAG_B"]));
  });

  it("excludes a flag's own running rule, which has no when: never", () => {
    // The asymmetry the old counting approach needed a magic number to correct
    // for: a flag appears once per file as the rule that RUNS its job.
    const own = topLevelBlocks(BALANCED).find((b) => b.name === "flag_a_job");
    expect(guardedFlags(own!.text)).toEqual(new Set());
  });

  it("tolerates a comment between the if: and its when: never", () => {
    // The exact fragility Duo review named in the line-offset version: an
    // inserted comment must not turn a real guard into an apparent gap.
    const yml = `job:
  rules:
    - if: '$CI_PIPELINE_SOURCE == "schedule" && $FLAG_A == "true"'
      # explaining why this one is suppressed

      when: never
`;
    expect(guardedFlags(yml)).toEqual(new Set(["FLAG_A"]));
  });

  it("recognises a guard whose when: never carries a trailing comment", () => {
    // #191 review. The sibling case above was already handled; this one was not,
    // and the asymmetry was an accident of implementation rather than a decision.
    // It matters more than it looks: `.gitlab-ci.yml` is listed in
    // `.prettierignore` *because* it "relies on hand-aligned inline comments",
    // and carries 41 of them — so the one file this parser exists to read is the
    // file where an inline comment is idiomatic and will never be normalised
    // away. Annotating a guard is an edit no reviewer would question.
    const yml = `job:
  rules:
    - if: '$CI_PIPELINE_SOURCE == "schedule" && $FLAG_A == "true"'
      when: never # the digest must not ride #191's hourly schedule
`;
    expect(guardedFlags(yml)).toEqual(new Set(["FLAG_A"]));
  });

  it("tolerates extra spacing between when: and never", () => {
    // Same brittleness as the trailing comment, same line. Worth pinning here
    // rather than trusting the formatter, because `.gitlab-ci.yml` is exactly
    // the file Prettier is told to skip — its spacing is hand-maintained.
    const yml = `job:
  rules:
    - if: '$CI_PIPELINE_SOURCE == "schedule" && $FLAG_A == "true"'
      when:   never
`;
    expect(guardedFlags(yml)).toEqual(new Set(["FLAG_A"]));
  });

  it("does not read a flag out of a trailing comment on the if: line", () => {
    // The same blindness pointing the other way, and the more dangerous
    // direction: a phantom flag enters `allGuardedFlags`, so every genuinely
    // guarded block is then reported as missing a guard for a flag that does
    // not exist. The failure is loud but the message is a lie.
    const yml = `job:
  rules:
    - if: '$CI_PIPELINE_SOURCE == "schedule"' # was $FLAG_A == "true" until #191
      when: never
`;
    expect(guardedFlags(yml)).toEqual(new Set());
  });

  it("does not read a commented-out rule as a live guard", () => {
    // A comment that quotes the rule it replaced is the house style here, and
    // this repo has been bitten twice by a scanner reading prose as code — which
    // is why `src/lib/source-text.ts` exists at all.
    const yml = `job:
  rules:
    - if: '$CI_PIPELINE_SOURCE == "schedule" && $FLAG_A == "true"'
      # if: '$FLAG_B == "true"' was dropped when this stopped being nightly
      when: never
`;
    expect(guardedFlags(yml)).toEqual(new Set(["FLAG_A"]));
  });

  it("treats a # inside a quoted scalar as data, not a comment", () => {
    // Why the stripper tracks quote state instead of cutting at the first `#`:
    // a rule matching a commit title against an issue reference is legitimate
    // YAML, and cutting there would silently drop the guard it introduces.
    const yml = `job:
  rules:
    - if: '$CI_COMMIT_TITLE =~ / #191/ && $FLAG_A == "true"'
      when: never
`;
    expect(guardedFlags(yml)).toEqual(new Set(["FLAG_A"]));
  });

  it("is indifferent to the order of guards within a block", () => {
    // Written out rather than produced by swapping substrings: the first attempt
    // used a regex that moved only the tail of each rule entry and built a
    // malformed fixture, so the test failed on its own input rather than on the
    // parser. A fixture that is easier to read than to generate is worth the lines.
    const aThenB = `job:
  rules:
    - if: '$CI_PIPELINE_SOURCE == "schedule" && $FLAG_A == "true"'
      when: never
    - if: '$CI_PIPELINE_SOURCE == "schedule" && $FLAG_B == "true"'
      when: never
`;
    const bThenA = `job:
  rules:
    - if: '$CI_PIPELINE_SOURCE == "schedule" && $FLAG_B == "true"'
      when: never
    - if: '$CI_PIPELINE_SOURCE == "schedule" && $FLAG_A == "true"'
      when: never
`;
    expect(guardedFlags(aThenB)).toEqual(new Set(["FLAG_A", "FLAG_B"]));
    expect(guardedFlags(bThenA)).toEqual(guardedFlags(aThenB));
    // Which is the whole improvement over the line-offset check this replaced:
    // that one required B's guard to sit exactly two lines below A's.
    expect(guardParityGaps(bThenA)).toEqual([]);
  });

  it("ignores a flag mentioned outside a rules if:", () => {
    const yml = `job:
  variables:
    NOTE: 'set $FLAG_A == "true" to run this'
  rules:
    - if: '$CI_PIPELINE_SOURCE == "schedule"'
`;
    expect(guardedFlags(yml)).toEqual(new Set());
  });

  it("does not count a when: never that belongs to a different entry", () => {
    const yml = `job:
  rules:
    - if: '$CI_PIPELINE_SOURCE == "schedule" && $FLAG_A == "true"'
    - if: '$CI_COMMIT_BRANCH == "main"'
      when: never
`;
    expect(guardedFlags(yml)).toEqual(new Set());
  });
});

describe("guardParityGaps", () => {
  it("finds nothing when every guarding block guards every flag", () => {
    expect(guardParityGaps(BALANCED)).toEqual([]);
  });

  it("NAMES the block and the flag when a guard is missing", () => {
    // The assertion that replaced the line arithmetic, shown failing. Without
    // this the real-file test below could be passing because the parser finds
    // nothing rather than because the file is correct.
    const missing = BALANCED.replace(
      `    - if: '$CI_PIPELINE_SOURCE == "schedule" && $FLAG_B == "true"'
      when: never
    - if: '$CI_PIPELINE_SOURCE == "schedule"'
`,
      `    - if: '$CI_PIPELINE_SOURCE == "schedule"'
`,
    );
    expect(missing).not.toBe(BALANCED);
    expect(guardParityGaps(missing)).toEqual([
      { block: "job_one", missing: "FLAG_B" },
    ]);
  });

  it("does not invent a gap when a guard carries an inline comment", () => {
    // The end-to-end cost of the trailing-comment hole (#191 review), in the
    // shape a contributor would actually produce: one guard annotated, the
    // others left alone. Before the fix this reported job_one as missing FLAG_A
    // — a failure naming a guard that is right there in the file.
    const annotated = BALANCED.replace(
      `    - if: '$CI_PIPELINE_SOURCE == "schedule" && $FLAG_A == "true"'
      when: never
    - if: '$CI_PIPELINE_SOURCE == "schedule" && $FLAG_B == "true"'
      when: never
    - if: '$CI_PIPELINE_SOURCE == "schedule"'
`,
      `    - if: '$CI_PIPELINE_SOURCE == "schedule" && $FLAG_A == "true"'
      when: never # flag A owns its own job
    - if: '$CI_PIPELINE_SOURCE == "schedule" && $FLAG_B == "true"'
      when: never
    - if: '$CI_PIPELINE_SOURCE == "schedule"'
`,
    );
    expect(annotated).not.toBe(BALANCED);
    expect(guardParityGaps(annotated)).toEqual([]);
  });

  it("does not drop a wholly-annotated block out of the parity check", () => {
    // The silent half, and the reason this outranks its severity label: a block
    // whose every guard carries a comment guards nothing as far as the parser is
    // concerned, and `guardParityGaps` skips blocks that guard nothing. So the
    // block leaves the check entirely — passing while asserting nothing, instead
    // of failing.
    const annotated = BALANCED.replace(
      `job_two:
  rules:
    - if: '$CI_PIPELINE_SOURCE == "schedule" && $FLAG_A == "true"'
      when: never
    - if: '$CI_PIPELINE_SOURCE == "schedule" && $FLAG_B == "true"'
      when: never
`,
      `job_two:
  rules:
    - if: '$CI_PIPELINE_SOURCE == "schedule" && $FLAG_A == "true"'
      when: never # not this job's schedule
    - if: '$CI_PIPELINE_SOURCE == "schedule" && $FLAG_B == "true"'
      when: never # nor this one
`,
    );
    expect(annotated).not.toBe(BALANCED);
    expect(blocksGuarding(annotated, "FLAG_A")).toContain("job_two");
    expect(blocksGuarding(annotated, "FLAG_B")).toContain("job_two");
  });

  it("derives the flag set from the file rather than a hard-coded list", () => {
    const withThird = BALANCED.replace(
      `job_two:
  rules:`,
      `job_two:
  rules:
    - if: '$CI_PIPELINE_SOURCE == "schedule" && $FLAG_C == "true"'
      when: never`,
    );
    expect(allGuardedFlags(withThird)).toEqual(["FLAG_A", "FLAG_B", "FLAG_C"]);
    // job_one now lacks FLAG_C, and nobody had to add FLAG_C to a list for that
    // to be caught — which is the point.
    expect(guardParityGaps(withThird)).toEqual([
      { block: "job_one", missing: "FLAG_C" },
    ]);
  });
});

describe("the real .gitlab-ci.yml", () => {
  it("guards every schedule flag in every block that guards any of them", () => {
    // `.gitlab-ci.yml`'s own words: "Each flag variable gets a `when: never` guard
    // on every OTHER scheduled job… Add a flag, add its guards." This is that
    // sentence, executable.
    expect(guardParityGaps(CI_YML)).toEqual([]);
  });

  it("knows about all four flags, and finds each in more than one block", () => {
    // The surface is shown returning NON-ZERO. An empty parse would satisfy the
    // parity assertion above perfectly, so "no gaps" only means something
    // alongside evidence that the parser found the guards at all.
    const flags = allGuardedFlags(CI_YML);
    expect(flags).toEqual([
      "PROD_STATE_CHECK",
      "REGISTRY_PRUNE",
      "RENOVATE_RUN",
      "SECURITY_ASSESSMENT",
    ]);
    for (const flag of flags) {
      const blocks = blocksGuarding(CI_YML, flag);
      expect(
        blocks.length,
        `${flag} is guarded in: ${blocks.join(", ")}`,
      ).toBeGreaterThan(1);
    }
  });

  it("keeps ops_digest guarded on every flag, because its last rule is a catch-all", () => {
    // Named explicitly rather than left to the parity rule: the digest is the one
    // block where a missing guard has an immediate, visible cost. #191's flag is
    // HOURLY, so the omission would have meant 24 weekly digests a day.
    for (const flag of allGuardedFlags(CI_YML)) {
      expect(blocksGuarding(CI_YML, flag)).toContain("ops_digest");
    }
  });
});
