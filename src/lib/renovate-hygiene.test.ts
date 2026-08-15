import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AUTOMERGE_FAILURE_LOG_MESSAGES,
  IGNORED_FOR_VULNERABILITY_ALERTS,
  PROBLEM_LOG_LEVELS,
  branchCreationWindows,
  cronWindowsWithoutWildcardMinute,
  effectiveAutomergeFor,
  ignoredKeysUnderVulnerabilityAlerts,
  packagesDeniedAutomerge,
  remappedLogLevelFor,
  unevaluatableMatchMessages,
  unreadableAutomergePackageNames,
  type RenovateConfigShape,
} from "./renovate-hygiene";

describe("ignoredKeysUnderVulnerabilityAlerts", () => {
  it("reports nothing for a block that only sets labels", () => {
    expect(
      ignoredKeysUnderVulnerabilityAlerts({
        labels: ["dependencies", "security"],
      }),
    ).toEqual([]);
  });

  it("reports nothing for an absent block", () => {
    expect(ignoredKeysUnderVulnerabilityAlerts(undefined)).toEqual([]);
  });

  // The exact key #243 proposed adding, and the reason this module exists.
  it("reports prConcurrentLimit", () => {
    expect(
      ignoredKeysUnderVulnerabilityAlerts({ prConcurrentLimit: 0 }),
    ).toEqual(["prConcurrentLimit"]);
  });

  it("reports a limit key even when its value would mean unlimited", () => {
    // `0` really does mean "no limit" for prConcurrentLimit — that is not the
    // problem. The problem is that the key is never consulted here at all, so
    // both `0` and `5` are equally inert and equally misleading to a reader.
    expect(
      ignoredKeysUnderVulnerabilityAlerts({ prConcurrentLimit: 5 }),
    ).toEqual(["prConcurrentLimit"]);
  });

  it("reports every documented key, in the documented order", () => {
    const block = Object.fromEntries(
      IGNORED_FOR_VULNERABILITY_ALERTS.map((key) => [key, 0]),
    );
    expect(ignoredKeysUnderVulnerabilityAlerts(block)).toEqual([
      ...IGNORED_FOR_VULNERABILITY_ALERTS,
    ]);
  });

  it("leaves keys Renovate does honour alone", () => {
    expect(
      ignoredKeysUnderVulnerabilityAlerts({
        labels: ["security"],
        automerge: true,
        vulnerabilityFixStrategy: "highest",
        enabled: true,
      }),
    ).toEqual([]);
  });

  // The `in` operator throws a TypeError on a primitive, and this reads a JSON
  // file nothing has shape-validated by the time it is called.
  it("reports nothing for a block that is not an object", () => {
    for (const block of ["a string", 7, null, ["x"], true]) {
      expect(
        ignoredKeysUnderVulnerabilityAlerts(
          block as unknown as Record<string, unknown>,
        ),
      ).toEqual([]);
    }
  });
});

/**
 * #243 regression guard, against the real config.
 *
 * The issue proposed `"vulnerabilityAlerts": { "prConcurrentLimit": 0 }` as a
 * one-line fix for "a security MR is queued behind routine digest bumps". That
 * property already holds unconditionally, so the key would have been a no-op that
 * reads like a control — and the next person to touch the concurrency cap would
 * have believed removing it reopened a risk that never existed.
 */
describe("renovate.json's vulnerabilityAlerts block (#243)", () => {
  const config = JSON.parse(
    readFileSync(join(process.cwd(), ".gitlab", "renovate.json"), "utf8"),
  ) as RenovateConfigShape;

  it("carries no key Renovate ignores for vulnerability-fix PRs", () => {
    expect(
      ignoredKeysUnderVulnerabilityAlerts(config.vulnerabilityAlerts),
      "Renovate always creates security PRs, even if the concurrent PR limit " +
        "is already reached — so a limit or schedule set here is never read. " +
        "Adding one back would restate a guarantee as if it were a setting " +
        "(#243).",
    ).toEqual([]);
  });
});

