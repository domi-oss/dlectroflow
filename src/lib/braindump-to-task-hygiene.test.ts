import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { findHandBuiltBrainDumpTasks } from "@/lib/braindump-to-task-hygiene";

/**
 * #179 — the guard `braindump-to-task.ts` promises in its own doc comment.
 *
 * `item.text` becomes a task title in four places, and before #179 they were
 * four independent object literals that happened to agree. The moment the item
 * grew columns worth carrying, "happened to agree" became "three of them carry
 * the note" — and the fourth would have been whichever path had no test, which
 * for a silently-dropped note is indistinguishable from working.
 *
 * `brainDumpItemToTaskData` fixed the four. This fails the build when a FIFTH
 * appears, which is the only part that keeps working after everyone involved has
 * forgotten the argument.
 *
 * ## What counts as a finding, and why it is `source` rather than `title`
 *
 * A hand-built row names its own `source: TaskSource.BrainDump`. Routing it
 * through the helper removes that property from the call site entirely, because
 * the helper supplies it — so the presence of the literal at a `task.create` IS
 * the drift, with no heuristics about which variable held the item.
 *
 * The alternative, looking for `title: item.text`, fails in both directions: it
 * misses a writer that named the variable something else, and it flags
 * `createTask` in `breakdown.ts`, which builds a genuinely MANUAL task from a
 * typed title and must not carry an item's note.
 *
 * ## AST, not a regex — and here that is not hypothetical
 *
 * `braindump-to-task.ts` names `prisma.task.create` **in its own doc comment**,
 * twice, explaining this guard. A regex reports the module that exists to prevent
 * the thing. This repo has twice shipped a tool that read a comment as code.
 */

const SCANNED_ROOT = "src";
const SELF = path.join("src", "lib", "braindump-to-task-hygiene.test.ts");

function scannedFiles(): string[] {
  const entries = readdirSync(SCANNED_ROOT, {
    recursive: true,
    encoding: "utf8",
  });
  const files: string[] = [];
  for (const entry of entries) {
    if (!/\.(ts|tsx|mts)$/.test(entry)) continue;
    if (/\.test\.(ts|tsx)$/.test(entry)) continue;
    const file = path.join(SCANNED_ROOT, entry);
    if (file === SELF) continue;
    files.push(file);
  }
  return files;
}

/**
 * The four writers, named rather than counted.
 *
 * A count would pass if one were deleted and a different one added; naming them
 * is what makes the mutation test below able to say WHICH path lost its routing.
 */
const CONVERSION_SITES = [
  "src/app/actions/braindump.ts",
  "src/app/actions/breakdown.ts",
  "src/app/actions/google-schedule.ts",
];

