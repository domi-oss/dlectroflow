/**
 * #266 — is the server the specs are about to run against actually THIS build?
 *
 * `config/playwright.config.ts` sets `reuseExistingServer: !process.env.CI` on
 * fixed ports 3000/3100. When something is already listening there, Playwright
 * attaches to it rather than starting its own, and until this module existed it
 * had no way to check what that something was built from. This project's default
 * working mode is many concurrent worktrees, so the server on 3000 frequently
 * belongs to a DIFFERENT BRANCH.
 *
 * Observed twice inside one review of !349: an all-red run in which `data-theme`
 * was absent everywhere, clean on an immediate re-run with no change to the
 * tree. An absent `data-theme` is exactly what a pre-#85 build looks like, which
 * is why it presented as a real failure of the feature under review rather than
 * as an environment fault.
 *
 * The false RED costs about ten minutes each time. The false GREEN is the hazard
 * worth code: a spec that should fail against the branch under test can pass
 * because it was pointed at a build that happens to satisfy it, and nothing
 * announces it. That is this repo's most frequently recorded failure shape — a
 * green signal that means nothing was looked at.
 *
 * ── Why the commit and not something stronger ────────────────────────────────
 * The identity compared is the CHECKOUT'S COMMIT, carried to the server through
 * `BUILD_SHA` and read back from `/api/health`, which has reported it since
 * #135. Two things it deliberately does not catch, stated so nobody reads more
 * into a pass than is there:
 *
 *   * two worktrees sitting on the SAME commit are indistinguishable — and are
 *     also, by definition, the same code;
 *   * a bundle built before the last commit still reports the new commit,
 *     because the config injects `BUILD_SHA` at server START, not at build time.
 *     That is a stale-build problem, not a wrong-server problem, and #266 is
 *     about the second.
 *
 * The alternative — hashing `.next/BUILD_ID` into something hex-shaped so it
 * passes `shortBuildSha`'s validation — would catch both and was rejected: it
 * would make `/api/health` report a value that LOOKS like a commit and is not,
 * on the one endpoint whose entire job is answering "which build is this?".
 *
 * ── Kept free of `fs`, `child_process` and the network ───────────────────────
 * The repo's hygiene-module shape: this file decides, `e2e/build-identity.ts`
 * fetches and shells out, and `src/lib/e2e-build-identity.test.ts` exercises the
 * deciding on synthetic input and then reads the real tree. A guard that can
 * only be exercised against a running server cannot be shown to fail.
 */
import { shortBuildSha } from "./build-info";

/**
 * What `/api/health` answered, reduced to the three outcomes that matter.
 *
 * `sha: null` is a real reading and NOT an error: the endpoint answers `null`
 * whenever the server was started without a usable `BUILD_SHA`, which is exactly
 * what a worktree on a branch predating this guard does. Treating it as
 * "unknown, carry on" would leave the commonest wrong-build attach — an older
 * branch's server — invisible, so it is a mismatch like any other.
 */
export interface HealthReading {
  /** The short SHA the server reported, or `null` if it reported none. */
  sha: string | null;
  /** The HTTP status, or `null` when no response arrived at all. */
  status: number | null;
  /** Why no usable response arrived, if that is what happened. */
  error: string | null;
}

/**
 * The commit this checkout is on, normalised the same way the server normalises
 * what it reports — through `shortBuildSha`, so the two sides cannot disagree
 * about width or case.
 *
 * `readHead` is injected rather than called here for the reason in the module
 * docblock. It returns `null` when git could not answer.
 *
 * ── The precedence, and the one that is deliberately absent ──────────────────
 * git HEAD first, because for a checkout that IS the truth. `CI_COMMIT_SHA`
 * second, for an environment where git cannot answer (an unpacked archive, a
 * clone with no `.git`).
 *
 * An ambient `BUILD_SHA` is NOT read, even though it is the variable this value
 * eventually becomes. It is the OUTPUT of this resolution, not an input: the
 * config exports it into the server's environment, so honouring an ambient one
 * would make both sides agree by construction and quietly turn the guard off —
 * a check that cannot fail, which is the shape of every incident this repo keeps
 * recording.
 */
