import { afterEach, describe, it, expect, vi } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ambientGitEnvPointingAt, isolatedGitEnv } from "@/lib/git-env";
import {
  CODE_GATED_SCANNERS,
  DOCS_ONLY_PATHS,
  DOCS_ONLY_STUB_JOB,
  parseCodeChangeGlobs,
  parseJobsGatedOn,
  parseStubDeclaredReports,
  parseStubReportTypes,
  parseStubWrittenReports,
  parseTreeEntries,
  docsOnlyViolations,
  globCoversTopLevel,
  classifyTopLevelPath,
  type CommittedEntry,
} from "./ci-docs-only";

const REPO_ROOT = join(__dirname, "..", "..");

const gitlabCiYml = readFileSync(join(REPO_ROOT, ".gitlab-ci.yml"), "utf8");

const codeGlobs = parseCodeChangeGlobs(gitlabCiYml);

/**
 * Committed top-level entries only. `git ls-tree` rather than `readdirSync` so
 * the set is identical locally and in CI — an untracked `node_modules/`, `.env`
 * or editor droppings must not influence a CI invariant.
 *
 * `-C REPO_ROOT` *and* `cwd`, with an allow-listed environment: #146. Wanting
 * this repository is not the same as being pinned to it — the call inherited the
 * whole ambient environment, so a `GIT_DIR` exported anywhere upstream pointed
 * it at a different repository entirely, and `cwd` had no say in the matter.
 */
function committedTopLevelPaths(): string[] {
  const out = execFileSync(
    "git",
    ["-C", REPO_ROOT, "ls-tree", "--name-only", "HEAD"],
    { cwd: REPO_ROOT, encoding: "utf8", env: isolatedGitEnv() },
  );
  return out.split("\n").filter(Boolean);
}

/**
 * Every committed file with its git mode, recursively.
 *
 * `-r` is the entire point, and its absence was the hole this reader closes:
 * `committedTopLevelPaths` above stops at the top level, so it sees the bare
 * name `skills` and has no opinion whatever about what is inside it. A
 * `skills/foo/helper.sh` would therefore be classified purely by the word
 * `skills` and take the fast path unbuilt, untested and unscanned.
 *
 * `-z` rather than the default line format: git QUOTES a path containing a
 * newline, a quote or a non-ASCII byte, and a quoted path parses to the wrong
 * name. That direction fails OPEN — a mangled `helper.sh` stops looking like a
 * shell script — so the format that cannot mangle it is the only safe one.
 *
 * Same `-C REPO_ROOT` + `cwd` + `isolatedGitEnv()` hardening as the reader
 * above, for the same #146 reason: an ambient `GIT_DIR` would point this at
 * another repository, and a guard enumerating somebody else's tree passes by
 * vacuity rather than failing.
 */
function committedEntries(): CommittedEntry[] {
  const out = execFileSync(
    "git",
    ["-C", REPO_ROOT, "ls-tree", "-r", "-z", "HEAD"],
    { cwd: REPO_ROOT, encoding: "utf8", env: isolatedGitEnv() },
  );
  return parseTreeEntries(out);
}

/**
 * A repository that is NOT this one, holding a file no top-level path list of
 * this repo could contain. #146: an ambient `GIT_DIR` makes git read whatever
 * repository it names, whatever `cwd` says — and the failure mode is a
 * confident wrong answer, not a crash, so the decoy has to be a real repo with
 * a real tree rather than an empty directory.
 */
function makeDecoyRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "ci-docs-only-decoy-"));
  const env = isolatedGitEnv({
    GIT_AUTHOR_NAME: "Docs Only Test",
    GIT_AUTHOR_EMAIL: "docs-only@example.test",
    GIT_COMMITTER_NAME: "Docs Only Test",
    GIT_COMMITTER_EMAIL: "docs-only@example.test",
  });
  const git = (...args: string[]): string =>
    execFileSync("git", ["-C", dir, ...args], {
      cwd: dir,
      encoding: "utf8",
      env,
    });
  git("init", "--quiet", "--initial-branch=main");
  writeFileSync(join(dir, "DECOY.md"), "not this repository\n");
  git("add", "DECOY.md");
  git("commit", "--quiet", "-m", "decoy");
  return dir;
}

