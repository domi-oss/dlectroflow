/**
 * #67 — pure helpers for asserting invariants about `package-lock.json`. Kept
 * free of `fs` so the parsing logic is unit-testable on synthetic trees (the
 * env-drift module follows the same split); the caller reads the file.
 */

/**
 * The subset of an npm lockfile `packages` entry these helpers need. Real
 * entries carry many more fields (resolved, integrity, dev, optional, …), so
 * extra keys are allowed rather than modelled.
 */
export type LockPackages = Record<
  string,
  { version?: string } & Record<string, unknown>
>;

export type LockTreeEntry = { path: string; version: string | undefined };

/**
 * Every place `name` resolves in the lockfile tree: the hoisted
 * `node_modules/<name>` plus any nested `.../node_modules/<name>`. Matching is
 * on the final path segment, so `esbuild` never matches `esbuild-register`.
 */
export function lockTreeEntries(
  packages: LockPackages,
  name: string,
): LockTreeEntry[] {
  const suffix = `node_modules/${name}`;
  return Object.keys(packages)
    .filter((path) => path === suffix || path.endsWith(`/${suffix}`))
    .sort()
    .map((path) => ({ path, version: packages[path].version }));
}

/**
 * The distinct versions of `name` present anywhere in the tree, ordered by
 * numeric segment value — NOT lexicographically, which would put "0.10.0"
 * before "0.9.0" (Duo review, #67). Numeric collation also keeps prerelease
 * tags in a sensible, deterministic order ("1.0.0-beta.2" before
 * "1.0.0-beta.10"); a segment-subtraction comparator cannot, because
 * Number("0-beta") is NaN and every comparison then no-ops, silently leaving
 * such versions unsorted. This is deliberately not a full semver comparator —
 * it exists to report duplicate resolutions readably, not to do version
 * arithmetic — so it does not implement semver's prerelease-precedes-release
 * rule.
 */
export function distinctLockVersions(
  packages: LockPackages,
  name: string,
): string[] {
  const versions = lockTreeEntries(packages, name)
    .map((e) => e.version)
    .filter((v): v is string => v != null);
  return [...new Set(versions)].sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true }),
  );
}
