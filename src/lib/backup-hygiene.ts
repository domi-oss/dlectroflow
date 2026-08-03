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
 * The inline shell script held in the block scalar under `<key>:`, or null when
 * the key is absent or carries something other than a block scalar.
 *
 * Shared by the chart walk (`args:`) and the Compose walk (`command:`) because
 * the two YAML shapes are identical below the key. Both `- |` (literal) and
 * `- >` (folded) count: the Compose service shipped before #162 used `>`, and a
 * parser blind to one form would report "no script", which every caller here
 * treats as "nothing to assert on" — a silent pass.
 *
 * Returning null rather than "" matters: an empty script satisfies no assertion,
 * so inventing one would turn a parse failure into a green build.
 *
 * The search for the block marker is bounded to lines indented UNDER the key,
 * not merely to lines after it. Duo review (!249) caught that as a real latent
 * bug: a `command:` holding a plain list, followed by any sibling key that does
 * carry a block scalar (`healthcheck: test: - |`), otherwise looked like an
 * inline script and would satisfy every script-level assertion using text the
 * service never runs. Bounded by indentation rather than adjacency, so a blank
 * line between the key and its marker still parses.
 */
function scriptBlockUnder(body: string[], key: string): string | null {
  const keyAt = body.findIndex((line) => line.trim() === `${key}:`);
  if (keyAt === -1) return null;

  const keyIndent = indentOf(body[keyAt] ?? "");
  let blockAt = -1;
  for (let k = keyAt + 1; k < body.length; k++) {
    const line = body[k] ?? "";
    const trimmed = line.trim();
    if (trimmed === "") continue;
    if (indentOf(line) <= keyIndent) break;
    if (trimmed === "- |" || trimmed === "- >") {
      blockAt = k;
      break;
    }
  }
  if (blockAt === -1) return null;

  const blockIndent = indentOf(body[blockAt] ?? "");
  const script: string[] = [];
  for (let k = blockAt + 1; k < body.length; k++) {
    const line = body[k] ?? "";
    if (line.trim() !== "" && indentOf(line) <= blockIndent) break;
    script.push(line.trim());
  }
  return script.length > 0 ? script.join("\n") : null;
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

    // A stage with no inline script has nothing to assert on; skipping it is
    // safer than inventing an empty one that would pass every check.
    const script = scriptBlockUnder(body, "args");
    if (script === null) continue;
    if (name) stages.push({ name, script });

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

// ── The Compose self-host path (#162) ───────────────────────────────────────
//
// Same question as above, asked of docker/docker-compose.prod.yml: would a
// failure here be silent? It is the harder case, because that stack's backup ran
// for two releases writing only to the host's own disk — a copy in the same
// failure domain as the database it protects, which is the one failure a backup
// exists to survive. The database is also the only asset here that cannot be
// rebuilt from source.
//
// A Compose file IS valid YAML, so nothing needs neutralising first; the walk is
// the same indentation walk, keyed on `command:` instead of `args:`.

/** One backup-family Compose service and the facts worth pinning about it. */
export interface ComposeBackupService {
  /** Service name, e.g. "backup" or "backup-upload". */
  name: string;
  /** The inline shell script, whole-line comments removed. */
  script: string;
  /** The service's volume entries, verbatim minus the list dash. */
  volumes: string[];
}

export interface ComposeBackupFacts {
  /** Services whose name starts with `backup`, in file order. */
  services: ComposeBackupService[];
  /** Which off-host destinations the upload service(s) write to. */
  destinations: { b2: boolean };
}

/** Compose service keys sit two spaces in, directly under `services:`. */
const COMPOSE_SERVICE_INDENT = 2;

/**
 * `  backup-upload:` → `"backup-upload"`, or null for anything else at that
 * indent (a prose comment, a mapping entry with a value, a list item).
 *
 * A plain character-class regex, not the `\s*`…`\s*` shape the SAST ReDoS rule
 * (`javascript-dos-rule-regex_dos`, CWE-185) flags — the line is trimmed first,
 * so no leading/trailing whitespace quantifier is needed at all.
 */
function parseComposeServiceKey(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed.endsWith(":")) return null;
  const name = trimmed.slice(0, -1);
  return /^[a-z0-9][a-z0-9._-]*$/.test(name) ? name : null;
}