export function resolveExpectedBuildSha(
  env: BuildShaEnv,
  readHead: () => string | null,
): string | null {
  return (
    shortBuildSha(readHead() ?? undefined) ?? shortBuildSha(env.CI_COMMIT_SHA)
  );
}

/**
 * The environment as this module reads it. Deliberately an open record rather
 * than `NodeJS.ProcessEnv`: it has to accept `process.env` from the caller AND a
 * two-key literal from a test, and the project's `ProcessEnv` augmentation makes
 * some keys required, which would force every test case to carry noise that has
 * nothing to do with what it is asserting.
 *
 * Only `CI_COMMIT_SHA` is read — see the precedence note above for why
 * `BUILD_SHA` is not.
 */
export type BuildShaEnv = Readonly<Record<string, string | undefined>>;

/**
 * The variable `config/playwright.config.ts` threads its ONE resolution through
 * to `globalSetup` (Duo review on !370).
 *
 * The commit used to be resolved twice — once at config load to decide
 * `reuseExistingServer`, once inside `globalSetup` to check the servers — by two
 * separate `git` shellouts. Two answers to one question, and the disagreement is
 * not academic on a machine carrying ~30 worktrees where a commit can land
 * mid-run:
 *
 *   * git answers at the config and transiently fails at the assertion → reuse
 *     was ENABLED and the guard then skips itself as "cannot identify the
 *     checkout". An unverified attach, silently — the exact hole this guard
 *     exists to close, reopened by the guard's own plumbing;
 *   * git fails at the config and answers at the assertion → reuse was off,
 *     Playwright started its own server with no `BUILD_SHA`, and the guard
 *     fires on a run that was never in danger.
 *
 * Threading it through the environment rather than through a module-level cache
 * is deliberate. Playwright loads the config and runs `globalSetup` in the same
 * process — `createGlobalSetupTask` calls `loadGlobalHook` and awaits the hook
 * inline, verified in `node_modules/playwright/lib/runner/index.js` — but that
 * is an implementation detail, and a shared module instance additionally
 * assumes both files resolve through one module registry. `process.env` needs
 * only the process to be shared, and when even that stops being true the
 * variable is ABSENT, which is its own loud state below rather than a silent
 * re-resolution.
 */
export const EXPECTED_BUILD_SHA_ENV = "E2E_EXPECTED_BUILD_SHA";

/**
 * What `globalSetup` finds when it looks for the config's resolution.
 *
 * Three states and not two, because "the config resolved nothing" and "the
 * value never arrived" call for opposite responses, and collapsing them is how
 * a guard comes to skip itself.
 */
export type ThreadedExpectation =
  { kind: "sha"; sha: string } | { kind: "unidentified" } | { kind: "lost" };

/**
 * Read the threaded resolution. The config writes the variable
 * **unconditionally** — empty when it could not identify the checkout — so an
 * absent variable can only mean the value did not survive.
 */
export function readThreadedExpectation(env: BuildShaEnv): ThreadedExpectation {
  const raw = env[EXPECTED_BUILD_SHA_ENV];
  if (raw === undefined) return { kind: "lost" };
  if (raw === "") return { kind: "unidentified" };
  return { kind: "sha", sha: raw };
}

/**
 * What to say when the config's resolution did not reach `globalSetup` at all.
 *
 * A hard error rather than a fallback. Re-resolving would restore the two
 * answers this variable exists to remove, and skipping would leave a possible
 * attach unverified — so the only honest response to "the plumbing changed" is
 * to stop and say which plumbing.
 */
export const LOST_EXPECTATION_ERROR =
  `e2e: \`${EXPECTED_BUILD_SHA_ENV}\` is not set, so the #266 wrong-build ` +
  "guard cannot tell which commit this run is supposed to be testing. " +
  "`config/playwright.config.ts` sets it unconditionally at config load — " +
  "empty when the checkout has no identity — so an absent one means the value " +
  "did not survive from there to global setup (a wiring change, or a " +
  "Playwright that no longer runs global setup in the config's process). " +
  "Refusing to re-resolve it here: two resolutions of one commit is the defect " +
  "this variable replaced.";

