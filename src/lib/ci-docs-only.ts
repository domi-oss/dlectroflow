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
 * Being on the documentation side is a claim about a directory's CONTENTS, and
 * a name is not evidence for it, so that half is enforced separately and
 * recursively by `docsOnlyViolations`: an executable, a symlink, a submodule or
 * an unrecognised file type anywhere beneath a docs-only prefix fails the
 * check. `docker/**\/*` needs no equivalent — its recursive glob in
 * `.code_changes` re-triggers the gate at any depth — but a docs-only prefix
 * has no backstop, so this is it.
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
 *
 * `skills` holds GitLab Duo agent skills (`skills/<name>/SKILL.md`). It is
 * classified here rather than in `.code_changes` because it is prose: Duo reads
 * it as instructions, nothing imports it, nothing bundles it, and no CI job
 * executes it — so changing one cannot change what the application does, which
 * is the test this list applies. The distinction from `docker/` is worth being
 * precise about, since that IS in `.code_changes` despite also never running in
 * CI: `docker/` is deployment configuration and decides how the app is built
 * and served, whereas a skill only shapes how an agent talks about the repo.
 *
 * This holds ONLY while the directory stays prose. Upstream AntiVibe ships four
 * optional helper shell scripts; they were deliberately not carried over, and
 * the reason is this line. Adding any executable under `skills/` means moving
 * `skills/**\/*` into `.code_changes` in the same change, or it ships unscanned
 * and unexecuted-by-CI — the precise hazard this module's header describes.
 *
 * That condition used to rest on this comment being read, which is what a gate
 * exists to replace: `docsOnlyViolations` below now fails the suite on the
 * offending file, by name, so the reclassification cannot be forgotten rather
 * than merely being written down. `skills/README.md` still states the rule
 * where someone adding a skill will meet it first.
 */
export const DOCS_ONLY_PATHS = [
  "AGENTS.md",
  "CHANGELOG.md",
  "CLAUDE.md",
  "LICENSE",
  "README.md",
  "docs",
  "skills",
] as const;

/**
 * File suffixes and exact filenames that may appear under a `DOCS_ONLY_PATHS`
 * prefix. Anything else fails the guard.
 *
 * This is the enforcement of the promise `DOCS_ONLY_PATHS` makes. That list
 * grants a whole directory the fast path on the strength of its name, and the
 * name is not evidence: `docker/**\/*` needs no equivalent because its
 * recursive glob in `.code_changes` re-triggers the gate at any depth, but a
 * docs-only prefix has no such backstop, so the contents are checked here
 * instead.
 *
 * Deliberately an allow-list of what the tree ACTUALLY holds, not of what
 * seems harmless — 70 `.md`, 3 `.png`, 1 `.html` and 3 `LICENSE` as of this
 * commit. Fail-closed only works if the list is not padded with speculative
 * entries: adding a `.svg` should fail once, in front of the person adding it,
 * rather than having been silently pre-authorised by someone who was not
 * looking at it.
 *
 * `.html` earns its place narrowly. `docs/wireframe/dlectroflow-wireframe.html`
 * is a static design artefact: nothing imports it, no route serves it, and it
 * is not in the image, so it can only run in a browser a developer aimed at
 * their own checkout. A `.html` that the app served would be a code path and
 * would belong in `.code_changes`, not here.
 */
export const DOCS_ONLY_FILE_SUFFIXES: readonly string[] = [
  ".md",
  ".png",
  ".html",
];

/** @see DOCS_ONLY_FILE_SUFFIXES — MIT copies from ported skills, and the root AGPL text. */
export const DOCS_ONLY_FILE_NAMES: readonly string[] = ["LICENSE"];

/** The only git file mode documentation has any business having. */
const GIT_MODE_REGULAR_FILE = "100644";

/**
 * What is wrong with each git mode that is not a plain file, phrased for the
 * failure message.
 *
 * A symlink and a submodule are here because neither is caught by looking at
 * the filename, which is the only thing the rest of this module does: a
 * `docs/guide.md` symlinked at `../src/lib/crypto/token.ts` reads as
 * documentation to every name-based check, and a submodule is an entire
 * repository that the fast path would ship without building or scanning a line
 * of it.
 */
