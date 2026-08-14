import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  TEARDOWN_JOBS,
  jobBlock,
  parseJobNeeds,
  declaresStopAction,
} from "./ci-job-deps";

const REPO_ROOT = join(__dirname, "..", "..");
const gitlabCiYml = readFileSync(join(REPO_ROOT, ".gitlab-ci.yml"), "utf8");

describe("jobBlock", () => {
  it("returns the job's own indented body and stops at the next top-level key", () => {
    const yml = [
      "a_job:",
      "  stage: deploy",
      "  needs: []",
      "next_job:",
      "  stage: test",
    ].join("\n");
    expect(jobBlock(yml, "a_job")).toEqual(["  stage: deploy", "  needs: []"]);
  });

  it("returns null for a job that does not exist", () => {
    expect(jobBlock("a_job:\n  stage: deploy", "nope")).toBeNull();
  });

  it("finds the job when its own key line carries a trailing comment (#226)", () => {
    // The exposure `#226` was filed for, one level up from the reported symptom:
    // the start line used to be matched with `l === `${job}:``, so annotating the
    // key made the block unfindable and every assertion below report that the job
    // is missing from the file. `ci-docs-only`'s sibling extractor already reads
    // its key through `withoutComment` for exactly this reason.
    const yml = [
      "a_job: # teardown, see #145",
      "  stage: deploy",
      "  needs: []",
    ].join("\n");
    expect(jobBlock(yml, "a_job")).toEqual(["  stage: deploy", "  needs: []"]);
  });

  it("does not accept a key whose value merely starts with the job name", () => {
    // The reason the key match is not a `startsWith`: `a_job: some-value` is a
    // scalar binding, not a block. Pinned alongside the comment tolerance above
    // so widening one does not quietly widen the other.
    expect(jobBlock("a_job: some-value\n  x: 1", "a_job")).toBeNull();
  });
});

describe("parseJobNeeds", () => {
  it("reports absent when the job declares no needs at all", () => {
    // The #145 shape: the job inherits everything from a template and says
    // nothing, so GitLab gives it every earlier stage as a dependency.
    const yml = [
      "stop_thing:",
      "  extends: .base",
      "  script:",
      "    - helm uninstall x",
    ].join("\n");
    expect(parseJobNeeds(yml, "stop_thing")).toEqual({ kind: "absent" });
  });

  it("reads the explicit empty form", () => {
    expect(parseJobNeeds("j:\n  needs: []", "j")).toEqual({ kind: "empty" });
  });

  it("reads the flow-sequence form", () => {
    expect(parseJobNeeds("j:\n  needs: [build_app, test_app]", "j")).toEqual({
      kind: "list",
      jobs: ["build_app", "test_app"],
    });
  });

  it("reads the block form with `- job:` entries, skipping comments", () => {
    const yml = [
      "j:",
      "  needs:",
      "    # a comment between the key and its items",
      "    - job: build_image",
      "      artifacts: false",
      "    - job: test_app",
      "  script:",
      "    - true",
    ].join("\n");
    expect(parseJobNeeds(yml, "j")).toEqual({
      kind: "list",
      jobs: ["build_image", "test_app"],
    });
  });

  it("reads the block form with bare entries", () => {
    expect(parseJobNeeds("j:\n  needs:\n    - build_app\n", "j")).toEqual({
      kind: "list",
      jobs: ["build_app"],
    });
  });

  it("ignores a `needs:` nested inside another mapping", () => {
    // Only a key of the job block itself counts; anything deeper is a different
    // thing and must not be mistaken for the job's dependencies.
    const yml = [
      "j:",
      "  rules:",
      "    - needs: something-else",
      "  script:",
      "    - true",
    ].join("\n");
    expect(parseJobNeeds(yml, "j")).toEqual({ kind: "absent" });
  });

  it("returns null for a job that does not exist", () => {
    expect(parseJobNeeds("j:\n  needs: []", "absent_job")).toBeNull();
  });

  it("reads the empty flow form when it carries a trailing comment (#226)", () => {
    // The same blindness as `declaresStopAction`, and this one is the worst of
    // the three because it does not merely miss: `[] # why` failed the `=== "[]"`
    // test, fell through to the flow-sequence branch, and came back as
    // `{ kind: "list", jobs: ["] # why"] }` — a dependency on a job that cannot
    // exist. The live file carries a twenty-line comment above `needs: []`
    // explaining why it is load-bearing, so an inline restatement is an
    // unremarkable edit.
    expect(
      parseJobNeeds("j:\n  needs: [] # load-bearing, see #145", "j"),
    ).toEqual({ kind: "empty" });
  });

  it("reads the flow-sequence form when it carries a trailing comment (#226)", () => {
    expect(
      parseJobNeeds("j:\n  needs: [build_app] # artifacts only", "j"),
    ).toEqual({ kind: "list", jobs: ["build_app"] });
  });

  it("keeps a `#` that is inside a quoted scalar rather than reading it as a comment (#226)", () => {
    // The direction stripping must NOT break. `.gitlab-ci.yml`'s rules are full
    // of quoted `if:` expressions, and this repo's own guard modules cite issue
    // numbers inside them; cutting at the first `#` regardless of quote state
    // would truncate a value and answer with a job name that was never written.
    const yml = [
      "j:",
      "  needs:",
      '    - job: "build#1"',
      "  script:",
      "    - true",
    ].join("\n");
    expect(parseJobNeeds(yml, "j")).toEqual({
      kind: "list",
      jobs: ["build#1"],
    });
  });
});