/**
 * The list items under `<key>:` within one service's body, each with its `- `
 * stripped. Comments and nested mappings are skipped rather than returned as
 * phantom entries.
 */
function listUnder(body: string[], key: string): string[] {
  const keyAt = body.findIndex((line) => line.trim() === `${key}:`);
  if (keyAt === -1) return [];

  const keyIndent = indentOf(body[keyAt] ?? "");
  const items: string[] = [];
  for (let i = keyAt + 1; i < body.length; i++) {
    const line = body[i] ?? "";
    const trimmed = line.trim();
    if (trimmed === "") continue;
    if (indentOf(line) <= keyIndent) break;
    if (!trimmed.startsWith("- ")) continue;
    items.push(trimmed.slice(2).trim());
  }
  return items;
}

/**
 * Whole-line `#` comments out of a shell script.
 *
 * Needed here and not in the chart walk because #162's Compose scripts are
 * literal block scalars carrying their own prose, and two tools in this repo
 * have already read a comment as the code it describes (#146, #150 — see
 * extractUsedEnvKeys in env-drift.ts). Without this, commenting out the rclone
 * call would leave every destination assertion still passing.
 *
 * Deliberately only WHOLE-line comments: deciding whether a mid-line `#` opens
 * a comment or sits inside a quoted string needs a shell parser, and guessing
 * wrong in the permissive direction is what this function exists to prevent. The
 * scripts it reads therefore keep their comments on their own lines.
 */
function stripShellComments(script: string): string {
  return script
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");
}

/**
 * The backup-family services of a Compose file and what they write to.
 *
 * Scoped to services named `backup*` for the same reason the chart walk scopes
 * destinations to `upload*` stages: the file also defines `db`, `app`, `caddy`
 * and `purge`, and letting an unrelated service's script answer these questions
 * is precisely the false green this module exists to prevent.
 */
export function parseComposeBackup(source: string): ComposeBackupFacts {
  const lines = source.split("\n");
  const servicesAt = lines.findIndex((line) => line.trimEnd() === "services:");
  const services: ComposeBackupService[] = [];

  for (let i = servicesAt + 1; servicesAt !== -1 && i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.trim() === "") continue;
    // Back at column 0 is a sibling of `services:` (`volumes:`, `networks:`),
    // so the services block is over.
    const indent = indentOf(line);
    if (indent === 0) break;
    if (indent !== COMPOSE_SERVICE_INDENT) continue;

    const name = parseComposeServiceKey(line);
    if (!name) continue;

    const body: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      const bodyLine = lines[j] ?? "";
      if (bodyLine.trim() !== "" && indentOf(bodyLine) <= indent) break;
      body.push(bodyLine);
    }
    // Skip the body wholesale. Without this the outer loop walks back into it,
    // and a nested two-space-indented key would surface as a phantom service.
    i += body.length;

    if (!name.startsWith("backup")) continue;
    const script = scriptBlockUnder(body, "command");
    // `command: ["npx", …]` is an exec array, not a script. Treating its absence
    // as an empty script would make every script-level assertion vacuous.
    if (script === null) continue;

    services.push({
      name,
      script: stripShellComments(script),
      volumes: listUnder(body, "volumes"),
    });
  }

  const uploadScripts = services
    .filter((service) => service.name !== "backup")
    .map((service) => service.script)
    .join("\n");

  return {
    services,
    // The destination URI, not the tool: `rclone` alone would be satisfied by a
    // copy to some other S3-compatible target, while the claim being made is
    // specifically that the dump leaves this host.
    destinations: { b2: /\bb2:/.test(uploadScripts) },
  };
}
