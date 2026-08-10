/**
 * #220 — the two rules that keep a workspace id from being handed to a frozen
 * account, as one parser.
 *
 * `src/lib/workspace.ts` exports two token-level resolvers, `resolveWorkspace`
 * and `resolveWorkspaceId`. They answer "which workspace is signed here", not
 * "may this account still act": they perform no database read at all, which is
 * what lets `hasSession()` (#61) stay free of a query on every byte-range
 * request of every audio seek. The `UserStatus` check lives one level up, in
 * `currentWorkspaceId()`.
 *
 * That split needs both halves policed, and `scoping.harness.test.ts` states
 * them as two rules this module answers:
 *
 *  1. {@link findSessionResolvers} — every exported function in `workspace.ts`
 *     that resolves a session to a workspace id checks `UserStatus`, or is
 *     exempted with a written reason.
 *  2. {@link findTokenResolverEscapes} — nothing outside `workspace.ts` gets
 *     hold of a token-level resolver at all. Rule 1 is worth nothing if an
 *     action file can reach past the helper that does the checking.
 *
 * Either way round, the failure is #220 exactly — a workspace id handed out
 * without asking whether the account behind the session is still allowed to
 * have one, with every query downstream of it perfectly scoped and all of them
 * writing for a frozen account.
 *
 * ## Why this exists as a parser and not as a substring
 *
 * Both rules shipped as a substring search, and `!305`'s review defeated both
 * with the same move: a spelling the fixed string could not predict. Each was
 * reproduced against the real harness before being rewritten.
 *
 * Rule 2 first said "no file contains the text `resolveWorkspaceId` followed by
 * an open parenthesis". A rename on import defeats that in one line — bind the
 * resolver to a local alias and the call site is spelled something the rule
 * cannot predict, so it reports a clean zero for the exact regression it exists
 * to catch. The fix is to stop asking about the call and ask about the
 * **reference**: the exported name is written down at the import whatever the
 * local alias becomes, and outside `workspace.ts` there is no legitimate use for
 * the reference at all — so holding one is the finding, and
 * `withWorkspace(resolveWorkspaceId)`, which never writes a call, is caught for
 * free.
 *
 * Rule 1 had the identical hole one level in. It built its set of "session
 * resolvers" from exported functions whose text contained `resolveWorkspace(` or
 * `resolveWorkspaceId(`, so a function that verified the signed token ITSELF and
 * returned `payload.wsId` was not a session resolver at all, and could hand out
 * a workspace id with no status check while the rule reported a clean zero.
 * `currentUser()` was already that shape — correct, and unwatched. The fix is to
 * stop asking about the name and ask about the **property**: reaches a session
 * primitive, or surfaces a workspace id it was not handed. See the section above
 * {@link findSessionResolvers} for why those two questions are unioned rather
 * than either one taken alone.
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
 * Nothing here asks "what declaration does this name refer to". A sibling guard
 * in this repo does, with a walk that never looks at parameters, so it binds a
 * parameter to an unrelated top-level `const` and fabricates a finding; there is
 * nothing of that shape to copy here.
 *
 * The two rules avoid it differently, because they are asked of different files.
 * Rule 2 anchors every finding to a module specifier written in the file being
 * read, so a same-named local function, a same-named parameter and a same-named
 * import from another module are all silent. Rule 1 is asked only of
 * `workspace.ts` and matches a call by the callee's spelled name, which is the
 * fail-closed direction: a local helper that happens to be called
 * `verifySession` produces a loud false finding somebody fixes rather than a
 * quiet miss nobody sees. What it DOES track is parameters, per function scope —
 * that is the one place where guessing produces a false finding on ordinary code
 * (`listTasks(workspaceId)` is most of `src/lib`), and a guard that fires on
 * correct code is a guard that gets relaxed rather than fixed.
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

/**
 * Everything that turns a signed cookie into a session payload — the two
 * token-level resolvers plus the primitive they are both built on.
 *
 * `verifySession` is the one that matters here and the one rule 1 could not see
 * (`!305` round 2). A resolver does not have to go through
 * `resolveWorkspace()` to hand out a workspace id; it can verify the token
 * itself and return `payload.wsId`, and `currentUser()` in `workspace.ts` is
 * that shape today. Watching only the two named resolvers meant such a function
 * was not a "session resolver" as far as the status rule was concerned, so the
 * rule could not have noticed its status check going missing.
 */