describe("declaresStopAction", () => {
  it("detects environment.action: stop", () => {
    const yml = [
      "j:",
      "  environment:",
      "    name: review/x",
      "    action: stop",
    ].join("\n");
    expect(declaresStopAction(yml, "j")).toBe(true);
  });

  it("is false for a deploy job", () => {
    const yml = [
      "j:",
      "  environment:",
      "    name: review/x",
      "    url: https://x",
    ].join("\n");
    expect(declaresStopAction(yml, "j")).toBe(false);
  });

  it("detects `action: stop` when the line carries a trailing comment (#226)", () => {
    // `.gitlab-ci.yml` is one of the few entries in `.prettierignore`, and the
    // recorded reason is that it "relies on hand-aligned inline comments" — so no
    // formatter will ever normalise one away and annotating this line is an
    // ordinary edit. The anchored `\s*$` this used to match on made that edit
    // report that a teardown job declares no stop action when it plainly does,
    // which is the loud half of the pair `guardedFlags` had silently (#191).
    const yml = [
      "j:",
      "  environment:",
      "    name: review/x",
      "    action: stop # the namespace goes with the merge, not with the timer",
    ].join("\n");
    expect(declaresStopAction(yml, "j")).toBe(true);
  });

  it("does not read `action: stop` out of a comment", () => {
    // The opposite direction, which stripping is what makes safe: prose
    // describing the key must not be mistaken for the key. Without stripping this
    // passed by accident — the anchor happened to exclude it — so it is pinned
    // rather than left resting on a regex detail that has now changed.
    const yml = [
      "j:",
      "  environment:",
      "    name: review/x",
      "    url: https://x # a teardown job would say action: stop here",
    ].join("\n");
    expect(declaresStopAction(yml, "j")).toBe(false);
  });
});

describe("the repo's own .gitlab-ci.yml", () => {
  it("every job listed as a teardown job really does tear an environment down", () => {
    // Guards the list itself: if a job is renamed or stops being a teardown,
    // this fails rather than silently checking nothing.
    for (const job of TEARDOWN_JOBS) {
      expect(
        jobBlock(gitlabCiYml, job),
        `${job} is missing from .gitlab-ci.yml`,
      ).not.toBeNull();
      expect(
        declaresStopAction(gitlabCiYml, job),
        `${job} no longer sets environment.action: stop — is TEARDOWN_JOBS stale?`,
      ).toBe(true);
    }
  });

  it("every teardown job declares needs: explicitly (#145)", () => {
    // A teardown job with no `needs:` implicitly depends on every earlier
    // stage. Once those artifacts expire it fails with
    // `missing_dependency_failure` before its script runs, the environment
    // wedges in `stopping`, and the namespace leaks forever — costing real
    // money, silently, because allow_failure: true keeps the pipeline green.
    for (const job of TEARDOWN_JOBS) {
      const needs = parseJobNeeds(gitlabCiYml, job);
      expect(
        needs?.kind,
        `${job} must declare needs: explicitly — without it GitLab depends on all earlier stages, and artifact expiry makes teardown permanently unrunnable (#145)`,
      ).not.toBe("absent");
    }
  });

  it("teardown jobs need nothing, because they consume no artifacts", () => {
    // Stronger than "declares needs": these jobs only run helm and kubectl
    // against a live cluster. Anything in the list would be a dependency that
    // can expire, which is the whole failure mode.
    for (const job of TEARDOWN_JOBS) {
      expect(
        parseJobNeeds(gitlabCiYml, job),
        `${job} should be needs: [] — it consumes no artifacts`,
      ).toEqual({ kind: "empty" });
    }
  });
});