describe("findHandBuiltBrainDumpTasks — the parser, on synthetic input", () => {
  it("flags a hand-built brain-dump task", () => {
    const findings = findHandBuiltBrainDumpTasks(
      `const task = await prisma.task.create({
         data: {
           title: item.text,
           source: TaskSource.BrainDump,
           status: TaskStatus.Active,
           workspaceId,
         },
       });`,
      "synthetic.ts",
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].line).toBe(1);
    expect(findings[0].reason).toContain("brainDumpItemToTaskData");
  });

  it("flags one inside a transaction, where the receiver is not `prisma`", () => {
    // `scheduleSingleTask` uses `tx.task.create`. Matching on the receiver's name
    // would have missed the one writer that has to be atomic.
    expect(
      findHandBuiltBrainDumpTasks(
        `await tx.task.create({ data: { source: TaskSource.BrainDump } });`,
        "synthetic.ts",
      ),
    ).toHaveLength(1);
  });

  it("flags the raw string form as well as the constant", () => {
    // Nothing writes it this way today. The guard should not be defeatable by
    // inlining the enum's value.
    expect(
      findHandBuiltBrainDumpTasks(
        `await prisma.task.create({ data: { source: "braindump" } });`,
        "synthetic.ts",
      ),
    ).toHaveLength(1);
  });

  it("flags the SHORTHAND form, `create({ data })`", () => {
    // Review round on `!281`. `ts.isPropertyAssignment` is FALSE for a
    // `ShorthandPropertyAssignment`, so `{ data }` was skipped entirely and a
    // hand-built brain-dump task could evade this guard by hoisting one line. For a
    // check whose whole purpose is to fail the build when a fifth writer stops going
    // through the helper, an evasion that cheap is the only kind that matters.
    const findings = findHandBuiltBrainDumpTasks(
      `const data = {
         title: item.text,
         source: TaskSource.BrainDump,
         status: TaskStatus.Active,
         workspaceId,
       };
       const task = await prisma.task.create({ data });`,
      "synthetic.ts",
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].reason).toContain("brainDumpItemToTaskData");
  });

  it("does NOT flag the shorthand form when it resolves to the helper", () => {
    // The control. Closing the shorthand hole must not start flagging the shape the
    // helper exists to provide — otherwise the guard gets relaxed, which is how a
    // compensating control dies.
    expect(
      findHandBuiltBrainDumpTasks(
        `const data = brainDumpItemToTaskData(item, workspaceId);
         const task = await tx.task.create({ data });`,
        "synthetic.ts",
      ),
    ).toEqual([]);
  });

  it("does NOT flag a shorthand whose object names no brain-dump source", () => {
    expect(
      findHandBuiltBrainDumpTasks(
        `const data = { title: "manual", status: TaskStatus.Active, workspaceId };
         const task = await prisma.task.create({ data });`,
        "synthetic.ts",
      ),
    ).toEqual([]);
  });

  it("resolves `{ data }` in the CALL SITE's scope, not the first one in the file", () => {
    // Review round on `!281`, against the shorthand fix from the round before it.
    // The first version walked the whole file for the first `data` declaration, so a
    // file holding two `data` locals resolved the wrong one for both call sites —
    // silently missing the offender, which is the only case this guard exists for.
    //
    // Here the CLEAN one is declared first, so a file-order lookup returns it for
    // both and reports nothing.
    const findings = findHandBuiltBrainDumpTasks(
      `async function good(item, workspaceId, tx) {
         const data = brainDumpItemToTaskData(item, workspaceId);
         return tx.task.create({ data });
       }
       async function bad(item, workspaceId) {
         const data = {
           title: item.text,
           source: TaskSource.BrainDump,
           status: TaskStatus.Active,
           workspaceId,
         };
         return prisma.task.create({ data });
       }`,
      "synthetic.ts",
    );
    expect(findings).toHaveLength(1);
    // And it is the offender that is named, not the innocent call above it —
    // asserted by LINE, because "one finding" alone would also pass if the guard
    // had flagged `good` and missed `bad`.
    expect(findings[0].line).toBe(12);
  });

  it("does not let an outer hand-built `data` frame an inner helper-routed call", () => {
    // The mirror image, and the one that would produce a FALSE POSITIVE — which is
    // how a compensating control gets relaxed rather than fixed.
    expect(
      findHandBuiltBrainDumpTasks(
        `const data = {
           title: item.text,
           source: TaskSource.BrainDump,
           status: TaskStatus.Active,
           workspaceId,
         };
         async function good(item, workspaceId, tx) {
           const data = brainDumpItemToTaskData(item, workspaceId);
           return tx.task.create({ data });
         }`,
        "synthetic.ts",
      ),
    ).toEqual([]);
  });

  it("flags the EXPLICIT hoisted form, `data: payload`", () => {
    // Review round on `!281`, against the previous round's fix. Closing the
    // `{ data }` shorthand while leaving `data: payload` unresolved left the two
    // syntaxes for one hazard treated differently — and the explicit one is the more
    // natural way to write it, so the guard was closed against the rarer spelling.
    const findings = findHandBuiltBrainDumpTasks(
      `const payload = {
         title: item.text,
         source: TaskSource.BrainDump,
         status: TaskStatus.Active,
         workspaceId,
       };
       await prisma.task.create({ data: payload });`,
      "synthetic.ts",
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].line).toBe(7);
  });

  it("does NOT flag an explicit initialiser that resolves to the helper", () => {
    // The control that keeps this from becoming a guard someone relaxes: the shape
    // the helper exists to provide must stay silent through the identifier too.
    expect(
      findHandBuiltBrainDumpTasks(
        `const payload = brainDumpItemToTaskData(item, workspaceId);
         await tx.task.create({ data: payload });`,
        "synthetic.ts",
      ),
    ).toEqual([]);
  });

  it("still does NOT flag a direct helper call, the original wanted shape", () => {
    // Unchanged behaviour, pinned again because this round widened what an
    // identifier initialiser means and the direct call must not be caught by it.
    expect(
      findHandBuiltBrainDumpTasks(
        `await tx.task.create({ data: brainDumpItemToTaskData(item, workspaceId) });`,
        "synthetic.ts",
      ),
    ).toEqual([]);
  });

  it("does NOT flag a manual task", () => {
    // `createTask` in breakdown.ts. A typed title is not an item, and giving it
    // an item's note would be the opposite bug.
    expect(
      findHandBuiltBrainDumpTasks(
        `await prisma.task.create({
           data: { title: trimmed, source: TaskSource.Manual, workspaceId },
         });`,
        "synthetic.ts",
      ),
    ).toEqual([]);
  });

  it("does NOT flag a create routed through the helper", () => {
    // The shape every conversion site has after #179. The helper supplies
    // `source`, so the call site never names it.
    expect(
      findHandBuiltBrainDumpTasks(
        `await prisma.task.create({
           data: brainDumpItemToTaskData(item, workspaceId),
         });`,
        "synthetic.ts",
      ),
    ).toEqual([]);
  });

  it("does NOT flag another model's create", () => {
    expect(
      findHandBuiltBrainDumpTasks(
        `await prisma.step.create({ data: { source: TaskSource.BrainDump } });`,
        "synthetic.ts",
      ),
    ).toEqual([]);
  });

  it("does NOT flag a mention in a COMMENT — the reason this is an AST", () => {
    // `braindump-to-task.ts` says `prisma.task.create` and `TaskSource.BrainDump`
    // in prose, describing this guard. A regex reports it.
    expect(
      findHandBuiltBrainDumpTasks(
        `// Every prisma.task.create({ data: { source: TaskSource.BrainDump } })
         // must go through the helper.
         const x = 1;`,
        "synthetic.ts",
      ),
    ).toEqual([]);
  });

  it("does NOT flag a create with no object literal to read", () => {
    // A spread or a variable is not evidence of hand-building, and a guard that
    // guesses is a guard that gets relaxed.
    expect(
      findHandBuiltBrainDumpTasks(
        `await prisma.task.create(args);`,
        "synthetic.ts",
      ),
    ).toEqual([]);
  });
});

