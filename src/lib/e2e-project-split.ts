/**
 * Playwright project routing — coverage guard (#127).
 *
 * The e2e suite is split into three projects because they are not held to the
 * same standard: `a11y` runs the axe gate with `retries: 0`, while `chromium`
 * and `member` keep `retries: 1` for infrastructure noise. That split is
 * expressed as regexes over file paths in `playwright.config.ts`, and regexes
 * over file paths fail quietly in both directions:
 *
 *   * **Too narrow** and specs stop running. A project that collects zero files
 *     does not error — it reports green, in a job whose whole purpose is to go
 *     red. This repo has been bitten repeatedly by a zero that meant "nobody
 *     looked" rather than "nothing wrong", and a silently-empty accessibility
 *     gate is the worst-placed instance of it available.
 *   * **Too wide** and non-spec files get collected. A project's `testMatch`
 *     REPLACES the suite-wide `testMatch: "**\/*.spec.ts"` rather than
 *     intersecting with it, so a pattern that forgets to spell out the
 *     extension pulls in helper modules. #127's first draft did exactly that
 *     with `e2e/a11y/axe-helpers.ts`, and Playwright refused to collect the
 *     suite at all ("test file … should not import test file …").
 *
 * A spec matched by two projects is the third failure: it runs twice, and the
 * copy in a retrying project defeats the point of the strict one.
 *
 * So this module re-derives the routing from plain data and the colocated test
 * asserts it against the committed `e2e/` tree. No `fs` here, deliberately (the
 * house shape for these guards): the routing logic is exercised on synthetic
 * input by the same test, so the parser can be shown to fail rather than only
 * shown to pass.
 */

/**
 * One Playwright project reduced to the only thing that decides file routing.
 *
 * `testMatch: null` means "inherits the suite-wide pattern", which is a
 * different state from an empty list and is exactly the distinction the
 * replaces-rather-than-intersects trap turns on.
 */
export interface ProjectRouting {
  name: string;
  testMatch: RegExp[] | null;
  testIgnore: RegExp[];
}

/**
 * The names of the projects that would run `file`.
 *
 * Mirrors Playwright's own resolution order: a project's `testMatch` (falling
 * back to the suite-wide predicate) decides inclusion, then `testIgnore`
 * subtracts from it.
 *
 * `isSuiteSpec` is injected rather than implemented here so this module needs
 * no glob dialect; the test passes the real suite-wide pattern's meaning and
 * separately asserts that pattern has not changed underneath it.
 */
export function claimingProjects(
  file: string,
  projects: readonly ProjectRouting[],
  isSuiteSpec: (file: string) => boolean,
): string[] {
  return projects
    .filter((project) => {
      const included = project.testMatch
        ? project.testMatch.some((pattern) => pattern.test(file))
        : isSuiteSpec(file);
      if (!included) return false;
      return !project.testIgnore.some((pattern) => pattern.test(file));
    })
    .map((project) => project.name);
}

/** How every candidate file routes, keyed by file. */
export type Routing = Map<string, string[]>;

export function routeFiles(
  files: readonly string[],
  projects: readonly ProjectRouting[],
  isSuiteSpec: (file: string) => boolean,
): Routing {
  return new Map(
    files.map((file) => [file, claimingProjects(file, projects, isSuiteSpec)]),
  );
}

/** Spec files no project would run. Each one is a test that silently vanished. */
export function unroutedSpecs(
  routing: Routing,
  isSuiteSpec: (f: string) => boolean,
): string[] {
  return [...routing]
    .filter(([file, names]) => isSuiteSpec(file) && names.length === 0)
    .map(([file]) => file);
}

/** Spec files more than one project would run. Each one runs twice. */
export function doubleRoutedSpecs(routing: Routing): string[] {
  return [...routing].filter(([, names]) => names.length > 1).map(([f]) => f);
}

/** Non-spec files a project would try to run — the `axe-helpers.ts` trap. */
export function routedNonSpecs(
  routing: Routing,
  isSuiteSpec: (f: string) => boolean,
): string[] {
  return [...routing]
    .filter(([file, names]) => !isSuiteSpec(file) && names.length > 0)
    .map(([file]) => file);
}

/** The files a single project would run. */
export function filesFor(routing: Routing, project: string): string[] {
  return [...routing]
    .filter(([, names]) => names.includes(project))
    .map(([file]) => file)
    .sort();
}
