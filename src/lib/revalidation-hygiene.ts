/**
 * #139 — pure helpers for asking a server-action module a single question:
 * **which actions write, and which of them invalidate the pages that render
 * what they wrote?**
 *
 * `requeueFocus` was the one mutation in `src/app/actions/focus.ts` that
 * revalidated `/tasks/{id}` and not `/`, so the home list kept showing the old
 * estimate after the database already had the new one. The other five actions
 * in the file all got it right, which is exactly why nobody spotted the sixth.
 *
 * Kept free of `fs` so the parsing is unit-testable on synthetic sources — the
 * same split `manifest-hygiene`, `lockfile-hygiene`, `dockerfile-hygiene` and
 * `fetch-host-hygiene` use; the caller reads the file.
 * `revalidation-hygiene.test.ts` holds the exemption list and the scan over the
 * real tree.
 *
 * ── Why the TypeScript AST and not a regex ──────────────────────────────────
 * Same reasoning as `fetch-host-hygiene` (and `typescript` is already a
 * devDependency): the two things this has to get right are both structural.
 * It must follow a write made through a module-local helper — `completeFocus`
 * and `giveUpFocus` mutate only via `closeSession()` — and it must tell a
 * top-level `revalidatePath("/")` from one nested in an `if`, because
 * `completeFocus` shipped with the branched version and a presence-only check
 * would have called that fine.
 *
 * ── What it deliberately does not see ───────────────────────────────────────
 * Writes made by IMPORTED helpers. `rewardStepDone()` and `awardBadge()` write
 * rows in `@/lib/rewards`, and this scan stops at the module boundary. That is
 * a scope choice, not an oversight: the guard exists to keep one file
 * internally consistent, and following imports would turn a fast unit test into
 * a whole-program analysis. Every action in `focus.ts` that writes through an
 * import also writes directly, so nothing is currently missed — but do not read
 * `writes: []` as "this action is a pure read".
 */

import ts from "typescript";

/** One module-level function and what the scan found in it. */
export interface ActionScan {
  /** Declared name. Anonymous functions are not module-level actions. */
  name: string;
  /** Does the module export it? Only exported functions are server actions. */
  exported: boolean;
  /** 1-based line of the declaration, for the failure message. */
  line: number;
  /**
   * Prisma models this writes, directly or through a module-local helper.
   * Sorted and de-duplicated; empty means "no write this scan can see" (read
   * the module doc for what it cannot).
   */
  writes: string[];
  /**
   * Literal paths passed to `revalidatePath()` from a statement sitting
   * directly in the function body — the ones that run on every path through it.
   */
  revalidates: string[];
  /**
   * Literal paths revalidated only from inside a branch, loop or nested block.
   * Reported separately rather than merged, because "revalidates `/` sometimes"
   * is the shape of the bug, not the fix.
   */
  conditionalRevalidates: string[];
}

/**
 * Prisma client methods that change data. `findFirst`/`findMany`/`count`/
 * `aggregate` and friends are absent on purpose — a read never needs to
 * invalidate anything.
 *
 * `$executeRaw`/`$executeRawUnsafe` are included because they are the escape
 * hatch: unused in this repo today, but a raw UPDATE is still an UPDATE, and a
 * guard that only recognises the ORM is one `$executeRaw` away from useless.
 */
const WRITE_METHODS = new Set([
  "create",
  "createMany",
  "createManyAndReturn",
  "update",
  "updateMany",
  "updateManyAndReturn",
  "upsert",
  "delete",
  "deleteMany",
  "$executeRaw",
  "$executeRawUnsafe",
]);

/** The client identifier those methods hang off (`prisma.step.update(…)`). */
const CLIENT = "prisma";

/**
 * Every identifier that can BE a Prisma client here: the module singleton, plus
 * the two aliases this codebase gives an interactive-transaction client (`tx`)
 * and an injected one (`db`, as in `reverseStepCompletionRewards`'s trailing
 * parameter).
 *
 * #198 review round 4 — the walk below deliberately descends into
 * `prisma.$transaction(async (tx) => …)` callbacks so their writes count, and
 * then this check threw every one of them away for not being spelled `prisma`.
 * The effect was that refactoring an action into a transaction, which a
 * correctness fix routinely does, silently exempted it from the #139 guard
 * altogether — `uncompleteStep` vanished from the focus.ts census the moment it
 * became atomic.
 *
 * Deliberately a closed list of three rather than "any receiver", so a
 * write-shaped call on something that is not a client (`cache.step.delete(…)`)
 * still reports nothing. Kept identical to the receiver list in
 * `src/lib/__tests__/scoping.harness.test.ts`, which has always accepted all
 * three: two guards reading the same source and disagreeing about what a client
 * is called is its own defect.
 */
const CLIENTS = new Set([CLIENT, "tx", "db"]);

type FunctionLike =
  ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction;

function isFunctionLike(node: ts.Node): node is FunctionLike {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node)
  );
}

