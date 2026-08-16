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
  readThreadedExpectation,
  buildMismatchReport,
  EXPECTED_BUILD_SHA_ENV,
  UNIDENTIFIED_CHECKOUT_NOTICE,
  LOST_EXPECTATION_ERROR,
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

describe("readThreadedExpectation", () => {
  // Duo review on !370, and the finding was right — worse than it read, in fact.
  // The commit was resolved TWICE, once in `config/playwright.config.ts` to
  // decide `reuseExistingServer` and again inside `globalSetup` to check the
  // servers, via two separate `git` shellouts. Two answers to one question:
  //
  //   * git succeeds at the config and transiently fails at the assertion →
  //     reuse was ENABLED and the guard then SKIPS itself with the
  //     "cannot identify the checkout" notice. An unverified attach, silently,
  //     which is the exact hole the guard exists to close;
  //   * git fails at the config and succeeds at the assertion → reuse was off,
  //     Playwright started its own server with no `BUILD_SHA`, and the guard
  //     fires on a run that was never in danger.
  //
  // Both need only a commit landing mid-run, which on a machine with ~30
  // worktrees is an ordinary Tuesday. So it is resolved once and threaded.

  it("reads a threaded commit back", () => {
    expect(
      readThreadedExpectation({ [EXPECTED_BUILD_SHA_ENV]: SHORT_SHA }),
    ).toEqual({ kind: "sha", sha: SHORT_SHA });
  });

  it("reads an empty value as 'the config could not identify the checkout'", () => {
    // The config writes the variable UNCONDITIONALLY, empty when it resolved
    // nothing, so that "no identity" is a value rather than an absence — the
    // whole point being that the two are then distinguishable.
    expect(readThreadedExpectation({ [EXPECTED_BUILD_SHA_ENV]: "" })).toEqual({
      kind: "unidentified",
    });
  });

  it("reads an ABSENT variable as lost, not as either of the other two", () => {
    // The dangerous third state, and the reason this is a three-way and not a
    // `?? null`. An absent variable means the value did not survive from the
    // config to here — a wiring change, or a future Playwright that runs
    // globalSetup out of process. Collapsing it into "unidentified" would skip
    // the guard; collapsing it into a re-resolution would reintroduce the two
    // answers this fix exists to remove.
    expect(readThreadedExpectation({})).toEqual({ kind: "lost" });
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

  it("names NO port rather than a wrong one when the URL will not parse", () => {
    // Duo review on !370. The fallback used to be a hardcoded `"3000"`, so a
    // malformed MEMBER url printed `lsof -ti tcp:3000 | xargs kill` — a command
    // that kills the wrong server, offered to someone already confused about
    // which server they are talking to. It is the precise inverse of the
    // property the test above this one asserts, sitting eight lines away from
    // it.
    //
    // `"unknown"` would be no better: `tcp:unknown` is a paste-able command
    // that cannot work, and this repo's failure messages are meant to be run.
    // So when the port is unknown the kill line is not offered at all.
    const report = buildMismatchReport(
      { label: "the member project's server", url: "http:// not a url" },
      SHORT_SHA,
      REPO_ROOT,
      reading({
        sha: null,
        status: null,
        error: "`http:// not a url` is not a URL",
      }),
    );
    expect(report).not.toBe(null);
    expect(report).not.toMatch(/tcp:/);
    expect(report).not.toMatch(/lsof/);
    // It still has to say what to do, and which server it is talking about.
    expect(report).toContain("the member project's server");
    expect(report).toMatch(/could not be parsed/);
    expect(report).toMatch(/CI=1/);
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

  it("threads the ONE resolution through to global setup", () => {
    // Written unconditionally — `?? ""` and not `if (sha)` — so that "the config
    // could not identify the checkout" arrives as a value rather than as an
    // absent variable, which is a different state with a different response.
    expect(config).toMatch(
      /process\.env\[EXPECTED_BUILD_SHA_ENV\]\s*=\s*EXPECTED_BUILD_SHA \?\? "";/,
    );
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

describe("assertServersAreThisBuild, driven for real (#266)", () => {
  // The `lost` state cannot be produced by a correctly wired run — the config
  // writes the variable unconditionally, which is the point of writing it
  // unconditionally. So it is produced HERE, by calling the real function with
  // the variable removed, rather than asserted from a regex over the source.
  // A source match proves the constant is mentioned; this proves the function
  // stops.
  it("throws, and probes NOTHING, when the threaded commit is absent", async () => {
    const { assertServersAreThisBuild } =
      await import("../../e2e/build-identity");
    const saved = process.env[EXPECTED_BUILD_SHA_ENV];
    // A fetch that fails the test if it is ever reached: a run that cannot say
    // which commit it wants must not go on to ask servers about it.
    const realFetch = globalThis.fetch;
    let probes = 0;
    globalThis.fetch = (async () => {
      probes += 1;
      throw new Error("probed despite having no expectation");
    }) as typeof fetch;
    try {
      delete process.env[EXPECTED_BUILD_SHA_ENV];
      await expect(
        assertServersAreThisBuild([DEFAULT_SERVER, MEMBER_SERVER], REPO_ROOT),
      ).rejects.toThrow(/E2E_EXPECTED_BUILD_SHA/);
      expect(probes).toBe(0);
    } finally {
      globalThis.fetch = realFetch;
      if (saved === undefined) delete process.env[EXPECTED_BUILD_SHA_ENV];
      else process.env[EXPECTED_BUILD_SHA_ENV] = saved;
    }
  });

  it("skips without throwing when the config reported no identity", async () => {
    // The other side of the same switch: an empty value is a real answer
    // ("this checkout has no commit"), reuse is already off, and the run
    // continues after saying so. If this threw, a checkout without git could
    // not run the suite at all.
    const { assertServersAreThisBuild } =
      await import("../../e2e/build-identity");
    const saved = process.env[EXPECTED_BUILD_SHA_ENV];
    const realFetch = globalThis.fetch;
    let probes = 0;
    globalThis.fetch = (async () => {
      probes += 1;
      throw new Error("probed despite having no expectation");
    }) as typeof fetch;
    try {
      process.env[EXPECTED_BUILD_SHA_ENV] = "";
      await expect(
        assertServersAreThisBuild([DEFAULT_SERVER], REPO_ROOT),
      ).resolves.toBeUndefined();
      expect(probes).toBe(0);
    } finally {
      globalThis.fetch = realFetch;
      if (saved === undefined) delete process.env[EXPECTED_BUILD_SHA_ENV];
      else process.env[EXPECTED_BUILD_SHA_ENV] = saved;
    }
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

  it("shells out to git exactly once per run, from one caller", () => {
    // The mechanical half of the Duo finding: `expectedBuildSha` is defined
    // here, called from the config and NOWHERE else. Counted rather than
    // eyeballed, because the regression is invisible — two calls that agree
    // look exactly like one call, right up until they do not.
    const configSource = stripComments(
      readFileSync(join(REPO_ROOT, "config/playwright.config.ts"), "utf8"),
    );
    const definitions = code.match(/export function expectedBuildSha\(/g) ?? [];
    const mentionsHere = code.match(/expectedBuildSha\(/g) ?? [];
    expect(definitions).toHaveLength(1);
    // Defined here, never called here — `assertServersAreThisBuild` reads the
    // threaded value instead.
    expect(mentionsHere).toHaveLength(definitions.length);
    expect(configSource.match(/expectedBuildSha\(/g) ?? []).toHaveLength(1);
    // And exactly one `git` invocation backs it.
    expect(code.match(/execFileSync\(/g) ?? []).toHaveLength(1);
  });

  it("refuses to guess when the threaded commit did not survive", () => {
    // "The value is missing" is a wiring failure, not a checkout without an
    // identity, and it must not take either of the other two paths: skipping
    // would leave an attach unverified, re-resolving would restore the two
    // answers this change removed.
    expect(code).toMatch(/LOST_EXPECTATION_ERROR/);
    expect(LOST_EXPECTATION_ERROR).toMatch(/#266/);
    expect(LOST_EXPECTATION_ERROR).toContain(EXPECTED_BUILD_SHA_ENV);
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
