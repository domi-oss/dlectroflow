/**
 * Runtime-image hygiene (#71): a tiny Dockerfile parser so the invariants that
 * keep the deployed image small are unit-testable instead of tribal knowledge.
 *
 * Background: the runtime image reached 893 MB — big enough that a cold pull on
 * a freshly scaled GKE Autopilot node pushed a deploy past Helm's timeout and
 * `--atomic` rolled back a healthy release. Two Dockerfile mistakes caused most
 * of it (an `npm install` that re-reified the whole app dependency tree into
 * /app, and a `RUN chown -R` that duplicated every file into a second layer),
 * and both are easy to reintroduce by accident. The guards in
 * dockerfile-hygiene.test.ts assert they stay fixed in BOTH Dockerfiles.
 *
 * The parser is deliberately minimal — enough for this repo's two Dockerfiles
 * (no heredocs, no parser directives beyond `# syntax=`), not a general one.
 */

/** A single Dockerfile instruction with its line continuations resolved. */
export interface DockerfileInstruction {
  /** Upper-cased instruction keyword, e.g. `RUN`, `COPY`, `FROM`. */
  instruction: string;
  /** Everything after the keyword, continuations joined into one line. */
  args: string;
}

/** Trailing backslash = the instruction continues on the next line. */
const CONTINUATION = /\\\s*$/;

/**
 * Parse a Dockerfile into instructions, joining `\`-continued lines and
 * dropping comments (including the `# syntax=` directive and comments that
 * appear *inside* a continuation, which the builder also ignores).
 */
export function parseDockerfile(text: string): DockerfileInstruction[] {
  const instructions: DockerfileInstruction[] = [];
  let buffer = "";

  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line.startsWith("#")) continue;
    if (buffer === "" && line === "") continue;

    const continues = CONTINUATION.test(line);
    const body = line.replace(CONTINUATION, "").trim();
    buffer = buffer === "" ? body : `${buffer} ${body}`.trim();
    if (continues) continue;

    const match = /^(\S+)\s*([\s\S]*)$/.exec(buffer);
    if (match) {
      instructions.push({
        instruction: match[1].toUpperCase(),
        args: match[2].trim(),
      });
    }
    buffer = "";
  }

  // A file ending mid-continuation is malformed, but keep what we have rather
  // than silently dropping the last instruction.
  if (buffer !== "") {
    const match = /^(\S+)\s*([\s\S]*)$/.exec(buffer);
    if (match) {
      instructions.push({
        instruction: match[1].toUpperCase(),
        args: match[2].trim(),
      });
    }
  }

  return instructions;
}

/**
 * Shell operators that end one command and begin another inside a single
 * `RUN`. A pattern that walks across one of these has left the command it
 * started in, so every check below refuses to cross them.
 */
const COMMAND_BOUNDARY = "[^&|;]";

/** Escape a literal path for embedding in a RegExp. */
function escapeForRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * True when `path` is an argument of an `rm -rf` **in `command` itself**, with
 * no shell command boundary between the two.
 *
 * The boundary matters: without it, a command that merely mentions the path
 * after some unrelated deletion — `rm -rf /opt/tools; echo cleaned
 * /tmp/npm-cache` — reads as proof that the cache was purged when it was not.
 * (Duo review on !159 flagged that `;` was missing from the original class.)
 */
export function deletesPathInSameCommand(
  command: string,
  path: string,
): boolean {
  return new RegExp(`rm -rf${COMMAND_BOUNDARY}*${escapeForRegExp(path)}`).test(
    command,
  );
}

/** A `RUN` that recursively re-owns /app — the +854 MB duplicate-layer bug. */
const RECURSIVE_APP_CHOWN = new RegExp(
  `chown\\s+-R${COMMAND_BOUNDARY}*/app\\b`,
);

