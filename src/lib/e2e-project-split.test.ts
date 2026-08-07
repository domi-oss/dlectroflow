import { describe, it, expect } from "vitest";
import { readdirSync } from "node:fs";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  claimingProjects,
  routeFiles,
  unroutedSpecs,
  doubleRoutedSpecs,
  routedNonSpecs,
  filesFor,
  type ProjectRouting,
} from "./e2e-project-split";

/**
 * #127 — the routing guard's own tests.
 *
 * Two halves, deliberately. The first exercises the pure functions on synthetic
 * input, so the parser can be shown to FAIL rather than only shown to pass — a
 * guard whose logic is only ever run against the real repo cannot be trusted to
 * fire when the repo is wrong. The second reads the committed `e2e/` tree and
 * the real `config/playwright.config.ts` and asserts the invariants hold today.
 */

/** The suite-wide `testMatch: "**\/*.spec.ts"`, expressed as a predicate. */
const isSuiteSpec = (file: string) => file.endsWith(".spec.ts");

describe("claimingProjects — synthetic", () => {
  const A11Y = /[\\/]e2e[\\/]a11y[-\\/].*\.spec\.ts$/;
  const MEMBER = /member-[\w-]+\.spec\.ts/;
  const projects: ProjectRouting[] = [
    { name: "a11y", testMatch: [A11Y], testIgnore: [] },
    { name: "chromium", testMatch: null, testIgnore: [MEMBER, A11Y] },
    { name: "member", testMatch: [MEMBER], testIgnore: [] },
  ];

  it("routes a nested a11y spec to the a11y project only", () => {
    expect(
      claimingProjects(
        "/repo/e2e/a11y/axe-core-flow.spec.ts",
        projects,
        isSuiteSpec,
      ),
    ).toEqual(["a11y"]);
  });

  it("routes the hyphenated top-level a11y spec to a11y too", () => {
    // `e2e/a11y-contrast.spec.ts` is not under `e2e/a11y/`; the `[-\\/]` in the
    // pattern is what catches both spellings, and it would be easy to lose.
    expect(
      claimingProjects(
        "/repo/e2e/a11y-contrast.spec.ts",
        projects,
        isSuiteSpec,
      ),
    ).toEqual(["a11y"]);
  });

  it("does NOT route a helper module that merely sits in the a11y directory", () => {
    // The trap this whole guard exists for: a project's testMatch REPLACES the
    // suite-wide pattern, so a pattern missing the extension collects helpers.
    expect(
      claimingProjects("/repo/e2e/a11y/axe-helpers.ts", projects, isSuiteSpec),
    ).toEqual([]);
  });

  it("gives a plain smoke spec to chromium alone", () => {
    expect(
      claimingProjects(
        "/repo/e2e/smoke/library.spec.ts",
        projects,
        isSuiteSpec,
      ),
    ).toEqual(["chromium"]);
  });

  it("gives a member spec to member alone, because chromium ignores it", () => {
    expect(
      claimingProjects(
        "/repo/e2e/smoke/member-google.spec.ts",
        projects,
        isSuiteSpec,
      ),
    ).toEqual(["member"]);
  });

  it("reports a spec no project claims", () => {
    const orphan: ProjectRouting[] = [
      { name: "a11y", testMatch: [A11Y], testIgnore: [] },
    ];
    const routing = routeFiles(
      ["/repo/e2e/smoke/library.spec.ts"],
      orphan,
      isSuiteSpec,
    );
    expect(unroutedSpecs(routing, isSuiteSpec)).toEqual([
      "/repo/e2e/smoke/library.spec.ts",
    ]);
  });

  it("reports a spec two projects claim", () => {
    const overlapping: ProjectRouting[] = [
      { name: "a11y", testMatch: [A11Y], testIgnore: [] },
      // chromium without its A11Y testIgnore — the regression this catches.
      { name: "chromium", testMatch: null, testIgnore: [MEMBER] },
    ];
    const routing = routeFiles(
      ["/repo/e2e/a11y/axe-core-flow.spec.ts"],
      overlapping,
      isSuiteSpec,
    );
    expect(doubleRoutedSpecs(routing)).toEqual([
      "/repo/e2e/a11y/axe-core-flow.spec.ts",
    ]);
  });

  it("reports a non-spec a project would try to run", () => {
    const tooWide: ProjectRouting[] = [
      { name: "a11y", testMatch: [/[\\/]e2e[\\/]a11y[-\\/]/], testIgnore: [] },
    ];
    const routing = routeFiles(
      ["/repo/e2e/a11y/axe-helpers.ts"],
      tooWide,
      isSuiteSpec,
    );
    expect(routedNonSpecs(routing, isSuiteSpec)).toEqual([
      "/repo/e2e/a11y/axe-helpers.ts",
    ]);
  });
});