export const SESSION_PRIMITIVES = [
  "verifySession",
  ...TOKEN_LEVEL_RESOLVERS,
] as const;

export type SessionPrimitive = (typeof SESSION_PRIMITIVES)[number];

/**
 * Property names that carry a workspace id out of a session payload.
 *
 * `wsId` is the field on the verified token (`src/lib/auth/session.ts`) and
 * `workspaceId` is the name it takes once it reaches the app. Deliberately NOT
 * including a bare `id`: it names the workspace on a `ResolvedWorkspace` and a
 * row's primary key everywhere else, so watching it everywhere would fire on
 * most of `src/lib`. It is honoured in RETURN position only — see
 * {@link findSessionResolvers} — where "the id this function hands back" is the
 * question actually being asked.
 */
export const WORKSPACE_ID_FIELDS = ["wsId", "workspaceId"] as const;

/** Property names that make a RETURNED value a workspace id. */
const RETURNED_ID_FIELDS: readonly string[] = ["id", ...WORKSPACE_ID_FIELDS];

/** The constant every status check in this codebase is written against. */
const STATUS_CONSTANT = "UserStatus";

/** One exported function that turns a session into something, with the three
 *  facts rule 1 decides on. */
export interface SessionResolver {
  /** The exported name. */
  name: string;
  /** 1-based line of the declaration. */
  line: number;
  /** Calls one of {@link SESSION_PRIMITIVES}, through an alias or a namespace. */
  reachesSessionPrimitive: boolean;
  /** Holds or returns a workspace id that did not arrive as its own parameter. */
  surfacesWorkspaceId: boolean;
  /** References the `UserStatus` constant as a VALUE — not in prose, not as a
   *  type annotation. */
  checksUserStatus: boolean;
}

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

/**
 * Parse one file's source, with the two settings that are load-bearing here.
 *
 * `setParentNodes` is required rather than cosmetic: the dynamic-import shapes
 * are recognised by walking `parent`, `getText()` walks to the root the same
 * way, and the resolver analysis asks whether an identifier is the `.name` half
 * of a property access. `.tsx` selects the TSX script kind, without which a
 * generic-looking `<T>` derails the parse and the file silently reports zero.
 */