/**
 * #146 — this fixture legitimately wants THIS repository, which is exactly why
 * it needs the same hardening as the prune fixture that wanted its own temp
 * one. It passed no `env` at all, so the child inherited everything: an ambient
 * `GIT_DIR` made `git ls-tree` enumerate a different repository, and the
 * classification below then decided which CI jobs a merge request needs based
 * on somebody else's file list. That answer is wrong and confident, and #116
 * showed what a wrongly-skipped gate costs.
 */
describe("committedTopLevelPaths is git-isolated", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("reads this repository even when the environment names another", () => {
    const decoy = makeDecoyRepo();
    for (const [name, value] of Object.entries(
      ambientGitEnvPointingAt(decoy),
    )) {
      vi.stubEnv(name, value);
    }

    const paths = committedTopLevelPaths();
    expect(paths, "read the decoy repository").not.toContain("DECOY.md");
    expect(paths).toContain("package.json");
    expect(paths).toContain("src");
  });

  // The recursive reader carries the same hazard and the same hardening. It is
  // the worse of the two to get wrong: the top-level reader pointed at another
  // repository fails loudly on the `package.json`/`src` sanity check, whereas
  // the recursive guard would simply find no violations in a tree that has no
  // docs-only prefixes at all, and report a clean pass.
  it("enumerates this repository recursively, not the one the environment names", () => {
    const decoy = makeDecoyRepo();
    for (const [name, value] of Object.entries(
      ambientGitEnvPointingAt(decoy),
    )) {
      vi.stubEnv(name, value);
    }

    const paths = committedEntries().map((e) => e.path);
    expect(paths, "read the decoy repository").not.toContain("DECOY.md");
    expect(paths).toContain("src/lib/ci-docs-only.ts");
  });
});

describe("parseTreeEntries", () => {
  const record = (mode: string, path: string): string =>
    `${mode} blob 179ae8d918cdbbc69dbdb3ee7724152b1f496950\t${path}\0`;

  it("reads the mode and path of each NUL-terminated record", () => {
    expect(
      parseTreeEntries(
        record("100644", "docs/legal.md") + record("100755", "scripts/x.sh"),
      ),
    ).toEqual([
      { mode: "100644", path: "docs/legal.md" },
      { mode: "100755", path: "scripts/x.sh" },
    ]);
  });

  it("keeps a path containing a newline intact", () => {
    // Exactly why `-z` is used. In the default line format git would render
    // this as a quoted, escaped string; parsed naively it stops looking like
    // the `.sh` it is, and the guard below then waves it through.
    expect(parseTreeEntries(record("100755", "skills/we\nird.sh"))).toEqual([
      { mode: "100755", path: "skills/we\nird.sh" },
    ]);
  });

  it("throws on an unreadable record rather than dropping it", () => {
    // Dropping it is the fail-open direction: the entry vanishes from the set
    // the guard inspects, and the guard then reports a clean tree.
    expect(() => parseTreeEntries("garbage-not-a-tree-entry\0")).toThrow(
      /cannot read/,
    );
  });

  it("throws on empty output rather than reporting an empty tree", () => {
    // `git ls-tree` printing nothing means the call went wrong, not that the
    // repository has no files — and an empty set passes every check below.
    expect(() => parseTreeEntries("")).toThrow(/no files/);
  });
});

/**
 * The recursive, fail-closed half of the guard.
 *
 * `DOCS_ONLY_PATHS` grants a whole directory the fast path on the strength of
 * its name. `classifyTopLevelPath` above only ever asks whether that name is
 * on a list, so nothing in this module could previously see *inside* `docs/`
 * or `skills/` at all — the classification was a promise about the contents
 * that nothing checked.
 *
 * Contrast `docker/**` + `/ *` in `.code_changes`: a recursive glob re-triggers
 * the full gate at any depth, so `docker/` needs no such promise. A docs-only
 * prefix has no equivalent, which is why the promise has to be enforced here
 * instead.
 *
 * Fail-closed means the allow-list is of *observed* shapes, not plausible
 * ones. Nothing is pre-authorised on the grounds that it would probably be
 * fine; adding a `.svg` to `docs/` is meant to fail once, in front of the
 * person adding it, who then either lists the type here or learns why not.
 */