describe("branchCreationWindows", () => {
  it("reports no window for a config that does not set one", () => {
    expect(branchCreationWindows({})).toEqual([]);
  });

  it("reports no window for the explicit default", () => {
    // "at any time" is what Renovate defaults `schedule` to, so writing it out
    // is the same as leaving it off — unbounded either way.
    expect(branchCreationWindows({ schedule: ["at any time"] })).toEqual([]);
    expect(branchCreationWindows({ schedule: "at any time" })).toEqual([]);
  });

  it("reports a cron window", () => {
    expect(branchCreationWindows({ schedule: ["* 7-8 * * 1"] })).toEqual([
      "* 7-8 * * 1",
    ]);
  });

  it("accepts the string form Renovate also allows", () => {
    expect(branchCreationWindows({ schedule: "* 7-8 * * 1" })).toEqual([
      "* 7-8 * * 1",
    ]);
  });

  it("reports nothing for a schedule that is not a string or array", () => {
    for (const schedule of [7, null, true, { cron: "* 7-8 * * 1" }]) {
      expect(branchCreationWindows({ schedule })).toEqual([]);
    }
  });

  it("drops blank entries rather than counting them as a window", () => {
    expect(
      branchCreationWindows({ schedule: ["", "  ", "* 7-8 * * 1"] }),
    ).toEqual(["* 7-8 * * 1"]);
  });
});

describe("cronWindowsWithoutWildcardMinute", () => {
  // Renovate's `schedule` docs carry this as a hard note: "For Cron schedules,
  // you _must_ use the `*` wildcard for the minutes value, as Renovate doesn't
  // support minute granularity." A `0 7 * * 1` written here — the same string the
  // GitLab pipeline schedule uses, which is exactly how the mistake would be made
  // — would otherwise be found by the next Monday's run and nothing sooner.
  //
  // This one is NOT a check Renovate lacks, and saying otherwise would overstate
  // it: `renovate-config-validator --no-global --strict` rejects it outright with
  // "has cron syntax, but doesn't have * as minutes". It is the same check moved
  // into a suite that actually runs, because nothing in this repo's CI invokes
  // that validator. The remap assertion further down is the one the validator
  // genuinely cannot make.
  it("accepts a wildcard minute", () => {
    expect(cronWindowsWithoutWildcardMinute(["* 7-8 * * 1"])).toEqual([]);
  });

  it("reports a cron window with a numeric minute", () => {
    expect(cronWindowsWithoutWildcardMinute(["0 7 * * 1"])).toEqual([
      "0 7 * * 1",
    ]);
  });

  it("reports a step or list in the minute field too", () => {
    expect(
      cronWindowsWithoutWildcardMinute(["*/15 7 * * 1", "0,30 7 * * 1"]),
    ).toEqual(["*/15 7 * * 1", "0,30 7 * * 1"]);
  });

  it("leaves Later-syntax phrases alone", () => {
    // Deprecated but still accepted by Renovate, and it has no minute field to
    // check. Flagging it would make the guard wrong rather than strict.
    expect(
      cronWindowsWithoutWildcardMinute([
        "before 5:00am",
        "after 10pm every weekday",
      ]),
    ).toEqual([]);
  });

  it("tolerates surrounding and repeated whitespace", () => {
    expect(cronWindowsWithoutWildcardMinute(["  *   7-8 * * 1 "])).toEqual([]);
    expect(cronWindowsWithoutWildcardMinute(["  0   7-8 * * 1 "])).toEqual([
      "  0   7-8 * * 1 ",
    ]);
  });

  /**
   * Duo review. The first version required all five fields to be numeric, so a
   * window written with a NAME — `0 7 * * MON`, which cron and Renovate both
   * accept — failed the structural check and fell out of the guard silently. That
   * is the exact class this helper exists for, arriving through the one spelling it
   * could not see.
   */
  it("catches a bad minute in a window written with named day or month fields", () => {
    expect(cronWindowsWithoutWildcardMinute(["0 7 * * MON"])).toEqual([
      "0 7 * * MON",
    ]);
    expect(cronWindowsWithoutWildcardMinute(["0 7 1 JAN *"])).toEqual([
      "0 7 1 JAN *",
    ]);
  });

  it("still accepts a wildcard minute when the day is named", () => {
    expect(cronWindowsWithoutWildcardMinute(["* 7-8 * * MON"])).toEqual([]);
  });

  /**
   * Why letters are allowed in the month and day-of-week fields only, rather than
   * in all five: this Later-syntax phrase is exactly five whitespace-separated
   * tokens, so a single loosened pattern would read it as cron and flag it. Keeping
   * the minute numeric-only is both what cron says and what tells the two apart.
   */
  it("does not mistake a five-token Later phrase for cron", () => {
    expect(
      cronWindowsWithoutWildcardMinute(["after 10pm and before 5am"]),
    ).toEqual([]);
  });
});