function parseSource(source: string, fileName: string): ts.SourceFile {
  return ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
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

  const sourceFile = parseSource(source, fileName);

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

// ── Rule 1's parser — which exported functions resolve a session ─────────────
//
// Rule 1 asks "does every function that turns a session into a workspace id
// check `UserStatus`". Answering it needs the SET first, and the set was the
// hole `!305` round 2 found: it was built by looking for the literal text
// `resolveWorkspace(` or `resolveWorkspaceId(` inside an exported function, so
// a function that verified the token itself was not in it. `currentUser()` was
// already that shape — correct today, and unwatched, which is the difference
// between safe and enforced.
//
// The set is now the UNION of two questions, so it fails closed:
//
//  1. does it reach a session primitive? (`SESSION_PRIMITIVES`, by AST, through
//     an import alias or a namespace)
//  2. does it surface a workspace id it was not given? (`WORKSPACE_ID_FIELDS`,
//     plus a returned `id` that did not come out of one of its parameters)
//
// Neither question is sufficient alone, and that is the point of the union.
// (1) alone is walked around by inventing a third primitive; (2) alone cannot
// see `hasSession()`, which reads the session and returns a boolean and is
// still a thing this file has to have an argued position about.
//
// A note on identifier resolution, because the module comment above disclaims
// it for rule 2 and this rule does something different. Nothing here binds a
// name to a declaration either — call sites are matched by the callee's spelled
// name, which is the same fail-closed direction the rest of this module takes:
// a local function that happens to be called `verifySession` produces a LOUD
// false finding somebody fixes, rather than a quiet miss nobody sees.
// Parameters ARE tracked, per function scope, because that is the one place
// where guessing produces a false finding on ordinary code (`listTasks(
// workspaceId)` is most of `src/lib`), and a guard that fires on correct code
// is a guard that gets relaxed rather than fixed.

/** Is this node prose or a type — neither of which runs? */
function isNonRuntimeNode(node: ts.Node): boolean {
  return (
    ts.isTypeNode(node) ||
    (node.kind >= ts.SyntaxKind.FirstJSDocNode &&
      node.kind <= ts.SyntaxKind.LastJSDocNode)
  );
}

/** Is this identifier the `.name` half of a member access, rather than a
 *  reference to a binding of its own? */
function isMemberName(node: ts.Identifier): boolean {
  const parent = node.parent;
  return (
    !!parent &&
    ((ts.isPropertyAccessExpression(parent) && parent.name === node) ||
      (ts.isQualifiedName(parent) && parent.right === node))
  );
}

/** The name a call is spelled with — `f()`, `ns.f()` and `ns["f"]()` all
 *  answer `f`, so a namespace cannot launder a primitive. */
function calleeName(expr: ts.Expression): string | null {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
  if (
    ts.isElementAccessExpression(expr) &&
    ts.isStringLiteralLike(expr.argumentExpression)
  ) {
    return expr.argumentExpression.text;
  }
  if (ts.isParenthesizedExpression(expr) || ts.isNonNullExpression(expr)) {
    return calleeName(expr.expression);
  }
  return null;
}

function isSessionPrimitive(name: string): name is SessionPrimitive {
  return (SESSION_PRIMITIVES as readonly string[]).includes(name);
}

function isWorkspaceIdField(name: string): boolean {
  return (WORKSPACE_ID_FIELDS as readonly string[]).includes(name);
}

/** The property a member access reads, as a plain string, or null. */
function accessedName(node: ts.Node): string | null {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (
    ts.isElementAccessExpression(node) &&
    ts.isStringLiteralLike(node.argumentExpression)
  ) {
    return node.argumentExpression.text;
  }
  return null;
}

/** Local names bound to a session primitive by an import, whatever the alias. */
function primitiveAliases(
  sourceFile: ts.SourceFile,
): Map<string, SessionPrimitive> {
  const aliases = new Map<string, SessionPrimitive>();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const clause = statement.importClause;
    if (!clause || clause.isTypeOnly || !clause.namedBindings) continue;
    if (!ts.isNamedImports(clause.namedBindings)) continue;
    for (const element of clause.namedBindings.elements) {
      if (element.isTypeOnly) continue;
      const imported = (element.propertyName ?? element.name).text;
      if (isSessionPrimitive(imported))
        aliases.set(element.name.text, imported);
    }
  }
  return aliases;
}

/** Every name this function binds through its parameter list, destructuring
 *  included — the ids it was HANDED rather than resolved. */
function parameterNames(fn: ts.SignatureDeclarationBase): string[] {
  const names: string[] = [];
  const add = (name: ts.BindingName) => {
    if (ts.isIdentifier(name)) {
      names.push(name.text);
      return;
    }
    for (const element of name.elements) {
      if (ts.isBindingElement(element)) add(element.name);
    }
  };
  for (const parameter of fn.parameters) add(parameter.name);
  return names;
}

/** Strip the wrappers that do not change what an expression evaluates to. */
function unwrapExpression(expr: ts.Expression): ts.Expression {
  let node = expr;
  while (
    ts.isAwaitExpression(node) ||
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isNonNullExpression(node)
  ) {
    node = node.expression;
  }
  return node;
}

