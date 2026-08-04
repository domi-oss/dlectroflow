import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  overrideScopes,
  rangeFloor,
  rangeCeiling,
  compareTriples,
  matchesCurrentValue,
  isVettedPattern,
  coveringRules,
  type OverrideBlock,
  type PackageRule,
  type VersionTriple,
} from "./override-hygiene";

const REAL_SHAPE: OverrideBlock = {
  postcss: "^8.5.16",
  sharp: "^0.35.3",
  "brace-expansion": "^5.0.8",
  "minimatch@^3": { "brace-expansion": "^2.1.3" },
};

describe("overrideScopes", () => {
  it("reports top-level entries with no parents", () => {
    expect(overrideScopes({ postcss: "^8.5.16" })).toEqual([
      { parents: [], name: "postcss", value: "^8.5.16" },
    ]);
  });

  it("distinguishes the two brace-expansion scopes by their parents", () => {
    expect(
      overrideScopes(REAL_SHAPE).filter((s) => s.name === "brace-expansion"),
    ).toEqual([
      { parents: [], name: "brace-expansion", value: "^5.0.8" },
      {
        parents: ["minimatch@^3"],
        name: "brace-expansion",
        value: "^2.1.3",
      },
    ]);
  });

  // A sibling selector must not inherit the previous one's parents. Renovate's
  // own recursion mutates a shared array and pops once per call, so this is the
  // case worth pinning rather than assuming.
  it("does not leak parents between sibling selectors", () => {
    expect(
      overrideScopes({
        "minimatch@^3": { "brace-expansion": "^2.1.3" },
        "glob@^7": { "brace-expansion": "^1.1.11" },
        top: "^1.0.0",
      }),
    ).toEqual([
      { parents: ["minimatch@^3"], name: "brace-expansion", value: "^2.1.3" },
      { parents: ["glob@^7"], name: "brace-expansion", value: "^1.1.11" },
      { parents: [], name: "top", value: "^1.0.0" },
    ]);
  });

  it("resolves npm's '.' key to the parent selector, as Renovate does", () => {
    expect(overrideScopes({ "minimatch@^3": { ".": "3.1.5" } })).toEqual([
      { parents: ["minimatch@^3"], name: "minimatch@^3", value: "3.1.5" },
    ]);
  });

  it("walks selectors nested more than one level deep", () => {
    expect(overrideScopes({ a: { b: { c: "1.0.0" } } })).toEqual([
      { parents: ["a", "b"], name: "c", value: "1.0.0" },
    ]);
  });
});

describe("rangeFloor", () => {
  it.each([
    ["^5.0.8", [5, 0, 8]],
    ["~2.1.3", [2, 1, 3]],
    [">=5.0.8", [5, 0, 8]],
    [">4", [4, 0, 0]],
    ["8.5.16", [8, 5, 16]],
    ["v1.2.3", [1, 2, 3]],
    ["^0.35.3", [0, 35, 3]],
    ["  ^5.0.8  ", [5, 0, 8]],
  ])("reads the floor of %s", (range, expected) => {
    expect(rangeFloor(range)).toEqual(expected);
  });

  // Returning null (not a guess) is what makes an unrecognised shape fail the
  // repo assertions below rather than pass them vacuously.
  it.each(["<3", "*", "", "1 || 2", "npm:other@^1.0.0", "git+https://x/y#v1"])(
    "returns null for %s, which is not a single lower bound",
    (range) => {
      expect(rangeFloor(range)).toBeNull();
    },
  );
});

describe("rangeCeiling", () => {
  it.each([
    ["<3", [3, 0, 0]],
    ["<6.1", [6, 1, 0]],
    ["<10", [10, 0, 0]],
    ["<=2.1.3", [2, 1, 3]],
  ])("reads the ceiling of %s", (range, expected) => {
    expect(rangeCeiling(range)).toEqual(expected);
  });

  it.each([">=5.0.8", "^5.0.8", "*", ""])(
    "returns null for %s, which is not a single upper bound",
    (range) => {
      expect(rangeCeiling(range)).toBeNull();
    },
  );
});