describe("unevaluatableMatchMessages", () => {
  it("reports nothing for a regex-form pattern", () => {
    expect(
      unevaluatableMatchMessages([
        { matchMessage: "/^Automerge on PR creation failed/" },
      ]),
    ).toEqual([]);
  });

  it("reports a glob-form pattern, which Renovate accepts and this cannot read", () => {
    expect(
      unevaluatableMatchMessages([
        { matchMessage: "Automerge on PR creation failed*" },
      ]),
    ).toEqual(["Automerge on PR creation failed*"]);
  });

  it("reports a regex that does not compile", () => {
    expect(
      unevaluatableMatchMessages([{ matchMessage: "/([unclosed/" }]),
    ).toEqual(["/([unclosed/"]);
  });

  it("reports a missing or non-string matchMessage", () => {
    expect(
      unevaluatableMatchMessages([
        { newLogLevel: "warn" },
        { matchMessage: 7 },
      ]),
    ).toEqual(["", "7"]);
  });

  it("reports nothing for a remap that is not an array", () => {
    for (const remap of [undefined, null, "x", 7, { matchMessage: "/a/" }]) {
      expect(unevaluatableMatchMessages(remap)).toEqual([]);
    }
  });
});

describe("remappedLogLevelFor", () => {
  const remap = [
    { matchMessage: "/^Package lookup error/", newLogLevel: "info" },
    { matchMessage: "/^Automerge on PR creation failed/", newLogLevel: "warn" },
  ];

  it("returns the level of the matching entry", () => {
    expect(
      remappedLogLevelFor("Automerge on PR creation failed. Retrying 3", remap),
    ).toBe("warn");
  });

  it("returns null when nothing matches", () => {
    expect(remappedLogLevelFor("Branch created", remap)).toBeNull();
  });

  it("honours Renovate's first-match-wins order", () => {
    // getRemappedLevel returns on the first matching entry, so a broad entry
    // placed above a narrow one shadows it. A helper that reported the *best*
    // match would pass a config Renovate reads differently.
    expect(
      remappedLogLevelFor("Automerge on PR creation failed", [
        { matchMessage: "/^Automerge/", newLogLevel: "debug" },
        {
          matchMessage: "/^Automerge on PR creation failed/",
          newLogLevel: "warn",
        },
      ]),
    ).toBe("debug");
  });

  it("ignores entries it cannot evaluate instead of throwing", () => {
    expect(
      remappedLogLevelFor("Automerge on PR creation failed", [
        { matchMessage: "/([unclosed/", newLogLevel: "warn" },
        { matchMessage: "Automerge*", newLogLevel: "warn" },
      ]),
    ).toBeNull();
  });

  it("ignores an entry whose newLogLevel is not a level", () => {
    expect(
      remappedLogLevelFor("Automerge on PR creation failed", [
        { matchMessage: "/^Automerge/", newLogLevel: "loud" },
      ]),
    ).toBeNull();
  });

  it("returns null for a remap that is not an array", () => {
    for (const value of [undefined, null, "x", 7]) {
      expect(remappedLogLevelFor("anything", value)).toBeNull();
    }
  });

  /**
   * Duo review, and it was right to single this out: `!/…/` was implemented and
   * unproven, in the one branch whose own code comment calls it the worst possible
   * failure here. A negated entry EXCLUDES what it matches, so reading one as a
   * promotion would report the #243 fix as in place while the message it was
   * supposed to surface stayed at `debug` — the guard would be the thing lying.
   *
   * Both directions are asserted, because only asserting the positive one passes
   * just as happily if the negation is dropped entirely.
   */
  it("treats a leading ! as Renovate does — the match EXCLUDES", () => {
    const negated = [
      {
        matchMessage: "!/^Automerge on PR creation failed/",
        newLogLevel: "warn",
      },
    ];
    expect(
      remappedLogLevelFor("Branch created", negated),
      "a negated pattern matches everything it does NOT describe",
    ).toBe("warn");
    expect(
      remappedLogLevelFor(
        "Automerge on PR creation failed. Retrying 2",
        negated,
      ),
      "the one message this entry excludes must not come back promoted",
    ).toBeNull();
  });

  it("reads a negated pattern as an evaluatable form, not an unreadable one", () => {
    // `!/…/` is regex form, so it must not be reported as something this module
    // cannot parse — otherwise the real-config assertion would fail for the wrong
    // reason and the negation would never be looked at.
    expect(
      unevaluatableMatchMessages([
        { matchMessage: "!/^Automerge on PR creation failed/" },
      ]),
    ).toEqual([]);
  });

  it("honours the trailing i as case-insensitive", () => {
    // Same class of gap as the negation: `endsWith("i")` was implemented and
    // never exercised.
    expect(
      remappedLogLevelFor("automerge on pr creation failed", [
        {
          matchMessage: "/^Automerge on PR creation failed/i",
          newLogLevel: "warn",
        },
      ]),
    ).toBe("warn");
    expect(
      remappedLogLevelFor("automerge on pr creation failed", [
        {
          matchMessage: "/^Automerge on PR creation failed/",
          newLogLevel: "warn",
        },
      ]),
      "without the flag the same pattern must stay case-sensitive",
    ).toBeNull();
  });
});

