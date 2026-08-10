/**
 * #223 — the guard for a class this repo shipped three times.
 *
 * An upsert whose update payload is EMPTY is not atomic. Prisma 6.19 compiles an
 * upsert to a native `INSERT … ON CONFLICT` **only when that payload is
 * non-empty**; with an empty one it degrades to `BEGIN; SELECT; INSERT; COMMIT`
 * — a read-then-insert at READ COMMITTED. Two concurrent callers from the no-row
 * state both insert, and the loser raises P2002.
 *
 * The fix is always the same and is already written out three times in this
 * codebase (`src/lib/db.ts`'s `firstUseByWorkspace`, `src/lib/rewards.ts`,
 * `src/app/actions/people.ts`): `createMany` / `createManyAndReturn` with
 * `skipDuplicates`, the only Prisma API that compiles to
 * `INSERT … ON CONFLICT DO NOTHING`. Catching the P2002 instead does not work —
 * Prisma's client logger prints a failed query strictly before any `catch` sees
 * it, so a fully handled duplicate still reports an incident (#156, #158, and
 * the note on `log` in `src/lib/db.ts`).
 *
 * ## Why a guard and not a review note
 *
 * Two of the three sites carried a comment asserting the race was closed. That
 * is not carelessness, it is the shape of the trap: the construct reads as
 * though somebody considered concurrency and answered it, so it never invites a
 * second look. Nobody can be asked to hold a Prisma compilation rule in their
 * head across a review; this can.
 *
 * ## The rule: `create` and an empty `update` in the same object literal
 *
 * Both halves are load-bearing.
 *
 * **Not "an empty `update` anywhere".** An unrelated object that happens to
 * carry an `update` key — an action map, a config default — is not a Prisma
 * upsert argument, and a guard whose first act is to demand a change with no
 * defect behind it is a guard that gets relaxed.
 *
 * **Not "inside an `upsert(` call" either**, which is the obvious framing and is
 * defeatable by hoisting: assign the same object to a `const` one line above and
 * the call expression no longer has a literal to read. Following the argument
 * would mean resolving identifiers through scopes, which
 * `braindump-to-task-hygiene` had to do for its own rule and which two review
 * rounds were spent getting right. Finding the CONSTRUCT needs none of it: every
 * Prisma upsert argument carries `create` alongside `update` — top-level ones add
 * `where`, nested ones do not — so the pair identifies it wherever it is written,
 * and the scan is one pass over every object literal in the file.
 *
 * Scope resolution does appear below, for a strictly smaller job: reading the
 * PAYLOAD when it is written as a name rather than a literal (`!302`, and the
 * boundary section at the end). Anchoring on the pair is what keeps that job
 * small enough to be safe — it only ever runs on an object already known to be
 * an upsert argument, never on every identifier in the file.
 *
 * ## The TypeScript AST rather than a regex, and here it is not hypothetical
 *
 * Both files fixed under #223 now **describe the defective shape in prose**,
 * because the comments that claimed a closed race had to be replaced with ones
 * that say what changed. A regex reports those two modules, on the very lines
 * explaining the fix. This repo has twice shipped a tool that read a comment as
 * code (`manifest-hygiene` #76, `env-drift` #30 — the reason
 * `src/lib/source-text.ts` exists); a parser gets it for free, the same call
 * `braindump-to-task-hygiene`, `fetch-host-hygiene` and `git-env-hygiene` make.
 *
 * Kept free of `fs` so the parsing is unit-testable on synthetic input — the
 * shape every file-parsing guard in this repo follows. The colocated test reads
 * the real tree, and mutates each converted site back to prove the same scanner
 * returns non-zero.
 *
 * ## What it cannot see, stated rather than left to be discovered
 *
 * An update payload that is empty only at RUNTIME — `update: { ...patch }` with
 * an empty `patch`, a payload assembled key by key after its declaration, or a
 * binding this file cannot read: a parameter, a `let`, an import, a destructured
 * name. Deciding those needs a type checker and a constant folder, and the
 * failure direction here is the safe one: a miss costs nothing until the shape
 * appears literally again, whereas a false positive costs a pipeline and ends
 * with somebody relaxing the rule. Every one of the three real instances was
 * written literally.
 *
 * What it *can* now see, added in review on `!302`, is the payload written as an
 * identifier — `update: payload` or the `{ update }` shorthand — when that name
 * resolves, in this file, to a `const` holding an empty object literal that
 * nothing else touches. That is the hoisting evasion the rule was already built
 * to defeat, moved one level in: hoist the property instead of the object. It is
 * resolution, not inference — anything the walk cannot read literally comes back
 * as "not knowably empty", which is a miss and never a guess. The sibling guard
 * `braindump-to-task-hygiene` spent two review rounds on `!281` establishing both
 * halves of that: resolve the NEAREST binding rather than the file's first, and
 * cover both spellings, because leaving one of two syntaxes uncovered is a guard
 * that only catches the rarer way of writing the same thing.
 */