describe("compareTriples", () => {
  it("orders by major, then minor, then patch", () => {
    expect(compareTriples([5, 0, 8], [2, 1, 4])).toBeGreaterThan(0);
    expect(compareTriples([2, 1, 4], [2, 1, 10])).toBeLessThan(0);
    expect(compareTriples([5, 0, 8], [5, 0, 8])).toBe(0);
  });

  // Lexical comparison would put 10 before 9; the caps here are compared as
  // numbers precisely so a future major-10 cap does not silently invert.
  it("compares segments numerically, not as digits", () => {
    expect(compareTriples([0, 10, 0], [0, 9, 0])).toBeGreaterThan(0);
  });
});

describe("matchesCurrentValue", () => {
  it("matches the explicit regex form", () => {
    expect(matchesCurrentValue("/^\\^?5\\./", "^5.0.8")).toBe(true);
    expect(matchesCurrentValue("/^\\^?5\\./", "^2.1.3")).toBe(false);
  });

  it("refuses a pattern that is not in the vetted set", () => {
    // Previously this asserted the `i` flag by compiling `/^V1/i` on the fly.
    // Patterns are no longer compiled from config text (ReDoS sink, and a
    // pattern nobody has read should not silently be interpreted), so a
    // well-formed but unlisted pattern now reads as "not covered" — the same
    // direction the glob form is refused in.
    expect(matchesCurrentValue("/^V1/i", "v1.2.3")).toBe(false);
    expect(matchesCurrentValue("/^\\^?9\\./", "^9.0.0")).toBe(false);
  });

  it("negates a leading '!'", () => {
    expect(matchesCurrentValue("!/^\\^?5\\./", "^2.1.3")).toBe(true);
    expect(matchesCurrentValue("!/^\\^?5\\./", "^5.0.8")).toBe(false);
  });

  // Renovate would treat these as globs. Reporting "no match" is deliberate —
  // see the module header: a guard this predicate cannot evaluate exactly must
  // read as absent, so the config is pushed to the unambiguous form.
  it.each(["^5.*", "5*", ""])(
    "does not evaluate the glob form %s",
    (pattern) => {
      expect(matchesCurrentValue(pattern, "^5.0.8")).toBe(false);
    },
  );

  it("does not throw on an unparseable regex", () => {
    expect(matchesCurrentValue("/[/", "^5.0.8")).toBe(false);
  });

  it("vets every matchCurrentValue the real config uses", () => {
    // The invariant that makes the fixed set safe rather than merely quieter:
    // a pattern added to renovate.json but not vetted here would make its scope
    // read as UNCOVERED, and the guard it was written for would stop applying
    // with nothing to say so. This fails instead.
    const config = JSON.parse(
      readFileSync(join(process.cwd(), ".gitlab/renovate.json"), "utf8"),
    ) as { packageRules?: { matchCurrentValue?: string }[] };
    const used = (config.packageRules ?? [])
      .map((r) => r.matchCurrentValue)
      .filter((v): v is string => typeof v === "string");
    expect(used.length).toBeGreaterThan(0);
    for (const pattern of used) {
      expect(matchesCurrentValue(pattern, "^0.0.0-nothing-matches-this")).toBe(
        false,
      );
      // Not "does it match this value" but "is it evaluated at all": an
      // unvetted pattern and a vetted non-matching one both return false, so
      // assert vetting directly.
      expect(isVettedPattern(pattern)).toBe(true);
    }
  });
});

