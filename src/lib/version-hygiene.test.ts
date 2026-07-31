import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  chartScalar,
  compareReleaseVersions,
  firstOutOfOrderPair,
  isReleaseVersion,
  latestReleasedChangelogVersion,
  packageJsonVersion,
  releasedChangelogVersions,
  versionDisagreement,
} from "./version-hygiene";

describe("isReleaseVersion", () => {
  it("accepts MAJOR.MINOR.PATCH", () => {
    expect(isReleaseVersion("0.4.0")).toBe(true);
    expect(isReleaseVersion("10.20.30")).toBe(true);
  });

  // The `v` belongs to the git tag, not to any of the three files. Accepting it
  // here would let `package.json: "v0.4.0"` — which npm rejects — read as
  // agreeing with a chart that says `0.4.0`.
  it("rejects a leading v, a two-segment version and a prerelease", () => {
    expect(isReleaseVersion("v0.4.0")).toBe(false);
    expect(isReleaseVersion("0.4")).toBe(false);
    expect(isReleaseVersion("0.4.0-rc.1")).toBe(false);
    expect(isReleaseVersion("")).toBe(false);
  });
});

describe("packageJsonVersion", () => {
  it("reads the version field", () => {
    expect(packageJsonVersion('{"name":"x","version":"0.4.0"}')).toBe("0.4.0");
  });

  it("returns null when the manifest has no version", () => {
    expect(packageJsonVersion('{"name":"x"}')).toBeNull();
  });

  // A non-string `version` would otherwise reach the comparison as a number and
  // compare unequal to every string, producing a mismatch report that blames
  // the wrong file. Report it as unreadable instead.
  it("returns null when version is not a string", () => {
    expect(packageJsonVersion('{"version":0.4}')).toBeNull();
  });

  it("returns null on malformed JSON rather than throwing", () => {
    expect(packageJsonVersion("{not json")).toBeNull();
    expect(packageJsonVersion("null")).toBeNull();
  });
});

describe("chartScalar", () => {
  const CHART = `apiVersion: v2
name: dlectroflow
type: application
version: 0.4.0
appVersion: "0.4.0"
kubeVersion: ">=1.26.0-0"
maintainers:
  - name: dlectronique
    version: 9.9.9
`;

  it("reads a bare top-level scalar", () => {
    expect(chartScalar(CHART, "version")).toBe("0.4.0");
  });

  it("strips the quotes Helm's scaffold puts around appVersion", () => {
    expect(chartScalar(CHART, "appVersion")).toBe("0.4.0");
    expect(chartScalar(`appVersion: '0.4.0'\n`, "appVersion")).toBe("0.4.0");
  });

  // `^version:` must not be satisfied by `apiVersion: v2` — reading the Helm
  // schema version as the chart version would make the guard compare `v2` to a
  // semver forever.
  it("does not match a key that merely ends with the name asked for", () => {
    expect(chartScalar("apiVersion: v2\n", "version")).toBeNull();
  });

  // Chart.yaml nests a `version` under `dependencies:` when the chart has
  // subcharts, and under `maintainers:` nothing stops someone adding one.
  it("ignores an indented key of the same name", () => {
    expect(chartScalar(CHART, "version")).not.toBe("9.9.9");
    expect(chartScalar("  version: 9.9.9\n", "version")).toBeNull();
  });

  it("ignores a commented-out key", () => {
    expect(chartScalar("# version: 9.9.9\nversion: 0.4.0\n", "version")).toBe(
      "0.4.0",
    );
  });

  // YAML starts a comment at `#` only when it opens the line or follows
  // whitespace, so `0.4.0#1` is the scalar `0.4.0#1` and must not be truncated
  // to something that happens to look like a valid version.
  it("strips a trailing comment but not a bare # inside the value", () => {
    expect(
      chartScalar("version: 0.4.0  # the chart's own semver\n", "version"),
    ).toBe("0.4.0");
    expect(chartScalar("version: 0.4.0#1\n", "version")).toBe("0.4.0#1");
  });

  it("returns null for an absent key and for a key with no value", () => {
    expect(chartScalar(CHART, "icon")).toBeNull();
    expect(chartScalar("version:\n", "version")).toBeNull();
    expect(chartScalar("version:  # TODO\n", "version")).toBeNull();
  });
});