/**
 * #243 — the two properties that make the lost-automerge failure recoverable and
 * visible. Both are assertions about `.gitlab/renovate.json` itself, because both
 * are load-bearing for something that lives outside the repo: the GitLab pipeline
 * schedules that run Renovate.
 */
describe("renovate.json's automerge recovery settings (#243)", () => {
  const config = JSON.parse(
    readFileSync(join(process.cwd(), ".gitlab", "renovate.json"), "utf8"),
  ) as RenovateConfigShape;

  it("bounds branch creation to a window", () => {
    // Renovate runs on more than one pipeline schedule here: one inside this
    // window, which opens update MRs, and several outside it whose only job is
    // to finish an automerge that was lost at MR creation. Drop the window and
    // every one of those runs starts opening MRs of its own.
    expect(
      branchCreationWindows(config),
      "`schedule` is what keeps the frequent automerge-recovery runs from " +
        "opening update MRs of their own (#243). Without it Renovate creates " +
        "branches on every run, up to prConcurrentLimit.",
    ).not.toEqual([]);
  });

  it("writes every cron window with a wildcard minute", () => {
    expect(
      cronWindowsWithoutWildcardMinute(branchCreationWindows(config)),
      "Renovate has no minute granularity and rejects a cron minute that is " +
        "not `*`. Nothing in CI runs renovate-config-validator, so this is the " +
        "only thing standing between a `0 7 * * 1` here and a silent week.",
    ).toEqual([]);
  });

  it("uses only matchMessage forms this module can evaluate", () => {
    // Renovate also accepts a minimatch glob, so this is stricter than Renovate
    // is — deliberately. The assertion below can only be trusted if every entry
    // in the file is one it actually read.
    expect(
      unevaluatableMatchMessages(config.logLevelRemap),
      "renovate-hygiene reads the `/…/` regex form only. An entry written as " +
        "a glob is valid to Renovate and invisible to this guard, which would " +
        "make the next assertion a claim about a file it did not parse.",
    ).toEqual([]);
  });

  it.each(AUTOMERGE_FAILURE_LOG_MESSAGES)(
    "promotes %j to a level Renovate collects as a repository problem",
    (message) => {
      expect(
        remappedLogLevelFor(message, config.logLevelRemap),
        "This is the message that made #243 invisible for a week: Renovate's " +
          "GitLab platform swallows every failed attempt to arm platform " +
          "automerge at `debug`, and the job runs at `info`. Renovate's " +
          "problems stream is registered at `warn`, and the Dependency " +
          "Dashboard reprints those under '## Repository Problems' — so `warn` " +
          "or above is what turns a lost automerge into something a human sees.",
      ).toBeOneOf([...PROBLEM_LOG_LEVELS]);
    },
  );
});

