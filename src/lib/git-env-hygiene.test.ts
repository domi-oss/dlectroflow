import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ALLOWLIST_HELPER,
  scanChildProcessCalls,
  type ChildProcessCall,
} from "@/lib/git-env-hygiene";

/**
 * #146 — the git-isolation guard.
 *
 * **Every process this repo starts that can reach git gets its environment from
 * `isolatedGitEnv()`, and names the repository on the command line.**
 *
 * The bug this replaces read as careful hygiene. `registry-prune.test.ts` built
 * its git environment by spreading `process.env` and then pinning
 * `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM` — which pins git's *config* and says
 * nothing about which *repository* git opens. `GIT_DIR`, `GIT_WORK_TREE`,
 * `GIT_INDEX_FILE` and the object-directory variables came through untouched, so
 * `git log`, run with `cwd` set to a freshly `git init`ed temp directory, ranked
 * the fixture's tags against the runner's own shallow clone. `main` was red for
 * 86 minutes, `deploy_production` sits in a later stage and was SKIPPED, and the
 * !220 merge never reached production. `ci-docs-only.test.ts` had the same
 * exposure in its plainest form: no `env` at all.
 *
 * A code review will not catch the next one — nobody reads a `...process.env`
 * and thinks about `GIT_ALTERNATE_OBJECT_DIRECTORIES`. So this is a hard gate in
 * the unit-test job, the same bargain `fetch-host-hygiene` struck for #83.
 *
 * ── Scope: `src/`, `scripts/`, `prisma/`, `e2e/`, tests INCLUDED ────────────
 * `fetch-host-hygiene` skips `*.test.ts` deliberately; this must not. Test
 * fixtures are the only things in this repo that shell out to git, and one of
 * them stopped a production deploy. Skipping them would leave the scanner with
 * nothing to look at.
 *
 * ── Shell scripts are followed one step ─────────────────────────────────────
 * `bash scripts/prune-registry.sh` runs git seven times, and a bash child hands
 * its whole environment to every command it then runs — so the rule applies to
 * the spawn that starts it. The scanner reports the script path and this file
 * reads the script to decide, rather than assuming: `security-assessment.sh` is
 * driven the same way and touches no git, so it is legitimately out of scope and
 * says so by its content instead of by an allowlist entry that would rot.
 */

// ── Reviewed exemptions ──────────────────────────────────────────────────────
//
// Git-reaching call sites that do NOT take their environment from the shared
// allow-list, each with a stated reason. Adding an entry re-opens #146 for that
// call site and has to be argued for in review — the same contract
// `REVIEWED_DYNAMIC_HOSTS` carries in the fetch-host guard.
//
// Keyed by `<file>:<line>`… deliberately NOT. A line number rots on the next
// edit above it, which is the failure mode that made the SAST ruleset unusable.
// Keyed by file and API instead. Empty today, and the honest goal is that it
// stays that way: there is no reason for a git child to see the ambient
// environment.
const REVIEWED_AMBIENT_GIT_CALLS: Record<string, string> = {};

// ── Directories that can contain a child process ─────────────────────────────
const SCANNED_ROOTS = ["src", "scripts", "prisma", "e2e"] as const;

const REPO_ROOT = path.join(__dirname, "..", "..");

/**
 * Resolved against REPO_ROOT, never the process CWD (Duo review on !227).
 * `readdirSync` on a bare `"src"` depends on where the runner happens to be, and
 * the failure is SILENT in the worst way: the catch below turns an unreadable
 * root into zero files, so a CWD that is not the repo root makes this whole gate
 * pass while scanning nothing. That is the #146 shape — a guard that quietly
 * stops guarding — reproduced inside the guard written to prevent it. The paths
 * that go OUT stay repo-relative, because they key REVIEWED_AMBIENT_GIT_CALLS
 * and appear in failure messages.
 */