describe("releasedChangelogVersions", () => {
  const CHANGELOG = `# Changelog

## [Unreleased]

### Added

- Something, see #131 and ## [9.9.9] inside prose.

## [0.4.0] - 2026-07-27

### Fixed

- A thing.

## [0.3.0] - 2026-07-26

## [0.0.1] - 2026-07-08

[unreleased]: https://example.invalid/compare/v0.4.0...HEAD
[0.4.0]: https://example.invalid/releases/v0.4.0
`;

  it("lists released versions in document order, newest first", () => {
    expect(releasedChangelogVersions(CHANGELOG)).toEqual([
      "0.4.0",
      "0.3.0",
      "0.0.1",
    ]);
  });

  it("skips the Unreleased heading", () => {
    expect(releasedChangelogVersions(CHANGELOG)).not.toContain("Unreleased");
  });

  // The link-reference definitions at the foot of the file are `[0.4.0]: …`,
  // not `## [0.4.0]`, and a version named in prose is not a heading either.
  it("ignores link definitions, subheadings and versions named in prose", () => {
    expect(releasedChangelogVersions(CHANGELOG)).not.toContain("9.9.9");
    expect(releasedChangelogVersions("### [0.9.0] - 2026-01-01\n")).toEqual([]);
  });

  it("takes the first released heading as the newest", () => {
    expect(latestReleasedChangelogVersion(CHANGELOG)).toBe("0.4.0");
  });

  it("returns null when nothing has been released yet", () => {
    expect(latestReleasedChangelogVersion("## [Unreleased]\n")).toBeNull();
  });

  // Fail closed: a malformed heading is invisible to the matcher, so the guard
  // falls back to the previous release and reports a disagreement, rather than
  // accepting `## [0.5]` as the current version.
  it("does not match a heading that is not MAJOR.MINOR.PATCH", () => {
    expect(
      latestReleasedChangelogVersion("## [0.5] - 2026-08-01\n"),
    ).toBeNull();
  });
});

describe("compareReleaseVersions", () => {
  it("orders by numeric segment value, not by digit", () => {
    expect(compareReleaseVersions("0.10.0", "0.9.0")).toBeGreaterThan(0);
    expect(compareReleaseVersions("0.9.0", "0.10.0")).toBeLessThan(0);
  });

  it("compares major before minor before patch", () => {
    expect(compareReleaseVersions("1.0.0", "0.99.99")).toBeGreaterThan(0);
    expect(compareReleaseVersions("0.4.1", "0.4.0")).toBeGreaterThan(0);
    expect(compareReleaseVersions("0.4.0", "0.4.0")).toBe(0);
  });

  // #67's lesson, applied here: a segment-subtraction comparator handed
  // "0-beta" computes NaN, every comparison no-ops, and the ordering check it
  // feeds passes on input it never ordered. `null` is distinguishable from `0`,
  // so the caller cannot mistake "incomparable" for "equal".
  it("returns null rather than NaN for anything that is not a release version", () => {
    expect(compareReleaseVersions("1.0.0-beta.2", "1.0.0")).toBeNull();
    expect(compareReleaseVersions("0.4", "0.4.0")).toBeNull();
    expect(compareReleaseVersions("v0.4.0", "0.4.0")).toBeNull();
    expect(compareReleaseVersions("0.4.0", "")).toBeNull();
  });
});

describe("firstOutOfOrderPair", () => {
  it("returns null for a strictly descending list", () => {
    expect(firstOutOfOrderPair(["0.4.0", "0.3.0", "0.0.1"])).toBeNull();
  });

  it("names the first pair that is not strictly descending", () => {
    expect(firstOutOfOrderPair(["0.3.0", "0.4.0", "0.0.1"])).toEqual([
      "0.3.0",
      "0.4.0",
    ]);
  });

  it("treats a repeated version as out of order", () => {
    expect(firstOutOfOrderPair(["0.4.0", "0.4.0"])).toEqual(["0.4.0", "0.4.0"]);
  });

  it("accepts a list too short to be out of order", () => {
    expect(firstOutOfOrderPair([])).toBeNull();
    expect(firstOutOfOrderPair(["0.4.0"])).toBeNull();
  });

  // Fails closed: an incomparable pair is reported rather than skipped, so a
  // malformed version cannot make the whole ordering check silently no-op.
  it("reports a pair it cannot compare as out of order", () => {
    expect(firstOutOfOrderPair(["0.4.0", "0.3"])).toEqual(["0.4.0", "0.3"]);
    expect(firstOutOfOrderPair(["nope", "0.3.0"])).toEqual(["nope", "0.3.0"]);
  });
});