/** The expressions this function hands back — its own, not a nested
 *  callback's, which belongs to the callback. */
function returnedExpressions(fn: ts.FunctionLikeDeclaration): ts.Expression[] {
  const body = fn.body;
  if (!body) return [];
  if (!ts.isBlock(body)) return [body];
  const returned: ts.Expression[] = [];
  const walk = (node: ts.Node) => {
    if (isNonRuntimeNode(node) || ts.isFunctionLike(node)) return;
    if (ts.isReturnStatement(node) && node.expression) {
      returned.push(node.expression);
    }
    ts.forEachChild(node, walk);
  };
  ts.forEachChild(body, walk);
  return returned;
}

/**
 * Does this returned expression hand back a workspace id?
 *
 * A bare `id` counts HERE and nowhere else. In return position the question is
 * "what does this function give out", so `ws.id` and `{ id, kind }` are the two
 * spellings a resolved workspace comes back as — and neither mentions `wsId`,
 * which is what a rule watching only the payload field would need. Everywhere
 * else `id` is a row's primary key and watching it would fire on most of the
 * codebase.
 *
 * An id read off one of the function's own PARAMETERS does not count: it came
 * in through the front door, so no session was resolved to produce it. That is
 * the difference between `return ws.id` after a token read and `return row.id`
 * in a serialiser.
 */
function returnsWorkspaceId(
  expr: ts.Expression,
  parameters: ReadonlySet<string>,
): boolean {
  const node = unwrapExpression(expr);

  if (ts.isConditionalExpression(node)) {
    return (
      returnsWorkspaceId(node.whenTrue, parameters) ||
      returnsWorkspaceId(node.whenFalse, parameters)
    );
  }
  // `a ?? b` and `a || b` are one value spelled as a choice between two.
  if (
    ts.isBinaryExpression(node) &&
    (node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
      node.operatorToken.kind === ts.SyntaxKind.BarBarToken)
  ) {
    return (
      returnsWorkspaceId(node.left, parameters) ||
      returnsWorkspaceId(node.right, parameters)
    );
  }
  if (ts.isObjectLiteralExpression(node)) {
    return node.properties.some((property) => {
      if (!property.name) return false;
      const key = bindingPropertyName(property.name);
      if (key === null || !RETURNED_ID_FIELDS.includes(key)) return false;
      // The same front-door exclusion the member-access branch below makes.
      // `return row.id` was already not a resolution; `return { id: row.id }`
      // is the same id in a wrapper and was still a finding (!305 review),
      // which is a serialiser or a mapper misread as a session resolver.
      return !propertyComesFromParameter(property, parameters);
    });
  }
  const read = accessedName(node);
  if (read !== null && RETURNED_ID_FIELDS.includes(read)) {
    return !readsOffParameter(node, parameters);
  }
  return false;
}

/**
 * Is this expression a field read off one of the function's own parameters?
 *
 * The single spelling of the front-door exclusion, shared by all three places
 * that need it, because they disagreed while it was written out inline: the
 * return-position check made it, the property-access walk did not, and the
 * object-literal branch did not (!305 review). A guard that fires on `listTasks
 * (workspaceId)`-shaped code — most of `src/lib` — is a guard that gets relaxed
 * rather than fixed, which is how the hole this module closes was made.
 *
 * Only the IMMEDIATE base counts, so `ctx.session.wsId` is still a finding even
 * when `ctx` is a parameter. That is the fail-closed direction the rest of this
 * module takes, and it is the pre-existing behaviour of the return-position
 * check rather than a new position: a parameter carrying a whole session object
 * is worth a look, whereas `row.wsId` is a row.
 */
function readsOffParameter(
  node: ts.Node,
  parameters: ReadonlySet<string>,
): boolean {
  if (
    !ts.isPropertyAccessExpression(node) &&
    !ts.isElementAccessExpression(node)
  ) {
    return false;
  }
  const base = unwrapExpression(node.expression);
  return ts.isIdentifier(base) && parameters.has(base.text);
}

