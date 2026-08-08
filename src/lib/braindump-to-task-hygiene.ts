/**
 * #179 — the guard `braindump-to-task.ts` promises in its own doc comment.
 *
 * `item.text` becomes a task title in four separate actions. Before #179 they
 * were four independent object literals that happened to agree; the moment
 * `BrainDumpItem` grew a `notes` column, "happened to agree" became "three of
 * them carry the note", and the fourth would have been whichever path had no
 * test — which, for a silently-dropped note, is indistinguishable from working.
 *
 * `brainDumpItemToTaskData` fixed the four. This module is what fails the build
 * when a FIFTH appears, and it is the only part of the argument that still works
 * after everyone involved has forgotten it.
 *
 * ## The rule: a call site that still names its own `source`
 *
 * The helper supplies `source: TaskSource.BrainDump` itself, so routing a writer
 * through it REMOVES that property from the call site. Its presence at a
 * `task.create` therefore is the drift, with no heuristics needed about which
 * variable happened to hold the item.
 *
 * The obvious alternative — look for `title: item.text` — is wrong in both
 * directions. It misses a writer that named its variable something else, and it
 * flags `createTask` in `breakdown.ts`, which builds a genuinely MANUAL task from
 * a typed title and must NOT carry an item's note. Keying on `source` is what
 * makes "brain-dump task" a decidable question rather than a guess.
 *
 * Kept free of `fs` so the parsing is unit-testable on synthetic sources — the
 * shape `a11y-class-hygiene`, `fetch-host-hygiene`, `jsx-text-weld` and
 * `inline-code-style` all share; the colocated test reads the real files.
 *
 * ## The TypeScript AST rather than a regex, and here it is not hypothetical
 *
 * `braindump-to-task.ts` names `prisma.task.create` in its own prose, twice,
 * explaining this guard — and the sibling it cites for the pattern documents the
 * same trap. A regex reports the module that exists to prevent the thing, and a
 * guard that cries wolf is a guard that gets relaxed. This repo has twice
 * shipped a tool that read a comment as code.
 */

import ts from "typescript";

/** One `task.create` that builds its brain-dump row by hand. */
export interface HandBuiltTaskFinding {
  /** 1-based line of the offending `task.create` call. */
  line: number;
  reason: string;
}

/**
 * The value a hand-built brain-dump row gives `source`.
 *
 * Both spellings, because the guard must not be defeatable by inlining the
 * enum's value. `TaskSource.BrainDump` is what the tree writes; `"braindump"` is
 * what `src/lib/constants.ts` defines it as, and it is the string the column
 * actually holds.
 */
