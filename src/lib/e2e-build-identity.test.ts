/**
 * #266 — a local e2e run can attach to another worktree's server.
 *
 * `config/playwright.config.ts` sets `reuseExistingServer: !process.env.CI` on
 * fixed ports 3000/3100, and with ~30 concurrent worktrees the server already
 * listening on 3000 frequently belongs to a different branch. Playwright
 * attaches to it and, until this guard, had no way to check what it was built
 * from.
 *
 * The property under test is not "do the specs pass". It is: **can a run tell
 * that it was pointed at the wrong build, and say so in a way nobody mistakes
 * for a spec failure?**
 *
 * The false red costs ten minutes. The false GREEN is why this is code and not
 * a note in a runbook: a spec that should fail can pass because the build it
 * was pointed at happens to satisfy it, and nothing announces it.
 *
 * Two halves, the shape every hygiene module here follows: synthetic input
 * against the pure decider, then the real tree, because a guard that is correct
 * and unwired is not a guard.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  resolveExpectedBuildSha,
  buildMismatchReport,
  UNIDENTIFIED_CHECKOUT_NOTICE,
  type HealthReading,
  type ServerUnderTest,
} from "./e2e-build-identity";
import { stripComments } from "./source-text";

const REPO_ROOT = join(__dirname, "..", "..");

const FULL_SHA = "4c0f1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b";
const SHORT_SHA = "4c0f1a2";
const OTHER_FULL = "b6e2b94c5d6e7f8091a2b3c4d5e6f708192a3b4c";
const OTHER_SHORT = "b6e2b94";

const DEFAULT_SERVER: ServerUnderTest = {
  label: "the default project's server",
  url: "http://localhost:3000",
};
const MEMBER_SERVER: ServerUnderTest = {
  label: "the member project's server",
  url: "http://localhost:3100",
};

const reading = (over: Partial<HealthReading> = {}): HealthReading => ({
  sha: SHORT_SHA,
  status: 200,
  error: null,
  ...over,
});

describe("resolveExpectedBuildSha", () => {
  it("takes git HEAD, shortened the way /api/health shortens it", () => {
    // Both sides normalise through `shortBuildSha`, so a width or case change
    // in one cannot silently start failing every run. Full SHA in, short out.
    expect(resolveExpectedBuildSha({}, () => FULL_SHA)).toBe(SHORT_SHA);
  });

  it("prefers git HEAD to CI_COMMIT_SHA", () => {
    // For a checkout, git IS the truth; CI_COMMIT_SHA is the fallback for an
    // environment where git cannot answer.
    expect(
      resolveExpectedBuildSha({ CI_COMMIT_SHA: OTHER_FULL }, () => FULL_SHA),
    ).toBe(SHORT_SHA);
  });

  it("falls back to CI_COMMIT_SHA when git cannot answer", () => {
    expect(
      resolveExpectedBuildSha({ CI_COMMIT_SHA: OTHER_FULL }, () => null),
    ).toBe(OTHER_SHORT);
  });

  it("IGNORES an ambient BUILD_SHA, so the guard cannot be switched off", () => {
    // THE arm that keeps this from being decorative. `BUILD_SHA` is what this
    // value BECOMES — the config exports it into the server's environment — so
    // honouring an ambient one would make both sides agree by construction and
    // turn the guard into a check that cannot fail. That is the shape of every
    // incident this repo keeps recording, so it is asserted rather than assumed.
    expect(resolveExpectedBuildSha({ BUILD_SHA: OTHER_FULL }, () => null)).toBe(
      null,
    );
    expect(
      resolveExpectedBuildSha({ BUILD_SHA: OTHER_FULL }, () => FULL_SHA),
    ).toBe(SHORT_SHA);
  });

  it("returns null rather than a guess when nothing identifies the checkout", () => {
    expect(resolveExpectedBuildSha({}, () => null)).toBe(null);
  });

  it("rejects a git answer that is not a SHA", () => {
    // `git rev-parse HEAD` on a repository with no commits prints `HEAD` and
    // exits non-zero; a wrapper that swallowed the status would hand this
    // module a word. It must not become an expectation the server can never
    // meet, and it must not read as a known commit either.
    for (const junk of ["HEAD", "", "   ", "not-a-sha", "1234"]) {
      expect(resolveExpectedBuildSha({}, () => junk)).toBe(null);
    }
  });
});

describe("buildMismatchReport", () => {
  it("says nothing when the server is the build under test", () => {
    expect(
      buildMismatchReport(DEFAULT_SERVER, SHORT_SHA, REPO_ROOT, reading()),
    ).toBe(null);
  });

  it("names BOTH shas when they differ", () => {
    // A guard that says only "wrong build" sends the reader to look up two
    // values by hand — and the entire point is that this must be
    // distinguishable at a glance from a spec failure.
    const report = buildMismatchReport(
      DEFAULT_SERVER,
      SHORT_SHA,
      REPO_ROOT,
      reading({ sha: OTHER_SHORT }),
    );
    expect(report).not.toBe(null);
    expect(report).toContain(SHORT_SHA);
    expect(report).toContain(OTHER_SHORT);
    expect(report).toContain(REPO_ROOT);
    expect(report).toContain("#266");
    // Named as an environment fault, so nobody spends ten minutes reading the
    // spec that "failed".
    expect(report).toMatch(/environment fault, not a test failure/);
  });

  it("treats `sha: null` as a mismatch, and says where it comes from", () => {
    // The commonest wrong-build attach in practice: a worktree on a branch that
    // predates this guard starts its server without BUILD_SHA, so /api/health
    // answers `sha: null`. Reading that as "unknown, carry on" would leave the
    // very case this exists for invisible.
    const report = buildMismatchReport(
      DEFAULT_SERVER,
      SHORT_SHA,
      REPO_ROOT,
      reading({ sha: null }),
    );
    expect(report).not.toBe(null);
    expect(report).toContain("`sha: null`");
    expect(report).toContain(SHORT_SHA);
    expect(report).toMatch(/predates this guard/);
  });

  it("treats a server that did not answer as a mismatch too", () => {
    const report = buildMismatchReport(
      DEFAULT_SERVER,
      SHORT_SHA,
      REPO_ROOT,
      reading({ sha: null, status: null, error: "ECONNREFUSED" }),
    );
    expect(report).not.toBe(null);
    expect(report).toContain("ECONNREFUSED");
  });

  it("still reports a mismatch when a matching sha arrives with an error", () => {
    // Belt and braces: an `error` set means the reading is not trustworthy,
    // whatever `sha` happens to hold beside it.
    expect(
      buildMismatchReport(
        DEFAULT_SERVER,
        SHORT_SHA,
        REPO_ROOT,
        reading({ error: "HTTP 503" }),
      ),
    ).not.toBe(null);
  });

  it("hands over a kill command for the port that is actually blocked", () => {
    // Two servers on two ports; a paste-block naming the wrong one is worse
    // than none, because it kills something unrelated and the run still fails.
    const member = buildMismatchReport(
      MEMBER_SERVER,
      SHORT_SHA,
      REPO_ROOT,
      reading({ sha: OTHER_SHORT }),
    );
    expect(member).toContain("tcp:3100");
    expect(member).not.toContain("tcp:3000");
    const base = buildMismatchReport(
      DEFAULT_SERVER,
      SHORT_SHA,
      REPO_ROOT,
      reading({ sha: OTHER_SHORT }),
    );
    expect(base).toContain("tcp:3000");
  });
});

// ── the wiring: a correct guard that nothing calls is not a guard ────────────

describe("config/playwright.config.ts wires the guard (#266)", () => {
  // Comments stripped first: this repo's config files carry dense prose, and a
  // paragraph naming `BUILD_SHA` would satisfy every assertion below while the
  // code did nothing. That failure has been paid for here before.
  const config = stripComments(
    readFileSync(join(REPO_ROOT, "config/playwright.config.ts"), "utf8"),
  );

  it("resolves the checkout's own commit", () => {
    expect(config).toMatch(/EXPECTED_BUILD_SHA/);
    expect(config).toMatch(/expectedBuildSha\(/);
  });

  it("hands that commit to the server as BUILD_SHA", () => {
    // Without this the server reports `sha: null` and the guard compares a
    // known commit against nothing — it would fire on every single run.
    expect(config).toMatch(/BUILD_SHA: EXPECTED_BUILD_SHA/);
  });

  it("stops reusing servers when the commit cannot be established", () => {
    // "The guard cannot run" must not read as "the guard passed". With no
    // identity for the checkout, reuse is switched off and Playwright's own
    // "port is already used" error becomes the failure — unmistakable, and
    // strictly better than an unverifiable attach.
    expect(config).toMatch(
      /const reuseExistingServer =[\s\S]{0,120}EXPECTED_BUILD_SHA !== null;/,
    );
    // BOTH servers, from the one gated value — the member project's specs would
    // otherwise be exempt from the whole check, and two copies of the condition
    // are two things that can drift apart.
    const uses = config.match(/^\s+reuseExistingServer,$/gm) ?? [];
    expect(uses).toHaveLength(2);
    // The ungated form this replaces must be gone, not merely joined.
    expect(config).not.toMatch(/reuseExistingServer:\s*!process\.env\.CI\b/);
  });
});

describe("e2e/global-setup.ts runs the guard (#266)", () => {
  const setup = stripComments(
    readFileSync(join(REPO_ROOT, "e2e/global-setup.ts"), "utf8"),
  );

  it("checks both servers before any spec runs", () => {
    expect(setup).toMatch(/assertServersAreThisBuild\(/);
    expect(setup).toMatch(/\bBASE_URL\b/);
    expect(setup).toMatch(/\bMEMBER_BASE_URL\b/);
  });

  it("checks them BEFORE it writes anything to the database", () => {
    // Ordering is load-bearing, not tidiness. A run that attached to the wrong
    // server must not first seed and re-assert fixture rows in the database
    // that server is talking to — the guard's whole claim is that a wrong-build
    // attach changes nothing and is distinguishable from a spec failure.
    const guardAt = setup.indexOf("assertServersAreThisBuild(");
    const firstWriteAt = setup.indexOf("upsert(");
    expect(guardAt).toBeGreaterThanOrEqual(0);
    expect(firstWriteAt).toBeGreaterThanOrEqual(0);
    expect(guardAt).toBeLessThan(firstWriteAt);
  });
});

describe("e2e/build-identity.ts (#266)", () => {
  const impl = readFileSync(join(REPO_ROOT, "e2e/build-identity.ts"), "utf8");
  const code = stripComments(impl);

  it("pins the repository git is asked about, with an isolated environment", () => {
    // #146: `cwd` alone pinned the wrong repository for months. `git -C <dir>`
    // says which repository, `isolatedGitEnv()` says no inherited variable gets
    // to override that. `git-env-hygiene` scans `e2e/` and enforces both — this
    // arm states the requirement where a reader of #266 will find it.
    expect(code).toMatch(/isolatedGitEnv\(\)/);
    expect(code).toMatch(/"-C",\s*repoRoot/);
  });

  it("throws rather than warning when a server is the wrong build", () => {
    // A warning scrolls past and the suite runs anyway, which is the status quo
    // this issue is about. globalSetup throwing aborts the run before any spec
    // reports a result.
    expect(code).toMatch(/throw new Error\(/);
  });

  it("says so out loud when it cannot identify the checkout", () => {
    expect(code).toMatch(/UNIDENTIFIED_CHECKOUT_NOTICE/);
    expect(UNIDENTIFIED_CHECKOUT_NOTICE).toMatch(/#266/);
    expect(UNIDENTIFIED_CHECKOUT_NOTICE).toMatch(/reuseExistingServer/);
  });
});