/** One server to check, named the way the failure message should name it. */
export interface ServerUnderTest {
  /** Human-readable, e.g. "the default project's server". */
  label: string;
  /** The origin the specs will drive, e.g. `http://localhost:3000`. */
  url: string;
}

/**
 * How the server described its own build, in a phrase that fits after
 * "reports:". Split out because the three cases need genuinely different words
 * and a single templated line read as though the server had answered when it
 * had not.
 */
function describeReading(reading: HealthReading): string {
  if (reading.error !== null) {
    return `nothing — ${reading.error}`;
  }
  if (reading.sha === null) {
    return (
      "no sha at all (`sha: null`) — the server was started without a usable " +
      "`BUILD_SHA`, which is what a checkout on a branch that predates this " +
      "guard does"
    );
  }
  return reading.sha;
}

/**
 * The message for a server that is not this build, or `null` when it is.
 *
 * Names BOTH sides. A guard that says only "wrong build" sends the reader to
 * look up two values by hand, and the whole point is that this must be
 * distinguishable at a glance from a spec failure.
 */
export function buildMismatchReport(
  server: ServerUnderTest,
  expected: string,
  repoRoot: string,
  reading: HealthReading,
): string | null {
  if (reading.error === null && reading.sha === expected) return null;
  const port = portOf(server.url);
  return [
    `e2e: ${server.label} on ${server.url} is NOT the build under test (#266).`,
    "",
    `  this checkout expects:  ${expected}   (HEAD of ${repoRoot})`,
    `  /api/health reports:    ${describeReading(reading)}`,
    "",
    "`reuseExistingServer` is on outside CI, so Playwright attached to a server",
    "that was already listening on that port instead of starting its own — on",
    "this project that is almost always another worktree's. Every spec would",
    "then have run against the wrong branch: red for a feature that is present,",
    "or GREEN for one that is absent.",
    "",
    "This is an environment fault, not a test failure. Either stop the other",
    ...(port === null
      ? [
          "server — this URL could not be parsed, so no port can be named for it",
          "here — and re-run, or",
        ]
      : [`server (\`lsof -ti tcp:${port} | xargs kill\`) and re-run, or`]),
    "run this suite with CI=1, which makes Playwright start its own.",
  ].join("\n");
}

/**
 * The port a `lsof` line can act on, or `null` when the URL will not parse.
 *
 * `null` and not a default (Duo review on !370). This used to fall back to a
 * hardcoded `"3000"`, so a malformed MEMBER url printed
 * `lsof -ti tcp:3000 | xargs kill` — a command that kills the wrong server,
 * handed to someone who is already confused about which server they are talking
 * to, and the exact inverse of the property the sibling test asserts.
 *
 * `"unknown"` was the review's suggestion and is not taken: `lsof -ti
 * tcp:unknown` is still a paste-able command that cannot work, and the failure
 * messages in this repo are meant to be run. When the port is not known, the
 * kill line is not offered — the caller says so in words instead, and the
 * unparseable URL is already named on the line above it.
 */
function portOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.port !== "") return parsed.port;
    return parsed.protocol === "https:" ? "443" : "80";
  } catch {
    return null;
  }
}

/**
 * What to say when the checkout's own commit cannot be established.
 *
 * The guard cannot run, and "cannot run" must not read as "passed" — so the
 * caller stops reusing servers instead, which makes a wrong-build attach
 * impossible rather than merely undetected. Playwright's own "port is already
 * used" error is then the failure, and that one is already unmistakable.
 */
export const UNIDENTIFIED_CHECKOUT_NOTICE =
  "e2e: this checkout's commit could not be established (no git HEAD and no " +
  "CI_COMMIT_SHA), so the #266 wrong-build guard cannot run. Disabling " +
  "`reuseExistingServer` instead — Playwright will start its own server and " +
  "fail loudly if the port is taken, rather than silently testing someone " +
  "else's build.";