import ts from "typescript";

/** One object literal that pairs `create` with an empty `update`. */
export interface EmptyUpsertFinding {
  /** 1-based line of the offending `update` property. */
  line: number;
  reason: string;
}

const REASON =
  "an upsert with an empty update payload is NOT atomic — Prisma compiles " +
  "`INSERT … ON CONFLICT` only for a non-empty payload, so this is a " +
  "read-then-insert and a concurrent caller raises P2002 (#223). Use " +
  "`createMany`/`createManyAndReturn` with `skipDuplicates: true`, then read " +
  "the winner's row back";

/**
 * The operators whose result is one of their two operands, so both are payloads
 * this call can hand Prisma.
 *
 * `??` and `||` were raised in review on `!302`, and they are not a new case:
 * `a ?? {}` IS `a != null ? a : {}`, the very shape the conditional branch below
 * exists for. `&&` is the mirror image — it yields the empty right operand when
 * the left is truthy — and costs one line to cover rather than wait for.
 */
const BRANCHING_OPERATORS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.QuestionQuestionToken,
  ts.SyntaxKind.BarBarToken,
  ts.SyntaxKind.AmpersandAmpersandToken,
]);

/**
 * Every payload an expression can hand Prisma, as written.
 *
 * A conditional is not a hypothetical: the third instance of #223 was
 * `update: options.resurface ? { clearedAt: null } : {}` in `syncShoppingSummary`
 * (`!295`, fixed in `2b993ea`). **Prisma chooses its SQL per call, from the
 * payload it is actually handed**, so a conditional with one empty branch is the
 * defect on every call that takes that branch — and it is the one instance a
 * guard asking "is the initializer an empty object literal" walks straight past.
 * Both branches are therefore returned, and either one being empty is a finding.
 *
 * Parentheses are unwrapped for the same reason `braindump-to-task-hygiene`
 * resolves a hoisted identifier: they change nothing and would hide everything.
 * `as`, `satisfies` and `!` join them because they are the same thing at the type
 * level, and an empty payload is exactly where somebody reaches for one — it is
 * the one shape Prisma's generated input types will not infer usefully from.
 */
function payloads(expression: ts.Expression): ts.Expression[] {
  if (
    ts.isParenthesizedExpression(expression) ||
    ts.isAsExpression(expression) ||
    ts.isSatisfiesExpression(expression) ||
    ts.isNonNullExpression(expression) ||
    ts.isTypeAssertionExpression(expression)
  ) {
    return payloads(expression.expression);
  }
  if (ts.isConditionalExpression(expression)) {
    return [
      ...payloads(expression.whenTrue),
      ...payloads(expression.whenFalse),
    ];
  }
  if (
    ts.isBinaryExpression(expression) &&
    BRANCHING_OPERATORS.has(expression.operatorToken.kind)
  ) {
    return [...payloads(expression.left), ...payloads(expression.right)];
  }
  return [expression];
}

/** An object literal with no properties at all — a spread is not one. */
function isEmptyObjectLiteral(expression: ts.Expression): boolean {
  return (
    ts.isObjectLiteralExpression(expression) &&
    // Zero properties, so a spread — which may hold anything at runtime — is
    // not the defective shape as written.
    expression.properties.length === 0
  );
}

/**
 * A property that names a value, in either spelling.
 *
 * `ts.isPropertyAssignment` is **false** for a shorthand — TypeScript treats the
 * two as distinct node kinds — which is what let `{ where, create, update: {} }`
 * through: the `create` half of the pair was invisible, so an `update: {}`
 * written out in full two keys along went unreported. Raised on `!302`; the same
 * distinction cost `braindump-to-task-hygiene` a round on `!281`.
 */
type NamedProperty = ts.PropertyAssignment | ts.ShorthandPropertyAssignment;

