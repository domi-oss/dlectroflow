/**
 * Pure helpers for asking the backup CronJob template one question: **would a
 * failure here be silent?**
 *
 * The database backup is the only job in this repo with no observable output.
 * Nothing renders it and no user hits it, so a CronJob that uploads an empty
 * file, or stopped uploading to one of its two destinations, looks exactly like
 * a healthy one until a restore is attempted. This project has already been
 * caught three times by a green signal that meant nothing was checked; the
 * backup path is the worst possible place for a fourth.
 *
 * Kept free of `fs` so the parsing is unit-testable on synthetic input — the
 * same split `manifest-hygiene`, `lockfile-hygiene`, `dockerfile-hygiene`,
 * `fetch-host-hygiene` and `revalidation-hygiene` use; the caller reads the
 * file. `backup-hygiene.test.ts` holds the assertions and reads the real chart.
 *
 * ── Why strip-then-YAML rather than a regex ─────────────────────────────────
 * `CLAUDE.md` asks for a structural parse over a regex for anything reasoning
 * about code shapes, and the questions here are structural: which *stages*
 * exist, and what does each stage's *script* contain. A regex over the raw file
 * cannot tell the `upload` container's script from the `dump` initContainer's,
 * which is exactly the distinction the size-guard assertion depends on.
 *
 * A Helm template is not valid YAML, so it is neutralised first: comments and
 * control actions are removed, and value interpolations become a placeholder
 * string. Deliberately a *placeholder* and not an empty scalar — `image: {{ … }}`
 * collapsing to `image:` parses as null, which would quietly satisfy a
 * presence check.
 *
 * ── What it deliberately does not see ───────────────────────────────────────
 * Whether the upload actually succeeds at runtime, whether the bucket exists,
 * or whether the credential is valid. Those are properties of the cluster, not
 * the chart. This guard only ensures the chart cannot lose a property that a
 * plausible tidy-up would remove.
 */

export interface BackupStage {
  /** Container name, e.g. "dump" or "upload". */
  name: string;
  /** The shell script the stage runs — `args[0]` under a `sh -c` command. */
  script: string;
}

export interface BackupTemplateFacts {
  stages: BackupStage[];
  /** Which upload destinations the stages write to. Both must stay true. */
  destinations: { gcs: boolean; b2: boolean };
}

/** Matches `{{- /* … *​/ -}}`, including the multi-line header comment. */
const HELM_COMMENT = /\{\{-?\s*\/\*[\s\S]*?\*\/\s*-?\}\}/g;

/**
 * Control actions produce no output, so they are removed outright.
 *
 * `fail` belongs here and `printf` does not, which is easy to get backwards:
 * `fail` aborts the render and emits nothing, while `printf` renders a value.
 * Deleting a `printf` would drop a scalar the document expects and shift the
 * structure the walk below depends on; leaving `fail` out would turn the
 * bucket guard in backup.yaml into a stray `"HELM_VALUE"` line.
 */
const HELM_CONTROL =
  /\{\{-?\s*(if|else|else\s+if|end|range|with|define|block|fail)\b[\s\S]*?-?\}\}/g;

/** Everything else interpolates a value; keep a scalar so YAML stays valid. */
const HELM_VALUE = /\{\{[\s\S]*?\}\}/g;

/**
 * Turn a Helm template into something `js-yaml` will accept, without changing
 * the document structure the assertions care about.
 */
export function stripHelmActions(source: string): string {
  return source
    .replace(HELM_COMMENT, "")
    .replace(HELM_CONTROL, "")
    .replace(HELM_VALUE, '"HELM_VALUE"')
    .split("\n")
    .filter((line) => line.trim() !== "")
    .join("\n");
}

const CONTAINER_PREFIX = "- name: ";

/** Width of a line's leading whitespace, without a regex. */
function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

