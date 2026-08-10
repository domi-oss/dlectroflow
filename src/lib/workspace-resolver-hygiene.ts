/**
 * #220 — the confinement rule that keeps the status-blind resolvers unreachable.
 *
 * `src/lib/workspace.ts` exports two token-level resolvers, `resolveWorkspace`
 * and `resolveWorkspaceId`. They answer "which workspace is signed here", not
 * "may this account still act": they perform no database read at all, which is
 * what lets `hasSession()` (#61) stay free of a query on every byte-range
 * request of every audio seek. The `UserStatus` check lives one level up, in
 * `currentWorkspaceId()`.
 *
 * That split is only safe while nothing outside `workspace.ts` can reach the
 * lower level. A module that gets hold of a token-level resolver is back to
 * #220 exactly — a workspace id handed out without asking whether the account
 * behind the session is still allowed to have one, with every query downstream
 * of it perfectly scoped and all of them writing for a frozen account.
 *
 * ## Why this exists as a parser and not as a substring
 *
 * Rule 2 of `scoping.harness.test.ts` first spelled the check as "no file
 * contains the text `resolveWorkspaceId` followed by an open parenthesis".
 * Review on `!305` showed that a rename on import defeats it in one line: bind
 * the resolver to a local alias and the call site is spelled something the rule
 * cannot predict, so it reports a clean zero for the exact regression it exists
 * to catch. That was reproduced against the real harness before this module was
 * written — an aliased import passed, the same fixture un-aliased failed.
 *
 * The fix is to stop asking about the call and ask about the **reference**. The
 * exported name is written down at the import whatever the local alias becomes,
 * and outside `workspace.ts` there is no legitimate use for the reference at
 * all — so holding one is the finding, and `withWorkspace(resolveWorkspaceId)`,
 * which never writes a call, is caught for free.
 *
 * ## Every way a reference crosses the boundary
 *
 * A module can only obtain one of these bindings by naming the workspace module
 * (statically or dynamically), or by importing it from somewhere that itself
 * named it. So the analysis is: find every mention of the module specifier, and
 * decide what came out.
 *
 *  - a named import, aliased or not — the finding this module was written for
 *  - a namespace import, where the reach is the property access, because the
 *    namespace also carries the legitimate entry points
 *  - a dynamic import, in the three shapes that bind anything: destructured,
 *    held whole, or destructured inside `.then`
 *  - a **re-export**, which is the one that would otherwise walk around all of
 *    the above: the next file imports the resolver from the laundering module
 *    and its specifier never names `workspace`. Flagging it at the re-export
 *    keeps the analysis single-file, which is what lets it be unit-tested.
 *
 * Type-only positions are excluded throughout: they bind nothing at runtime.
 *
 * ## No identifier resolution, deliberately
 *
 * Nothing here asks "what does this name refer to". Every finding is anchored to
 * a module specifier that is written in the file being read, so a same-named
 * local function, a same-named parameter and a same-named import from another
 * module are all silent without a scope walk to get wrong. A sibling guard in
 * this repo resolves identifiers with a walk that never looks at parameters, and
 * so can bind a parameter to an unrelated top-level `const` and fabricate a
 * finding; there is nothing of that shape to copy here.
 *
 * Kept free of `fs` so the parsing is unit-testable on synthetic input — the
 * shape `a11y-class-hygiene`, `fetch-host-hygiene` and `braindump-to-task-hygiene`
 * all share. The scan of the real tree lives in `scoping.harness.test.ts`, with
 * the rest of the #220 argument.
 */

import ts from "typescript";

/** The module the token-level resolvers are confined to, repo-relative. */
export const WORKSPACE_MODULE = "src/lib/workspace.ts";

/**
 * The resolvers that answer the token-level question and by design know nothing
 * about `UserStatus`. Adding an export to `workspace.ts` that resolves a session
 * to a workspace id without checking status means adding it here too — rule 1 of
 * the harness is what forces that decision to be made out loud.
 */
export const TOKEN_LEVEL_RESOLVERS = [
  "resolveWorkspace",
  "resolveWorkspaceId",
] as const;

export type TokenLevelResolver = (typeof TOKEN_LEVEL_RESOLVERS)[number];

/** One reference to a token-level resolver, held outside `workspace.ts`. */
export interface TokenResolverEscape {
  /** 1-based line of the import, re-export or namespace access. */
  line: number;
  /** The name as `workspace.ts` exports it. */
  resolver: TokenLevelResolver;
  /** How the reference is spelled here — the alias, or `ns.name`. */
  local: string;
  reason: string;
}

const IMPORT_REASON =
  "holds a token-level workspace resolver, which answers what is signed rather than whether the account may still act — call currentWorkspaceId(), the one that reads UserStatus";

const REEXPORT_REASON =
  "re-exports a token-level workspace resolver, putting it back in reach under a module path that no longer names workspace.ts";