// ── The real tree ────────────────────────────────────────────────────────────

// `fileURLToPath`, not `.pathname`. A `file://` URL's pathname is
// percent-encoded and, on Windows, carries a leading slash before the drive
// letter — so a checkout under a directory containing a space would hand
// `readdirSync` a path with `%20` in it and `walk()` would find no `e2e/` at
// all. Raised in review on !277.
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return entry.name.endsWith(".ts") ? [full] : [];
  });
}

/**
 * Absolute and forward-slashed — the shape Playwright itself matches against.
 *
 * Repo-relative paths look tidier and are WRONG here: every project pattern
 * opens with `[\\/]e2e[\\/]`, so a path beginning `e2e/` has no separator to
 * match and silently routes nowhere. Getting this wrong makes the guard report
 * an empty a11y project — the exact false alarm it exists to raise.
 */
function e2eFiles(): string[] {
  return walk(join(REPO_ROOT, "e2e"))
    .map((f) => f.split(sep).join("/"))
    .sort();
}

/**
 * A project's `testMatch`/`testIgnore` normalised to an array of RegExp.
 *
 * **Throws rather than filtering.** Playwright's types allow a plain string
 * glob, and this used to drop one silently — which would normalise the project
 * to `testMatch: []`, and `claimingProjects` reads that as "matches nothing"
 * rather than "matches via glob". The guard would then confidently report a
 * routing model that has nothing to do with what Playwright actually does, and
 * report it as a pass. Raised in review on !277.
 *
 * A loud failure is the only safe behaviour here: this whole file exists to
 * catch the routing quietly drifting, so it cannot itself contain a quiet
 * drift. If a string pattern is ever genuinely wanted, teach this function to
 * translate globs — do not soften it back into a filter.
 */
function patterns(value: unknown): RegExp[] {
  if (value == null) return [];
  const list = Array.isArray(value) ? value : [value];
  return list.map((p) => {
    if (!(p instanceof RegExp)) {
      throw new Error(
        `e2e-project-split guard cannot model a non-RegExp pattern: ${JSON.stringify(p)}. ` +
          `Playwright allows string globs, but this harness only understands RegExp, so ` +
          `silently skipping it would make every routing assertion below measure the wrong thing.`,
      );
    }
    return p;
  });
}

/** A project exactly as the config declares it, before routing normalisation. */
type RawProject = {
  name: string;
  testMatch?: unknown;
  testIgnore?: unknown;
  retries?: number;
  dependencies?: string[];
};

/**
 * The ONE place that knows how to load `playwright.config.ts`.
 *
 * It returns the raw project list alongside the normalised routing, because
 * there were briefly two copies of this dynamic import — the second added only
 * to read `retries` off a project — and two loaders that can drift is exactly
 * the class of gap this file exists to close. Raised in review on !277.
 */
async function realProjects(): Promise<{
  projects: ProjectRouting[];
  raw: RawProject[];
  suiteTestMatch: unknown;
}> {
  const url = new URL("../../config/playwright.config.ts", import.meta.url)
    .href;
  const mod = (await import(/* @vite-ignore */ url)) as {
    default: { testMatch?: unknown; projects?: RawProject[] };
  };
  const cfg = mod.default;
  const raw = cfg.projects ?? [];
  return {
    suiteTestMatch: cfg.testMatch,
    raw,
    projects: raw.map((p) => ({
      name: p.name,
      testMatch: p.testMatch == null ? null : patterns(p.testMatch),
      testIgnore: patterns(p.testIgnore),
    })),
  };
}