describe("docsOnlyViolations", () => {
  const entry = (mode: string, path: string): CommittedEntry => ({
    mode,
    path,
  });

  it("rejects an executable committed under a docs-only prefix", () => {
    // The scenario this whole guard exists for. Upstream AntiVibe ships four
    // optional helper shell scripts; carrying one over would land exactly this
    // entry, and before this check it would have merged with no build, no
    // test and no security scan, and nothing anywhere would have said so.
    expect(
      docsOnlyViolations([entry("100755", "skills/antivibe/helper.sh")]),
    ).toEqual([
      {
        path: "skills/antivibe/helper.sh",
        reason: "has the executable bit set",
      },
      {
        path: "skills/antivibe/helper.sh",
        reason: "is not a recognised documentation file type",
      },
    ]);
  });

  it("rejects a non-documentation file type even without the executable bit", () => {
    // `sh file.sh` and `node file.js` both ignore the mode entirely, so the
    // executable bit is a signal and not the control.
    expect(
      docsOnlyViolations([entry("100644", "skills/antivibe/helper.sh")]),
    ).toEqual([
      {
        path: "skills/antivibe/helper.sh",
        reason: "is not a recognised documentation file type",
      },
    ]);
  });

  it("rejects a symlink, which is not prose whatever it is named", () => {
    // A `docs/shortcut.md` symlinked at `../src/lib/secrets.ts` reads as
    // documentation to every name-based check in this file.
    expect(docsOnlyViolations([entry("120000", "docs/shortcut.md")])).toEqual([
      { path: "docs/shortcut.md", reason: "is a symbolic link" },
    ]);
  });

  it("rejects a submodule, which is an entire unscanned repository", () => {
    expect(docsOnlyViolations([entry("160000", "skills/vendor")])).toEqual([
      { path: "skills/vendor", reason: "is a git submodule" },
      {
        path: "skills/vendor",
        reason: "is not a recognised documentation file type",
      },
    ]);
  });

  it("names an unrecognised mode instead of assuming it is harmless", () => {
    expect(docsOnlyViolations([entry("100664", "docs/legal.md")])).toEqual([
      {
        path: "docs/legal.md",
        reason: "has the unrecognised git mode 100664",
      },
    ]);
  });

  it("accepts the documentation shapes the tree actually holds", () => {
    expect(
      docsOnlyViolations([
        entry("100644", "README.md"),
        entry("100644", "LICENSE"),
        entry("100644", "docs/design/specs/assets/row-final.png"),
        entry("100644", "docs/wireframe/dlectroflow-wireframe.html"),
        entry("100644", "skills/antivibe/LICENSE"),
        entry("100644", "skills/antivibe/templates/deep-dive.md"),
      ]),
    ).toEqual([]);
  });

  it("ignores everything outside the docs-only prefixes", () => {
    // `scripts/` is full of committed 100755 shell scripts and is covered by
    // `.code_changes`, so it gets the full gate and is none of this guard's
    // business. A guard that flagged them would be relaxed within the week.
    expect(
      docsOnlyViolations([
        entry("100755", "scripts/prune-registry.sh"),
        entry("100644", "src/lib/ci-docs-only.ts"),
      ]),
    ).toEqual([]);
  });

  it("does not let a sibling name pick up a docs prefix", () => {
    // `docs` must not claim `docs-internal/`, and must not therefore silently
    // start policing a directory that `.code_changes` is responsible for.
    expect(
      docsOnlyViolations([entry("100755", "docs-internal/build.sh")]),
    ).toEqual([]);
  });

  it("rejects a bare extension with no stem", () => {
    // `skills/.md` is a dotfile, not a document. Fail-closed: an odd shape
    // nobody thought about gets rejected, not waved through on a suffix match.
    expect(docsOnlyViolations([entry("100644", "skills/.md")])).toEqual([
      {
        path: "skills/.md",
        reason: "is not a recognised documentation file type",
      },
    ]);
  });
});

