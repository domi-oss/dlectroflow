/**
 * Playwright project routing — coverage guard (#127), and the guard on what the
 * routing is FOR (#247).
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

// The neutral text helper #150 extracted for exactly this, rather than a second
// copy of it — see `commentOnlySpecifiers` for the one thing this module uses it
// for, and the one thing it deliberately does not.
import { stripComments } from "./source-text";

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

// ── #247: the assertion that escaped the split ───────────────────────────────
//
// Everything above answers "which project runs this FILE". #247 is that question
// one level in, and the level where it was actually wrong: an accessibility
// assertion is not a file, it is a CALL, and a call can be made from a spec the
// strict project does not run. Measured on the tree #247 was filed against:
//
//   * `e2e/smoke/schedule-menu.spec.ts` — `scanA11y` AND `scanColorContrast`, so
//     two, not the one the issue named. `chromium`.
//   * `e2e/smoke/people-admin.spec.ts` — `scanColorContrast`, three times.
//     `chromium`.
//   * `e2e/smoke/member-delete-account.spec.ts` — a hand-rolled `AxeBuilder`
//     that imports `@axe-core/playwright` directly and touches the helpers not at
//     all. `member`, so the exposure was never limited to one project either.
//
// **Six call sites, three files, both retrying projects.** So #127 bought zero
// tolerance for the files in `e2e/a11y/` and left all six running with a retry to
// spend. (Six CALL SITES; the test count is higher, because the contrast blocks
// are parameterised over both themes.)
//
// Not a theoretical hole. It masked #222's `document-title` race at the
// schedule-menu call site, so the race never surfaced from `chromium`; it then
// failed in the `a11y` project on `main`, `deploy_production` was SKIPPED rather
// than failed, and production sat a commit behind `main` until a third run went
// green. A retried a11y assertion is not a noisier signal, it is a failure class
// that stays invisible until it lands somewhere that gates.
//
// **The rule enforced here: a file that can reach `@axe-core/playwright` — through
// the a11y helpers or through a scan it builds itself — is run only by projects
// that declare `retries: 0`.** Keyed on the PACKAGE deliberately, and saying so
// here deliberately: the third file above escaped a helper-keyed rule, and "go
// through the helpers" is a convention, not a mechanism. A reader who takes the
// trigger to be `e2e/a11y/axe-helpers.ts` will write that sixth call site again.
//
// Chosen over the alternative #247 also
// lists — leave the call where it is and give its spec `retries: 0` via
// `test.describe.configure` — on two counts, both mechanical rather than
// aesthetic:
//
//   * `trace` is a `use` option, and `test.describe.configure` cannot set one.
//     The suite-wide `trace: "on-first-retry"` records NOTHING when there is no
//     first retry, so a describe-level `retries: 0` inside `chromium` would buy
//     zero tolerance at the price of arriving with no trace at all. That is the
//     exact trade the `a11y` project's `trace: "retain-on-failure"` override
//     exists to refuse — so the alternative reintroduces a defect #127 had
//     already fixed, one project over.
//   * Enforcing it would mean proving a given CALL sits inside a zero-retry
//     describe, which is scope analysis over an AST. Enforcing this rule means
//     comparing a file path against a routing table that already exists. A guard
//     nobody can implement correctly is a comment with extra steps.
//
// Keyed on the retry COUNT rather than on the name `a11y`, so renaming the gate
// project cannot quietly defeat it.

/**
 * Every relative import specifier in `source`, resolved against `file`'s own
 * directory, **without** extension resolution — see `filesReaching`, which does
 * that against the real file list rather than by guessing.
 *
 * Paths in, paths out, forward-slashed: the same shape the routing patterns
 * above match against, so the two halves of this module cannot disagree about
 * what a file is called.
 *
 * Bare-package specifiers (`@playwright/test`) are dropped rather than resolved,
 * and so is the `@/` alias — it maps to `src/` (see tsconfig's `paths`), and the
 * a11y helpers live under `e2e/`, so no aliased specifier can name them. A
 * relative path is the only route, which is what makes relative-only complete
 * here rather than merely convenient.
 */
