/**
 * #148 — pure helpers pinning the project's version sources to one number.
 *
 * Three files claim a version, and until this module existed nothing checked
 * that they agreed: `package.json`, `charts/dlectroflow/Chart.yaml` and the
 * newest released heading in `CHANGELOG.md`. At the v0.4.0 cut they diverged.
 * The tag moved and `package.json` did not — `git show v0.4.0:package.json`
 * still reads `0.3.0` — so the image published as `:v0.4.0` was built from a
 * tree that calls itself 0.3.0, and anything reading the package version for
 * diagnostics reports a version superseded on 2026-07-27.
 *
 * `Chart.yaml` was worse, because it is operator-facing. `appVersion: "1.0.0"`
 * was never edited from the `helm create` scaffold, and `appVersion` is what
 * `helm list` and `helm status` print as *the version of the application
 * running* — so an operator inspecting the cluster was told this pre-1.0
 * project had made the stability promise the CHANGELOG reserves `v1.0.0` for.
 *
 * Cutting a release here is a manual ritual (bump, tag, CHANGELOG, image,
 * GitLab Release object) and a manual ritual with no gate eventually skips a
 * step. This is the gate.
 *
 * **Deliberately not a CI job that bumps the files on tag push.** That would
 * create a commit the tag does not contain, which is a worse inconsistency than
 * the one it fixes. A test that fails when the files disagree gets the same
 * protection without CI writing to the repo.
 *
 * Kept free of `fs` so the parsing is unit-testable on synthetic input — the
 * same split as `manifest-hygiene`, `lockfile-hygiene`, `dockerfile-hygiene`
 * and `ci-job-deps`; the caller reads the real files.
 */

/**
 * `MAJOR.MINOR.PATCH` and nothing else. The `v` prefix belongs to the git tag,
 * not to any of these files: npm rejects `"version": "v0.4.0"`, and accepting
 * it here would let two files "agree" on a value one of them cannot hold.
 * Prereleases are excluded because this project has never cut one — if it ever
 * does, widen this deliberately rather than by accident.
 */
const RELEASE_VERSION = /^\d+\.\d+\.\d+$/;

/** True when `value` is a bare `MAJOR.MINOR.PATCH` release version. */
export function isReleaseVersion(value: string): boolean {
  return RELEASE_VERSION.test(value);
}

/**
 * The `version` field of a `package.json`, or `null` when the manifest is
 * unparseable, has no `version`, or has one that is not a string.
 *
 * Failing to `null` rather than throwing matters for the caller: every source
 * is collected first and reported together, so one unreadable file still names
 * the other two instead of aborting the check.
 */
export function packageJsonVersion(source: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const version = (parsed as { version?: unknown }).version;
  return typeof version === "string" ? version : null;
}

/**
 * Strip YAML quoting and any trailing comment from a scalar's raw text.
 *
 * A `#` only opens a comment when it starts the line or follows whitespace, so
 * `0.4.0#1` stays intact — truncating it would turn a malformed value into one
 * that looks valid, which is the one outcome a hygiene guard must not produce.
 */
