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