describe("coveringRules", () => {
  const rules: PackageRule[] = [
    {
      matchPackageNames: ["brace-expansion"],
      matchCurrentValue: "/^\\^?5\\./",
      allowedVersions: ">=5.0.8",
    },
    {
      matchPackageNames: ["brace-expansion"],
      matchCurrentValue: "/^\\^?2\\./",
      allowedVersions: "<3",
    },
    { matchPackageNames: ["eslint"], allowedVersions: "<10" },
  ];

  it("ignores a rule whose matchDepTypes excludes overrides", () => {
    // Renovate extracts these deps with depType "overrides". A rule that matches
    // the name and the value but restricts itself to another depType would not be
    // applied to the override, so reporting it as covering would leave the scope
    // silently unguarded — the exact failure this module exists to prevent.
    const wrongDepType: PackageRule[] = [
      {
        matchPackageNames: ["brace-expansion"],
        matchCurrentValue: "/^\\^?5\\./",
        matchDepTypes: ["dependencies"],
        allowedVersions: ">=5.0.8",
      },
    ];
    expect(
      coveringRules(wrongDepType, {
        parents: [],
        name: "brace-expansion",
        value: "^5.0.8",
      }),
    ).toEqual([]);
  });

  it("accepts a rule that names overrides explicitly, as renovate.json does", () => {
    const explicit: PackageRule[] = [
      {
        matchPackageNames: ["brace-expansion"],
        matchCurrentValue: "/^\\^?5\\./",
        matchDepTypes: ["overrides"],
        allowedVersions: ">=5.0.8",
      },
    ];
    expect(
      coveringRules(explicit, {
        parents: [],
        name: "brace-expansion",
        value: "^5.0.8",
      }),
    ).toHaveLength(1);
  });

  it("picks the rule whose current-value pattern matches the scope", () => {
    expect(
      coveringRules(rules, {
        parents: [],
        name: "brace-expansion",
        value: "^5.0.8",
      }),
    ).toEqual([rules[0]]);
    expect(
      coveringRules(rules, {
        parents: ["minimatch@^3"],
        name: "brace-expansion",
        value: "^2.1.3",
      }),
    ).toEqual([rules[1]]);
  });

  it("reports nothing for a scope whose value no pattern matches", () => {
    expect(
      coveringRules(rules, {
        parents: [],
        name: "brace-expansion",
        value: "^4.0.1",
      }),
    ).toEqual([]);
  });

  it("ignores rules that carry no matchCurrentValue", () => {
    expect(
      coveringRules(rules, { parents: [], name: "eslint", value: "^9.0.0" }),
    ).toEqual([]);
  });
});

/**
 * #161 regression guard, and the reason this module exists.
 *
 * `!245` was a Renovate MR titled "update dependency brace-expansion to v2.1.4"
 * that rewrote the TOP-LEVEL override from `^5.0.8` to `^2.1.3` — back inside the
 * affected range of CVE-2026-14257 / GHSA-mh99-v99m-4gvg. It was classified as a
 * `patch`, which this repo automerges, and only an unresolved review discussion
 * stopped it. The scanners were not a backstop: the head pipeline's security
 * summary was identical to main's.
 *
 * The cause is that Renovate resolves the top-level override's `lockedVersion`
 * from the hoisted `node_modules/brace-expansion`, which the NESTED
 * `minimatch@^3` override pins to 2.1.3 — the patched 5.0.8 copy lives nested
 * under `@ts-morph/common`. So Renovate reads the top-level entry as "currently
 * 2.1.3", offers 2.1.3 -> 2.1.4 as a patch, and writes the range it derived from
 * that reading over the deliberate `^5.0.8`. Nothing about the mechanism is
 * one-off: it recurs on every 2.x release, and the MR is recreated even if closed.
 *
 * `.gitlab/renovate.json` fixes the cause by capping each scope inside its own
 * major. This test guards the two ways that fix can rot:
 *   1. an override value drifting so its `matchCurrentValue` rule stops matching,
 *      which removes the guard silently; and
 *   2. either constraint being loosened past the thing it protects.
 *
 * If it fails, the config and the manifest have stopped agreeing. Realign them
 * rather than deleting this test — and see #82 for why the two scopes cannot
 * share one constraint.
 */
