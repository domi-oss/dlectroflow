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
 * rounds were spent getting right. The pair needs none of it: every Prisma
 * upsert argument carries `create` alongside `update` — top-level ones add
 * `where`, nested ones do not — so the pair identifies the construct wherever it
 * is written, and the scan is one pass over every object literal in the file.
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
 * an empty `patch`, or an identifier resolved from elsewhere. Deciding those
 * needs a type checker and a constant folder, and the failure direction here is
 * the safe one: a miss costs nothing until the shape appears literally again,
 * whereas a false positive costs a pipeline and ends with somebody relaxing the
 * rule. Every one of the three real instances was written literally.
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
 */
function payloads(expression: ts.Expression): ts.Expression[] {
  if (ts.isParenthesizedExpression(expression)) {
    return payloads(expression.expression);
  }
  if (ts.isConditionalExpression(expression)) {
    return [
      ...payloads(expression.whenTrue),
      ...payloads(expression.whenFalse),
    ];
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

/** The named (non-spread) properties of an object literal, by key. */
function namedProperty(
  literal: ts.ObjectLiteralExpression,
  key: string,
): ts.PropertyAssignment | null {
  for (const prop of literal.properties) {
    if (!ts.isPropertyAssignment(prop)) continue;
    // `getText()` rather than `.text`: the key may be written `"update"` or
    // `'update'` as well as bare, and a quoted key is the same property.
    if (prop.name.getText().replace(/^["'`]|["'`]$/g, "") === key) return prop;
  }
  return null;
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
      if (update && payloads(update.initializer).some(isEmptyObjectLiteral)) {
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