// `patterns()` is the bridge between the real config and this file's model of
// it, so a value it cannot represent has to stop the run rather than be skipped.
// Raised in review on !277.
describe("patterns() refuses what it cannot model", () => {
  it("throws on a string glob instead of dropping it", () => {
    expect(() => patterns("**/*.spec.ts")).toThrow(/non-RegExp pattern/);
  });

  it("throws when a string hides among RegExps in an array", () => {
    expect(() => patterns([/a/, "**/b.spec.ts"])).toThrow(/non-RegExp pattern/);
  });

  it("still passes RegExps through, singly and in arrays", () => {
    expect(patterns(/a/)).toEqual([/a/]);
    expect(patterns([/a/, /b/])).toEqual([/a/, /b/]);
    expect(patterns(null)).toEqual([]);
    expect(patterns(undefined)).toEqual([]);
  });
});

describe("the committed e2e tree routes cleanly (#127)", () => {
  it("the suite-wide testMatch still means '*.spec.ts'", async () => {
    // `isSuiteSpec` above encodes this. If the config's glob changes, every
    // assertion below is quietly measuring the wrong thing, so pin it.
    const { suiteTestMatch } = await realProjects();
    expect(suiteTestMatch).toBe("**/*.spec.ts");
  });

  it("every spec is claimed by exactly one project", async () => {
    const { projects } = await realProjects();
    const routing = routeFiles(e2eFiles(), projects, isSuiteSpec);
    expect(unroutedSpecs(routing, isSuiteSpec)).toEqual([]);
    expect(doubleRoutedSpecs(routing)).toEqual([]);
  });

  it("no project would try to run a non-spec module", async () => {
    const { projects } = await realProjects();
    const routing = routeFiles(e2eFiles(), projects, isSuiteSpec);
    expect(routedNonSpecs(routing, isSuiteSpec)).toEqual([]);
  });

  it("the a11y gate is not empty, and holds every a11y spec in the tree", async () => {
    // The failure this exists for: a pattern narrowed by accident collects zero
    // files, and a project that runs no tests reports GREEN. On the gate whose
    // entire purpose is to go red, that is the worst place in the repo for it.
    const { projects } = await realProjects();
    const files = e2eFiles();
    const routed = filesFor(routeFiles(files, projects, isSuiteSpec), "a11y");
    const expected = files.filter(
      (f) => isSuiteSpec(f) && /[\\/]e2e[\\/]a11y[-\\/]/.test(f),
    );
    expect(expected.length).toBeGreaterThan(0);
    expect(routed).toEqual(expected);
  });

  it("the a11y project is the one configured with no retries", async () => {
    // The whole point of #127. If someone renames the project or moves the
    // setting, the split above would still pass while buying nothing.
    const { raw } = await realProjects();
    const a11y = raw.find((p) => p.name === "a11y");
    expect(a11y, "no project named a11y — did it get renamed?").toBeDefined();
    expect(a11y?.retries).toBe(0);
  });

  // The a11y specs seed and delete rows in the shared owner workspace, so
  // running them after the smoke suite would change the database state the
  // smoke specs scan against. The config used to secure that by being declared
  // first and relying on "with `workers: 1`, Playwright runs projects in
  // declaration order" — an observed implementation detail, not a contract, and
  // nothing checked it. Reordering the array would have reintroduced the hazard
  // in silence. Raised in review on !277.
  //
  // Two assertions on purpose. `dependencies` is the one the RUNNER enforces;
  // the array position is a second line of defence for the day someone removes
  // the dependencies without understanding why they were there.
  it("makes every other project wait for the a11y gate", async () => {
    const { raw } = await realProjects();
    const others = raw.filter((p) => p.name !== "a11y");

    expect(others.length).toBeGreaterThan(0);
    for (const p of others) {
      // `?? []` so a project with no `dependencies` at all fails on the
      // assertion's own message rather than on chai complaining about
      // `undefined` — the message IS the finding here.
      expect(
        p.dependencies ?? [],
        `project "${p.name}" does not wait for a11y, so it can observe workspace rows the a11y specs are still mutating`,
      ).toContain("a11y");
    }
  });

  it("keeps a11y first in the projects array", async () => {
    const { raw } = await realProjects();
    expect(
      raw[0]?.name,
      "a11y is no longer declared first — the dependencies above should still hold the ordering, but this pairing is deliberate; read the comment in config/playwright.config.ts before changing it",
    ).toBe("a11y");
  });
});
