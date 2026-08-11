/**
 * #225 — pure helper for one question about the inbox view: **which functions
 * start a transition of their own, rather than going through the one place that
 * reports a write that did not land?**
 *
 * `run()` was hardened so that "a new call site inherits the behaviour", and the
 * hardening held for the twenty call sites the issue enumerated. It did not hold
 * for the two it did not: `breakdown` and `focusOnItem` kept their own
 * `startTransition(async () => { await action(); router.push(…) })` — no `try`, no
 * notice — for ten commits of an MR whose title says every inbox row write says so
 * when it does not land, and nothing in a 1300-line test suite could see it
 * (!306, substitute review). A guard that only covers the sites somebody
 * remembered to list is the same guard that let those two through.
 *
 * So the invariant is structural, and stated as a closed set: a bare
 * `startTransition` in `inbox-view.tsx` is either the write machinery itself or
 * one of the surfaces with its own reporting, and there is no third kind. Adding a
 * fourth requires editing the allow-list, which is where a reviewer is asked the
 * question "what tells the user when this one fails?".
 *
 * Kept free of `fs` so the parsing is unit-testable on synthetic sources — the
 * same split `revalidation-hygiene`, `manifest-hygiene`, `fetch-host-hygiene` and
 * `dockerfile-hygiene` use; the caller reads the file. `inbox-write-hygiene.test.ts`
 * holds the allow-list and the scan over the real tree.
 *
 * ## Why the TypeScript AST and not a regex
 *
 * The question is "which FUNCTION contains the call", which is exactly the part a
 * regex cannot answer — it would have to guess the enclosing declaration from
 * indentation, and `inbox-view.tsx` nests call sites eight levels deep inside JSX.
 * `typescript` is already a devDependency for the same reason in three other
 * hygiene modules.
 *
 * ## What it deliberately does not see
 *
 * A transition started through an imported helper, or through a local alias
 * (`const t = startTransition`). The scan stops at the identifier, which is a
 * scope choice rather than an oversight: the guard exists to keep one file
 * internally honest, and every transition in it today is a direct call. Do not
 * read an empty result as "this file starts no transitions".
 */

import ts from "typescript";

/**
 * Names of the functions in `source` that call `startTransition` directly.
 *
 * The nearest enclosing named declaration wins, which is what makes the answer
 * useful: the call itself is inside an arrow function passed to it, and every
 * interesting call site in this file is a `const name = (…) => …`. A call with no
 * named ancestor is reported as `"<anonymous>"` rather than dropped — an
 * unnameable transition is precisely the kind that escapes a review.
 */
export function transitionStarters(source: string): string[] {
  const file = ts.createSourceFile(
    "inbox-view.tsx",
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TSX,
  );

  const found = new Set<string>();

  /** The nearest ancestor that has a name a human would cite in review. */
  const enclosingName = (node: ts.Node): string => {
    for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
      // `const capture = (…) => …` and `const run = (…) => …`.
      if (
        ts.isVariableDeclaration(n) &&
        n.name &&
        ts.isIdentifier(n.name) &&
        n.initializer &&
        (ts.isArrowFunction(n.initializer) ||
          ts.isFunctionExpression(n.initializer))
      )
        return n.name.text;
      // `function foo() {}` and `class { foo() {} }`.
      if (
        (ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)) &&
        n.name &&
        ts.isIdentifier(n.name)
      )
        return n.name.text;
    }
    return "<anonymous>";
  };

  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "startTransition"
    )
      found.add(enclosingName(node));
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(file, visit);

  return [...found].sort();
}