/** The named (non-spread, non-method) properties of an object literal, by key. */
function namedProperty(
  literal: ts.ObjectLiteralExpression,
  key: string,
): NamedProperty | null {
  for (const prop of literal.properties) {
    if (
      !ts.isPropertyAssignment(prop) &&
      !ts.isShorthandPropertyAssignment(prop)
    ) {
      continue;
    }
    // `getText()` rather than `.text`: the key may be written `"update"` or
    // `'update'` as well as bare, and a quoted key is the same property.
    if (prop.name.getText().replace(/^["'`]|["'`]$/g, "") === key) return prop;
  }
  return null;
}

/**
 * The expression a property hands over. A shorthand's own name IS that
 * expression, which is what collapses `{ update }` into the identifier case
 * below rather than making it a branch of its own.
 */
function payloadOf(property: NamedProperty): ts.Expression {
  return ts.isShorthandPropertyAssignment(property)
    ? property.name
    : property.initializer;
}

/** A node that can hold declarations of its own. */
function isScopeLike(node: ts.Node): boolean {
  return (
    ts.isSourceFile(node) ||
    ts.isBlock(node) ||
    ts.isModuleBlock(node) ||
    ts.isCaseClause(node) ||
    ts.isDefaultClause(node) ||
    ts.isForStatement(node) ||
    ts.isForOfStatement(node) ||
    ts.isForInStatement(node) ||
    ts.isCatchClause(node) ||
    ts.isFunctionLike(node)
  );
}

/** The statements a scope declares directly in, never a nested one's. */
function statementsOf(scope: ts.Node): readonly ts.Statement[] {
  if (ts.isSourceFile(scope) || ts.isBlock(scope) || ts.isModuleBlock(scope)) {
    return scope.statements;
  }
  if (ts.isCaseClause(scope) || ts.isDefaultClause(scope)) {
    return scope.statements;
  }
  return [];
}

/** True when this binding form introduces `wanted`, destructuring included. */
function bindsName(name: ts.BindingName, wanted: string): boolean {
  if (ts.isIdentifier(name)) return name.text === wanted;
  return name.elements.some(
    (element) =>
      ts.isBindingElement(element) && bindsName(element.name, wanted),
  );
}

/**
 * `readable` — a `const` whose initializer can be read literally. `opaque` — the
 * name IS bound here, but by something this module refuses to guess at. The
 * distinction is the whole point: an opaque binding STOPS the outward walk,
 * because continuing past a parameter or a `let` is how a resolver frames a call
 * with an unrelated outer literal and invents a finding.
 */
type Binding =
  | { readonly kind: "readable"; readonly expression: ts.Expression }
  | { readonly kind: "opaque" };

const OPAQUE: Binding = { kind: "opaque" };

function fromDeclarations(
  list: ts.VariableDeclarationList,
  wanted: string,
): Binding | null {
  for (const declaration of list.declarations) {
    if (!bindsName(declaration.name, wanted)) continue;
    // Destructured (the value is written elsewhere), reassignable, or declared
    // with nothing to read. Bound, so the walk stops here — just not readable.
    if (!ts.isIdentifier(declaration.name)) return OPAQUE;
    if ((list.flags & ts.NodeFlags.Const) === 0) return OPAQUE;
    if (!declaration.initializer) return OPAQUE;
    return { kind: "readable", expression: declaration.initializer };
  }
  return null;
}

/** Whether an import statement introduces `wanted`, in any of its spellings. */
function importBinds(
  declaration: ts.ImportDeclaration,
  wanted: string,
): boolean {
  const clause = declaration.importClause;
  if (!clause) return false;
  if (clause.name?.text === wanted) return true;
  const bindings = clause.namedBindings;
  if (!bindings) return false;
  return ts.isNamespaceImport(bindings)
    ? bindings.name.text === wanted
    : bindings.elements.some((element) => element.name.text === wanted);
}

/** What this one scope — and nothing inside or outside it — binds `wanted` to. */
function bindingIn(scope: ts.Node, wanted: string): Binding | null {
  if (ts.isFunctionLike(scope)) {
    return scope.parameters.some((parameter) =>
      bindsName(parameter.name, wanted),
    )
      ? OPAQUE
      : null;
  }
  if (ts.isCatchClause(scope)) {
    return scope.variableDeclaration &&
      bindsName(scope.variableDeclaration.name, wanted)
      ? OPAQUE
      : null;
  }
  if (
    ts.isForStatement(scope) ||
    ts.isForOfStatement(scope) ||
    ts.isForInStatement(scope)
  ) {
    const { initializer } = scope;
    return initializer && ts.isVariableDeclarationList(initializer)
      ? fromDeclarations(initializer, wanted)
      : null;
  }
  for (const statement of statementsOf(scope)) {
    if (ts.isVariableStatement(statement)) {
      const binding = fromDeclarations(statement.declarationList, wanted);
      if (binding) return binding;
      continue;
    }
    if (
      (ts.isFunctionDeclaration(statement) ||
        ts.isClassDeclaration(statement) ||
        ts.isEnumDeclaration(statement)) &&
      statement.name?.text === wanted
    ) {
      return OPAQUE;
    }
    if (ts.isImportDeclaration(statement) && importBinds(statement, wanted)) {
      return OPAQUE;
    }
  }
  return null;
}

/**
 * True when this identifier READS the binding of that name, rather than merely
 * spelling the same word where a name is not a value — `other.update`,
 * `{ update: … }`, a declaration or a parameter of its own.
 *
 * Being wrong in the permissive direction is safe: every extra "yes" only makes
 * the resolver below give up, and giving up is a miss, not a false positive. So
 * the rule is deliberately blunt — an identifier that is its parent's `name` is
 * a name — with the one exception that a shorthand's name is the key AND the
 * read.
 */
function readsBinding(identifier: ts.Identifier): boolean {
  const parent = identifier.parent as
    (ts.Node & { name?: ts.Node }) | undefined;
  if (!parent) return true;
  if (ts.isShorthandPropertyAssignment(parent)) return true;
  return parent.name !== identifier;
}

/** Any read of `wanted` inside `scope` other than the one being resolved. */
function referencedElsewhere(
  scope: ts.Node,
  wanted: string,
  use: ts.Identifier,
): boolean {
  let found = false;
  const visit = (node: ts.Node) => {
    if (found) return;
    if (
      ts.isIdentifier(node) &&
      node.text === wanted &&
      node !== use &&
      readsBinding(node)
    ) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(scope);
  return found;
}

/**
 * The expression an identifier payload was declared with, or null when this file
 * cannot say.
 *
 * Innermost scope outwards, stopping at the nearest binding whatever it holds.
 * Scope-awareness is not caution for its own sake: the sibling guard's first
 * attempt walked the whole file for the FIRST matching declaration, so a file
 * holding two resolved the wrong one for both call sites — silently missing the
 * offender in one direction and inventing one in the other (`!281`).
 */
function resolvePayload(reference: ts.Identifier): ts.Expression | null {
  const wanted = reference.text;
  for (
    let scope: ts.Node | undefined = reference;
    scope;
    scope = scope.parent
  ) {
    if (!isScopeLike(scope)) continue;
    const binding = bindingIn(scope, wanted);
    if (!binding) continue;
    if (binding.kind === "opaque") return null;
    // `const` freezes the binding, not the object. A payload assembled key by
    // key after its declaration is the legitimate way to write a conditional
    // update and is empty only at RUNTIME, which is the stated boundary — so any
    // other read of the name in the declaring scope makes the answer "not
    // knowably empty" rather than a guess in either direction.
    if (referencedElsewhere(scope, wanted, reference)) return null;
    return binding.expression;
  }
  return null;
}

/** Whether any payload this expression can produce is empty, as written. */
function hasEmptyPayload(
  expression: ts.Expression,
  seen: ReadonlySet<string>,
): boolean {
  return payloads(expression).some((branch) => {
    if (isEmptyObjectLiteral(branch)) return true;
    // A `const a = b; const b = a;` cycle cannot execute, but it can be parsed.
    if (!ts.isIdentifier(branch) || seen.has(branch.text)) return false;
    const bound = resolvePayload(branch);
    return (
      bound !== null && hasEmptyPayload(bound, new Set([...seen, branch.text]))
    );
  });
}

/**
 * Every object literal in `source` that pairs a `create` with an empty
 * `update` — a Prisma upsert argument written the way that does not race-proof
 * anything.
 *
 * `fileName` only names the parse; nothing is read from disk.
 */
export function findEmptyUpsertUpdates(
  source: string,
  fileName: string,
): EmptyUpsertFinding[] {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    // `setParentNodes` is required, not cosmetic: `getText()` walks to the root
    // through `parent`, and without it every property name reads as empty.
    true,
    fileName.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

  const findings: EmptyUpsertFinding[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isObjectLiteralExpression(node) && namedProperty(node, "create")) {
      const update = namedProperty(node, "update");
      if (update && hasEmptyPayload(payloadOf(update), new Set())) {
        findings.push({
          line:
            sourceFile.getLineAndCharacterOfPosition(
              update.getStart(sourceFile),
            ).line + 1,
          reason: REASON,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return findings;
}