describe("parseCodeChangeGlobs", () => {
  it("reads the quoted items of the .code_changes block", () => {
    const yml = [
      "some_key: value",
      ".code_changes: &code_changes",
      "  # a comment inside the block",
      '  - "src/**/*"',
      '  - "*.ts"',
      "",
      ".next_key: &other",
      '  - "not-part-of-it"',
    ].join("\n");
    expect(parseCodeChangeGlobs(yml)).toEqual(["src/**/*", "*.ts"]);
  });

  it("accepts every quoting style GitLab accepts, plus inline comments", () => {
    const yml = [
      ".code_changes: &code_changes",
      '  - "double/**/*"',
      "  - 'single/**/*'",
      "  - bare/**/*",
      '  - "with-comment/**/*"   # why this path matters',
      "next_key: x",
    ].join("\n");
    expect(parseCodeChangeGlobs(yml)).toEqual([
      "double/**/*",
      "single/**/*",
      "bare/**/*",
      "with-comment/**/*",
    ]);
  });

  it("throws on an unreadable list item instead of truncating the list", () => {
    // Silently stopping here would drop `scripts/**/*` and send the developer
    // off to fix a coverage gap that does not exist.
    const yml = [
      ".code_changes: &code_changes",
      '  - "src/**/*"',
      "  - [flow, syntax]",
      '  - "scripts/**/*"',
      "next_key: x",
    ].join("\n");
    expect(() => parseCodeChangeGlobs(yml)).toThrow(/cannot read/);
  });

  it("throws if the anchor is missing, rather than silently passing", () => {
    expect(() => parseCodeChangeGlobs("workflow:\n  rules: []\n")).toThrow(
      /\.code_changes/,
    );
  });

  it("throws if the anchor is present but empty", () => {
    expect(() =>
      parseCodeChangeGlobs(".code_changes: &code_changes\nother_key: x\n"),
    ).toThrow(/empty/);
  });
});

describe("globCoversTopLevel", () => {
  it("covers a directory entry via its recursive glob", () => {
    expect(globCoversTopLevel("src/**/*", "src")).toBe(true);
    expect(globCoversTopLevel("src/**/*", "srcs")).toBe(false);
  });

  it("matches root-level extension globs without crossing directories", () => {
    expect(globCoversTopLevel("*.ts", "next.config.ts")).toBe(true);
    expect(globCoversTopLevel("*.ts", "src/index.ts")).toBe(false);
  });

  // `.code_changes` no longer contains a trailing-wildcard glob — the last one
  // was `Dockerfile*`, retired when the Docker family moved under `docker/`.
  // The shape stays supported and stays tested: it is the same substitution
  // that makes `*.ts` work, so a rewrite to `endsWith` would pass the leading-
  // wildcard cases above and quietly break this one. Names here are generic on
  // purpose — nothing in the repo is called this.
  it("matches a trailing-wildcard name", () => {
    expect(globCoversTopLevel("Widget*", "Widget")).toBe(true);
    expect(globCoversTopLevel("Widget*", "Widget.ci")).toBe(true);
    expect(globCoversTopLevel("Widget*", "my.Widget")).toBe(false);
  });

  it("matches a literal dotfile and does not treat the dot as a wildcard", () => {
    expect(globCoversTopLevel(".nvmrc", ".nvmrc")).toBe(true);
    expect(globCoversTopLevel(".nvmrc", "xnvmrc")).toBe(false);
  });

  it("does not let a bare * glob swallow dotfiles the way the shell would", () => {
    expect(globCoversTopLevel("*.yml", "anything.yml")).toBe(true);
    // `.gitlab-ci.yml` IS matched by *.yml here, which is what GitLab does for
    // an explicit extension glob — the guard below is what keeps that honest.
    // It is now the only top-level .yml left: the two Compose files moved into
    // docker/, where `docker/**/*` covers them.
    expect(globCoversTopLevel("*.yml", ".gitlab-ci.yml")).toBe(true);
  });
});

