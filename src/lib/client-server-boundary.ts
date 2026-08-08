/**
 * #199 — the client/server import boundary, as a guard.
 *
 * ## The bug this exists for
 *
 * `shopping-summary-card.tsx` is a `"use client"` component and imported
 * `shoppingSummaryLabel` from `@/lib/shopping-summary`, which at the time also held
 * `syncShoppingSummary` and therefore imported `@/lib/db`. `src/lib/db.ts`
 * constructs `new PrismaClient()` **at module scope**, so that one import pulled
 * the whole Prisma client into the browser bundle: two client chunks of 156 KB
 * each, containing the string *"unable to run in this browser"* — which is the
 * error the page throws the moment that chunk is evaluated.
 *
 * **`next build` was green.** Nothing in the repo could see it: the unit suite
 * imports modules directly in node, so a server-only import is simply available;
 * the e2e suite renders pages, and this particular card only appears when a
 * workspace has both the feature switched on and a non-empty shopping list, which
 * no spec had. Found by grepping the built chunks after a review comment
 * *guessed* at it without having seen the diff — which is not a reproducible way
 * to find this again.
 *
 * ## What it checks
 *
 * Every `"use client"` module's transitive import graph, and whether it reaches a
 * module that instantiates a database client. Transitive is the whole point: the
 * direct import was innocuous-looking (`@/lib/shopping-summary`), and the offence
 * was one hop further in.
 *
 * ## Two things it must NOT flag, or it would flag half the tree
 *
 * The first draft reported 27 leaks. Two of the three reasons were the guard's
 * fault, and both exclusions are semantics rather than leniency — checked against
 * the built bundles, which showed 0 Prisma-bearing client chunks before this
 * feature and 2 after, i.e. exactly one real leak:
 *
 *  1. **A `"use server"` module is where the graph ENDS.** Next.js replaces a
 *     server-action module's body with a client reference in the browser bundle, so
 *     `shopping-list.tsx → @/app/actions/shopping → @/lib/db` bundles no Prisma at
 *     all. Importing a server action from a client component is the framework's
 *     intended pattern, and every settings section in this repo does it.
 *  2. **A type-only import is erased.** `roundup-card.tsx` has
 *     `import type { Rollup } from "@/lib/rollup"`, and `rollup.ts` imports
 *     `@/lib/db` — nothing of either reaches the bundle. Following type imports
 *     would make this guard demand a split for a type.
 *
 * Kept free of `fs` so the walk is unit-testable on a synthetic module graph — the
 * house shape `fetch-host-hygiene`, `a11y-class-hygiene` and `revalidation-hygiene`
 * all use; `client-server-boundary.test.ts` holds the scan over the real tree.
 *
 * ## Why the TypeScript AST and not a regex
 *
 * The same reason `a11y-class-hygiene` gives, and it is not hypothetical here:
 * this very file names `@/lib/db` in prose several times, and so does
 * `shopping-summary.ts`. A regex over the source reports both as importers. The AST
 * also carries the one distinction the exclusions above turn on — `import type`
 * versus a value import — which no regex and not even `ts.preProcessFile` can
 * report. `typescript` is already a declared devDependency.
 */

import ts from "typescript";

/** One module, reduced to what the walk needs. */
export interface ModuleFacts {
  /** Repo-relative path, e.g. `src/lib/db.ts`. */
  path: string;
  /** Does the file open with a `"use client"` directive? */
  isClientEntry: boolean;
  /** Does the file open with a `"use server"` directive? The walk STOPS here —
   *  Next.js replaces such a module with a client reference in the browser. */
  isServerBoundary: boolean;
  /** Does it construct a database client at module scope? */
  instantiatesDbClient: boolean;
  /** VALUE-import specifiers, resolved to repo-relative paths by the caller (this
   *  module does no filesystem resolution). Type-only imports are excluded: they
   *  are erased, so they cannot pull anything into a bundle. */
  imports: string[];
}

/**
 * Is `"use client"` the file's first statement?
 *
 * Checked as a DIRECTIVE rather than as "the text appears near the top": the
 * string occurs in prose in several files in this repo, and a file that merely
 * mentions it is not a client entry point.
 */
