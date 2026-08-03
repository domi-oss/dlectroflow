/**
 * #161 — pure helpers for asserting that the deliberate `overrides` entries in
 * `package.json` still say what a security decision needs them to say, and that
 * `.gitlab/renovate.json` still guards each of them. Kept free of `fs` so the
 * parsing is unit-testable on synthetic manifests (lockfile-hygiene,
 * manifest-hygiene and env-drift follow the same split); the caller reads the
 * files.
 *
 * The npm `overrides` block is the one place in this repo where the SAME package
 * name carries two deliberately different constraints (#82):
 *
 *     "brace-expansion": "^5.0.8"                      <- production-reachable
 *     "minimatch@^3": { "brace-expansion": "^2.1.3" }  <- dev-only lint tooling
 *
 * Renovate extracts both as `depName: "brace-expansion"`, `depType: "overrides"`.
 * The nested one is distinguished ONLY by `managerData.parents` — there is no
 * path-qualified dep name — so no `matchPackageNames` rule can tell the two
 * apart, and the guard in renovate.json has to key on `matchCurrentValue`
 * instead. That makes the guard *silent* if an override's value ever drifts
 * outside the pattern its rule matches: the rule stops applying, nothing errors,
 * and the next Renovate run is free to propose the downgrade again. Catching
 * that drift is the whole reason `coveringRules` exists.
 */

/** An `overrides` block: a version range, or a nested selector object. */
export type OverrideBlock = { [key: string]: string | OverrideBlock };

export type OverrideScope = {
  /**
   * The `overrides` keys walked to reach this entry — `[]` for a top-level one,
   * `["minimatch@^3"]` for one nested under that selector. Mirrors the
   * `managerData.parents` array Renovate itself builds.
   */
  parents: string[];
  name: string;
  value: string;
};

/**
 * Every constraint in an `overrides` block, flattened. Deliberately mirrors
 * Renovate's own `extractOverrideDepsRec`, including its handling of npm's `"."`
 * key (which means "the selector's own package"): Renovate substitutes the raw
 * parent selector, so `{"minimatch@^3": {".": "3.1.5"}}` yields the name
 * `minimatch@^3`, selector suffix included. That is Renovate's behaviour rather
 * than npm's semantics, and it is reproduced here on purpose — this helper
 * exists to predict what Renovate will do, not to improve on it.
 */
export function overrideScopes(
  overrides: OverrideBlock,
  parents: string[] = [],
): OverrideScope[] {
  const scopes: OverrideScope[] = [];
  for (const [key, value] of Object.entries(overrides)) {
    if (typeof value === "string") {
      scopes.push({
        parents: [...parents],
        name: key === "." ? (parents.at(-1) ?? ".") : key,
        value,
      });
    } else {
      scopes.push(...overrideScopes(value, [...parents, key]));
    }
  }
  return scopes;
}

/** `[major, minor, patch]`, zero-filling omitted segments. */
export type VersionTriple = [number, number, number];

const LOWER_BOUND = /^\s*(?:[\^~]|>=?)?\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?\s*$/;
const UPPER_BOUND = /^\s*<=?\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?\s*$/;

function triple(match: RegExpExecArray): VersionTriple {
  return [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)];
}

/**
 * The lowest version a simple range admits: `^5.0.8` → `[5, 0, 8]`, `>=2` →
 * `[2, 0, 0]`. Returns `null` for anything that is not a single lower bound —
 * `*`, `<3`, `1 || 2`, `npm:alias@1`, a git URL.
 *
 * Deliberately NOT a semver range parser. It exists so a hygiene test can check
 * the *floor* of the handful of simple ranges this repo's overrides and version
 * caps actually use, and returning `null` rather than guessing means an
 * unrecognised shape fails the test loudly instead of passing vacuously.
 */
export function rangeFloor(range: string): VersionTriple | null {
  const match = LOWER_BOUND.exec(range);
  return match ? triple(match) : null;
}

/**
 * The exclusive-ish upper bound of a simple range: `<3` → `[3, 0, 0]`, `<6.1` →
 * `[6, 1, 0]`. `null` for anything that is not a single upper bound. `<=` is
 * accepted and treated as the same bound, which is conservative in the only
 * direction that matters here — a cap is being checked for being tight enough,
 * so rounding it *down* can never let a too-loose cap pass.
 */
export function rangeCeiling(range: string): VersionTriple | null {
  const match = UPPER_BOUND.exec(range);
  return match ? triple(match) : null;
}

/** Ordering on `[major, minor, patch]`, segment by segment. */
export function compareTriples(a: VersionTriple, b: VersionTriple): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/** The subset of a Renovate `packageRules` entry these helpers read. */
export type PackageRule = {
  matchPackageNames?: string[];
  matchCurrentValue?: string;
  matchDepTypes?: string[];
  allowedVersions?: string;
} & Record<string, unknown>;

const CONFIG_REGEX = /^!?\/(.*)\/(i?)$/;

/**
 * Whether Renovate's `matchCurrentValue` pattern would match `value`, for the
 * explicit `/regex/` form only (`!` prefix negates, trailing `i` folds case —
 * both as in Renovate's own `getRegexPredicate`).
 *
 * Renovate also accepts a bare glob, and that form is deliberately NOT
 * implemented: a glob's reach is easy to misjudge (`^5.*` happens to work only
 * because `^` is a literal to minimatch), and this predicate is the thing a test
 * uses to prove a security guard covers a given override. Anything it cannot
 * evaluate exactly must read as "not covered", so the config is pushed towards
 * the one form whose semantics are unambiguous.
 */
export function matchesCurrentValue(pattern: string, value: string): boolean {
  const parsed = CONFIG_REGEX.exec(pattern);
  if (!parsed) return false;
  let matched: boolean;
  try {
    matched = new RegExp(parsed[1], parsed[2] || undefined).test(value);
  } catch {
    return false;
  }
  return pattern.startsWith("!") ? !matched : matched;
}

/**
 * The rules that would constrain `scope`: those naming its package in
 * `matchPackageNames` whose `matchCurrentValue` matches the scope's current
 * value. A scope with no covering rule is one Renovate is free to move in any
 * direction it likes.
 */
export function coveringRules(
  rules: PackageRule[],
  scope: OverrideScope,
): PackageRule[] {
  return rules.filter(
    (rule) =>
      rule.matchPackageNames?.includes(scope.name) === true &&
      rule.matchCurrentValue !== undefined &&
      matchesCurrentValue(rule.matchCurrentValue, scope.value),
  );
}
