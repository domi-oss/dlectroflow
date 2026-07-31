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
 * Every variable git reads to decide WHICH repository it operates on, i.e. the
 * ones that make `cwd` and `-C` irrelevant. Never copied from the parent
 * environment and never accepted as an override — the repository is named on
 * the command line instead.
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
 * Anything else a caller needs is passed explicitly. That includes the git
 * author/committer identity, which belongs to the fixture creating the commits
 * and not to this module.
 */
export const GIT_ENV_PASSTHROUGH = ["PATH", "HOME"] as const;

/**
 * Set on every child git regardless of what the caller asks for.
 *
 * The two config pins mean a developer's global config — signing hooks,
 * templates, a different `init.defaultBranch` — cannot change what a fixture
 * produces, so the fixture is identical locally and in CI.
 * `GIT_TERMINAL_PROMPT=0` turns a credential prompt into an error instead of a
 * child process that blocks until the job times out.
 */
const GIT_ISOLATION_PINS: Readonly<Record<string, string>> = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
};

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
 */
export function isolatedGitEnv(
  overrides: Readonly<Record<string, string>> = {},
): NodeJS.ProcessEnv {
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

  const env: NodeJS.ProcessEnv = {};
  for (const name of GIT_ENV_PASSTHROUGH) {
    const value = process.env[name];
    // An absent passthrough stays absent rather than becoming the string
    // "undefined", which is what assigning `process.env[name]` blindly would
    // hand the child.
    if (value !== undefined) env[name] = value;
  }

  return { ...env, ...GIT_ISOLATION_PINS, ...overrides };
}