const NON_FILE_GIT_MODES: Readonly<Record<string, string>> = {
  "100755": "has the executable bit set",
  "120000": "is a symbolic link",
  "160000": "is a git submodule",
};

/**
 * Every scanner job `.code_scanner_rules` gates, mapped to the security report
 * type it feeds GitLab. Two SAST jobs share one report type, which is exactly
 * why this is a map and not a list: the stub owes one empty report per *type*,
 * not per job.
 *
 * #116: skipping these jobs is not free. The approval policy in the linked
 * security-policy project compares the report types present in a merge
 * request's pipeline against those in main's; a type main has and the merge
 * request lacks is a `scan_removed` violation, and the policy's
 * `fallback_behavior: fail: closed` converts that into a required approval. So
 * every docs-only merge request was unmergeable until one specific human
 * approved it — on a diff that cannot contain a vulnerability.
 *
 * `docs_only_scan_stub` in `.gitlab-ci.yml` supplies the missing types. Keeping
 * this map honest is what stops the fix rotting: add a fifth code-gated scanner
 * and the test fails until it is listed here AND stubbed there.
 *
 * `secret_detection` is deliberately absent — it is gated on `*scanner_rules`,
 * not `*code_scanner_rules`, so it runs on the fast path and needs no stand-in.
 */
export const CODE_GATED_SCANNERS: Readonly<Record<string, string>> = {
  "semgrep-sast": "sast",
  "gitlab-advanced-sast": "sast",
  "gemnasium-dependency_scanning": "dependency_scanning",
  container_scanning: "container_scanning",
};

/** The `.gitlab-ci.yml` job that emits the empty stand-in reports (#116). */
export const DOCS_ONLY_STUB_JOB = "docs_only_scan_stub";

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
 * A trailing wildcard (`Name*`) is honoured too, though `.code_changes` no
 * longer uses one — the last was `Dockerfile*`, retired when the Docker family
 * moved under `docker/`.
 *
 * Matched by walking the literal fragments rather than by compiling a regex.
 * The regex version needed every fragment escaped against injection and was
 * flagged by semgrep as "regular expression with non-literal value" on each of
 * the four occasions this function drifted to a new line number — three
 * dismissals as a false positive so far, all of the same code. A matcher that
 * never builds a pattern cannot be flagged and cannot be mis-escaped, and this
 * module had already made the same trade once (`parseStubReportTypes` compares
 * a substring for exactly this reason). Behaviour is unchanged; the
 * characterisation cases in the colocated test were written against the regex
 * implementation and pass against both.
 */
export function globCoversTopLevel(glob: string, name: string): boolean {
  const slash = glob.indexOf("/");
  if (slash !== -1) return glob.slice(0, slash) === name;

  const fragments = glob.split("*");
  if (fragments.length === 1) return glob === name; // no wildcard: a literal name

  // A glob with no `/` describes a top-level name, and a wildcard stands for
  // `[^/]*`, so nothing in this branch can legally match a path with a
  // separator in it. Rejecting those up front is what keeps `*.ts` from
  // claiming `src/index.ts` — and with them gone, the remaining wildcards are
  // unconstrained and the walk below stays a plain left-to-right scan.
  if (name.includes("/")) return false;

  const first = fragments[0];
  const last = fragments[fragments.length - 1];
  if (!name.startsWith(first) || !name.endsWith(last)) return false;

  // Interior fragments must appear in order and must not overlap each other,
  // hence searching from `cursor` and advancing past each hit.
  let cursor = first.length;
  for (const fragment of fragments.slice(1, -1)) {
    const found = name.indexOf(fragment, cursor);
    if (found === -1) return false;
    cursor = found + fragment.length;
  }

  // The trailing fragment is matched by `endsWith` above, but that can overlap
  // what the walk already consumed — `a*b*c` against `abc` must not let the
  // final `c` double as a character an interior fragment already claimed.
  return cursor + last.length <= name.length;
}