export function hasDirective(source: string, directive: string): boolean {
  const file = ts.createSourceFile(
    "x.tsx",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  for (const statement of file.statements) {
    if (
      !ts.isExpressionStatement(statement) ||
      !ts.isStringLiteralLike(statement.expression)
    ) {
      // A directive prologue ends at the first non-string-literal statement.
      return false;
    }
    if (statement.expression.text === directive) return true;
  }
  return false;
}

/** `"use client"` as the file's first directive. */
export const hasUseClientDirective = (source: string): boolean =>
  hasDirective(source, "use client");

/** `"use server"` as the file's first directive — a boundary, not a leak. */
export const hasUseServerDirective = (source: string): boolean =>
  hasDirective(source, "use server");

/**
 * Does this module construct a database client where importing it is enough to run
 * the constructor?
 *
 * `new PrismaClient(` at any depth, because `src/lib/db.ts`'s is inside a `??`
 * expression at module scope and a top-level-statement check would miss it. A
 * constructor inside a function would be a false positive in principle; nothing in
 * the tree does that, and the failure direction is the safe one — the guard would
 * demand a split that is not strictly needed rather than permit a bundle that
 * explodes.
 */
export function instantiatesDbClient(source: string): boolean {
  const file = ts.createSourceFile(
    "x.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  let found = false;
  const visit = (node: ts.Node): void => {
    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "PrismaClient"
    ) {
      found = true;
    }
    if (!found) ts.forEachChild(node, visit);
  };
  ts.forEachChild(file, visit);
  return found;
}

/**
 * The module specifiers a file imports **as values**.
 *
 * A full AST walk rather than `ts.preProcessFile`, and the reason is the one
 * exclusion that matters: `preProcessFile` reports every specifier and cannot say
 * whether it was `import type`. A type-only import is erased by the compiler, so
 * following one would make this guard demand a module split for a type —
 * `roundup-card.tsx` does exactly that with `import type { Rollup }`.
 *
 * A declaration with SOME inline type specifiers (`import { type A, b }`) still has
 * a value import and counts. A declaration with only inline type specifiers counts
 * too: it is rare, and over-counting costs at most a split that was not strictly
 * needed, while under-counting costs a bundle that explodes in the browser.
 *
 * Relative specifiers are returned alongside `@/` ones, resolved against the
 * importing file's directory by the caller: `src/lib/export/collect.ts` imports
 * `./types`, and a walk that only followed `@/` would stop at every folder boundary.
 *
 * Nothing a COMMENT says is returned, which is the whole reason this is an AST walk
 * — this repo names `@/lib/db` in prose in several module docs, including this one.
 */
export function importedModules(source: string): string[] {
  const file = ts.createSourceFile(
    "x.tsx",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const out: string[] = [];
  const add = (specifier: ts.Expression | undefined): void => {
    if (specifier && ts.isStringLiteralLike(specifier)) {
      const name = specifier.text;
      if (name.startsWith("@/") || name.startsWith(".")) out.push(name);
    }
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      // `import type { X } from` — erased, so it pulls nothing into a bundle.
      if (!node.importClause?.isTypeOnly) add(node.moduleSpecifier);
    } else if (ts.isExportDeclaration(node)) {
      if (!node.isTypeOnly) add(node.moduleSpecifier);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      // A dynamic `import()` is always a value import.
      add(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(file, visit);
  return out;
}

/**
 * Every client entry point whose transitive imports reach a module that
 * instantiates a database client, with the path that gets there.
 *
 * The path is returned, not just the offending pair, because "this client
 * component imports Prisma" is not actionable on its own — the fix is always at
 * one specific hop, and on the bug this was written for that hop was the second
 * one.
 *
 * A cycle is survived rather than recursed into forever, the same way
 * `revalidation-hygiene`'s helper walk is.
 */
export function findClientDbLeaks(
  modules: readonly ModuleFacts[],
): { entry: string; via: string[] }[] {
  const byPath = new Map(modules.map((m) => [m.path, m]));
  const leaks: { entry: string; via: string[] }[] = [];

  for (const entry of modules.filter((m) => m.isClientEntry)) {
    const seen = new Set<string>([entry.path]);
    // Depth-first, carrying the path so the report can name the hop to fix.
    const stack: string[][] = [[entry.path]];
    while (stack.length > 0) {
      const via = stack.pop()!;
      const current = byPath.get(via[via.length - 1]);
      if (!current) continue;
      // A "use server" module is the end of the browser's graph — Next.js replaces
      // it with a client reference, so nothing behind it is bundled. Checked before
      // the leak test so a server action that legitimately imports the database is
      // never reported.
      if (current.isServerBoundary && via.length > 1) continue;
      if (current.instantiatesDbClient && via.length > 1) {
        leaks.push({ entry: entry.path, via });
        break;
      }
      for (const next of current.imports) {
        if (seen.has(next)) continue;
        seen.add(next);
        stack.push([...via, next]);
      }
    }
  }
  return leaks;
}
