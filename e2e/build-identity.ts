/**
 * #266 — prove the server the suite is about to drive is THIS build.
 *
 * The reasoning lives in `src/lib/e2e-build-identity.ts`, which decides; this
 * file is the half that touches the world — it shells out to git and it fetches
 * `/api/health`. Split that way for the reason every hygiene module here is:
 * the decider is exercised on synthetic input by
 * `src/lib/e2e-build-identity.test.ts`, and a guard that can only be exercised
 * against a running server cannot be shown to fail.
 *
 * It is also why the fetch is HERE and not in `src/lib/`: `fetch-host-hygiene`
 * scans `src/`, `prisma/` and `scripts/` and deliberately excludes `e2e/`,
 * because e2e fetches dynamic local URLs by design. Moving this function into
 * `src/lib/` would put a variable-host `fetch()` in front of a scanner that
 * stands in for a demoted CWE-918 rule (#83), for no gain.
 */
import { execFileSync } from "node:child_process";
import { isolatedGitEnv } from "../src/lib/git-env";
import {
  resolveExpectedBuildSha,
  readThreadedExpectation,
  buildMismatchReport,
  LOST_EXPECTATION_ERROR,
  UNIDENTIFIED_CHECKOUT_NOTICE,
  type HealthReading,
  type ServerUnderTest,
} from "../src/lib/e2e-build-identity";

/**
 * How long to wait for `/api/health`. Generous, because this runs immediately
 * after Playwright has already polled the same endpoint to a 2xx — a server
 * that cannot answer within this is not slow, it has gone away, and that is a
 * reading rather than a reason to hang the suite.
 */
const HEALTH_TIMEOUT_MS = 15_000;

/**
 * The commit this checkout is on, or `null` if git could not say.
 *
 * `-C repoRoot` AND `cwd`, with `isolatedGitEnv()` for the environment: #146.
 * Wanting this repository is not the same as being pinned to it — a `GIT_DIR`
 * exported anywhere upstream redirects the call and `cwd` has no say, which is
 * how a fixture once ranked its tags against the runner's own shallow clone.
 * `git-env-hygiene` scans `e2e/` and fails the suite if either half is dropped.
 *
 * stderr is discarded rather than inherited: outside a repository git prints a
 * multi-line complaint that would land in the middle of Playwright's startup
 * output looking like an error, when the honest answer is simply `null` and the
 * caller has a much better sentence to print about it.
 */
function readHeadSha(repoRoot: string): string | null {
  try {
    return execFileSync("git", ["-C", repoRoot, "rev-parse", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf8",
      env: isolatedGitEnv(),
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

/** The short SHA this checkout expects every server under test to report. */
export function expectedBuildSha(repoRoot: string): string | null {
  return resolveExpectedBuildSha(process.env, () => readHeadSha(repoRoot));
}

/**
 * What one server says about itself.
 *
 * Every failure shape collapses to a `HealthReading` rather than throwing: the
 * caller composes one message per server and reports them together, so a run
 * that attached to two wrong servers says so once instead of dying on the first.
 */
async function probeHealth(origin: string): Promise<HealthReading> {
  let endpoint: string;
  try {
    endpoint = new URL("/api/health", origin).toString();
  } catch {
    return { sha: null, status: null, error: `\`${origin}\` is not a URL` };
  }
  try {
    const response = await fetch(endpoint, {
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
    if (!response.ok) {
      return {
        sha: null,
        status: response.status,
        error: `HTTP ${response.status}`,
      };
    }
    const body: unknown = await response.json();
    const sha =
      typeof body === "object" && body !== null && "sha" in body
        ? (body as { sha: unknown }).sha
        : null;
    return {
      sha: typeof sha === "string" && sha.length > 0 ? sha : null,
      status: response.status,
      error: null,
    };
  } catch (cause) {
    return {
      sha: null,
      status: null,
      error: cause instanceof Error ? cause.message : String(cause),
    };
  }
}

/**
 * Abort the run if any server under test was built from a different commit.
 *
 * Throwing rather than warning is the whole point: a warning scrolls past and
 * the suite runs anyway, which is the status quo #266 describes. Thrown from
 * `globalSetup`, Playwright reports it before a single spec produces a result,
 * so a wrong-build attach can never be mistaken for a failing feature.
 *
 * Every server is probed before anything is thrown, so two wrong attachments
 * are reported together rather than one per re-run.
 *
 * The expected commit is READ, never re-resolved (Duo review on !370). It was
 * resolved a second time here by a second `git rev-parse`, and two answers to
 * one question could disagree — with the worse direction silent: git answering
 * at the config and failing here left `reuseExistingServer` ON while this
 * function skipped itself as "cannot identify the checkout".
 */
export async function assertServersAreThisBuild(
  servers: readonly ServerUnderTest[],
  repoRoot: string,
): Promise<void> {
  const expectation = readThreadedExpectation(process.env);
  if (expectation.kind === "lost") {
    // The plumbing changed under this guard. Not a skip and not a re-resolve —
    // both of those are how it would come to pass without looking.
    throw new Error(`\n\n${LOST_EXPECTATION_ERROR}\n`);
  }
  if (expectation.kind === "unidentified") {
    // Not silence, and not a throw either: with no identity for the checkout
    // the config has already switched `reuseExistingServer` off, so the attach
    // this guard exists to catch cannot happen on this run. Saying so keeps
    // "the guard did not run" from reading as "the guard passed".
    console.warn(UNIDENTIFIED_CHECKOUT_NOTICE);
    return;
  }
  const expected = expectation.sha;

  const readings = await Promise.all(
    servers.map(async (server) => ({
      server,
      reading: await probeHealth(server.url),
    })),
  );
  const reports = readings
    .map(({ server, reading }) =>
      buildMismatchReport(server, expected, repoRoot, reading),
    )
    .filter((report): report is string => report !== null);

  if (reports.length > 0) {
    throw new Error(`\n\n${reports.join("\n\n")}\n`);
  }
}