describe("docs-only CI fast path covers every committed top-level path", () => {
  const paths = committedTopLevelPaths();

  it("finds a plausible repo root (sanity check on the git call)", () => {
    expect(paths).toContain("package.json");
    expect(paths).toContain("src");
    expect(paths.length).toBeGreaterThan(10);
  });

  it("classifies every top-level entry as either code or docs", () => {
    const unclassified = paths.filter(
      (p) => classifyTopLevelPath(p, codeGlobs) === "unclassified",
    );
    expect(
      unclassified,
      `These top-level paths are matched by neither .code_changes in .gitlab-ci.yml nor DOCS_ONLY_PATHS, so a merge request touching only them would SKIP the entire test/build/scan gate. Add each one to .code_changes (it can affect the app) or to DOCS_ONLY_PATHS (it cannot): ${unclassified.join(", ")}`,
    ).toEqual([]);
  });

  it("never classifies a path as both code and docs", () => {
    const both = DOCS_ONLY_PATHS.filter((p) =>
      codeGlobs.some((g) => globCoversTopLevel(g, p)),
    );
    expect(
      both,
      `Listed as documentation but also matched by .code_changes, so the fast path can never trigger for it: ${both.join(", ")}`,
    ).toEqual([]);
  });

  it("treats the things that must never be fast-pathed as code", () => {
    for (const critical of [
      "src",
      "e2e",
      "prisma",
      "charts",
      "package.json",
      "package-lock.json",
      // The whole Docker family — both Dockerfiles, the Caddyfile and both
      // Compose files — is one top-level entry now, covered by `docker/**/*`.
      "docker",
      ".gitlab-ci.yml",
      ".env.example",
    ]) {
      expect(
        classifyTopLevelPath(critical, codeGlobs),
        `${critical} must trigger the full gate`,
      ).toBe("code");
    }
  });

  it("treats documentation as documentation", () => {
    for (const doc of ["README.md", "CHANGELOG.md", "docs"]) {
      expect(classifyTopLevelPath(doc, codeGlobs)).toBe("docs");
    }
  });
});

/**
 * The classification above is a promise that `docs/` and `skills/` contain
 * nothing but prose. This is the enforcement of it, against the real tree.
 */
describe("every committed file under a docs-only prefix is really documentation", () => {
  const entries = committedEntries();
  const covered = entries.filter((e) =>
    DOCS_ONLY_PATHS.some((p) => e.path === p || e.path.startsWith(`${p}/`)),
  );

  /**
   * The "clean" result below is only worth anything if the enumeration
   * actually looked at something, and specifically if it looked BELOW the top
   * level — a reader that stopped at the top level (the bug this closes) would
   * find nothing wrong and report exactly the same zero.
   */
  it("actually descends into the docs-only directories", () => {
    expect(covered.length).toBeGreaterThan(50);
    expect(covered.map((e) => e.path)).toContain(
      "skills/antivibe/templates/deep-dive.md",
    );
    expect(covered.map((e) => e.path)).toContain(
      "docs/design/specs/assets/2026-07-16-row-final-stacked.png",
    );
  });

  /** The same guard, shown returning a non-empty answer when there is one. */
  it("would flag an executable added under one of them", () => {
    expect(
      docsOnlyViolations([
        ...entries,
        { mode: "100755", path: "skills/antivibe/helper.sh" },
      ]),
    ).not.toEqual([]);
  });

  it("finds no executable, symlink, submodule or non-prose file", () => {
    const violations = docsOnlyViolations(entries);
    expect(
      violations.map((v) => `${v.path} ${v.reason}`),
      `These committed files sit under a path in DOCS_ONLY_PATHS, so a merge request touching only them SKIPS the compile, test, image-build and scanning jobs — but they are not documentation. Either move the prefix into .code_changes in .gitlab-ci.yml (it can now affect the app or be executed), or, if the file genuinely is inert documentation of a shape this repo did not have before, add its type to DOCS_ONLY_FILE_SUFFIXES / DOCS_ONLY_FILE_NAMES and say in the comment there why it cannot execute.`,
    ).toEqual([]);
  });
});

