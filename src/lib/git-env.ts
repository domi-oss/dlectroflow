/**
 * #146 — the environment a child `git` process is allowed to see.
 *
 * `registry-prune.test.ts` built its git environment by spreading
 * `process.env` and then overriding `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM`.
 * That neutralises git's *config* and nothing else: `GIT_DIR`, `GIT_WORK_TREE`,
 * `GIT_INDEX_FILE` and the object-directory variables passed straight through,
 * so a `git log` run with `cwd` set to a freshly `git init`ed temp directory
 * reported commits belonging to whatever repository the runner was sitting in.
 * On 2026-07-31 that repository was `test_app`'s shallow clone, `git log` died
 * traversing parents outside the clone depth, `main` was red for 86 minutes and
 * `deploy_production` — a later stage — was SKIPPED, so the !220 merge never
 * reached production.
 *
 * ── Why an allow-list and not a blocklist ───────────────────────────────────
 * Deleting the five variables that broke us would leave the next one to be
 * discovered the same way. git has around forty environment variables and adds
 * more; a child process that starts from `{}` and is handed only what it needs
 * cannot be redirected by a variable nobody here has heard of yet. That is the
 * whole point of this module, so `git-env-hygiene.test.ts` fails the suite if a
 * git invocation goes back to spreading `process.env`.
 *
 * ── This is belt AND braces ─────────────────────────────────────────────────
 * A clean environment says "no variable names another repository"; `git -C
 * <dir>` says "this is the repository". Callers do both, because `cwd` alone
 * pinned the wrong one for months without anybody noticing.
 *
 * Test fixtures are the only callers today, which is why this module carries no
 * `fs` and no repository logic — it builds an environment, nothing more.
 */

/**
 * Every variable that makes `cwd` and `-C` irrelevant — either by telling git
 * WHICH repository to operate on, or by changing what it can see once it has
 * found one. Never copied from the parent environment and never accepted as an
 * override; the repository is named on the command line instead.
 *
 * The second clause is why `GIT_NAMESPACE` belongs here even though it does not
 * redirect git anywhere (Duo review on !227): it scopes which refs are visible
 * inside the current repository, so a leaked one makes `refs/heads/main`
 * invisible and the fixture's own history unreachable. Different mechanism, same
 * outcome — the command line stops deciding what git reads.
 *
 * Kept as a list rather than folded into the code because it is also what
 * `registry-prune.test.ts` points at a decoy repo to prove the isolation is
 * real, and the two must not drift.
 */
export const GIT_LOCATION_VARIABLES = [
  "GIT_DIR",
  "GIT_COMMON_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CEILING_DIRECTORIES",
  "GIT_DISCOVERY_ACROSS_FILESYSTEM",
  "GIT_NAMESPACE",
] as const;

/**
 * The only names copied from the parent environment.
 *
 * `PATH` — git execs its own `git-*` helpers, and the fixtures put stub
 * binaries on PATH, so an empty one means nothing runs at all.
 * `HOME` — git resolves `~` and would otherwise warn about not being able to
 * read a home directory. It cannot reach `~/.gitconfig` through it: the pins
 * below point global config at /dev/null.
 *
 * Two names, and adding a third needs an argument: every entry here is a value
 * the child gets from whatever happens to be in the parent's environment, which
 * is the class of problem #146 is about.
 *
 * Anything else a caller needs is passed explicitly. That includes the git
 * author/committer identity, which belongs to the fixture creating the commits
 * and not to this module.
 */
export const GIT_ENV_PASSTHROUGH = ["PATH", "HOME"] as const;

/**
 * Set on every child regardless of what the caller asks for. These are
 * LITERALS, not passthroughs — nothing here is read from the parent — so they
 * narrow the environment rather than widening it.
 *
 * The two config pins mean a developer's global config — signing hooks,
 * templates, a different `init.defaultBranch` — cannot change what a fixture
 * produces, so the fixture is identical locally and in CI.
 * `GIT_TERMINAL_PROMPT=0` turns a credential prompt into an error instead of a
 * child process that blocks until the job times out.
 * `NODE_ENV=test` is pinned rather than inherited: every caller is a test
 * fixture, and a child that lost it behaves as though it were in development.
 * `security-assessment.test.ts` hardcodes the same value for the same reason.
 * It also happens to be what makes the return type below work — see there.
 *
 * `as const` matters: it keeps `NODE_ENV`'s literal type, which is what lets the
 * result satisfy `NodeJS.ProcessEnv`.
 */
export const GIT_ISOLATION_PINS = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
  NODE_ENV: "test",
} as const;