/**
 * Strip the wrappers that do not change what a call expression is, nor whether
 * it runs. Kept in step with `enclosingStatement` below, which climbs out
 * through the same list from the other side.
 */
function unwrap(node: ts.Expression): ts.Expression {
  let current = node;
  for (;;) {
    if (
      ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isNonNullExpression(current) ||
      ts.isAwaitExpression(current) ||
      ts.isVoidExpression(current)
    ) {
      current = current.expression;
      continue;
    }
    return current;
  }
}

/**
 * Climb OUT of the wrappers that change how an expression is written but not
 * whether it runs, and return the node the expression's statement is.
 *
 * The mirror of `unwrap`, and needed for the same reason (Duo review round 2,
 * !223): `await revalidatePath("/")` puts an `AwaitExpression` between the call
 * and its `ExpressionStatement`, so a parent check that looks exactly one level
 * up sees no statement and silently downgrades a top-level call to
 * "conditional" — a false failure with a misleading message, in a guard whose
 * whole value is that its verdict can be trusted. Duo reported the `await`
 * case; the others are the same mistake in different clothes, so they are
 * handled here rather than waiting to be found one at a time.
 *
 * Terminates: `setParentNodes` gives every node a parent up to the source file,
 * which is none of these.
 */
function enclosingStatement(node: ts.Node): ts.Node {
  let current = node.parent;
  while (
    ts.isAwaitExpression(current) ||
    ts.isParenthesizedExpression(current) ||
    ts.isVoidExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isAsExpression(current)
  ) {
    current = current.parent;
  }
  return current;
}

/** A module-level function declaration, with the node that carries `export`. */
interface Declared {
  name: string;
  fn: FunctionLike;
  exported: boolean;
  line: number;
}

function declaredFunctions(source: ts.SourceFile): Declared[] {
  const found: Declared[] = [];
  const lineOf = (node: ts.Node) =>
    source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;

  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      found.push({
        name: statement.name.text,
        fn: statement,
        exported: Boolean(
          ts.getCombinedModifierFlags(statement) & ts.ModifierFlags.Export,
        ),
        line: lineOf(statement),
      });
      continue;
    }
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!declaration.initializer || !ts.isIdentifier(declaration.name)) {
        continue;
      }
      const initializer = unwrap(declaration.initializer);
      if (!isFunctionLike(initializer)) continue;
      found.push({
        name: declaration.name.text,
        fn: initializer,
        exported: Boolean(
          ts.getCombinedModifierFlags(declaration) & ts.ModifierFlags.Export,
        ),
        line: lineOf(declaration),
      });
    }
  }
  return found;
}

/**
 * The model written by the thing being invoked, given the expression in
 * callee/tag position: `<client>.<model>.<writeMethod>` → `<model>`, else null.
 * `<client>` is any of `CLIENTS` — see there for why it is not just `prisma`.
 *
 * Takes the callee rather than the whole node so it serves both invocation
 * forms — `prisma.step.update({…})` is a `CallExpression`, while
 * ``prisma.$executeRaw`UPDATE …` `` is a `TaggedTemplateExpression` (Duo
 * review, !223). Listing `$executeRaw` in `WRITE_METHODS` while only ever
 * looking at calls would have made the doc comment's claim about the raw
 * escape hatch false, which is worse than not claiming it.
 */
function writtenModel(invoked: ts.Expression): string | null {
  const callee = unwrap(invoked);
  if (!ts.isPropertyAccessExpression(callee)) return null;
  if (!WRITE_METHODS.has(callee.name.text)) return null;

  // `prisma.$executeRaw` (or `tx.$executeRaw`) — no model segment, so name the
  // client itself. Reported as `CLIENT` whichever alias it was written on: the
  // census cares that the raw escape hatch wrote something, not which handle
  // reached it.
  if (
    ts.isIdentifier(callee.expression) &&
    CLIENTS.has(callee.expression.text)
  ) {
    return CLIENT;
  }
  const model = unwrap(callee.expression);
  if (!ts.isPropertyAccessExpression(model)) return null;
  if (!ts.isIdentifier(model.expression)) return null;
  if (!CLIENTS.has(model.expression.text)) return null;
  return model.name.text;
}

/** What one function body does on its own, before following helpers. */
interface Direct {
  models: Set<string>;
  /** Names of same-module functions it calls — and nothing else. */
  calls: Set<string>;
  revalidates: string[];
  conditionalRevalidates: string[];
}

/**
 * @param localNames every function declared at module scope, so `calls` holds
 *   only same-module edges. Without it the set collected every bare-identifier
 *   callee — `Number(…)`, `revalidatePath` aside — and `transitiveWrites`
 *   silently dropped the ones it could not resolve (Duo review round 6, !223).
 *   No verdict changes, because the drop happened anyway; what changes is that
 *   `calls` now means what its doc comment says, and a future module-local
 *   helper sharing a name with a global cannot inherit a phantom edge from it.
 */
