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
 *
 * ## The second rule: the create must be inside a transaction with a budget
 * (#244)
 *
 * #225 gave three of the four writers a precondition inside a transaction, and
 * left `scheduleSingleTask` — which #244 closed. All four now share one shape,
 * and one thing about that shape is invisible in review and silently wrong when
 * it is missing: **the transaction's timeout.**
 *
 * Prisma's default is 5 s, and these transactions exist precisely to make a
 * second caller WAIT for the winner's row lock. Measured on real Postgres during
 * `!306`'s review, a lock held 6.5 s killed the waiter with `P2028 Transaction
 * already closed` — which converts the no-op every one of these guards is
 * documented as giving into an error raised at somebody who pressed a button
 * twice. `TASK_WRITER_TX_BUDGET` (`src/lib/constants.ts`) exists for that, and
 * dropping it is a one-token edit with no visible symptom until a slow server.
 *
 * So `findUnbudgetedBrainDumpTaskWrites` requires every `task.create` routed
 * through the helper to sit inside a `$transaction(…)` call that was given an
 * explicit options argument. It is the natural companion to the rule above rather
 * than a separate module, because the two describe one construction: this is the
 * only place in the repo that knows which `task.create` calls are brain-dump
 * writers, and the answer is what both rules need.
 *
 * `inbox-write-hygiene`, which #225 added, is NOT the right home for it — that
 * module answers "which functions in `inbox-view.tsx` start a bare
 * `startTransition`", and a server action starts none. Recorded here because the
 * two guards came out of the same review and the confusion is easy to make.
 *
 * The budget is accepted as either the shared constant or any options literal
 * that names `timeout`. Requiring the constant by name would be stronger, and it
 * would also flag a writer that deliberately chose a different budget and said
 * so — the invariant worth enforcing is that somebody *decided*, not which value
 * they picked.
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
    if (ts.isObjectLiteralExpression(prop.initializer)) return prop.initializer;
    // `data: payload` — the SAME hoisting evasion the shorthand branch above
    // closes, in the spelling people actually reach for first. Resolving only the
    // shorthand left one hazard with two syntaxes and a guard covering the rarer
    // one (review round on `!281`, against the previous round's fix).
    //
    // This narrows the original "a variable is not evidence of hand-building"
    // rule rather than contradicting it: the concern behind that sentence was
    // GUESSING, and this does not guess. It resolves the identifier to a
    // declaration in the call site's own scope and reads the object literally, or
    // gives up. A helper call, a spread, a parameter or anything from another file
    // still yields `null` — which the three colocated control tests pin, because
    // widening what a guard catches is how it acquires false positives and then
    // gets relaxed.
    if (ts.isIdentifier(prop.initializer)) {
      return resolveShorthandData(prop, prop.initializer.text);
    }
    return null;
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

/** The name every brain-dump→Task writer routes its `data` through (#179). */
const CONVERSION_HELPER = "brainDumpItemToTaskData";

/**
 * The initialiser a `data` identifier resolves to in the call site's own scope.
 *
 * Deliberately a sibling of `resolveShorthandData` rather than a widening of it:
 * that one returns an object literal because the rule above is about hand-built
 * literals, and this one needs the expression whatever kind it is, because the
 * rule below is about a helper CALL. The scope walk is identical and stops at the
 * nearest declaration for the same reason — continuing outward past a local
 * `data` would let an unrelated outer one answer for this call site.
 */
function resolveDataExpression(
  call: ts.Node,
  name: string,
): ts.Expression | null {
  for (let scope: ts.Node | undefined = call; scope; scope = scope.parent) {
    if (!isScopeLike(scope)) continue;
    const decl = declaredDirectlyIn(scope, name);
    if (!decl) continue;
    return decl.initializer ?? null;
  }
  return null;
}

/** Is this expression a call to the conversion helper? */
function isConversionCall(expr: ts.Expression | null): boolean {
  return (
    expr !== null &&
    ts.isCallExpression(expr) &&
    ts.isIdentifier(expr.expression) &&
    expr.expression.text === CONVERSION_HELPER
  );
}

/** Does this `task.create` build its row through `brainDumpItemToTaskData`? */
function isConversionRouted(node: ts.CallExpression): boolean {
  const [arg] = node.arguments;
  if (!arg || !ts.isObjectLiteralExpression(arg)) return false;
  for (const prop of arg.properties) {
    // `create({ data })`, resolved to its declaration in this file.
    if (
      ts.isShorthandPropertyAssignment(prop) &&
      prop.name.getText() === "data"
    ) {
      return isConversionCall(resolveDataExpression(prop, prop.name.text));
    }
    if (!ts.isPropertyAssignment(prop)) continue;
    if (prop.name.getText() !== "data") continue;
    // `data: brainDumpItemToTaskData(item, workspaceId)` — the shape all four
    // writers actually use.
    if (isConversionCall(prop.initializer)) return true;
    // `data: payload`, the hoisted spelling the rule above also resolves.
    if (ts.isIdentifier(prop.initializer)) {
      return isConversionCall(
        resolveDataExpression(prop, prop.initializer.text),
      );
    }
    return false;
  }
  return false;
}

/** `x.$transaction(…)` — any receiver, so a re-exported client still counts. */
function isTransactionCall(node: ts.Node): node is ts.CallExpression {
  if (!ts.isCallExpression(node)) return false;
  const callee = node.expression;
  return (
    ts.isPropertyAccessExpression(callee) && callee.name.text === "$transaction"
  );
}

/**
 * Was this `$transaction` given a budget?
 *
 * Either the shared constant by name, or any options object that names
 * `timeout`. A bare `$transaction(cb)` is the finding: it inherits Prisma's 5 s
 * default, which is shorter than these transactions are designed to WAIT.
 */
function hasExplicitBudget(call: ts.CallExpression): boolean {
  const options = call.arguments[1];
  if (!options) return false;
  if (ts.isIdentifier(options)) return true;
  if (ts.isObjectLiteralExpression(options)) {
    return options.properties.some(
      (p) =>
        (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) &&
        p.name.getText() === "timeout",
    );
  }
  return false;
}

/** One brain-dump `task.create` whose transaction has no explicit budget (#244). */
export interface UnbudgetedTaskWriteFinding {
  /** 1-based line of the `task.create` call. */
  line: number;
  reason: string;
}

/**
 * Every helper-routed `task.create` in `source` that is not inside a
 * `$transaction` carrying an explicit timeout budget (#244).
 *
 * `fileName` is only used to give the parse a name; nothing is read from disk.
 *
 * The two failure modes are reported separately because they are different
 * mistakes with different fixes — "no transaction at all" reopens the orphan a
 * failed link leaves behind, while "no budget" reopens the `P2028` that turns a
 * losing caller's no-op into an error.
 */
export function findUnbudgetedBrainDumpTaskWrites(
  source: string,
  fileName: string,
): UnbudgetedTaskWriteFinding[] {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    // Required for the same reason as above: `getText()` and the ancestor walk
    // below both need `parent` links.
    true,
    fileName.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

  const findings: UnbudgetedTaskWriteFinding[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && isTaskCreate(node)) {
      if (isConversionRouted(node)) {
        // Nearest enclosing `$transaction`, walking out through the arrow
        // function the callback is written as. Nearest rather than any, because a
        // nested transaction would be the one that owns this write.
        let enclosing: ts.CallExpression | null = null;
        for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
          if (isTransactionCall(n)) {
            enclosing = n;
            break;
          }
        }
        const line =
          sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
            .line + 1;
        if (!enclosing) {
          findings.push({
            line,
            reason:
              "a brain-dump `task.create` outside any `$transaction` — the insert and the item link must commit together, or a failed link orphans the Task and the retry makes a second one",
          });
        } else if (!hasExplicitBudget(enclosing)) {
          findings.push({
            line,
            reason:
              "`$transaction` with no explicit timeout budget — pass `TASK_WRITER_TX_BUDGET`, because Prisma's 5 s default kills a caller that waits longer than that for the winner's row lock with `P2028` and turns a documented no-op into an error",
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return findings;
}