describe("versionDisagreement", () => {
  it("returns null when every source agrees", () => {
    expect(
      versionDisagreement([
        { source: "package.json", version: "0.4.0" },
        { source: "Chart.yaml appVersion", version: "0.4.0" },
        { source: "CHANGELOG.md", version: "0.4.0" },
      ]),
    ).toBeNull();
  });

  it("names every source and its value when they disagree", () => {
    const report = versionDisagreement([
      { source: "package.json", version: "0.3.0" },
      { source: "Chart.yaml appVersion", version: "1.0.0" },
      { source: "CHANGELOG.md", version: "0.4.0" },
    ]);
    expect(report).toContain("package.json = 0.3.0");
    expect(report).toContain("Chart.yaml appVersion = 1.0.0");
    expect(report).toContain("CHANGELOG.md = 0.4.0");
  });

  it("reports a source it could not read at all", () => {
    const report = versionDisagreement([
      { source: "package.json", version: "0.4.0" },
      { source: "Chart.yaml appVersion", version: null },
    ]);
    expect(report).toContain("Chart.yaml appVersion");
    expect(report).toContain("(missing)");
  });

  it("reports a value that is not a release version even if all sources match", () => {
    const report = versionDisagreement([
      { source: "package.json", version: "v0.4.0" },
      { source: "Chart.yaml appVersion", version: "v0.4.0" },
    ]);
    expect(report).toContain("package.json = v0.4.0");
  });

  // A guard that passes when handed nothing is a guard that stops guarding —
  // the same failure mode `lateRecursiveChowns` returns `null` to avoid (#71).
  it("refuses an empty list rather than vacuously agreeing", () => {
    expect(versionDisagreement([])).not.toBeNull();
  });
});

/**
 * #148 — the invariant itself, over the real files.
 *
 * If this fails, the repo drifted: a release was cut without bringing every
 * source with it. Fix the files, do not relax the test — the whole point is
 * that the four numbers below are one number.
 *
 * **One limitation, stated rather than left to be discovered.** `CHANGELOG.md`
 * is documentation to `.code_changes` (#53), so an MR touching *only* it takes
 * the docs-only fast path and never runs `test_app` — meaning a lone commit that
 * renamed `## [Unreleased]` to `## [0.5.0]` would not be gated here. Root
 * `*.json` and everything under `charts/` are both code paths, so the cut
 * described in `CLAUDE.md`
 * ("CI & release" → "Cutting a release") *is* gated: it does the heading and
 * both bumps in one commit, which runs the full pipeline. A CHANGELOG-only cut
 * would slip past until the next code change to `main`, which is the reason the
 * ritual says one commit.
 */
describe("release version hygiene (#148)", () => {
  const read = (...parts: string[]) =>
    readFileSync(join(process.cwd(), ...parts), "utf8");

  const packageJson = read("package.json");
  const chart = read("charts", "dlectroflow", "Chart.yaml");
  const changelog = read("CHANGELOG.md");

  it("package.json, Chart.yaml and CHANGELOG.md all claim the same version", () => {
    expect(
      versionDisagreement([
        {
          source: "package.json version",
          version: packageJsonVersion(packageJson),
        },
        {
          source: "Chart.yaml appVersion",
          version: chartScalar(chart, "appVersion"),
        },
        // The chart's own semver is in the set because this repo decided the
        // chart tracks the app rather than moving independently, and wrote that
        // decision into Chart.yaml. Helm allows them to differ; an undocumented
        // difference is what #148 was.
        {
          source: "Chart.yaml version",
          version: chartScalar(chart, "version"),
        },
        {
          source: "CHANGELOG.md newest released heading",
          version: latestReleasedChangelogVersion(changelog),
        },
      ]),
    ).toBeNull();
  });

  // `latestReleasedChangelogVersion` trusts document order, which is only a
  // safe reading while the file really is maintained newest-first.
  it("CHANGELOG.md release headings are strictly newest-first", () => {
    expect(
      firstOutOfOrderPair(releasedChangelogVersions(changelog)),
    ).toBeNull();
  });
});