function scanBody(fn: FunctionLike, localNames: Set<string>): Direct {
  const direct: Direct = {
    models: new Set(),
    calls: new Set(),
    revalidates: [],
    conditionalRevalidates: [],
  };
  if (!fn.body) return direct;
  const body = fn.body;

  const visit = (node: ts.Node): void => {
    // ``prisma.$executeRaw`UPDATE …` `` — a write, and not a CallExpression.
    if (ts.isTaggedTemplateExpression(node)) {
      const model = writtenModel(node.tag);
      if (model) direct.models.add(model);
    }
    if (ts.isCallExpression(node)) {
      const model = writtenModel(node.expression);
      if (model) direct.models.add(model);

      const callee = unwrap(node.expression);
      if (ts.isIdentifier(callee)) {
        if (callee.text === "revalidatePath") {
          const [first] = node.arguments;
          // Only a string literal is credited: a computed path could be
          // anything, and a guard that assumes the best is decoration.
          if (first && ts.isStringLiteral(first)) {
            // Unconditional == the call runs on every route through the
            // function. Anything else (an `if` consequent, a nested block, a
            // `&&`, a ternary, a loop) can be skipped at run time.
            //
            // Two body shapes, because an arrow function has two (Duo review
            // round 3, !223, which suggested documenting the second as a known
            // limitation — it is one line to close, and a guard with a
            // documented blind spot is a guard someone will one day be trusted
            // through):
            //
            //  * BLOCK body — the call's statement is a direct child of it.
            //  * CONCISE body (`() => revalidatePath("/")`) — the body IS one
            //    expression, so the call runs iff it is that expression, seen
            //    through the wrappers that do not gate it. `x && …` and
            //    `c ? … : …` are not, and stay conditional.
            const statement = enclosingStatement(node);
            const unconditional = ts.isBlock(body)
              ? ts.isExpressionStatement(statement) && statement.parent === body
              : unwrap(body) === node;
            (unconditional
              ? direct.revalidates
              : direct.conditionalRevalidates
            ).push(first.text);
          }
        } else if (localNames.has(callee.text)) {
          direct.calls.add(callee.text);
        }
      }
    }
    // Deliberately walks INTO nested functions (Duo review, !223 — which
    // suggested stopping at function-scope boundaries). A write inside
    // `prisma.$transaction(async (tx) => …)`, inside `await Promise.all([…])`,
    // or inside a `.then()` genuinely executes, so scoping the walk would make
    // this guard silently miss the exact class of omission (#139) it exists to
    // catch. The cost of the other direction is bounded and visible: at worst
    // one spurious `revalidatePath("/")`, or one allowlist entry with a stated
    // reason. A guard that fails closed is the only kind worth having, and
    // `revalidation-hygiene.test.ts` pins both cases so this stays a decision
    // rather than an accident.
    ts.forEachChild(node, visit);
  };
  visit(body);
  return direct;
}

/**
 * Every module-level function in `source`, with the models it writes
 * (transitively through module-local helpers) and where it revalidates.
 *
 * Parsed with `isolatedModules`-style leniency: no type checker, no file
 * system, no module resolution — a string in, a verdict out.
 */
export function scanServerActions(
  source: string,
  fileName = "actions.ts",
): ActionScan[] {
  const parsed = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TS,
  );

  const declared = declaredFunctions(parsed);
  // Collected before any body is scanned, because `scanBody` needs to know
  // which callees are module-local and the map it would otherwise consult is
  // still being built at that point.
  const localNames = new Set(declared.map((d) => d.name));
  const direct = new Map(
    declared.map((d) => [d.name, scanBody(d.fn, localNames)]),
  );

  /**
   * Models written by `name`, following module-local calls breadth-first.
   *
   * No hop ceiling (Duo review round 3, !223, which read the old `MAX_DEPTH`
   * off-by-one). `seen` is what makes this terminate, and it does so provably:
   * a name is expanded at most once, and `next` only collects names not already
   * expanded, so the walk is bounded by the number of identifiers in the file.
   * A fixed ceiling on top of that could do exactly one thing — silently
   * TRUNCATE a legitimately deep helper chain — and a guard that exists to
   * notice omissions must not have a way to quietly stop looking.
   */
  const transitiveWrites = (name: string): string[] => {
    const models = new Set<string>();
    const seen = new Set<string>();
    let frontier = [name];
    while (frontier.length > 0) {
      const next: string[] = [];
      for (const current of frontier) {
        if (seen.has(current)) continue;
        seen.add(current);
        const body = direct.get(current);
        if (!body) continue; // an import or a builtin — outside this module
        for (const model of body.models) models.add(model);
        for (const called of body.calls) {
          if (!seen.has(called)) next.push(called);
        }
      }
      frontier = next;
    }
    return [...models].sort();
  };

  return declared.map((d) => {
    const body = direct.get(d.name)!;
    return {
      name: d.name,
      exported: d.exported,
      line: d.line,
      writes: transitiveWrites(d.name),
      revalidates: body.revalidates,
      conditionalRevalidates: body.conditionalRevalidates,
    };
  });
}