export function relativeImportTargets(file: string, source: string): string[] {
  const lastSlash = file.lastIndexOf("/");
  // A bare filename has no directory to resolve against; `slice(0, -1)` would
  // silently lop off its last character and resolve every specifier one
  // directory too deep.
  const dir = lastSlash === -1 ? "." : file.slice(0, lastSlash);
  const targets = new Set<string>();
  for (const specifier of specifiersIn(source)) {
    // A relative specifier is the only kind that can name a repo file.
    if (!specifier.startsWith(".")) continue;
    targets.add(normalise(`${dir}/${specifier}`));
  }
  return [...targets];
}

/** Every quoted specifier in `text`, in source order, duplicates included. */
function specifiersIn(text: string): string[] {
  return [...text.matchAll(IMPORT_SPECIFIER)].map((match) => match[1]);
}

/**
 * The import forms that can pull one module into another.
 *
 * `from "…"` covers `import … from`, `import type … from` and `export … from`;
 * the other three arms cover a side-effect `import "…"`, a dynamic
 * `import("…")` and a `require("…")`. Missing a form here makes this guard
 * under-report, which is the dangerous direction — so it matches the specifier
 * position generously and lets `filesReaching` discard anything that is not a
 * real file.
 */
const IMPORT_SPECIFIER =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)["']([^"']+)["']/g;

/** `.` and `..` segments collapsed, leading slash preserved. */
function normalise(path: string): string {
  const rooted = path.startsWith("/");
  const out: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      out.pop();
      continue;
    }
    out.push(segment);
  }
  return (rooted ? "/" : "") + out.join("/");
}

/** True when `source` imports the bare package `pkg` (not a relative path). */
export function importsPackage(source: string, pkg: string): boolean {
  // Exact, or a subpath import of the same package (`@axe-core/playwright` has
  // none today, but `pkg/thing` must not be read as a different package).
  return specifiersIn(source).some(
    (specifier) => specifier === pkg || specifier.startsWith(`${pkg}/`),
  );
}

/**
 * Specifiers that appear ONLY in text `stripComments` removes — a comment
 * quoting an import rather than an import.
 *
 * ── Why this classifies and never decides (#150, raised on !323) ─────────────
 * Every regex scanner in this repo strips comments before it looks, because
 * prose describing a construct is indistinguishable from code using it once the
 * reader is a regex. This scanner did not, so a doc comment writing
 * `derived from "@axe-core/playwright"` with straight quotes became a phantom
 * edge. That much was real and is what this function is for.
 *
 * What it deliberately does NOT do is gate reachability on the stripped text.
 * `source-text.ts` states its own trade plainly: it is text-level, a `//` or
 * `/*` inside a string literal can still read as a comment opener, and it
 * therefore errs "towards seeing LESS". For `manifest-hygiene` and `env-drift`
 * that is the safe direction — a missed package name or env var costs nothing
 * until the construct reappears in plain code. **For this guard it is the
 * catastrophic direction**: seeing less means declaring a file that genuinely
 * reaches axe to be clean, while it retries a zero-tolerance WCAG assertion.
 * That is the exact defect #247 exists to remove, one layer up in the parser.
 *
 * Measured rather than argued, in the colocated test: `stripComments` turns a
 * REAL `import AxeBuilder from "@axe-core/playwright"` into no match at all when
 * a string containing `/*` precedes it, or when a regex literal containing
 * slashes sits on the same line. So reachability stays on the raw text, which
 * can only ever over-report, and this function exists to make the over-report
 * legible: the colocated test fails with "only a comment mentions it" instead of
 * leaving someone to reverse-engineer why prose tripped a routing guard.
 *
 * Comment-exclusive only. A specifier both imported and discussed is code.
 *
 * ── Why absence after stripping is not enough (raised on !323) ───────────────
 * The first version of this asked only "did `stripComments` remove it?", which is
 * the inverse of the bug above and just as wrong. Because the strip also removes
 * REAL code in the shapes the colocated hazard tests pin, a genuine axe import in
 * such a file was classified comment-only — and the invariant that reads this
 * would then tell someone whose import is perfectly correct to "put the path in
 * backticks". Reachability was never affected, so nothing could ship a masked
 * WCAG assertion; but a diagnostic that lies is worse than none, and being read
 * by a human is this function's only job.
 *
 * So a specifier must be PROVABLY not code, by two independent signals agreeing:
 * the lossy strip removed it, AND every one of its occurrences sits on a line
 * that OPENS a comment. A line whose first non-whitespace is `//`, `/*` or `*`
 * cannot also carry code, so no string or regex literal can be hiding on it —
 * which is exactly the ambiguity the strip alone cannot resolve. Anything less
 * certain abstains and says nothing.
 *
 * Abstaining costs only a less specific failure message. Accusing real code costs
 * a developer their afternoon, so the asymmetry decides the design.
 */