const BRAIN_DUMP_SOURCE = /(^|\.)BrainDump$|^["'`]braindump["'`]$/;

/** `x.task.create(...)` — any receiver, so a `tx.` inside a transaction counts. */
function isTaskCreate(node: ts.CallExpression): boolean {
  const callee = node.expression;
  if (!ts.isPropertyAccessExpression(callee)) return false;
  if (callee.name.text !== "create") return false;
  const model = callee.expression;
  return ts.isPropertyAccessExpression(model) && model.name.text === "task";
}

/** The `data:` object literal of a create call, or null when there isn't one. */
/**
 * Resolve `{ data }` shorthand to the object literal it names, when that literal
 * is declared in the same file.
 *
 * Added in review on `!281`. `ts.isPropertyAssignment` is **false** for a
 * `ShorthandPropertyAssignment` — TypeScript treats the two as distinct node
 * kinds — so `create({ data })` was skipped entirely and a hand-built brain-dump
 * task could evade this guard by hoisting one line: declare `const data = { … }`
 * carrying the brain-dump `source`, then pass it to the create call in shorthand.
 *
 * The example is written as prose rather than as a code block ON PURPOSE. Spelling
 * it out literally puts a real-looking create call into this file, and
 * `scoping.harness.test.ts` reads source text — it flagged exactly that on the
 * first attempt at this comment:
 *
 *     src/lib/braindump-to-task-hygiene.ts: task.create
 *       — call must filter by workspaceId
 *
 * A guard that cannot tell a comment from code is still a guard, and the cheaper
 * fix is to not write the bait. (Known repo behaviour: env-drift does the same.)
 *
 * For a check whose entire purpose is to fail the build the moment a fifth writer
 * stops going through `brainDumpItemToTaskData`, an evasion that cheap is the
 * only kind that matters.
 *
 * Same-file only, and deliberately so: this module takes source text, not a
 * `Program`, which is what lets its parsing be unit-tested on synthetic input
 * (the shape every file-parsing guard in this repo follows). A cross-file
 * indirection would need a type checker and would trade that testability for a
 * case nobody has written. If one ever appears, the shorthand still reaches the
 * `null` return below — the same answer as any other unresolvable initialiser,
 * which is the conservative side to fail on for a guard, not the silent side.
 */
/** A node that can hold `const` declarations of its own. */
function isScopeLike(node: ts.Node): boolean {
  return (
    ts.isSourceFile(node) ||
    ts.isBlock(node) ||
    ts.isModuleBlock(node) ||
    ts.isCaseClause(node) ||
    ts.isDefaultClause(node)
  );
}

/** A `data` declared DIRECTLY in this scope — never one inside a nested function. */
function declaredDirectlyIn(
  scope: ts.Node,
  name: string,
): ts.VariableDeclaration | null {
  const statements: ts.NodeArray<ts.Statement> | undefined = ts.isSourceFile(
    scope,
  )
    ? scope.statements
    : ts.isBlock(scope) || ts.isModuleBlock(scope)
      ? scope.statements
      : ts.isCaseClause(scope) || ts.isDefaultClause(scope)
        ? scope.statements
        : undefined;
  if (!statements) return null;
  for (const st of statements) {
    if (!ts.isVariableStatement(st)) continue;
    for (const decl of st.declarationList.declarations) {
      if (ts.isIdentifier(decl.name) && decl.name.text === name) return decl;
    }
  }
  return null;
}

function resolveShorthandData(
  call: ts.Node,
  name: string,
): ts.ObjectLiteralExpression | null {
  // Innermost enclosing scope outwards. Scope-aware because the first attempt was
  // not: it walked the whole file for the FIRST `data` declaration, so a file
  // holding two of them resolved the wrong one for both call sites — silently
  // missing the offender in one direction and inventing one in the other. Both
  // directions are pinned by tests; a false positive is how a compensating control
  // gets relaxed rather than fixed. (Review round on `!281`.)
  for (let scope: ts.Node | undefined = call; scope; scope = scope.parent) {
    if (!isScopeLike(scope)) continue;
    const decl = declaredDirectlyIn(scope, name);
    if (!decl) continue;
    // STOP at the nearest declaration, whatever it holds. Continuing outward past a
    // `const data = brainDumpItemToTaskData(...)` would let an outer hand-built
    // object frame a call that is correctly routed through the helper.
    return decl.initializer && ts.isObjectLiteralExpression(decl.initializer)
      ? decl.initializer
      : null;
  }
  return null;
}

function dataLiteral(
  node: ts.CallExpression,
): ts.ObjectLiteralExpression | null {
  const [arg] = node.arguments;
  if (!arg || !ts.isObjectLiteralExpression(arg)) return null;
  for (const prop of arg.properties) {
    // `{ data }` — resolved to its declaration in this file, so the shorthand is
    // read exactly as `data: { … }` would have been.
    if (
      ts.isShorthandPropertyAssignment(prop) &&
      prop.name.getText() === "data"
    ) {
      return resolveShorthandData(prop, prop.name.text);
    }
    if (!ts.isPropertyAssignment(prop)) continue;
    if (prop.name.getText() !== "data") continue;
    // A spread, a variable or a helper call is NOT evidence of hand-building —
    // `data: brainDumpItemToTaskData(item, workspaceId)` is the shape we want,
    // and a guard that guesses at anything else is a guard that gets relaxed.
    return ts.isObjectLiteralExpression(prop.initializer)
      ? prop.initializer
      : null;
  }
  return null;
}

/** True when `data` names a brain-dump `source` of its own. */
function namesBrainDumpSource(data: ts.ObjectLiteralExpression): boolean {
  for (const prop of data.properties) {
    if (!ts.isPropertyAssignment(prop)) continue;
    if (prop.name.getText() !== "source") continue;
    if (BRAIN_DUMP_SOURCE.test(prop.initializer.getText().trim())) return true;
  }
  return false;
}

/**
 * Every `task.create` in `source` that builds a brain-dump `Task` by hand.
 *
 * `fileName` is only used to give the parse a name; nothing is read from disk.
 */
export function findHandBuiltBrainDumpTasks(
  source: string,
  fileName: string,
): HandBuiltTaskFinding[] {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    // `setParentNodes` is required, not cosmetic: `getText()` walks to the root
    // through `parent`, and without it every property name reads as empty.
    true,
    fileName.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

  const findings: HandBuiltTaskFinding[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && isTaskCreate(node)) {
      const data = dataLiteral(node);
      if (data && namesBrainDumpSource(data)) {
        findings.push({
          line:
            sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
              .line + 1,
          reason:
            "builds a brain-dump Task by hand — pass `data: brainDumpItemToTaskData(item, workspaceId)` instead, or the item's note and schedule intent are dropped on this path only",
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return findings;
}