describe("effectiveAutomergeFor", () => {
  /** The shape this repo's file actually has: a blanket rule, then exceptions. */
  const BLANKET = {
    matchUpdateTypes: ["minor", "patch", "digest", "pin"],
    automerge: true,
  };
  /**
   * A synthetic package name, deliberately not a real dependency. The config has
   * no per-package deny entry today, and naming a real one here would read as
   * though it did.
   */
  const PKG = "denied-package";
  const DENY = { matchPackageNames: [PKG], automerge: false };

  it("reports nothing for a package no rule mentions and no blanket rule covers", () => {
    expect(effectiveAutomergeFor("left-pad", [DENY])).toBe(null);
  });

  it("reports nothing when there are no rules at all", () => {
    for (const rules of [undefined, [], null, 7, "rules", {}]) {
      expect(effectiveAutomergeFor(PKG, rules)).toBe(null);
    }
  });

  it("reads a blanket rule as applying to every package", () => {
    // No `matchPackageNames` means "everything", which is exactly why the
    // ordering below matters at all.
    expect(effectiveAutomergeFor(PKG, [BLANKET])).toBe(true);
  });

  // The two orderings that make this guard worth having. Renovate applies
  // packageRules in order and later rules override earlier ones, so the SAME two
  // rules mean opposite things depending on which way round they are written —
  // and `renovate-config-validator` accepts both. Measured: both forms return
  // `Config validated successfully`, exit 0, on the renovate 43 major CI pins.
  it("lets a later deny rule win over an earlier blanket automerge", () => {
    expect(effectiveAutomergeFor(PKG, [BLANKET, DENY])).toBe(false);
  });

  it("reports the blanket rule winning when the deny rule is put above it", () => {
    expect(effectiveAutomergeFor(PKG, [DENY, BLANKET])).toBe(true);
  });

  it("ignores a rule that names other packages", () => {
    expect(
      effectiveAutomergeFor(PKG, [
        BLANKET,
        DENY,
        { matchPackageNames: ["react", "react-dom"], automerge: true },
      ]),
    ).toBe(false);
  });

  it("skips rules that express no opinion on automerge", () => {
    // A grouping or allowedVersions rule matches the package without setting
    // `automerge`; it must not be read as re-enabling it.
    expect(
      effectiveAutomergeFor(PKG, [
        BLANKET,
        DENY,
        { matchPackageNames: [PKG], groupName: "a group" },
      ]),
    ).toBe(false);
  });

  it("ignores a non-boolean automerge value rather than coercing it", () => {
    // `"false"` is not `false`. Coercing would make a stringly-typed edit read as
    // the control being in place.
    expect(
      effectiveAutomergeFor(PKG, [
        BLANKET,
        { matchPackageNames: [PKG], automerge: "false" },
      ]),
    ).toBe(true);
  });

  it("tolerates malformed entries inside a real array", () => {
    expect(effectiveAutomergeFor(PKG, [null, "x", 7, BLANKET, DENY])).toBe(
      false,
    );
  });

  it("reports nothing for a matchPackageNames that is not an array of strings", () => {
    expect(
      effectiveAutomergeFor(PKG, [
        { matchPackageNames: PKG, automerge: false },
      ]),
    ).toBe(null);
  });

  it("matches a literal name case-insensitively, as Renovate's minimatch does", () => {
    // Renovate builds its `matchPackageNames` predicate with
    // `minimatch(pattern, { dot: true, nocase: true })`, so a literal entry is a
    // case-INSENSITIVE comparison, not `===`. npm names are lowercase by spec but
    // Go, Maven and NuGet names are not, so exact-case equality would read a
    // real deny entry as absent.
    expect(
      effectiveAutomergeFor("Masterminds/Semver", [
        BLANKET,
        { matchPackageNames: ["masterminds/semver"], automerge: false },
      ]),
    ).toBe(false);
  });

  // ── Pattern entries: `matchPackageNames` is NOT exact-match-only ────────────
  //
  // Renovate resolves it through `matchRegexOrGlobList`, which accepts a bare
  // `*`, a minimatch glob, a `/…/` or `!/…/` regex, and a leading `!` negation.
  // This module reads LITERAL names only, so a pattern entry that carries an
  // `automerge` boolean has to make the answer INDEFINITE rather than being
  // silently skipped — skipping it is a false pass in the dangerous direction.
  describe("a pattern entry that carries an automerge boolean", () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ["a prefix glob", "denied-*"],
      ["a scope glob", "*-package"],
      ["a bare wildcard", "*"],
      ["a regex form", "/^denied-/"],
      ["a case-insensitive regex form", "/^DENIED-/i"],
      ["a negated regex form", "!/^other-/"],
      ["a negated literal", "!other-package"],
      ["a brace expansion", "{denied,other}-package"],
      ["a character class", "denied-[pq]ackage"],
      ["an extglob", "+(denied)-package"],
      ["an empty string", ""],
    ];

    it.each(cases)(
      "gives no answer when %s could re-enable automerge below the deny entry",
      (_label, pattern) => {
        // The dangerous shape: a correctly-ordered literal deny entry, then a
        // pattern entry BELOW it that under real Renovate governs the same
        // package and turns automerge back on. Read as inapplicable, the
        // ordering invariant passes while the package merges unattended.
        expect(
          effectiveAutomergeFor(PKG, [
            BLANKET,
            DENY,
            { matchPackageNames: [pattern], automerge: true },
          ]),
        ).toBe(null);
      },
    );

    it.each(cases)(
      "gives no answer when %s is itself the deny entry",
      (_label, pattern) => {
        expect(
          effectiveAutomergeFor(PKG, [
            BLANKET,
            { matchPackageNames: [pattern], automerge: false },
          ]),
        ).toBe(null);
      },
    );

    it("gives no answer when a pattern sits alongside a literal in one entry", () => {
      expect(
        effectiveAutomergeFor(PKG, [
          BLANKET,
          { matchPackageNames: [PKG, "other-*"], automerge: false },
        ]),
      ).toBe(null);
    });

    it("gives no answer for a non-string element", () => {
      expect(
        effectiveAutomergeFor(PKG, [
          BLANKET,
          { matchPackageNames: [PKG, 7], automerge: false },
        ]),
      ).toBe(null);
    });

    it("still reads a pattern entry that expresses no automerge opinion", () => {
      // A grouping or allowedVersions rule contributes no `automerge` key, so
      // Renovate merging it cannot change the resolved value whether it matches
      // or not. Going indefinite here would red the suite for a harmless config
      // edit, so the scope limit is drawn at rules that can actually decide.
      expect(
        effectiveAutomergeFor(PKG, [
          BLANKET,
          DENY,
          { matchPackageNames: ["@types/*"], groupName: "types" },
        ]),
      ).toBe(false);
    });
  });
});