/**
 * `  - name: upload-b2` → `{ indent: 2, name: "upload-b2" }`, or null.
 *
 * String operations rather than `/^(\s*)- name: (\S+)\s*$/` deliberately. The
 * SAST ReDoS rule (`javascript-dos-rule-regex_dos`, CWE-185) flags any
 * `\s*` … `\s*` pair, and while this one backtracks linearly — the quantifiers
 * are sequential, not nested, and separated by a mandatory literal — arguing
 * that in a dismissal comment costs more than not writing the regex. The
 * string version is also plainly easier to read.
 */
function parseContainerStart(
  line: string,
): { indent: number; name: string } | null {
  const trimmed = line.trimStart();
  if (!trimmed.startsWith(CONTAINER_PREFIX)) return null;
  const name = trimmed.slice(CONTAINER_PREFIX.length).trim();
  // A name with inner whitespace is not a container name; bail rather than
  // silently treating the first word as one.
  if (name === "" || /\s/.test(name)) return null;
  return { indent: indentOf(line), name };
}

/**
 * Collect every container's inline script by walking indentation.
 *
 * Hand-rolled rather than delegating to a YAML library on purpose: `js-yaml` is
 * present in `node_modules` only as a transitive dependency of something else,
 * so importing it would put a build-breaking bet on a package this project
 * never declared. Adding `@types/js-yaml` is not free either — local `npm` is
 * allow-scripts-wrapped, so a lockfile change has to be regenerated in the CI
 * image (see CLAUDE.md).
 *
 * This is still a structural walk and not a regex over the whole file: a
 * container's script is bounded by the indentation of the `- name:` that opened
 * it, which is exactly what tells the `upload` script apart from `dump`'s.
 */
function collectStages(lines: string[]): BackupStage[] {
  const stages: BackupStage[] = [];

  for (let i = 0; i < lines.length; i++) {
    const start = parseContainerStart(lines[i] ?? "");
    if (!start) continue;
    const { indent, name } = start;

    // Everything more-indented than the `- name:` belongs to this container,
    // up to the next sibling or the end of the block.
    const body: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j] ?? "";
      if (indentOf(line) <= indent) break;
      body.push(line);
    }

    // The script is the literal block that follows `args:` — `- |` then the
    // indented lines under it.
    const argsAt = body.findIndex((l) => l.trim() === "args:");
    if (argsAt === -1) continue;
    const blockAt = body.findIndex((l, k) => k > argsAt && l.trim() === "- |");
    if (blockAt === -1) continue;

    const scriptIndent = indentOf(body[blockAt] ?? "");
    const script: string[] = [];
    for (let k = blockAt + 1; k < body.length; k++) {
      const line = body[k] ?? "";
      if (line.trim() !== "" && indentOf(line) <= scriptIndent) break;
      script.push(line.trim());
    }

    // A stage with no inline script has nothing to assert on; skipping it is
    // safer than inventing an empty one that would pass every check.
    if (name && script.length > 0) {
      stages.push({ name, script: script.join("\n") });
    }

    // Skip past this container's body. Without it the outer loop re-examines
    // every line inside it, and a nested `- name:` that happened to carry its
    // own `args:` would be emitted a second time as a phantom stage.
    i += body.length;
  }

  return stages;
}

export function parseBackupTemplate(source: string): BackupTemplateFacts {
  const stages = collectStages(stripHelmActions(source).split("\n"));

  // Only the upload stages count. Searching every script concatenated would let
  // a `# see gs://…` comment in the dump stage satisfy the GCS check, which is
  // the precise opposite of what this guard is for.
  const uploadScripts = stages
    .filter((s) => s.name.includes("upload"))
    .map((s) => s.script)
    .join("\n");

  return {
    stages,
    // Match the destination URI, not the tool: `rclone` alone would be
    // satisfied by an rclone call to some other S3-compatible target, while
    // the test that reads this claims specifically that B2 is written to.
    destinations: {
      gcs: /gs:\/\//.test(uploadScripts),
      b2: /\bb2:/.test(uploadScripts),
    },
  };
}