/**
 * Does this object-literal property take its value from a parameter — directly
 * as shorthand, or by reading a field off one?
 *
 * Anything else (a method, a getter, an accessor, a call) is left alone and so
 * keeps counting, which is the fail-closed default: the question is only ever
 * "did this demonstrably come in through the front door", never "is it safe".
 */
function propertyComesFromParameter(
  property: ts.ObjectLiteralElementLike,
  parameters: ReadonlySet<string>,
): boolean {
  if (ts.isShorthandPropertyAssignment(property)) {
    return parameters.has(property.name.text);
  }
  if (!ts.isPropertyAssignment(property)) return false;
  const value = unwrapExpression(property.initializer);
  if (ts.isIdentifier(value)) return parameters.has(value.text);
  return readsOffParameter(value, parameters);
}

/** One exported function, with the node the analysis reads. */
interface ExportedFunction {
  name: string;
  line: number;
  node: ts.FunctionLikeDeclaration;
}

function hasExportModifier(node: ts.Node): boolean {
  return (
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node) ?? []).some(
      (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
    )
  );
}

/**
 * Every exported function in a module, however it is declared.
 *
 * The rule this replaces read `/export async function (\w+)/`, and its own doc
 * comment listed what that misses: a synchronous export, an arrow function, and
 * a declaration exported by a later `export { … }` clause. Any of the three
 * would have removed a resolver from rule 1's set without removing it from the
 * app, which is the failure mode this whole file exists to avoid.
 */
function collectExportedFunctions(
  sourceFile: ts.SourceFile,
): ExportedFunction[] {
  /** Every top-level function-shaped declaration, by the name it binds. */
  const declared = new Map<string, ts.FunctionLikeDeclaration>();
  /** local name → the name it is exported under. */
  const exported = new Map<string, string>();

  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      declared.set(statement.name.text, statement);
      if (hasExportModifier(statement)) {
        exported.set(statement.name.text, statement.name.text);
      }
      continue;
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        const initializer = declaration.initializer;
        if (!ts.isIdentifier(declaration.name) || !initializer) continue;
        const fn = unwrapExpression(initializer);
        if (!ts.isArrowFunction(fn) && !ts.isFunctionExpression(fn)) continue;
        declared.set(declaration.name.text, fn);
        if (hasExportModifier(statement)) {
          exported.set(declaration.name.text, declaration.name.text);
        }
      }
      continue;
    }
    // `export { local as public }` — no module specifier, so it exports what
    // this file declared. A re-export FROM another module binds nothing here
    // and is rule 2's business, not rule 1's.
    if (
      ts.isExportDeclaration(statement) &&
      !statement.isTypeOnly &&
      !statement.moduleSpecifier &&
      statement.exportClause &&
      ts.isNamedExports(statement.exportClause)
    ) {
      for (const element of statement.exportClause.elements) {
        if (element.isTypeOnly) continue;
        exported.set(
          (element.propertyName ?? element.name).text,
          element.name.text,
        );
      }
    }
  }

  const functions: ExportedFunction[] = [];
  for (const [local, publicName] of exported) {
    const node = declared.get(local);
    if (!node) continue;
    functions.push({
      name: publicName,
      line:
        sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
          .line + 1,
      node,
    });
  }
  // Source order, because `export { … }` names things declared above it and a
  // finding list that jumps around the file is harder to read than one that
  // does not.
  return functions.sort((a, b) => a.line - b.line);
}

/**
 * The names of every function this module exports.
 *
 * Used by the harness to prove that an entry in its "allowed to skip the status
 * check" list still names something real — a stale exemption reads like
 * considered coverage.
 */
export function findExportedFunctionNames(
  source: string,
  fileName: string,
): string[] {
  return collectExportedFunctions(parseSource(source, fileName)).map(
    (fn) => fn.name,
  );
}