/**
 * Names of the jobs whose `rules:` are the YAML alias `*<anchor>`.
 *
 * Line-based for the same reason `parseCodeChangeGlobs` is: no YAML parser
 * dependency, and the shape being read is unambiguous. A job name is a key at
 * column 0; everything indented under it belongs to the last such key seen. The
 * `.code_scanner_rules:` anchor definition itself is a column-0 key too, but it
 * defines the alias rather than using it, so it never matches the `rules:` line
 * and never appears in the result.
 */
export function parseJobsGatedOn(
  gitlabCiYml: string,
  anchor: string,
): string[] {
  const jobs = new Set<string>();
  let currentKey: string | null = null;

  for (const line of gitlabCiYml.split("\n")) {
    const topLevelKey = /^([^\s#][^:]*):/.exec(line);
    if (topLevelKey) {
      currentKey = topLevelKey[1];
      continue;
    }
    // Match on the parsed alias rather than the literal line: `rules:  *x`
    // with two spaces is valid YAML, and a literal comparison would drop the
    // job and then fail the coverage assertion with a message about
    // CODE_GATED_SCANNERS drifting instead of about the whitespace.
    const alias = /^rules:\s*\*(\S+)$/.exec(withoutComment(line));
    if (currentKey && alias?.[1] === anchor) jobs.add(currentKey);
  }
  return [...jobs];
}

/**
 * A line with its trailing YAML comment removed, trimmed.
 *
 * YAML only starts a comment at a `#` preceded by whitespace, so `\s+#` is the
 * correct test and `value#notacomment` is left alone. The list-item parser
 * above already tolerates inline comments; the job/report parsers below do the
 * same, because this file's YAML uses them freely and a parser that silently
 * skipped a commented line would fail its assertion with a message about the
 * wrong thing (Duo review on !217).
 */
function withoutComment(line: string): string {
  return line.replace(/\s+#.*$/, "").trim();
}

/**
 * The lines of one column-0 job block, excluding the `job:` line itself.
 *
 * The start line must be the job key exactly: at column 0, not a comment, and
 * with nothing after the colon but an optional comment. `startsWith` would also
 * accept `job: some-value`, which is not a job at all.
 */
function jobBlock(gitlabCiYml: string, job: string): string[] {
  const lines = gitlabCiYml.split("\n");
  const start = lines.findIndex(
    (l) => /^[^\s#]/.test(l) && withoutComment(l) === `${job}:`,
  );
  if (start === -1) {
    throw new Error(
      `\`${job}:\` not found in .gitlab-ci.yml. Without it a docs-only merge request produces none of the report types main's pipeline has, and the approval policy blocks it as \`scan_removed\` (#116).`,
    );
  }
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^[^\s#]/.test(l)); // next column-0 key
  return end === -1 ? rest : rest.slice(0, end);
}

/**
 * The docs-only stub job's `artifacts:reports:` block, as report type → file.
 *
 * Throws rather than returning `{}` when the job or its reports block is
 * missing: an empty result would make the coverage assertions in the test pass
 * by vacuity at precisely the moment the job that closes the gap was deleted,
 * which is the silent failure this whole guard exists to prevent.
 */
export function parseStubDeclaredReports(
  gitlabCiYml: string,
  job: string = DOCS_ONLY_STUB_JOB,
): Record<string, string> {
  const declared: Record<string, string> = {};
  // Only `reports:` nested under `artifacts:` counts. The job's `script:` is a
  // YAML block scalar that this line-based parser reads as plain text, so a log
  // line or comment inside it that happened to read `reports:` would otherwise
  // open a phantom block and capture script text as report declarations (Duo
  // review on !217).
  let artifactsIndent: number | null = null;
  let reportsIndent: number | null = null;

  for (const line of jobBlock(gitlabCiYml, job)) {
    const trimmed = withoutComment(line);
    if (trimmed === "" || trimmed.startsWith("#")) continue;

    const indent = line.length - line.trimStart().length;
    if (reportsIndent !== null) {
      if (indent > reportsIndent) {
        // The value is the rest of the line rather than one token, so a
        // filename containing a space is captured instead of skipped.
        // Hyphens are allowed in the type even though every GitLab report
        // type is snake_case today: a type neither parser recognised would be
        // dropped from BOTH sides, so the two lists would agree about a report
        // neither of them had actually checked.
        const entry = /^([A-Za-z_][\w-]*):\s*(.+)$/.exec(trimmed);
        if (entry) {
          const [, type, value] = entry;
          if (value.startsWith("*") || value.startsWith("&")) {
            throw new Error(
              `\`${job}:\` declares \`${type}: ${value}\` — artifacts:reports: must name a literal filename here, because the guard compares it against the filename the inline script writes. A YAML alias cannot be compared and would fail as a phantom mismatch (#116).`,
            );
          }
          declared[type] = value;
        }
        continue;
      }
      reportsIndent = null; // dedented back out of the reports block
    }
    if (artifactsIndent !== null && indent <= artifactsIndent) {
      artifactsIndent = null; // dedented back out of artifacts:
    }
    if (trimmed === "artifacts:") {
      artifactsIndent = indent;
      continue;
    }
    if (artifactsIndent !== null && indent > artifactsIndent) {
      if (trimmed === "reports:") reportsIndent = indent;
    }
  }

  if (Object.keys(declared).length === 0) {
    throw new Error(
      `\`${job}:\` declares no artifacts:reports:, so it registers no scan types with GitLab and cannot unblock a docs-only merge request (#116).`,
    );
  }
  return declared;
}

/** The report types the stub job declares in `artifacts:reports:`. */
export function parseStubReportTypes(
  gitlabCiYml: string,
  job: string = DOCS_ONLY_STUB_JOB,
): string[] {
  return Object.keys(parseStubDeclaredReports(gitlabCiYml, job));
}

/**
 * The report type → file pairs the stub job's inline `node -e` script actually
 * writes, read from its `["type", "file"],` array literal.
 *
 * Declaring a report in `artifacts:reports:` and forgetting to write the file
 * is the one way left to reintroduce #116 silently: the runner logs
 * `no matching files`, the job still SUCCEEDS, GitLab registers no scan for
 * that type, and the next docs-only merge request is blocked again with a
 * message about security rather than about this file. So the two lists are
 * compared, and a script that writes nothing throws rather than comparing
 * equal to an empty set.
 */
export function parseStubWrittenReports(
  gitlabCiYml: string,
  job: string = DOCS_ONLY_STUB_JOB,
): Record<string, string> {
  const written: Record<string, string> = {};
  // Trailing `//` comment tolerated for the same reason the YAML parsers
  // tolerate `#`: this list is meant to be annotated. The type character class
  // matches the one in parseStubDeclaredReports, hyphens included — the two
  // must recognise the same set of types or they agree by both skipping.
  const PAIR = /^\["([A-Za-z_][\w-]*)",\s*"([^"]+)"\],?(?:\s*\/\/.*)?$/;

  for (const line of jobBlock(gitlabCiYml, job)) {
    const pair = PAIR.exec(line.trim());
    if (pair) written[pair[1]] = pair[2];
  }

  if (Object.keys(written).length === 0) {
    throw new Error(
      `\`${job}:\` writes no report files. Expected a \`["type", "file"],\` pair per declared report in its inline node script — without one, artifacts:reports: points at a file that never exists, the job still passes, and #116 comes back silently.`,
    );
  }
  return written;
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

/** One committed file: its git mode and its repository-relative path. */
export type CommittedEntry = { mode: string; path: string };

/** A committed file that a `DOCS_ONLY_PATHS` prefix should not be vouching for. */
export type DocsOnlyViolation = { path: string; reason: string };

/**
 * `<mode> SP <type> SP <object>` then a TAB then the path — the format
 * `git ls-tree` has emitted since forever, so no `--format` (git 2.36+)
 * dependency is taken on the `node:22-alpine` image's git.
 *
 * `[\s\S]+` and not `.+` for the path: with `-z` the records are NUL-separated
 * and the path is raw, so a path legitimately containing a newline arrives
 * intact and must not fall out of the match. Dropping it would be fail-open —
 * a file the guard never saw is a file the guard never objected to.
 */
const TREE_ENTRY = /^(\d{6}) (\w+) ([0-9a-f]+)\t([\s\S]+)$/;

/**
 * Parse `git ls-tree -r -z HEAD` into mode/path pairs.
 *
 * Pure, and separate from the call that produces the input, for the reason
 * every file-parsing guard in this repo is: parsing that can only be exercised
 * against the real tree cannot be shown to FAIL, and a guard nobody has
 * watched fail is a guard nobody has tested.
 *
 * Throws on an unreadable record and on no records at all, rather than
 * returning what it managed to read. Both silent versions fail in the
 * dangerous direction: the entry the parser could not read is precisely the
 * oddly-shaped one worth inspecting, and an empty set satisfies every
 * assertion made against it.
 */
export function parseTreeEntries(lsTreeZOutput: string): CommittedEntry[] {
  const entries: CommittedEntry[] = [];

  for (const record of lsTreeZOutput.split("\0")) {
    if (record === "") continue; // trailing NUL after the last record

    const parsed = TREE_ENTRY.exec(record);
    if (!parsed) {
      throw new Error(
        `\`git ls-tree\` produced a record this guard cannot read: ${JSON.stringify(record)}\n` +
          `Expected \`<mode> <type> <object>\\t<path>\`, NUL-separated (\`git ls-tree -r -z HEAD\`).`,
      );
    }
    entries.push({ mode: parsed[1], path: parsed[4] });
  }

  if (entries.length === 0) {
    throw new Error(
      "`git ls-tree` listed no files. That means the call went wrong, not that the repository is empty — and an empty file list passes every docs-only check by vacuity.",
    );
  }
  return entries;
}

/**
 * Every committed file under a docs-only prefix that is not documentation.
 *
 * The fail-closed half of this module. `classifyTopLevelPath` asks only whether
 * a top-level NAME is on a list; it cannot see inside `docs/` or `skills/`, so
 * on its own the docs-only classification is an unchecked promise about their
 * contents. This checks it, recursively, for every depth.
 *
 * Both the mode and the filename are tested, and a file can fail on both.
 * Neither substitutes for the other: `sh helper.sh` and `node helper.js` run a
 * mode-644 file perfectly well, so the executable bit is a signal rather than
 * the control, while a mode-755 `NOTES.md` is a shell script wearing a hat.
 *
 * Entries outside the docs-only prefixes are not this function's business —
 * `scripts/` is full of committed executables and is covered by
 * `.code_changes`, so it already gets the full gate.
 */
export function docsOnlyViolations(
  entries: readonly CommittedEntry[],
  docsPaths: readonly string[] = DOCS_ONLY_PATHS,
): DocsOnlyViolation[] {
  const violations: DocsOnlyViolation[] = [];

  for (const { mode, path } of entries) {
    // `${p}/` and not `startsWith(p)`: `docs` must not claim `docs-internal/`,
    // which `.code_changes` — not this list — is responsible for.
    const isDocsOnly = docsPaths.some(
      (p) => path === p || path.startsWith(`${p}/`),
    );
    if (!isDocsOnly) continue;

    if (mode !== GIT_MODE_REGULAR_FILE) {
      violations.push({
        path,
        reason:
          NON_FILE_GIT_MODES[mode] ?? `has the unrecognised git mode ${mode}`,
      });
    }

    const name = path.slice(path.lastIndexOf("/") + 1);
    // `length >` and not `>=`: `.md` alone is a dotfile with no stem, not a
    // document, and an unaccounted-for shape fails rather than passing on a
    // suffix match nobody intended.
    const isDocumentation =
      DOCS_ONLY_FILE_NAMES.includes(name) ||
      DOCS_ONLY_FILE_SUFFIXES.some(
        (suffix) => name.length > suffix.length && name.endsWith(suffix),
      );
    if (!isDocumentation) {
      violations.push({
        path,
        reason: "is not a recognised documentation file type",
      });
    }
  }
  return violations;
}
