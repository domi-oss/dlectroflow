/**
 * Docs-only CI fast path — coverage guard.
 *
 * `.gitlab-ci.yml` gates the expensive merge-request jobs (compile, unit tests,
 * e2e, image build, container scan, review-app deploy) behind
 * `changes: *code_changes`, so an MR whose entire diff is documentation skips
 * them. That turned an 18-runner-minute pipeline for a three-file README change
 * into a single secret-detection job.
 *
 * The hazard that design creates: `rules:changes` is an allow-list, so a path
 * that nobody remembered to add to `.code_changes` does not "fail closed" — it
 * silently looks like documentation and skips the whole gate. A new top-level
 * `middleware.ts`, or a new `server/` directory, would be shipped untested and
 * unscanned with no signal at all.
 *
 * So this module re-derives the classification from the committed tree and the
 * test asserts every top-level entry is deliberately on one side or the other.
 *
 * The test enumerates that tree with `git ls-tree`, which is why the `test_app`
 * job installs `git` — `node:22-alpine` ships without it, and the first run of
 * this guard failed in CI with `spawnSync git ENOENT` while passing locally.
 * Reading the working directory instead would be worse: it would pick up
 * `node_modules/`, `ci-dist/` and whatever else is lying around, so the ignore
 * list would become the thing that rots.
 * Add a top-level file or directory and the test fails until you either list it
 * in `.code_changes` (it affects the app) or in `DOCS_ONLY_PATHS` below (it does
 * not). The parser is intentionally minimal — it understands only the glob
 * shapes this repo's list actually uses, not a general glob dialect.
 */

/**
 * Top-level paths that are pure documentation or licensing: changing one cannot
 * change what the application does, so a merge request touching only these is
 * safe to fast-path. Everything else must be matched by `.code_changes`.
 *
 * `CODE_OF_CONDUCT.md`, `CONTRIBUTING.md` and `SECURITY.md` are NOT missing —
 * they moved under `docs/` in the root tidy, and `docs` below already covers
 * them. Keeping them as top-level entries would be dead weight the next reader
 * has to disprove. Note the fast path is exactly why they went to `docs/`
 * rather than `.gitlab/`: GitLab detects the community files in any of the
 * three locations, but `.gitlab/` has a recursive glob in `.code_changes`, so
 * a typo fix there would run the full pipeline.
 */
export const DOCS_ONLY_PATHS = [
  "AGENTS.md",
  "CHANGELOG.md",
  "CLAUDE.md",
  "LICENSE",
  "README.md",
  "docs",
] as const;

/** How a top-level entry is treated by the merge-request fast path. */
export type PathClass = "code" | "docs" | "unclassified";

/**
 * One `- …` item of the `.code_changes` sequence: a double-quoted,
 * single-quoted or bare scalar, with an optional trailing inline comment (the
 * repo's YAML uses those elsewhere). All three quoting styles are valid YAML and
 * GitLab honours all three, so the parser accepts all three rather than
 * imposing a house style the pipeline itself does not care about.
 */
const LIST_ITEM = /^- (?:"([^"]+)"|'([^']+)'|(\S+?))\s*(?:#.*)?$/;

/**
 * Extract the `.code_changes` glob list from `.gitlab-ci.yml`.
 *
 * Line-based on purpose: the repo has no YAML parser dependency, and the block
 * is a flat sequence of scalars with comments, which is trivial to read exactly.
 * A line that is not a comment and does not start with `- ` ends the block —
 * that is the next top-level key.
 *
 * A line that *does* start with `- ` but cannot be read as a scalar throws
 * instead of ending the block. Silently stopping there would truncate the glob
 * list, and the caller would then report the paths those dropped globs covered
 * as "unclassified" — sending whoever added the line off to fix an imaginary
 * coverage gap instead of the malformed item in front of them.
 */
export function parseCodeChangeGlobs(gitlabCiYml: string): string[] {
  const lines = gitlabCiYml.split("\n");
  const start = lines.findIndex((l) => l.startsWith(".code_changes:"));
  if (start === -1) {
    throw new Error(
      "`.code_changes:` anchor not found in .gitlab-ci.yml — the docs-only fast path is gone, or was renamed without updating this guard.",
    );
  }

  const globs: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    if (!trimmed.startsWith("- ")) break; // next key — block finished

    const item = LIST_ITEM.exec(trimmed);
    if (!item) {
      throw new Error(
        `\`.code_changes:\` has an item this guard cannot read: ${trimmed}\n` +
          `Expected one glob per line as a plain scalar, e.g. - "src/**/*"`,
      );
    }
    globs.push(item[1] ?? item[2] ?? item[3]);
  }

  if (globs.length === 0) {
    throw new Error("`.code_changes:` is present but empty.");
  }
  return globs;
}

/**
 * Does `glob` cover a top-level entry named `name`?
 *
 * Only the two shapes used by `.code_changes` are supported:
 *   • `dir/**` + `/ *` — covers the directory entry `dir`
 *   • a filename pattern where `*` matches any run of non-`/` characters
 *     (`*.ts`, or a literal name like `.nvmrc`)
 *
 * A trailing wildcard (`Name*`) falls out of the same substitution and is still
 * honoured, though `.code_changes` no longer uses one — the last was
 * `Dockerfile*`, retired when the Docker family moved under `docker/`.
 */
export function globCoversTopLevel(glob: string, name: string): boolean {
  const slash = glob.indexOf("/");
  if (slash !== -1) return glob.slice(0, slash) === name;

  const pattern = glob
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("[^/]*");
  return new RegExp(`^${pattern}$`).test(name);
}

/**
 * Classify one top-level entry. `code` wins over `docs` when a path somehow
 * matches both, because under-testing is the dangerous direction — but the test
 * also asserts that overlap never happens, so it stays a theoretical tie-break.
 */
export function classifyTopLevelPath(
  name: string,
  codeGlobs: readonly string[],
  docsPaths: readonly string[] = DOCS_ONLY_PATHS,
): PathClass {
  if (codeGlobs.some((g) => globCoversTopLevel(g, name))) return "code";
  if (docsPaths.includes(name)) return "docs";
  return "unclassified";
}