/**
 * The environment for a child process that will run git: the allow-listed
 * passthroughs, the isolation pins, then `overrides`.
 *
 * Pass the repository as `git -C <dir>` (or, for a script, its `cwd`) — never
 * as an override. Naming one of {@link GIT_LOCATION_VARIABLES} throws rather
 * than being silently honoured, because an override there defeats the argument
 * on the command line and reopens #146 from the inside.
 *
 * `overrides` is also how a caller supplies everything that is not git's
 * business: the fixture's `GIT_AUTHOR_*`/`GIT_COMMITTER_*` identity, a stub
 * directory prepended to `PATH`, or the `CI_*` variables a shell script under
 * test reads.
 *
 * ── Why the return type is `NodeJS.ProcessEnv` and not `Record<string,string>` ─
 * `Record<string, string>` would describe what this builds more precisely — an
 * allow-list of variables that are all present, every value a defined string,
 * where `ProcessEnv` says `string | undefined`. It does not typecheck. Next.js
 * augments `NodeJS.ProcessEnv` so that `NODE_ENV` is a REQUIRED property rather
 * than part of the optional index signature, and `child_process`'s `env` option
 * is typed `NodeJS.ProcessEnv`, so every call site would fail with "Property
 * 'NODE_ENV' is missing in type 'Record<string, string>'". Pinning `NODE_ENV` in
 * {@link GIT_ISOLATION_PINS} satisfies that without widening the allow-list: it
 * is a literal, so nothing is inherited to satisfy the compiler (#146).
 */
export function isolatedGitEnv(
  overrides: Readonly<Record<string, string>> = {},
): NodeJS.ProcessEnv {
  // Refused for the same reason as the location variables below: the doc comment
  // above promises the pins apply regardless of what the caller asks for, and
  // `overrides` is spread last, so without this the promise was false (Duo review
  // on !227). Refused even when the override re-states the pin's own value —
  // otherwise the guard's answer depends on that value, and editing the pin later
  // silently converts a passing call into an override.
  const pinned = Object.keys(overrides).filter(
    (name) => name in GIT_ISOLATION_PINS,
  );
  if (pinned.length > 0) {
    throw new Error(
      `isolatedGitEnv: refusing to override the isolation pin(s) ` +
        `${pinned.join(", ")} — these are what make a fixture reproducible ` +
        `regardless of the machine it runs on. If a test genuinely needs a real ` +
        `git config or a terminal prompt, it is not using this helper.`,
    );
  }

  const located = Object.keys(overrides).filter((name) =>
    (GIT_LOCATION_VARIABLES as readonly string[]).includes(name),
  );
  if (located.length > 0) {
    throw new Error(
      `isolatedGitEnv: refusing to set ${located.join(", ")} — those tell git ` +
        `to operate on a repository other than the one on the command line, ` +
        `which is how #146 happened. Pass the repository as \`git -C <dir>\`.`,
    );
  }

  const copied: Record<string, string> = {};
  for (const name of GIT_ENV_PASSTHROUGH) {
    const value = process.env[name];
    // An absent passthrough stays absent rather than becoming the string
    // "undefined", which is what assigning `process.env[name]` blindly would
    // hand the child.
    if (value !== undefined) copied[name] = value;
  }

  return { ...copied, ...GIT_ISOLATION_PINS, ...overrides };
}

/**
 * Every one of {@link GIT_LOCATION_VARIABLES}, pointed at `dir` — the shape
 * that reddened `main` in #146, where a `GIT_DIR` inherited from the runner
 * named a shallow clone instead of the fixture's own temp repo.
 *
 * Tests stub these into `process.env` so that isolation is *demonstrated*
 * rather than assumed: a suite which only ever runs where they are unset cannot
 * tell an isolated fixture from one that merely looks isolated, and that is the
 * state the suite was in for months.
 *
 * Written out as an explicit map rather than derived from the list, so that each
 * variable gets a value with the right *shape* (a path to a git dir, a work
 * tree, an index file). `registry-prune.test.ts` asserts the keys here match
 * `GIT_LOCATION_VARIABLES` exactly, which is what stops a variable being added
 * to the allow-list and never exercised.
 */
export function ambientGitEnvPointingAt(dir: string): Record<string, string> {
  const gitDir = `${dir}/.git`;
  return {
    GIT_DIR: gitDir,
    GIT_COMMON_DIR: gitDir,
    GIT_WORK_TREE: dir,
    GIT_INDEX_FILE: `${gitDir}/index`,
    GIT_OBJECT_DIRECTORY: `${gitDir}/objects`,
    GIT_ALTERNATE_OBJECT_DIRECTORIES: `${gitDir}/objects`,
    GIT_CEILING_DIRECTORIES: dir,
    GIT_DISCOVERY_ACROSS_FILESYSTEM: "1",
    GIT_NAMESPACE: "refs/namespaces/decoy",
  };
}