describe("npm overrides hygiene (#161)", () => {
  const root = process.cwd();
  const manifest = JSON.parse(
    readFileSync(join(root, "package.json"), "utf8"),
  ) as { overrides?: OverrideBlock };
  const renovate = JSON.parse(
    readFileSync(join(root, ".gitlab", "renovate.json"), "utf8"),
  ) as { packageRules?: PackageRule[] };

  const scopes = overrideScopes(manifest.overrides ?? {});
  const rules = renovate.packageRules ?? [];
  const braceScopes = scopes.filter((s) => s.name === "brace-expansion");

  /** The floor of a range, asserted to be readable rather than assumed. */
  function floorOf(range: string): VersionTriple {
    const floor = rangeFloor(range);
    expect(floor, `unrecognised lower bound: ${range}`).not.toBeNull();
    return floor!;
  }

  it("parses both files and finds override scopes at all", () => {
    expect(scopes.length).toBeGreaterThan(0);
    expect(rules.length).toBeGreaterThan(0);
  });

  it("declares exactly the two deliberate brace-expansion scopes (#82)", () => {
    expect(braceScopes.map((s) => s.parents)).toEqual([[], ["minimatch@^3"]]);
  });

  it("keeps the production-reachable override on patched 5.0.8 or later", () => {
    const top = braceScopes.find((s) => s.parents.length === 0)!;
    expect(
      compareTriples(floorOf(top.value), [5, 0, 8]),
    ).toBeGreaterThanOrEqual(0);
  });

  // 5.x's CommonJS build exports only `{ expand }`, so forcing it here raises
  // `TypeError: expand is not a function` inside @eslint/config-array and ESLint
  // exits 2 having linted 0 FILES — which a bare "did lint pass" check reads as
  // success. Hence a real assertion rather than a comment (#82).
  it("keeps the dev-only lint-tooling override below 3", () => {
    const nested = braceScopes.find((s) => s.parents.length > 0)!;
    const floor = floorOf(nested.value);
    expect(compareTriples(floor, [2, 1, 3])).toBeGreaterThanOrEqual(0);
    expect(floor[0]).toBeLessThan(3);
  });

  it("guards every brace-expansion scope with a renovate rule", () => {
    for (const scope of braceScopes) {
      const covering = coveringRules(rules, scope);
      expect(
        covering,
        `no renovate.json rule matches brace-expansion "${scope.value}" ` +
          `(parents: ${JSON.stringify(scope.parents)}), so Renovate may move it freely`,
      ).not.toHaveLength(0);
      for (const rule of covering) {
        expect(
          rule.allowedVersions,
          "covering rule sets no allowedVersions",
        ).toBeDefined();
      }
    }
  });

  it("points each scope's guard in the direction that scope needs", () => {
    const top = braceScopes.find((s) => s.parents.length === 0)!;
    for (const rule of coveringRules(rules, top)) {
      // A floor at or above 5.0.8 is what excludes the 2.x downgrade.
      expect(
        compareTriples(floorOf(rule.allowedVersions!), [5, 0, 8]),
      ).toBeGreaterThanOrEqual(0);
    }

    const nested = braceScopes.find((s) => s.parents.length > 0)!;
    for (const rule of coveringRules(rules, nested)) {
      const ceiling = rangeCeiling(rule.allowedVersions!);
      expect(
        ceiling,
        `the nested guard must be an upper bound, got: ${rule.allowedVersions}`,
      ).not.toBeNull();
      expect(compareTriples(ceiling!, [3, 0, 0])).toBeLessThanOrEqual(0);
    }
  });

  // postcss is a top-level override of the same *shape* as brace-expansion but
  // with a single scope and no nested twin, so it is not at risk and must stay
  // freely updatable. Requiring every cap to name its packages explicitly is the
  // general form of that: a bare `allowedVersions` with no matchPackageNames
  // would apply to the whole repo and silently freeze unrelated dependencies.
  it("scopes every version cap to named packages, and never to postcss", () => {
    for (const rule of rules.filter((r) => r.allowedVersions !== undefined)) {
      expect(
        rule.matchPackageNames,
        `allowedVersions "${rule.allowedVersions}" names no packages`,
      ).toBeDefined();
      expect(rule.matchPackageNames).not.toContain("postcss");
    }
  });
});