describe("the real tree", () => {
  it("scans a plausible number of files", () => {
    // A zero from a scanner that visited nothing looks exactly like a clean
    // tree. This is the cheapest thing that can tell them apart.
    expect(scannedFiles().length).toBeGreaterThan(100);
  });

  it("has no hand-built brain-dump task, anywhere", () => {
    const offenders: string[] = [];
    for (const file of scannedFiles()) {
      for (const finding of findHandBuiltBrainDumpTasks(
        readFileSync(file, "utf8"),
        file,
      )) {
        offenders.push(`${file}:${finding.line} — ${finding.reason}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it.each(CONVERSION_SITES)("%s routes through the helper", (file) => {
    expect(readFileSync(file, "utf8")).toContain("brainDumpItemToTaskData(");
  });

  /**
   * The zero above, proved rather than asserted.
   *
   * A passing clean scan is worth exactly as much as the evidence that the same
   * scanner returns non-zero on the same files. So each real conversion site has
   * its routing undone — the precise edit a future writer would make by copying
   * an older sibling — and the detector has to notice.
   */
  it.each(CONVERSION_SITES)("%s would be flagged if it stopped", (file) => {
    const mutated = readFileSync(file, "utf8").replace(
      /brainDumpItemToTaskData\([^)]*\)/g,
      `{ title: item.text, source: TaskSource.BrainDump, status: TaskStatus.Active, workspaceId }`,
    );
    const findings = findHandBuiltBrainDumpTasks(mutated, file);
    expect(findings.length).toBeGreaterThan(0);
  });
});