/**
 * `RUN` instructions that recursively `chown` /app at or after the stage's
 * first `COPY` — i.e. in a layer of their own, where rewriting every file
 * duplicates everything copied above it. A chown *before* the COPYs (inside
 * the install RUN) is free, because a layer records only its final state.
 *
 * Returns **`null`** when the stage contains no `COPY` at all, rather than a
 * misleading empty array: with no anchor there is nothing to measure "after"
 * against, and callers must say what that means instead of reading `[]` as a
 * pass. (The earlier inline version did `slice(findIndex(...))`, and
 * `findIndex` returning `-1` made `slice(-1)` quietly narrow the search to the
 * single last instruction — a guard that stops guarding. Duo review on !159.)
 */
export function lateRecursiveChowns(
  instructions: readonly DockerfileInstruction[],
): DockerfileInstruction[] | null {
  const copyIndex = instructions.findIndex((i) => i.instruction === "COPY");
  if (copyIndex === -1) return null;

  return instructions
    .slice(copyIndex)
    .filter((i) => i.instruction === "RUN" && RECURSIVE_APP_CHOWN.test(i.args));
}

/**
 * Return only the instructions belonging to the named build stage
 * (`FROM <image> AS <stage>`), i.e. everything from that FROM up to the next
 * one. Returns `[]` when the stage does not exist.
 */
export function stageInstructions(
  instructions: readonly DockerfileInstruction[],
  stage: string,
): DockerfileInstruction[] {
  const wanted = stage.toLowerCase();
  const collected: DockerfileInstruction[] = [];
  let inStage = false;

  for (const entry of instructions) {
    if (entry.instruction === "FROM") {
      const named = /\s+AS\s+(\S+)\s*$/i.exec(entry.args);
      inStage = (named?.[1] ?? "").toLowerCase() === wanted;
      continue;
    }
    if (inStage) collected.push(entry);
  }

  return collected;
}

/**
 * A `printf '<json>' > <path>` redirect. Global, because a RUN may write more
 * than one file and the caller asks for a specific one; `matchAll` builds its own
 * regex from this rather than advancing `lastIndex` here, so a module-level `g`
 * flag is safe to share (`.exec`/`.test` in a loop would not be).
 */
const PRINTF_REDIRECT = /printf\s+'([^']*)'\s*>\s*(\S+)/g;

/** The npm manifest a stage writes into an isolated install prefix. */
export interface IsolatedManifest {
  /** The JSON text written, with printf's trailing `\n` escape removed. */
  json: string;
  /** Parsed manifest, or `null` when `json` is not a JSON object. */
  manifest: { overrides?: Record<string, unknown> } | null;
}

/**
 * The manifest a stage `printf`s into an isolated npm prefix, e.g.
 * `printf '{"private":true}' > /opt/tools/package.json`.
 *
 * The prefix is isolated so that installing the image's CLIs cannot make npm
 * treat the standalone output's package.json as the project root and reinstall
 * the whole app tree on top of it (#71). The consequence callers check is the
 * other half of that: npm reads THIS manifest as the root instead, so the repo's
 * `overrides` do not reach the install — and no lockfile is committed for it, so
 * every build resolves it afresh. Anything the image must force has to be forced
 * here too, and pinned exactly.
 *
 * Returns `null` when no RUN writes `manifestPath`, and a non-null result with
 * `manifest: null` when something is written there that is not a JSON object.
 * The two need different failure messages, and a thrown `SyntaxError` names
 * neither — so parsing is reported, not raised.
 *
 * The redirect target is matched rather than just the surrounding command, so a
 * RUN that writes several files cannot have another one's payload read as this
 * manifest.
 */
export function isolatedManifest(
  runs: readonly string[],
  manifestPath: string,
): IsolatedManifest | null {
  for (const run of runs) {
    if (!run.includes(manifestPath)) continue;

    for (const [, payload, target] of run.matchAll(PRINTF_REDIRECT)) {
      if (target !== manifestPath) continue;

      // printf's argument is shell-quoted source, so its trailing newline is the
      // two characters `\` and `n`, not a newline.
      const json = payload.replace(/\\n$/, "");
      let parsed: unknown;
      try {
        parsed = JSON.parse(json);
      } catch {
        return { json, manifest: null };
      }
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        Array.isArray(parsed)
      )
        return { json, manifest: null };

      return { json, manifest: parsed as IsolatedManifest["manifest"] };
    }
  }

  return null;
}