describe("unreadableAutomergePackageNames", () => {
  it("reports nothing for a config with no rules", () => {
    for (const rules of [undefined, [], null, 7, "rules", {}]) {
      expect(unreadableAutomergePackageNames(rules)).toEqual([]);
    }
  });

  it("reports nothing for the literal name shapes Renovate's datasources use", () => {
    expect(
      unreadableAutomergePackageNames([
        { matchPackageNames: ["node"], automerge: true },
        { matchPackageNames: ["@types/react-dom"], automerge: false },
        {
          matchPackageNames: ["github.com/Masterminds/semver"],
          automerge: false,
        },
        {
          matchPackageNames: ["org.apache.commons:commons-lang3"],
          automerge: false,
        },
        {
          matchPackageNames: ["registry.example.com/org/image"],
          automerge: false,
        },
        { matchPackageNames: ["Some.NuGet.Package"], automerge: false },
      ]),
    ).toEqual([]);
  });

  it("reports every pattern form Renovate accepts but this module cannot read", () => {
    expect(
      unreadableAutomergePackageNames([
        { matchPackageNames: ["denied-*"], automerge: false },
        { matchPackageNames: ["*"], automerge: true },
        { matchPackageNames: ["/^denied-/"], automerge: false },
        { matchPackageNames: ["!other"], automerge: false },
        { matchPackageNames: ["{a,b}"], automerge: false },
        { matchPackageNames: ["a[bc]"], automerge: false },
        { matchPackageNames: ["+(a)"], automerge: false },
        { matchPackageNames: ["a?"], automerge: false },
        { matchPackageNames: ["#a"], automerge: false },
      ]),
    ).toEqual([
      "denied-*",
      "*",
      "/^denied-/",
      "!other",
      "{a,b}",
      "a[bc]",
      "+(a)",
      "a?",
      "#a",
    ]);
  });

  it("reports a non-string element as its String() form, and an empty string as empty", () => {
    expect(
      unreadableAutomergePackageNames([
        { matchPackageNames: ["ok", 7, null, ""], automerge: false },
      ]),
    ).toEqual(["7", "null", ""]);
  });

  it("reports a pattern only once however many entries carry it", () => {
    expect(
      unreadableAutomergePackageNames([
        { matchPackageNames: ["a-*"], automerge: false },
        { matchPackageNames: ["a-*"], automerge: true },
      ]),
    ).toEqual(["a-*"]);
  });

  it("ignores a pattern on a rule that expresses no automerge opinion", () => {
    // Same scope limit as `effectiveAutomergeFor`: a rule with no `automerge`
    // boolean cannot change what the ordering invariant computes, so a glob
    // there is not a problem this guard has an opinion about.
    expect(
      unreadableAutomergePackageNames([
        { matchPackageNames: ["@types/*"], groupName: "types" },
        { matchPackageNames: ["eslint*"], allowedVersions: "<10" },
        { matchPackageNames: ["a-*"], automerge: "false" },
      ]),
    ).toEqual([]);
  });

  it("ignores a blanket automerge rule, which names no package at all", () => {
    expect(unreadableAutomergePackageNames([{ automerge: true }])).toEqual([]);
  });

  it("reports a matchPackageNames that is not an array at all", () => {
    // Renovate requires an array here, so a bare string is a config error — and
    // it is also the shape that made the old `ruleCouldApply` skip the rule
    // silently. Reported by its `String()` form, like `unevaluatableMatchMessages`
    // does, which for a bare string is indistinguishable from a literal name; the
    // fix is the brackets and the assertion message says so.
    expect(
      unreadableAutomergePackageNames([
        { matchPackageNames: "denied-package", automerge: false },
      ]),
    ).toEqual(["denied-package"]);
  });

  it("tolerates malformed entries inside a real array", () => {
    expect(
      unreadableAutomergePackageNames([
        null,
        "x",
        7,
        ["nested"],
        { matchPackageNames: ["a-*"], automerge: false },
      ]),
    ).toEqual(["a-*"]);
  });
});

