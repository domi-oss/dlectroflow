import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AUTOMERGE_FAILURE_LOG_MESSAGES,
  IGNORED_FOR_VULNERABILITY_ALERTS,
  PROBLEM_LOG_LEVELS,
  branchCreationWindows,
  cronWindowsWithoutWildcardMinute,
  ignoredKeysUnderVulnerabilityAlerts,
  remappedLogLevelFor,
  unevaluatableMatchMessages,
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