describe("parseJobsGatedOn", () => {
  it("attributes a rules alias to the job that carries it", () => {
    const yml = [
      ".code_scanner_rules: &code_scanner_rules",
      "  - if: '$CI_PIPELINE_SOURCE == \"merge_request_event\"'",
      "some-scanner:",
      "  needs: []",
      "  rules: *code_scanner_rules",
      "other_job:",
      "  rules: *scanner_rules",
      "third-scanner:",
      "  rules: *code_scanner_rules",
    ].join("\n");
    expect(parseJobsGatedOn(yml, "code_scanner_rules")).toEqual([
      "some-scanner",
      "third-scanner",
    ]);
  });

  it("is not fooled by a nested key that looks like a job name", () => {
    // `variables:` and `artifacts:` sit at column 0 only for real jobs; an
    // indented `rules:` still belongs to the last column-0 key above it.
    const yml = [
      "job_a:",
      "  variables:",
      "    FOO: bar",
      "  rules: *code_scanner_rules",
    ].join("\n");
    expect(parseJobsGatedOn(yml, "code_scanner_rules")).toEqual(["job_a"]);
  });

  it("returns nothing when the alias is unused", () => {
    expect(parseJobsGatedOn("job_a:\n  rules: []\n", "nope")).toEqual([]);
  });

  // Duo review on !217: an exact-string match would silently miss a commented
  // line and then fail the coverage assertion with a message about
  // CODE_GATED_SCANNERS drifting, sending the reader after the wrong thing.
  // `parseCodeChangeGlobs` already tolerates inline comments; so does this.
  it("tolerates a trailing inline comment on the rules line", () => {
    const yml = "job_a:\n  rules: *code_scanner_rules   # added in !217\n";
    expect(parseJobsGatedOn(yml, "code_scanner_rules")).toEqual(["job_a"]);
  });

  it("tolerates extra whitespace before the alias", () => {
    // `rules:  *anchor` is valid YAML. Matching on the parsed alias rather
    // than the literal line keeps the failure message about the thing that
    // actually drifted (Duo review on !217).
    const yml = "job_a:\n  rules:   *code_scanner_rules\n";
    expect(parseJobsGatedOn(yml, "code_scanner_rules")).toEqual(["job_a"]);
  });

  it("does not match a different alias with the anchor as a prefix", () => {
    const yml = "job_a:\n  rules: *code_scanner_rules_v2\n";
    expect(parseJobsGatedOn(yml, "code_scanner_rules")).toEqual([]);
  });

  it("does not treat a # without leading whitespace as a comment", () => {
    // YAML only starts a comment at a `#` preceded by whitespace, so this is a
    // different alias, not `code_scanner_rules` plus a comment.
    const yml = "job_a:\n  rules: *code_scanner_rules#notacomment\n";
    expect(parseJobsGatedOn(yml, "code_scanner_rules")).toEqual([]);
  });
});

describe("parseStubReportTypes", () => {
  it("reads the artifacts:reports: keys of the stub job", () => {
    const yml = [
      "before_job:",
      "  artifacts:",
      "    reports:",
      "      junit: not-ours.xml",
      `${DOCS_ONLY_STUB_JOB}:`,
      "  stage: test",
      "  artifacts:",
      "    paths:",
      "      - gl-sast-report.json",
      "    reports:",
      "      # a comment inside the block",
      "      sast: gl-sast-report.json",
      "      container_scanning: gl-container-scanning-report.json",
      "    expire_in: 1 week",
      "after_job:",
      "  artifacts:",
      "    reports:",
      "      dast: also-not-ours.json",
    ].join("\n");
    expect(parseStubReportTypes(yml)).toEqual(["sast", "container_scanning"]);
  });

  it("throws when the stub job is gone rather than reporting zero types", () => {
    // Reporting `[]` would make the coverage assertion below pass by vacuity
    // exactly when the job that closes the gap has been deleted.
    // Substring match, not `new RegExp(DOCS_ONLY_STUB_JOB)`: building a regex
    // from a variable trips semgrep's "regular expression with non-literal
    // value" rule, and `toThrow(string)` already means "message contains".
    expect(() => parseStubReportTypes("workflow:\n  rules: []\n")).toThrow(
      DOCS_ONLY_STUB_JOB,
    );
  });

  it("throws when the stub job declares no reports", () => {
    expect(() =>
      parseStubReportTypes(`${DOCS_ONLY_STUB_JOB}:\n  script:\n    - true\n`),
    ).toThrow(/no artifacts:reports:/);
  });
});

/**
 * `parseStubReportTypes` is this function's keys, so the throwing cases above
 * cover both. What is asserted here is the part only this function has: the
 * filename each report type points at, which is what the writer is compared
 * against.
 */