describe("packagesDeniedAutomerge", () => {
  it("reports nothing for a config with no rules", () => {
    for (const rules of [undefined, [], null, 7, "rules", {}]) {
      expect(packagesDeniedAutomerge(rules)).toEqual([]);
    }
  });

  it("reports nothing when no rule turns automerge off", () => {
    expect(
      packagesDeniedAutomerge([
        { matchUpdateTypes: ["minor"], automerge: true },
        { matchPackageNames: ["react"], groupName: "react monorepo" },
        { matchPackageNames: ["typescript"], allowedVersions: "<6.1" },
      ]),
    ).toEqual([]);
  });

  it("reports every package a deny rule names", () => {
    expect(
      packagesDeniedAutomerge([
        { matchPackageNames: ["a", "b"], automerge: false },
        { matchPackageNames: ["c"], automerge: false },
      ]),
    ).toEqual(["a", "b", "c"]);
  });

  it("reports a package named by two deny rules only once", () => {
    expect(
      packagesDeniedAutomerge([
        { matchPackageNames: ["a"], automerge: false },
        { matchPackageNames: ["a"], automerge: false },
      ]),
    ).toEqual(["a"]);
  });

  it("ignores a blanket rule that denies automerge without naming a package", () => {
    // That is a different config — automerge off for everything — not a
    // per-package exception. Reporting `undefined` here would make the ordering
    // invariant assert something it cannot check.
    expect(packagesDeniedAutomerge([{ automerge: false }])).toEqual([]);
  });

  it("ignores a non-boolean automerge and a non-array matchPackageNames", () => {
    expect(
      packagesDeniedAutomerge([
        { matchPackageNames: ["a"], automerge: "false" },
        { matchPackageNames: "b", automerge: false },
      ]),
    ).toEqual([]);
  });

  it("tolerates malformed entries inside a real array", () => {
    expect(
      packagesDeniedAutomerge([
        null,
        "x",
        7,
        ["nested"],
        { matchPackageNames: ["a", 7, null], automerge: false },
      ]),
    ).toEqual(["a"]);
  });

  it("reports only literal names, never a pattern that is not one", () => {
    // A glob, a regex form and a negation are not package names, so feeding them
    // to `effectiveAutomergeFor` as if they were would test the wrong subject —
    // the pattern string, which under Renovate is not what the rule governs.
    // `unreadableAutomergePackageNames` is what reports these.
    expect(
      packagesDeniedAutomerge([
        {
          matchPackageNames: ["denied-*", "*", "/^x/", "!y", "{a,b}"],
          automerge: false,
        },
        { matchPackageNames: ["real-package"], automerge: false },
      ]),
    ).toEqual(["real-package"]);
  });
});

