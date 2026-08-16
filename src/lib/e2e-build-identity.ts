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
    `server (\`lsof -ti tcp:${portOf(server.url)} | xargs kill\`) and re-run, or`,
    "run this suite with CI=1, which makes Playwright start its own.",
  ].join("\n");
}

/**
 * The port a `lsof` line can act on. Falls back to the scheme default rather
 * than printing `undefined` into a command the reader is invited to paste.
 */
function portOf(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.port !== "") return parsed.port;
    return parsed.protocol === "https:" ? "443" : "80";
  } catch {
    return "3000";
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