function unquoteScalar(raw: string): string | null {
  const quoted = /^(["'])(.*?)\1/.exec(raw.trim());
  if (quoted) return quoted[2] === "" ? null : quoted[2];
  const bare = raw.replace(/(^|\s)#.*$/, "").trim();
  return bare === "" ? null : bare;
}

/** Escape a literal key for embedding in a RegExp. */
function escapeForRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * A **top-level** scalar from `Chart.yaml`, or `null` when it is absent or
 * empty. Deliberately a line matcher rather than a YAML parser: the repo has no
 * YAML dependency, and `ci-docs-only` / `ci-job-deps` already establish that
 * a minimal matcher sized to this repo's own files is the convention.
 *
 * Anchoring at column 0 does two jobs at once. It skips keys nested under
 * `maintainers:` or a future `dependencies:` block — a subchart's `version` is
 * not this chart's — and it stops `version` being satisfied by `apiVersion`,
 * which would otherwise pin the guard to Helm's schema version (`v2`) forever.
 * A commented-out key is skipped for the same reason.
 */
export function chartScalar(chartYaml: string, key: string): string | null {
  const pattern = new RegExp(`^${escapeForRegExp(key)}:[ \\t]*(.*)$`);
  for (const line of chartYaml.split("\n")) {
    const match = pattern.exec(line);
    if (match) return unquoteScalar(match[1]);
  }
  return null;
}

/**
 * A released section heading: `## [0.4.0] - 2026-07-27`.
 *
 * Matching the digits inside the brackets rather than "any heading, then
 * filter" is what skips `## [Unreleased]` without hard-coding that word, so a
 * future `## [Unreleased — 0.5.0]` is skipped too instead of being mistaken for
 * a release. It also means a malformed heading (`## [0.5]`) is invisible here,
 * which fails **closed**: the caller falls back to the previous release and
 * reports a disagreement rather than accepting a version the file cannot mean.
 *
 * The `## ` prefix excludes both the `### Added` subheadings and the
 * `[0.4.0]: https://…` link-reference definitions at the foot of the file.
 */
const RELEASED_HEADING = /^## \[(\d+\.\d+\.\d+)\]/;

/** Every released version in `CHANGELOG.md`, in document order. */
export function releasedChangelogVersions(changelog: string): string[] {
  return changelog
    .split("\n")
    .map((line) => RELEASED_HEADING.exec(line)?.[1])
    .filter((version): version is string => version != null);
}

/**
 * The newest released version in `CHANGELOG.md`, or `null` when nothing has
 * been released yet.
 *
 * "Newest" is read as "first in the file", which is only sound while the file
 * really is maintained newest-first — the convention its own `[Unreleased]`
 * note states. `firstOutOfOrderPair` exists so the caller can prove that
 * premise instead of assuming it.
 */
export function latestReleasedChangelogVersion(
  changelog: string,
): string | null {
  return releasedChangelogVersions(changelog)[0] ?? null;
}

/**
 * Order two `MAJOR.MINOR.PATCH` versions by segment **value**: negative when
 * `a` is older, positive when newer, `0` when equal. Numeric rather than
 * lexicographic, which would put `0.10.0` before `0.9.0` (the trap
 * `distinctLockVersions` documents for #67).
 */
export function compareReleaseVersions(a: string, b: string): number {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (left[i] !== right[i]) return left[i] - right[i];
  }
  return 0;
}

/**
 * The first adjacent pair in `versions` that is not strictly descending, or
 * `null` when the whole list is. A repeat counts as out of order — two sections
 * for one version means one of them was edited instead of being cut.
 */
export function firstOutOfOrderPair(
  versions: readonly string[],
): [string, string] | null {
  for (let i = 1; i < versions.length; i++) {
    if (compareReleaseVersions(versions[i - 1], versions[i]) <= 0) {
      return [versions[i - 1], versions[i]];
    }
  }
  return null;
}

/** One file's claim about the version, named the way a failure should read. */
export interface VersionClaim {
  /** Human-readable origin, e.g. `"Chart.yaml appVersion"`. */
  source: string;
  /** The value read, or `null` when the file carried none. */
  version: string | null;
}

/**
 * `null` when every claim is a well-formed release version and they are all the
 * same; otherwise a message naming **every** source and its value.
 *
 * Reporting the whole set rather than just the odd one out is deliberate: which
 * file is wrong is a judgement about what was released, not something this
 * function can know, and at the v0.4.0 cut it was two of the three.
 *
 * An empty list returns a message rather than `null`. A guard that passes when
 * handed nothing is a guard that stops guarding — the failure mode
 * `lateRecursiveChowns` returns `null` to avoid (#71).
 */
export function versionDisagreement(
  claims: readonly VersionClaim[],
): string | null {
  if (claims.length === 0) {
    return "no version sources were supplied, so nothing was checked";
  }

  const all = claims
    .map(({ source, version }) => `${source} = ${version ?? "(missing)"}`)
    .join(", ");

  const unreadable = claims.filter(
    ({ version }) => version === null || !isReleaseVersion(version),
  );
  if (unreadable.length > 0) {
    const names = unreadable.map(({ source }) => source).join(", ");
    return `not a MAJOR.MINOR.PATCH release version: ${names} — ${all}`;
  }

  const distinct = new Set(claims.map(({ version }) => version));
  return distinct.size > 1 ? `version sources disagree: ${all}` : null;
}