/** Path segments joined and collapsed, with no `fs` and no platform separators. */
function normalise(p: string): string {
  const parts: string[] = [];
  for (const segment of p.replace(/\\/g, "/").split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      parts.pop();
      continue;
    }
    parts.push(segment);
  }
  return parts.join("/");
}

/** `src/lib/workspace`, the module path with its extension removed. */
const WORKSPACE_PATH = normalise(WORKSPACE_MODULE).replace(/\.tsx?$/, "");

/**
 * Does this specifier name `workspace.ts`, read from `fromFile`?
 *
 * Both spellings the tree uses have to resolve to the same answer: `@/lib/…`
 * (the `paths` alias for `src/`) and a relative path from the importing file. An
 * explicit extension is stripped because `moduleResolution: "bundler"` accepts
 * `./workspace.js` as a name for `./workspace.ts`.
 */
function isWorkspaceModule(specifier: string, fromFile: string): boolean {
  const bare = specifier.replace(/\.[mc]?[jt]sx?$/, "");
  if (bare.startsWith("@/")) {
    return normalise(`src/${bare.slice(2)}`) === WORKSPACE_PATH;
  }
  if (bare.startsWith("./") || bare.startsWith("../")) {
    const dir = normalise(fromFile).split("/").slice(0, -1).join("/");
    return normalise(`${dir}/${bare}`) === WORKSPACE_PATH;
  }
  // A bare specifier is a package, and this module is not published.
  return false;
}

function isResolver(name: string): name is TokenLevelResolver {
  return (TOKEN_LEVEL_RESOLVERS as readonly string[]).includes(name);
}

/**
 * The property a destructuring element reads, as a plain string.
 *
 * `getText()` is wrong here and quietly so: for the legal-but-odd
 * `const { "resolveWorkspaceId": id } = …` it returns the name WITH its quotes,
 * which matches no resolver and hands back a silent zero — the same class of
 * hole as the rename this module was written for, one spelling further out.
 */
function bindingPropertyName(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) return name.text;
  if (
    ts.isComputedPropertyName(name) &&
    ts.isStringLiteralLike(name.expression)
  )
    return name.expression.text;
  return null;
}

/** The string literal specifier of an import/export declaration, if it has one. */
function specifierOf(
  node: ts.ImportDeclaration | ts.ExportDeclaration,
): string | null {
  const spec = node.moduleSpecifier;
  return spec && ts.isStringLiteralLike(spec) ? spec.text : null;
}

/** `import("…")` naming the workspace module. */
function isDynamicWorkspaceImport(
  node: ts.Node,
  fromFile: string,
): node is ts.CallExpression {
  if (!ts.isCallExpression(node)) return false;
  if (node.expression.kind !== ts.SyntaxKind.ImportKeyword) return false;
  const [arg] = node.arguments;
  return (
    !!arg &&
    ts.isStringLiteralLike(arg) &&
    isWorkspaceModule(arg.text, fromFile)
  );
}

/**
 * What a dynamic import binds, in the shapes that bind anything.
 *
 * `const { … } = await import(…)` and `const ns = await import(…)` reach a
 * variable declaration through wrappers that do not change the value;
 * `import(…).then(({ … }) => …)` reaches a parameter instead. Anything else —
 * the promise passed around, stored on an object — binds nothing here and is
 * left alone rather than guessed at.
 */
function dynamicBinding(call: ts.CallExpression): ts.BindingName | null {
  let node: ts.Node = call;
  while (
    node.parent &&
    (ts.isAwaitExpression(node.parent) ||
      ts.isParenthesizedExpression(node.parent) ||
      ts.isAsExpression(node.parent) ||
      ts.isNonNullExpression(node.parent))
  ) {
    node = node.parent;
  }
  const parent = node.parent;
  if (
    parent &&
    ts.isVariableDeclaration(parent) &&
    parent.initializer === node
  ) {
    return parent.name;
  }
  if (
    parent &&
    ts.isPropertyAccessExpression(parent) &&
    parent.name.text === "then" &&
    parent.parent &&
    ts.isCallExpression(parent.parent)
  ) {
    const [callback] = parent.parent.arguments;
    if (
      callback &&
      (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))
    ) {
      return callback.parameters[0]?.name ?? null;
    }
  }
  return null;
}

/**
 * Every reference to a token-level resolver held by `source`.
 *
 * `fileName` is the repo-relative path, and it is load-bearing rather than
 * cosmetic: relative specifiers resolve against it, and `.tsx` selects the TSX
 * script kind (without which a generic-looking `<T>` derails the parse and the
 * file silently reports zero). `WORKSPACE_MODULE` itself always returns none —
 * it is the inside of the boundary.
 */