export function commentOnlySpecifiers(source: string): string[] {
  const inCode = new Set(specifiersIn(stripComments(source)));
  const candidates = new Set(
    specifiersIn(source).filter((specifier) => !inCode.has(specifier)),
  );
  if (candidates.size === 0) return [];

  const lines = source.split("\n");
  /** Offset of each line's first character, so a match index maps to its line. */
  const lineStarts: number[] = [];
  let offset = 0;
  for (const line of lines) {
    lineStarts.push(offset);
    offset += line.length + 1;
  }
  const lineAt = (index: number): string => {
    // Last line whose start is at or before `index`.
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (lineStarts[mid] <= index) lo = mid;
      else hi = mid - 1;
    }
    return lines[lo];
  };

  /** Every occurrence on a comment-opening line, for each candidate. */
  const proven = new Map<string, boolean>();
  for (const match of source.matchAll(IMPORT_SPECIFIER)) {
    const specifier = match[1];
    if (!candidates.has(specifier)) continue;
    // A match spanning a newline (`import x\n  from "./y"`) straddles lines that
    // may not agree, so it is never proof.
    const single = !match[0].includes("\n");
    const opensComment = single && OPENS_COMMENT.test(lineAt(match.index));
    proven.set(specifier, (proven.get(specifier) ?? true) && opensComment);
  }
  // `=== true` so a candidate with no recorded occurrence — which would make
  // "every occurrence is a comment" vacuously true — is excluded rather than
  // accused.
  return [...candidates].filter((specifier) => proven.get(specifier) === true);
}

/**
 * A line whose first non-whitespace begins a comment: `//`, `/*`, or the `*`
 * continuation of a JSDoc block, which is how this repo writes nearly all of its
 * prose. Such a line cannot also carry code.
 */
const OPENS_COMMENT = /^\s*(?:\/\/|\/\*|\*)/;

/**
 * Every file in `files` whose import graph reaches a file `isTarget` accepts —
 * itself included — directly or through any number of intermediate modules.
 *
 * **Transitive on purpose.** A one-hop check is what a `grep` for `scanA11y`
 * already gives, and it is defeated by the most natural refactor available: a
 * shared `e2e/` module that re-exports the helpers, imported by a smoke spec.
 * The guard would read clean while the assertion ran with a retry — the same
 * "nothing found because nothing was looked at" shape this file already exists
 * to prevent one level up.
 *
 * **A predicate rather than a path**, because keying on
 * `e2e/a11y/axe-helpers.ts` was not enough. `e2e/smoke/member-delete-account.spec.ts`
 * ran a zero-tolerance WCAG scan by importing `@axe-core/playwright` and building
 * an `AxeBuilder` itself, touching the helper module not at all — so a guard
 * pointed at the helpers reported that file clean while it retried an a11y
 * assertion in the `member` project. Pointing the predicate at the PACKAGE
 * subsumes the helpers (`axe-helpers.ts` imports it too) and catches the
 * hand-rolled scan as well.
 *
 * `readSource` is injected so the traversal can be exercised on synthetic input
 * (the house shape: no `fs` in this module). Cycle-safe — `e2e/helpers.ts` and a
 * spec importing each other must not hang the test suite.
 */