/**
 * Which session primitives this module binds, under their exported names.
 *
 * The anti-vacuous surface for rule 1. Every question below is asked about
 * names, so a rename in `src/lib/auth/session.ts` would turn the whole rule
 * into a clean zero; the harness asserts against this instead, and a rename
 * then fails loudly and points at the list to update.
 */
export function findSessionPrimitiveBindings(
  source: string,
  fileName: string,
): SessionPrimitive[] {
  const sourceFile = parseSource(source, fileName);
  const bound = new Set<SessionPrimitive>(
    primitiveAliases(sourceFile).values(),
  );
  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      if (isSessionPrimitive(statement.name.text))
        bound.add(statement.name.text);
      continue;
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (
          ts.isIdentifier(declaration.name) &&
          isSessionPrimitive(declaration.name.text)
        ) {
          bound.add(declaration.name.text);
        }
      }
    }
  }
  return SESSION_PRIMITIVES.filter((primitive) => bound.has(primitive));
}

/**
 * Every exported function in `source` that resolves a session, with the facts
 * rule 1 decides on.
 *
 * Written for `workspace.ts` and applied there by
 * `src/lib/__tests__/scoping.harness.test.ts`; it takes source text rather than
 * a path so the deliberately-bad fixtures in the colocated test can prove it
 * bites, which is the shape every file-parsing guard in this repo follows.
 */
export function findSessionResolvers(
  source: string,
  fileName: string,
): SessionResolver[] {
  const sourceFile = parseSource(source, fileName);
  const aliases = primitiveAliases(sourceFile);
  const resolvers: SessionResolver[] = [];

  for (const fn of collectExportedFunctions(sourceFile)) {
    const ownParameters = new Set(parameterNames(fn.node));
    let reachesSessionPrimitive = false;
    let surfacesWorkspaceId = false;
    let checksUserStatus = false;

    const walk = (node: ts.Node, scope: ReadonlySet<string>) => {
      // A comment is not a node and a type binds nothing at runtime. Both
      // matter: #220 shipped as a doc comment promising a check the code did
      // not make, and this repo has twice shipped a tool that read one as code.
      if (isNonRuntimeNode(node)) return;

      let inner = scope;
      if (ts.isFunctionLike(node) && node !== fn.node) {
        inner = new Set([...scope, ...parameterNames(node)]);
      }

      if (ts.isCallExpression(node)) {
        const callee = calleeName(node.expression);
        if (
          callee !== null &&
          (isSessionPrimitive(callee) || aliases.has(callee))
        ) {
          reachesSessionPrimitive = true;
        }
      }

      // `row.workspaceId` is an id handed IN, exactly as `return row.id` is —
      // and without the exclusion this fired FIRST, before the return-position
      // check that would have made it, leaving the careful half unreachable for
      // the shape it was written for (!305 review).
      const read = accessedName(node);
      if (
        read !== null &&
        isWorkspaceIdField(read) &&
        !readsOffParameter(node, inner)
      ) {
        surfacesWorkspaceId = true;
      }

      if (ts.isIdentifier(node) && !isMemberName(node)) {
        if (isWorkspaceIdField(node.text) && !inner.has(node.text)) {
          surfacesWorkspaceId = true;
        }
        if (node.text === STATUS_CONSTANT) checksUserStatus = true;
      }

      ts.forEachChild(node, (child) => walk(child, inner));
    };
    walk(fn.node, ownParameters);

    if (!surfacesWorkspaceId) {
      surfacesWorkspaceId = returnedExpressions(fn.node).some((expr) =>
        returnsWorkspaceId(expr, ownParameters),
      );
    }

    if (reachesSessionPrimitive || surfacesWorkspaceId) {
      resolvers.push({
        name: fn.name,
        line: fn.line,
        reachesSessionPrimitive,
        surfacesWorkspaceId,
        checksUserStatus,
      });
    }
  }

  return resolvers;
}