export function findTokenResolverEscapes(
  source: string,
  fileName: string,
): TokenResolverEscape[] {
  if (normalise(fileName) === normalise(WORKSPACE_MODULE)) return [];

  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    // `setParentNodes` is required, not cosmetic: the dynamic-import shapes are
    // recognised by walking `parent`, and `getText()` walks to the root the same
    // way.
    true,
    fileName.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

  const findings: TokenResolverEscape[] = [];
  /** Locals bound to the whole module — static or dynamic namespace handles. */
  const namespaceLocals = new Set<string>();

  const record = (
    node: ts.Node,
    resolver: TokenLevelResolver,
    local: string,
    reason: string,
  ) => {
    findings.push({
      line:
        sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
          .line + 1,
      resolver,
      local,
      reason: `${local} ${reason}`,
    });
  };

  // Pass 1 — what is bound to the module as a whole, and what a dynamic import
  // destructures. Separate from pass 2 because `const ns = await import(…)` can
  // sit below a reach through `ns`, unlike a hoisted static import.
  const collect = (node: ts.Node) => {
    if (ts.isImportDeclaration(node)) {
      const specifier = specifierOf(node);
      const clause = node.importClause;
      if (
        specifier !== null &&
        isWorkspaceModule(specifier, fileName) &&
        clause &&
        !clause.isTypeOnly &&
        clause.namedBindings &&
        ts.isNamespaceImport(clause.namedBindings)
      ) {
        namespaceLocals.add(clause.namedBindings.name.text);
      }
    }
    if (isDynamicWorkspaceImport(node, fileName)) {
      const binding = dynamicBinding(node);
      if (binding && ts.isIdentifier(binding)) {
        namespaceLocals.add(binding.text);
      } else if (binding && ts.isObjectBindingPattern(binding)) {
        for (const element of binding.elements) {
          // `...rest` keeps every unlisted export, the resolvers included.
          if (element.dotDotDotToken && ts.isIdentifier(element.name)) {
            namespaceLocals.add(element.name.text);
            continue;
          }
          const imported = element.propertyName
            ? bindingPropertyName(element.propertyName)
            : ts.isIdentifier(element.name)
              ? element.name.text
              : null;
          if (imported !== null && isResolver(imported)) {
            record(
              element,
              imported,
              element.name.getText(sourceFile),
              IMPORT_REASON,
            );
          }
        }
      }
    }
    ts.forEachChild(node, collect);
  };
  collect(sourceFile);

  // Pass 2 — static imports, re-exports, and reaches through a namespace.
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node)) {
      const specifier = specifierOf(node);
      const clause = node.importClause;
      if (
        specifier !== null &&
        isWorkspaceModule(specifier, fileName) &&
        clause &&
        !clause.isTypeOnly &&
        clause.namedBindings &&
        ts.isNamedImports(clause.namedBindings)
      ) {
        for (const element of clause.namedBindings.elements) {
          if (element.isTypeOnly) continue;
          const imported = (element.propertyName ?? element.name).text;
          if (isResolver(imported)) {
            record(element, imported, element.name.text, IMPORT_REASON);
          }
        }
      }
    }

    if (ts.isExportDeclaration(node) && !node.isTypeOnly) {
      const specifier = specifierOf(node);
      if (specifier !== null && isWorkspaceModule(specifier, fileName)) {
        const clause = node.exportClause;
        if (!clause) {
          // `export * from "…"` carries both, under their own names.
          for (const resolver of TOKEN_LEVEL_RESOLVERS) {
            record(node, resolver, resolver, REEXPORT_REASON);
          }
        } else if (ts.isNamespaceExport(clause)) {
          for (const resolver of TOKEN_LEVEL_RESOLVERS) {
            record(
              node,
              resolver,
              `${clause.name.text}.${resolver}`,
              REEXPORT_REASON,
            );
          }
        } else {
          for (const element of clause.elements) {
            if (element.isTypeOnly) continue;
            const exported = (element.propertyName ?? element.name).text;
            if (isResolver(exported)) {
              record(element, exported, element.name.text, REEXPORT_REASON);
            }
          }
        }
      }
    }

    // `ns.resolveWorkspaceId` and `ns["resolveWorkspaceId"]` — the same
    // reference in two syntaxes, and a rule that knows only the first is
    // walked around by the second.
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      namespaceLocals.has(node.expression.text) &&
      isResolver(node.name.text)
    ) {
      record(
        node,
        node.name.text,
        `${node.expression.text}.${node.name.text}`,
        IMPORT_REASON,
      );
    }
    if (
      ts.isElementAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      namespaceLocals.has(node.expression.text) &&
      ts.isStringLiteralLike(node.argumentExpression) &&
      isResolver(node.argumentExpression.text)
    ) {
      record(
        node,
        node.argumentExpression.text,
        `${node.expression.text}.${node.argumentExpression.text}`,
        IMPORT_REASON,
      );
    }

    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  // Source order, because the two passes do not run in it and a finding list
  // that jumps around the file is harder to read than one that does not.
  return findings.sort(
    (a, b) => a.line - b.line || a.resolver.localeCompare(b.resolver),
  );
}