function scannedFiles(): string[] {
  const files: string[] = [];
  for (const root of SCANNED_ROOTS) {
    let entries: string[];
    try {
      entries = readdirSync(path.join(REPO_ROOT, root), {
        recursive: true,
        encoding: "utf8",
      });
    } catch {
      // A scanned root that does not exist is a repo-layout change, not a
      // silent pass — the "roots exist" test below is what reports it.
      continue;
    }
    for (const entry of entries) {
      if (!/\.(ts|tsx|mts)$/.test(entry)) continue;
      files.push(path.join(root, entry));
    }
  }
  return files;
}

/** Every child-process call site in the real tree, with its file. */
function repoCalls(): { file: string; call: ChildProcessCall }[] {
  return scannedFiles().flatMap((file) =>
    scanChildProcessCalls(
      readFileSync(path.join(REPO_ROOT, file), "utf8"),
      file,
    ).map((call) => ({
      file,
      call,
    })),
  );
}

/** A git invocation inside a shell script — the same shape the scanner uses. */
const GIT_IN_SCRIPT = /(^|[\s;&|(`$])git\s/m;

/**
 * Does the shell script at `script` (as written in the source, e.g.
 * `scripts/prune-registry.sh`) run git?
 *
 * Throws when the file is not there: a guard that cannot read the thing it is
 * judging must say so, not quietly answer "no".
 */
function scriptRunsGit(script: string): boolean {
  const resolved = path.join(REPO_ROOT, script);
  if (!existsSync(resolved)) {
    throw new Error(
      `${script} is spawned somewhere in the scanned tree but is not at ` +
        `${resolved}, so this guard cannot tell whether it runs git. Fix the ` +
        `path or teach the guard how to resolve it.`,
    );
  }
  return GIT_IN_SCRIPT.test(readFileSync(resolved, "utf8"));
}

/** Call sites that reach git, directly or through a shell script that does. */
function gitReachingCalls(): { file: string; call: ChildProcessCall }[] {
  return repoCalls().filter(
    ({ call }) => call.runsGit || call.scripts.some(scriptRunsGit),
  );
}

/** Convenience: the single call site in a one-liner fixture. */
function only(body: string): ChildProcessCall {
  const source = `import { exec, execSync, execFile, execFileSync, spawn, spawnSync } from "node:child_process";\n${body}`;
  const calls = scanChildProcessCalls(source, "fixture.ts");
  expect(calls, `expected exactly one call site in:\n${body}`).toHaveLength(1);
  return calls[0];
}

describe("scanChildProcessCalls — what counts as a call site", () => {
  it("finds a named import", () => {
    expect(only(`execFileSync("git", ["log"]);`)).toMatchObject({
      api: "execFileSync",
      command: "git",
      runsGit: true,
    });
  });

  it("follows a renamed import", () => {
    const calls = scanChildProcessCalls(
      `import { execFileSync as runGit } from "node:child_process";
       runGit("git", ["log"], { env: {} });`,
      "fixture.ts",
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].api).toBe("execFileSync");
  });

  it("finds a namespace import's member call", () => {
    const calls = scanChildProcessCalls(
      `import * as cp from "node:child_process";
       cp.spawnSync("git", ["log"]);`,
      "fixture.ts",
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].runsGit).toBe(true);
  });

  it("ignores RegExp.prototype.exec, which merely shares a name", () => {
    // This repo's own parsers are full of `/…/.exec(buffer)`. Matching on the
    // callee's NAME would report every one as a child process, and a guard whose
    // output is mostly noise stops being read. Resolving the import is what
    // makes the difference.
    const source = `const m = /^(\\S+)\\s*(.*)$/.exec(buffer);
       const n = db.exec("git gc");`;
    expect(scanChildProcessCalls(source, "fixture.ts")).toEqual([]);
  });

  it("ignores a same-named local function", () => {
    const source = `function execSync(command: string) { return command; }
       execSync("git log");`;
    expect(scanChildProcessCalls(source, "fixture.ts")).toEqual([]);
  });
});

describe("scanChildProcessCalls — does it run git", () => {
  it("recognises an absolute path to git", () => {
    expect(only(`execFileSync("/usr/bin/git", ["log"]);`).runsGit).toBe(true);
  });

  it("recognises git inside a shell command line", () => {
    expect(only(`execSync("git log --format=%H");`).runsGit).toBe(true);
    expect(only(`execSync("cd /tmp && git status");`).runsGit).toBe(true);
  });

  it("recognises git handed to a shell as an argument", () => {
    expect(only(`spawnSync("sh", ["-c", "git log"]);`).runsGit).toBe(true);
  });

  it("does not match a command that merely contains the letters", () => {
    // `command -v bash` is this repo's real preflight check, and `legit` is the
    // classic false positive for a substring match.
    expect(only(`spawnSync("sh", ["-c", "command -v bash"]);`).runsGit).toBe(
      false,
    );
    expect(only(`execSync("legit status");`).runsGit).toBe(false);
    expect(only(`execFileSync("gitless", ["log"]);`).runsGit).toBe(false);
  });

  it("reports the shell scripts a call runs, resolving a const path", () => {
    const calls = scanChildProcessCalls(
      `import { spawnSync } from "node:child_process";
       import { join } from "node:path";
       const SCRIPT = join(process.cwd(), "scripts/prune-registry.sh");
       spawnSync("bash", [SCRIPT], { env: {} });`,
      "fixture.ts",
    );
    expect(calls[0].scripts).toEqual(["scripts/prune-registry.sh"]);
    // The scanner cannot see inside the script, so it does not guess.
    expect(calls[0].runsGit).toBe(false);
  });
});

describe("scanChildProcessCalls — where the environment comes from", () => {
  it("reports a missing env option as inherited", () => {
    expect(only(`execFileSync("git", ["log"]);`)).toMatchObject({
      env: "inherited",
    });
    expect(only(`execFileSync("git", ["log"], { cwd: dir });`)).toMatchObject({
      env: "inherited",
    });
  });

  it("reports a spread of process.env as ambient", () => {
    // The exact #146 shape: the config pins look like isolation and are not.
    const source = `const GIT_ENV = {
         ...process.env,
         GIT_CONFIG_GLOBAL: "/dev/null",
         GIT_CONFIG_SYSTEM: "/dev/null",
       };
       execFileSync("git", ["log"], { env: GIT_ENV });`;
    expect(only(source)).toMatchObject({ env: "ambient" });
  });

  it("reports process.env passed straight through as ambient", () => {
    expect(
      only(`execFileSync("git", ["log"], { env: process.env });`),
    ).toMatchObject({ env: "ambient" });
  });

  it("reports a rest-destructured process.env as ambient", () => {
    // The laundering shape: an exclusion list can only remove the names somebody
    // has already thought of, and `GIT_DIR` was not one of them.
    const source = `const { REGISTRY_PRUNE_TOKEN: _t, ...ambient } = process.env;
       execFileSync("git", ["log"], { env: { ...ambient, PATH: "/bin" } });`;
    expect(only(source)).toMatchObject({ env: "ambient" });
  });

  it("reports Object.assign onto process.env as ambient", () => {
    const source = `execFileSync("git", ["log"], {
         env: Object.assign({}, process.env, { GIT_CONFIG_GLOBAL: "/dev/null" }),
       });`;
    expect(only(source)).toMatchObject({ env: "ambient" });
  });

  it("accepts the shared allow-list helper", () => {
    expect(
      only(`execFileSync("git", ["log"], { env: ${ALLOWLIST_HELPER}() });`),
    ).toMatchObject({ env: "allowlist" });
  });

  it("accepts the helper through a const, and spread into an object", () => {
    const viaConst = `const GIT_ENV = ${ALLOWLIST_HELPER}({ GIT_AUTHOR_NAME: "T" });
       execFileSync("git", ["log"], { env: GIT_ENV });`;
    expect(only(viaConst)).toMatchObject({ env: "allowlist" });

    const spread = `spawnSync("bash", [SCRIPT], {
         env: { ...${ALLOWLIST_HELPER}(), CI_PROJECT_ID: "1" },
       });`;
    expect(only(spread)).toMatchObject({ env: "allowlist" });
  });

  it("does not confuse reading one variable by name with spreading them all", () => {
    // `process.env.PATH` is how an allow-list is BUILT. A guard that flagged it
    // would be unusable, and it is the reason this module parses TypeScript
    // rather than grepping for `process.env`.
    const source = `execFileSync("git", ["log"], {
         env: ${ALLOWLIST_HELPER}({ PATH: \`/stub:\${process.env.PATH}\` }),
       });`;
    expect(only(source)).toMatchObject({ env: "allowlist" });
  });

  it("reports a hand-rolled environment as unverifiable, not as a pass", () => {
    // Hermetic by inspection today, and one edit from not being. It has to route
    // through the shared helper so the pins and the passthrough list stay in one
    // place — `security-assessment.test.ts` was exactly this shape.
    expect(
      only(`execFileSync("git", ["log"], { env: { PATH: "/bin" } });`),
    ).toMatchObject({ env: "unverifiable" });
  });

  it("fails closed on a rebindable binding", () => {
    const source = `let env = ${ALLOWLIST_HELPER}();
       execFileSync("git", ["log"], { env });`;
    expect(only(source)).toMatchObject({ env: "unverifiable" });
  });

  it("fails closed on an env this file cannot follow", () => {
    const source = `import { buildEnv } from "./elsewhere";
       execFileSync("git", ["log"], { env: buildEnv() });`;
    expect(only(source)).toMatchObject({ env: "unverifiable" });
  });

  it("resolves the options object through a const", () => {
    const source = `const options = { cwd: dir, env: process.env };
       execFileSync("git", ["log"], options);`;
    expect(only(source)).toMatchObject({ env: "ambient" });
  });

  it("states a reason for every verdict, passing ones included", () => {
    for (const body of [
      `execFileSync("git", ["log"]);`,
      `execFileSync("git", ["log"], { env: process.env });`,
      `execFileSync("git", ["log"], { env: ${ALLOWLIST_HELPER}() });`,
      `execFileSync("git", ["log"], { env: { PATH: "/bin" } });`,
    ]) {
      expect(only(body).envReason.length, body).toBeGreaterThan(20);
    }
  });
});

describe("scanChildProcessCalls — is the repository named", () => {
  it("accepts -C in an argument array", () => {
    expect(
      only(`execFileSync("git", ["-C", dir, "log"]);`).pinsRepository,
    ).toBe(true);
  });

  it("accepts -C and --git-dir in a shell command line", () => {
    expect(only(`execSync(\`git -C \${dir} log\`);`).pinsRepository).toBe(true);
    expect(only(`execSync("git --git-dir=/x/.git log");`).pinsRepository).toBe(
      true,
    );
  });

  it("accepts a spread argument array built elsewhere in the file", () => {
    const source = `const base = ["-C", dir];
       execFileSync("git", [...base, "log"]);`;
    expect(only(source).pinsRepository).toBe(true);
  });

  it("rejects a call that leaves cwd as the only thing pinning the repo", () => {
    // The #146 shape exactly: `cwd` was right and git read a different repo.
    expect(
      only(`execFileSync("git", ["log"], { cwd: dir });`).pinsRepository,
    ).toBe(false);
  });

  it("fails closed when the argument list cannot be read at all", () => {
    // `execFileSync("git", args)` inside a `(dir, ...args)` wrapper — the exact
    // pre-fix shape. Nothing about `args` is knowable here, so the repository is
    // reported as unpinned rather than assumed fine.
    const source = `function git(dir: string, ...args: string[]) {
         return execFileSync("git", args, { env: ${ALLOWLIST_HELPER}() });
       }`;
    expect(only(source).pinsRepository).toBe(false);
  });

  it("does not call an unrelated .assign() ambient", () => {
    // Duo review (!227): matching any `.assign` treated `schema.assign(process.env)`
    // as Object.assign. Safe direction — it over-reports — but a guard that cries
    // wolf on unrelated code gets routed around, which is how the SAST ruleset
    // this replaced became unusable.
    const source = `const env = schema.assign(process.env);
       execFileSync("git", ["-C", dir, "log"], { env });`;
    expect(only(source).env).not.toBe("ambient");
  });

  it("still calls a real Object.assign(…, process.env) ambient", () => {
    const source = `const env = Object.assign({}, process.env);
       execFileSync("git", ["-C", dir, "log"], { env });`;
    expect(only(source).env).toBe("ambient");
  });

  it("is not fooled by a -C that belongs to another word", () => {
    expect(
      only(`execFileSync("git", ["log", "--pretty=-Coops"]);`).pinsRepository,
    ).toBe(false);
  });

  // Duo review (!227): `-C` is two different flags depending on where it sits.
  // As a GLOBAL option before the subcommand, `git -C <dir>` chooses the
  // repository — that is the one this guard is looking for. After the
  // subcommand, `git log -C` / `git diff -C` is copy detection and says nothing
  // about which repository is being read. Matching it anywhere in the argument
  // list let the copy-detection flag satisfy a repository-pinning guard, which
  // is a false negative in the one direction that matters: it reports #146's
  // exact shape as safe.
  it("rejects -C used as git's copy-detection flag after the subcommand", () => {
    expect(
      only(`execFileSync("git", ["log", "-C"], { cwd: dir });`).pinsRepository,
    ).toBe(false);
    expect(
      only(`execFileSync("git", ["diff", "-C", "-M"], { cwd: dir });`)
        .pinsRepository,
    ).toBe(false);
    expect(only(`execSync("git log -C");`).pinsRepository).toBe(false);
  });

  it("still accepts -C before the subcommand, where it names the repo", () => {
    expect(
      only(`execFileSync("git", ["-C", dir, "diff", "-C"]);`).pinsRepository,
    ).toBe(true);
    expect(only(`execSync(\`git -C \${dir} log -C\`);`).pinsRepository).toBe(
      true,
    );
  });

  // The mirror of the above: a global `-C` counts even when the directory after
  // it is a variable this scanner cannot resolve — which is the normal case, and
  // is `registry-prune.test.ts`'s own `["-C", dir, ...args]` fixture. Requiring a
  // readable directory token flagged that correct code, so the rule was dropped;
  // see namesRepository's comment for why a bare `-C` is not worth catching.
  it("accepts a global -C whose directory is not statically readable", () => {
    const source = `function git(dir: string, ...args: string[]) {
         return execFileSync("git", ["-C", dir, ...args], { cwd: dir });
       }`;
    expect(only(source).pinsRepository).toBe(true);
  });
});

describe("the repo itself", () => {
  it("every scanned root exists where this test thinks it does", () => {
    // `scannedFiles()` swallows a missing root, and the file-count guard below
    // is satisfied by `src/` alone — so renaming `scripts/` would silently drop
    // it from the scan while everything stayed green. Same guard
    // `fetch-host-hygiene` puts on its roots, for the same reason (!218).
    for (const root of SCANNED_ROOTS) {
      expect(
        () => readdirSync(path.join(REPO_ROOT, root), { encoding: "utf8" }),
        `${root}/ is missing — fix the layout or update SCANNED_ROOTS`,
      ).not.toThrow();
    }
  });

  it("scans a real number of files (guards against matching nothing)", () => {
    expect(scannedFiles().length).toBeGreaterThan(50);
  });

  // Duo review (!227). The scan used to `readdirSync("src")` relative to the
  // process CWD, and `scannedFiles()` swallows an unreadable root — so running
  // from anywhere else made every "no violations" assertion below vacuously true.
  // The gate would have been green while looking at nothing.
  it("scans the same files from any working directory", () => {
    const fromRepoRoot = scannedFiles();
    const original = process.cwd();
    try {
      process.chdir(tmpdir());
      expect(scannedFiles()).toEqual(fromRepoRoot);
      expect(scannedFiles().length).toBeGreaterThan(50);
    } finally {
      process.chdir(original);
    }
  });

  it("reads file contents from any working directory too", () => {
    // Anchoring the listing without anchoring the reads would trade a silent
    // empty scan for a loud ENOENT — better, but still not working.
    const original = process.cwd();
    try {
      process.chdir(tmpdir());
      expect(() => repoCalls()).not.toThrow();
      expect(repoCalls().length).toBeGreaterThanOrEqual(6);
    } finally {
      process.chdir(original);
    }
  });

  it("finds the child-process call sites that are known to exist", () => {
    // registry-prune.test.ts has three, ci-docs-only.test.ts two,
    // security-assessment.test.ts two. A scanner that suddenly finds none is
    // broken, not clean.
    expect(repoCalls().length).toBeGreaterThanOrEqual(6);
  });

  it("finds the git-reaching call sites that are known to exist", () => {
    // Two in registry-prune.test.ts (the `git` wrapper and the `bash
    // prune-registry.sh` spawn, which runs git seven times), two in
    // ci-docs-only.test.ts (`ls-tree` and the decoy repo builder), one in
    // source-encoding-hygiene.test.ts (`ls-files`, which is how the whole-repo
    // sweep for #224 learns which files are tracked — a recursive readdir from
    // the repo root would walk node_modules and sibling worktrees), and one in
    // e2e/build-identity.ts (`rev-parse HEAD`, the only non-test caller: #266
    // needs the checkout's own commit to tell this worktree's server apart from
    // the one another worktree left on port 3000).
    const reaching = gitReachingCalls();
    expect(reaching.length).toBeGreaterThanOrEqual(6);
    expect(new Set(reaching.map(({ file }) => file))).toEqual(
      new Set([
        path.join("src", "lib", "registry-prune.test.ts"),
        path.join("src", "lib", "ci-docs-only.test.ts"),
        path.join("src", "lib", "source-encoding-hygiene.test.ts"),
        path.join("e2e", "build-identity.ts"),
      ]),
    );
  });

  it("does not drag in a script spawn that never touches git", () => {
    // `security-assessment.sh` is driven exactly like `prune-registry.sh` and
    // runs no git, so it must fall OUT of scope by its content — proving the
    // shell-script step actually reads the script rather than assuming.
    const securityAssessment = repoCalls().filter(({ file, call }) =>
      file.endsWith("security-assessment.test.ts")
        ? call.scripts.length > 0
        : false,
    );
    expect(securityAssessment.length).toBeGreaterThan(0);
    for (const { call } of securityAssessment) {
      expect(call.scripts.some(scriptRunsGit)).toBe(false);
    }
  });

  it("every REVIEWED_AMBIENT_GIT_CALLS entry is live and carries a reason", () => {
    // A stale exemption reads like considered coverage.
    const offending = new Set(
      gitReachingCalls()
        .filter(({ call }) => call.env !== "allowlist")
        .map(({ file, call }) => `${file}:${call.api}`),
    );
    for (const [key, reason] of Object.entries(REVIEWED_AMBIENT_GIT_CALLS)) {
      expect(
        offending,
        `${key} is no longer a git-reaching call site`,
      ).toContain(key);
      expect(reason.length, `${key} needs a real reason`).toBeGreaterThan(40);
    }
  });

  it("every git-reaching child takes its env from the shared allow-list", () => {
    const offenders = gitReachingCalls()
      .filter(({ file, call }) => {
        if (call.env === "allowlist") return false;
        return !REVIEWED_AMBIENT_GIT_CALLS[`${file}:${call.api}`];
      })
      .map(
        ({ file, call }) =>
          `${file}:${call.line} ${call.api}(${call.command ?? "?"}) — ${call.envReason}`,
      );
    expect(
      offenders,
      `These call sites can reach git with an environment that was not built by ` +
        `${ALLOWLIST_HELPER}() in src/lib/git-env.ts. Inheriting or spreading ` +
        `the parent environment hands the child GIT_DIR, GIT_WORK_TREE, ` +
        `GIT_INDEX_FILE and the object-directory variables, which override cwd ` +
        `and -C and silently point git at a different repository (#146). Use ` +
        `${ALLOWLIST_HELPER}({ …only what this child needs… }).`,
    ).toEqual([]);
  });

  it("every direct git invocation names its repository on the command line", () => {
    const offenders = repoCalls()
      .filter(({ call }) => call.runsGit && !call.pinsRepository)
      .map(({ file, call }) => `${file}:${call.line} ${call.api}`);
    expect(
      offenders,
      `These git invocations rely on cwd alone to choose the repository. In ` +
        `#146 cwd was correct and git still read a different repo, so pass ` +
        `\`-C <dir>\` (or \`--git-dir\`) as well — belt and braces.`,
    ).toEqual([]);
  });
});