describe("parseStubDeclaredReports", () => {
  it("tolerates inline comments on the block and on its entries", () => {
    const yml = [
      `${DOCS_ONLY_STUB_JOB}:`,
      "  artifacts:",
      "    reports:   # what registers the scan type",
      "      sast: gl-sast-report.json   # empty by construction",
      "    expire_in: 1 week",
    ].join("\n");
    expect(parseStubDeclaredReports(yml)).toEqual({
      sast: "gl-sast-report.json",
    });
  });

  it("reads a hyphenated report type on both sides of the comparison", () => {
    // Every GitLab security report type is snake_case today, so this is
    // future-proofing, not a live bug — but a type the parsers silently
    // skipped would be skipped on BOTH sides, so the two lists would agree
    // about a report neither of them checked (Duo review on !217).
    const yml = [
      `${DOCS_ONLY_STUB_JOB}:`,
      "  script:",
      "    - |",
      '          ["future-type", "gl-future-report.json"],',
      "  artifacts:",
      "    reports:",
      "      future-type: gl-future-report.json",
    ].join("\n");
    expect(parseStubDeclaredReports(yml)).toEqual({
      "future-type": "gl-future-report.json",
    });
    expect(parseStubWrittenReports(yml)).toEqual(parseStubDeclaredReports(yml));
  });

  it("finds the job by its exact key, comment or no comment", () => {
    const yml = [
      `# ${DOCS_ONLY_STUB_JOB}: described in the block comment above the job`,
      `  ${DOCS_ONLY_STUB_JOB}: not-a-job-this-is-nested`,
      `${DOCS_ONLY_STUB_JOB}:   # the real one`,
      "  artifacts:",
      "    reports:",
      "      sast: gl-sast-report.json",
    ].join("\n");
    expect(parseStubDeclaredReports(yml)).toEqual({
      sast: "gl-sast-report.json",
    });
  });

  it("ignores a `reports:` line inside the script block scalar", () => {
    // Duo review on !217: the job's `script:` is a block scalar this
    // line-based parser reads as plain text, so a log line or comment that
    // happens to read `reports:` would otherwise open a phantom block and
    // capture script text as report declarations. Only `reports:` nested
    // under `artifacts:` counts.
    const yml = [
      `${DOCS_ONLY_STUB_JOB}:`,
      "  script:",
      "    - |",
      "      echo 'reports:'",
      "      reports:",
      "        dast: gl-dast-report.json",
      "  artifacts:",
      "    reports:",
      "      sast: gl-sast-report.json",
    ].join("\n");
    expect(parseStubDeclaredReports(yml)).toEqual({
      sast: "gl-sast-report.json",
    });
  });

  it("names the problem when a report value is a YAML alias, not a filename", () => {
    // Duo review on !217: an alias compares unequal to the literal filename the
    // script writes, so the guard would fail — but with a message about the two
    // lists disagreeing rather than about the alias in front of you.
    const yml = [
      `${DOCS_ONLY_STUB_JOB}:`,
      "  artifacts:",
      "    reports:",
      "      sast: *sast_report_file",
    ].join("\n");
    expect(() => parseStubDeclaredReports(yml)).toThrow(/literal filename/);
  });
});

describe("parseStubWrittenReports", () => {
  /**
   * A stub job whose `artifacts:reports:` block and inline writer disagree:
   * `dependency_scanning` is declared but never written. The runner logs
   * `no matching files`, the job still passes, and no scan type is registered
   * — #116 back, silently. This fixture is the shape that must not slip past.
   */
  const divergent = [
    `${DOCS_ONLY_STUB_JOB}:`,
    "  script:",
    "    - |",
    "      node -e '",
    "        for (const [type, file] of [",
    '          ["sast", "gl-sast-report.json"],',
    '          ["container_scanning", "gl-container-scanning-report.json"],',
    "        ]) { writeFileSync(file, report(type)); }",
    "      '",
    "  artifacts:",
    "    reports:",
    "      sast: gl-sast-report.json",
    "      dependency_scanning: gl-dependency-scanning-report.json",
    "      container_scanning: gl-container-scanning-report.json",
  ].join("\n");

  it("reads the type-to-file pairs the inline script writes", () => {
    expect(parseStubWrittenReports(divergent)).toEqual({
      sast: "gl-sast-report.json",
      container_scanning: "gl-container-scanning-report.json",
    });
  });

  it("catches a report declared in artifacts but never written", () => {
    expect(parseStubWrittenReports(divergent)).not.toEqual(
      parseStubDeclaredReports(divergent),
    );
  });

  it("catches a declared report pointed at a different filename", () => {
    const typo = [
      `${DOCS_ONLY_STUB_JOB}:`,
      "  script:",
      "    - |",
      "      node -e '",
      "        for (const [type, file] of [",
      '          ["sast", "gl-sast-report.json"],',
      "        ]) { writeFileSync(file, report(type)); }",
      "      '",
      "  artifacts:",
      "    reports:",
      "      sast: gl-sast-reports.json", // plural: the artifact never resolves
    ].join("\n");
    expect(parseStubWrittenReports(typo)).not.toEqual(
      parseStubDeclaredReports(typo),
    );
  });

  it("tolerates a trailing // comment on a pair line", () => {
    const yml = [
      `${DOCS_ONLY_STUB_JOB}:`,
      "  script:",
      "    - |",
      '          ["sast", "gl-sast-report.json"], // semgrep + advanced SAST',
    ].join("\n");
    expect(parseStubWrittenReports(yml)).toEqual({
      sast: "gl-sast-report.json",
    });
  });

  it("throws when the script writes nothing rather than comparing equal to {}", () => {
    expect(() =>
      parseStubWrittenReports(
        `${DOCS_ONLY_STUB_JOB}:\n  script:\n    - true\n  artifacts:\n    reports:\n      sast: x.json\n`,
      ),
    ).toThrow(/writes no report files/);
  });
});