export function filesReaching(
  isTarget: (file: string, source: string) => boolean,
  files: readonly string[],
  readSource: (file: string) => string,
): string[] {
  const known = new Set(files);
  // TypeScript's extensionless specifiers, resolved against the files that
  // actually exist instead of by appending and hoping.
  const resolve = (base: string): string | undefined =>
    [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`].find((candidate) =>
      known.has(candidate),
    );

  /**
   * Each file read and parsed ONCE, however many traversals cross it.
   *
   * Raised by review on !323: the outer filter starts a fresh DFS per file, so
   * without this a module every spec imports — `e2e/helpers.ts` — was read off
   * disk and regex-scanned once per importing spec.
   *
   * Deliberately caching the EDGES and the predicate's answer, not per-file
   * REACHABILITY. Reachability is the tempting thing to memoise and the unsafe
   * one: a traversal cut short by the cycle guard has not proven the file cannot
   * reach the target, only that this walk stopped, so caching that `false` would
   * make the result depend on which entry point happened to run first. Parsing
   * is a pure function of the file's bytes and has no such hazard.
   */
  const parsed = new Map<string, { hit: boolean; imports: string[] }>();
  const parse = (file: string) => {
    let entry = parsed.get(file);
    if (entry === undefined) {
      const source = readSource(file);
      entry = {
        hit: isTarget(file, source),
        imports: relativeImportTargets(file, source),
      };
      parsed.set(file, entry);
    }
    return entry;
  };

  const reaches = (entry: string): boolean => {
    const seen = new Set<string>();
    const pending = [entry];
    while (pending.length > 0) {
      const file = pending.pop()!;
      if (seen.has(file)) continue;
      seen.add(file);
      const { hit, imports } = parse(file);
      if (hit) return true;
      for (const base of imports) {
        const dependency = resolve(base);
        if (dependency !== undefined) pending.push(dependency);
      }
    }
    return false;
  };

  return files.filter((file) => reaches(file)).sort();
}

/** A project that would run an a11y assertion, and the retry it would give it. */
export interface RetryingClaim {
  name: string;
  /** `undefined` = the project inherits the suite-wide default. */
  retries: number | undefined;
}

/** One file that can reach `@axe-core/playwright` from a project that retries. */
export interface RetryMaskedSpec {
  file: string;
  claims: RetryingClaim[];
}

/**
 * The files that would run an a11y assertion with a retry to spend.
 *
 * **Only an explicit `retries: 0` counts as strict.** A project that declares no
 * `retries` inherits the suite-wide value, which is `process.env.CI ? 1 : 0` —
 * so reading the inherited number would make this guard pass on a developer's
 * machine and fail in CI, for a tree that never changed. Treating "unset" as
 * retrying is both the CI-independent answer and the safe direction to be wrong
 * in: it over-reports a project that has genuinely opted out of retries, which
 * costs one explicit `retries: 0`, rather than under-reporting the exact defect
 * #247 is about.
 *
 * Files no project claims are not offences — a helper module is not a test. The
 * `unroutedSpecs` guard above is what catches a spec nobody runs.
 */
export function retryMaskedSpecs(
  reachers: readonly string[],
  routing: Routing,
  retriesByProject: ReadonlyMap<string, number | undefined>,
): RetryMaskedSpec[] {
  return reachers.flatMap((file) => {
    const claims = (routing.get(file) ?? [])
      .map((name) => ({ name, retries: retriesByProject.get(name) }))
      .filter((claim) => claim.retries !== 0);
    return claims.length > 0 ? [{ file, claims }] : [];
  });
}
