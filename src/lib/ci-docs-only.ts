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

/** The lines of one column-0 job block, excluding the `job:` line itself. */
function jobBlock(gitlabCiYml: string, job: string): string[] {
  const lines = gitlabCiYml.split("\n");
  const start = lines.findIndex((l) => l.startsWith(`${job}:`));
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
    if (trimmed === "reports:") reportsIndent = indent;
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