/**
 * #116: the fast path skipping a scanner is only half the story. The approval
 * policy in the linked security-policy project compares the security report
 * TYPES in the merge request's pipeline against those in main's; a type main
 * has and the MR lacks is a `scan_removed` violation, and the policy's
 * `fallback_behavior: fail: closed` turns that into a required approval. Every
 * docs-only MR was therefore unmergeable until one specific human approved it.
 *
 * `docs_only_scan_stub` closes that by emitting an empty report for each type
 * the fast path skips. These assertions keep the two lists in step: add a fifth
 * code-gated scanner and the suite fails until the stub stands in for its
 * report type too. Without them the regression is silent — the MR just becomes
 * unmergeable, with a message that blames security rather than CI config.
 */
describe("docs-only fast path leaves no security report type behind", () => {
  it("gates exactly the scanner jobs the stub knows how to stand in for", () => {
    const gated = parseJobsGatedOn(gitlabCiYml, "code_scanner_rules");
    expect(
      [...gated].sort(),
      `Jobs gated on *code_scanner_rules in .gitlab-ci.yml no longer match CODE_GATED_SCANNERS. A gated scanner missing from that map produces a report type on main that a docs-only MR will not have, which blocks the MR on the approval policy. Map it, then stub its report type in ${DOCS_ONLY_STUB_JOB}.`,
    ).toEqual(Object.keys(CODE_GATED_SCANNERS).sort());
  });

  it("emits one empty report for every type those scanners produce", () => {
    const expected = [...new Set(Object.values(CODE_GATED_SCANNERS))].sort();
    expect(
      parseStubReportTypes(gitlabCiYml).sort(),
      `${DOCS_ONLY_STUB_JOB}'s artifacts:reports: must cover exactly the report types the skipped scanners produce.`,
    ).toEqual(expected);
  });

  it("actually writes every report file it declares", () => {
    // Duo review on !217: `artifacts:reports:` and the inline writer are two
    // separate lists, and only the first was guarded. A declared-but-unwritten
    // report is the quietest way back to #116 — `no matching files` is a
    // WARNING, the job goes green, and the scan type never registers.
    expect(
      parseStubWrittenReports(gitlabCiYml),
      `${DOCS_ONLY_STUB_JOB}'s inline node script and its artifacts:reports: block must name the same report types AND the same filenames.`,
    ).toEqual(parseStubDeclaredReports(gitlabCiYml));
  });

  it("never stubs a report type whose scanner still runs on a docs-only MR", () => {
    // secret_detection is deliberately ungated (a secret can be pasted into a
    // README), so it runs on the fast path and must NOT be stubbed — a stub
    // would sit alongside the real report and add a scanner name to the
    // security widget that scanned nothing.
    expect(parseStubReportTypes(gitlabCiYml)).not.toContain("secret_detection");
    expect(parseJobsGatedOn(gitlabCiYml, "scanner_rules")).toContain(
      "secret_detection",
    );
  });
});