/**
 * The ordering invariant, against the real config.
 *
 * ⚠️ **The second arm below is VACUOUS today, and that is recorded rather than
 * hidden.** `.gitlab/renovate.json` currently has no per-package
 * `automerge: false` entry, so `packagesDeniedAutomerge` returns `[]` and the loop
 * asserts nothing. The synthetic `effectiveAutomergeFor` cases above are what carry
 * the ordering coverage — deliberately not counted here, because a count in a
 * comment goes stale the moment somebody adds a case and this file has no way to
 * notice. This arm exists so the check arms ITSELF the first time somebody adds a
 * deny entry, rather than being written after the incident by whoever got the
 * ordering wrong.
 *
 * The first arm is the one that is not vacuous, and it is here for exactly that
 * reason: a describe block whose only assertion ran zero times is the failure shape
 * this repo has recorded most often — a green that means nothing was looked at. It
 * reads the real file and requires a definite `true` out of it, so deleting
 * `packageRules`, emptying it, or dropping the blanket rule fails here.
 *
 * Both arms were verified red before this landed; the proof is in !359.
 */
describe("renovate.json's packageRules resolve as Renovate would merge them", () => {
  const config = JSON.parse(
    readFileSync(join(process.cwd(), ".gitlab", "renovate.json"), "utf8"),
  ) as RenovateConfigShape;

  /**
   * A name no rule in the file matches, so the only entry that can apply to it is
   * the blanket rule at the top of the list. Deliberately not a real package.
   */
  const NAMED_BY_NO_RULE = "renovate-hygiene-sentinel-not-a-dependency";

  it("computes a definite answer out of the real file", () => {
    // `true` here proves three things at once: the file parsed, `packageRules` is
    // a real array this helper could read, and the blanket automerge rule is
    // present and effective. That is also the baseline any future deny entry has
    // to override — which is what makes the arm below meaningful once it has
    // something to iterate.
    expect(
      packagesDeniedAutomerge(config.packageRules),
      "the sentinel must stay unnamed by any rule, or the assertion below stops " +
        "being about the blanket automerge rule",
    ).not.toContain(NAMED_BY_NO_RULE);
    expect(
      effectiveAutomergeFor(NAMED_BY_NO_RULE, config.packageRules),
      "the blanket automerge rule no longer resolves for a package nothing else " +
        "names. Either `packageRules` stopped parsing, or the blanket " +
        "`automerge: true` entry was removed or narrowed — in which case the " +
        "ordering invariant below has no baseline to override and this module's " +
        "fourth property needs rewriting, not relaxing.",
    ).toBe(true);
  });

  it("keeps every automerge rule's matchPackageNames to literal names", () => {
    // The scope limit made mechanical rather than documented. This module reads
    // literal names; Renovate also accepts `*`, minimatch globs, `/…/` regexes and
    // `!` negations through `matchRegexOrGlobList`. A pattern on a rule that sets
    // `automerge` changes which packages the ordering invariant below is actually
    // about, and reading it as inapplicable would let that invariant pass over a
    // config that automerges a denied package. Non-vacuous today: the file has ten
    // `matchPackageNames` entries and every one is a literal name, so this passes
    // by reading them, not by finding nothing to read.
    expect(
      unreadableAutomergePackageNames(config.packageRules),
      "a `matchPackageNames` on a rule that sets `automerge` is not a literal " +
        "package name. Renovate resolves that key through `matchRegexOrGlobList`, " +
        "which accepts a bare `*`, a minimatch glob, a `/…/` regex and a leading " +
        "`!`; this module reads literal names only, so it cannot tell which " +
        "packages such an entry governs and the ordering invariant below stops " +
        "meaning what it says. Write the name literally, or teach " +
        "`renovate-hygiene.ts` the pattern form — do not delete this assertion. " +
        "(A value that is not an array is reported here too; the fix for that is " +
        "the brackets.)",
    ).toEqual([]);
  });

  it("keeps every per-package deny entry below the blanket rule", () => {
    // Vacuous while the list is empty — see the docblock. It is written as a loop
    // rather than against a hardcoded package list so that adding a deny entry to
    // the config is all it takes to switch this on.
    for (const name of packagesDeniedAutomerge(config.packageRules)) {
      expect(
        effectiveAutomergeFor(name, config.packageRules),
        `${name} has an \`automerge: false\` entry that does not take effect. ` +
          `Renovate merges packageRules in file order and LATER entries win, so ` +
          `a deny entry has to sit BELOW the blanket automerge rule at the top ` +
          `of the list; above it, the entry is inert and the package keeps ` +
          `merging unattended. renovate-config-validator returns exit 0 on both ` +
          `orderings, so nothing else in the chain can tell you.`,
      ).toBe(false);
    }
  });
});
