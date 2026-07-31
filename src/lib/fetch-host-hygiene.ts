/**
 * #83 — outbound-request host hygiene: is every `fetch()` target's HOST fixed
 * at build time?
 *
 * This is the repo-owned replacement for `javascript-node-ssrf-generic-taint`,
 * which is demoted to Info in `.gitlab/sast-ruleset.toml`. That rule follows
 * user input into a request's *body* — which is exactly what an OAuth
 * authorization-code exchange is — and so produced five findings in this repo
 * and zero true positives, while re-fingerprinting on every line shift and
 * blocking unrelated MRs six times. SSRF (CWE-918) is control of the request
 * TARGET, so that is the property asserted here instead.
 *
 * Kept free of `fs` so the parsing is unit-testable on synthetic sources — the
 * same split `manifest-hygiene`, `lockfile-hygiene` and `dockerfile-hygiene`
 * use; the caller reads the files. `fetch-host-hygiene.test.ts` holds the
 * `REVIEWED_DYNAMIC_HOSTS` allowlist and the scan over the real tree.
 *
 * ── Why the TypeScript AST and not a regex ──────────────────────────────────
 * The other hygiene modules hand-roll a parser because they read Dockerfiles
 * and lockfiles. This one reads TypeScript, and `typescript` is already a
 * declared devDependency. A regex cannot tell `fetch(` in a comment from a real
 * call, cannot resolve `TOKEN_ENDPOINT` to its declaration, and cannot look
 * inside `tasksUrl(...)` — all three of which this repo's real call sites need.
 * A security guard that answers "unknown shape" with a shrug is decoration.
 *
 * ── The rule ────────────────────────────────────────────────────────────────
 * Reduce the target expression to the longest CONSTANT PREFIX it is guaranteed
 * to start with, then require one of:
 *
 *   * the expression is constant end to end (nothing can vary), or
 *   * that constant prefix already closes the URL's authority — scheme, host
 *     and port are all inside it, terminated by `/`, `?` or `#`.
 *
 * Everything after the authority is a path/query question, which is #79's
 * concern (path traversal) and was fixed in !165 by per-segment encoding. That
 * separation is deliberate: conflating the two is what produced the noise this
 * replaces, so a caller-supplied *path segment* is accepted here on purpose.
 */

import ts from "typescript";

/** One outbound-request call site and the verdict on its target. */
export interface FetchTarget {
  /** 1-based line of the call, for the failure message. */
  line: number;
  /** The target expression's source text, whitespace-collapsed. Used as the
   *  `REVIEWED_DYNAMIC_HOSTS` key, so it must not carry line numbers. */
  target: string;
  /** True when the host cannot vary at run time. */
  constantHost: boolean;
  /** Why — stated for constant verdicts too, so a review can check the
   *  reasoning rather than just the boolean. */
  reason: string;
}

/**
 * Does `prefix` — text the expression is guaranteed to start with — pin the
 * whole authority, so that appending anything cannot change the host?
 *
 * Two accepted shapes:
 *
 *  1. `scheme://authority` followed by `/`, `?` or `#`. Once the authority is
 *     terminated, no suffix can re-open it: `https://host/` + `//evil.com` is
 *     still a request to `host`. A prefix that STOPS inside the authority is
 *     rejected, including one that merely reaches its end —
 *     `` `${GITLAB}${tail}` `` with `tail = "@evil.com/x"` resolves to
 *     `evil.com`, and `` `https://${host}/x` `` is the textbook shape.
 *
 *  2. A same-origin relative reference: `/` followed by a NON-slash character.
 *     The second character matters — `` `/${p}` `` with `p = "/evil.com/"`
 *     produces the protocol-relative `//evil.com/`, which is cross-origin while
 *     looking local.
 *
 * A scheme-less relative reference (`tasks/…`) is rejected: it resolves against
 * whatever base is current, and in Node there is none.
 */
export function establishesConstantHost(prefix: string): boolean {
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#]+[/?#]/.test(prefix)) return true;
  return /^\/[^/]/.test(prefix);
}

/** The longest text an expression must start with, and whether that is all of
 *  it. `complete: false` means a run-time value follows `text`. */
interface ConstantPrefix {
  text: string;
  complete: boolean;
}

/** Nothing constant could be established at all (a parameter, say). */
const UNRESOLVED = null;

/**
 * How deep to follow `const` bindings and local URL builders. The deepest real
 * chain here is three hops — `fetch(tasksUrl(...))` → the builder's return
 * template → its `TASKS_API` span — so six leaves room without letting a
 * pathological file spin. Running out of depth resolves to "unresolved", which
 * fails closed.
 */
const MAX_DEPTH = 6;

/** Strip the wrappers that do not change a value. */
function unwrap(node: ts.Expression): ts.Expression {
  let current = node;
  for (;;) {
    if (
      ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isSatisfiesExpression(current) ||
      ts.isNonNullExpression(current) ||
      ts.isTypeAssertionExpression(current)
    ) {
      current = current.expression;
      continue;
    }
    return current;
  }
}

/** Statements directly visible from `node`, for a scope walk. */
function statementsOf(node: ts.Node): readonly ts.Statement[] {
  if (ts.isSourceFile(node) || ts.isBlock(node) || ts.isModuleBlock(node)) {
    return node.statements;
  }
  return [];
}

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
 * The initializer of the nearest `const` named `name`, walking outwards from
 * `from`.
 *
 * `let` and `var` are deliberately NOT resolved: a rebindable variable is only
 * as constant as the last write to it, and proving that needs flow analysis
 * this module does not do. Parameters are not resolved either — a parameter is
 * precisely the attacker-reachable case.
 */
function resolveConst(name: string, from: ts.Node): ts.Expression | null {
  for (let scope: ts.Node | undefined = from; scope; scope = scope.parent) {
    for (const statement of statementsOf(scope)) {
      if (!ts.isVariableStatement(statement)) continue;
      const isConst =
        (statement.declarationList.flags & ts.NodeFlags.Const) !== 0;
      if (!isConst) continue;
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name)) continue;
        if (declaration.name.text !== name) continue;
        return declaration.initializer ?? null;
      }
    }
  }
  return null;
}

/** The nearest function named `name` declared in this file, or null. */
function resolveFunction(name: string, from: ts.Node): FunctionLike | null {
  for (let scope: ts.Node | undefined = from; scope; scope = scope.parent) {
    for (const statement of statementsOf(scope)) {
      if (
        ts.isFunctionDeclaration(statement) &&
        statement.name?.text === name
      ) {
        return statement;
      }
    }
  }
  const bound = resolveConst(name, from);
  if (bound && isFunctionLike(unwrap(bound)))
    return unwrap(bound) as FunctionLike;
  return null;
}

/**
 * The single expression a function returns, or null when there is not exactly
 * one.
 *
 * "Exactly one" is the conservative choice: two return statements mean two
 * possible targets, and accepting a function because its FIRST return looks
 * constant is how a guard stops guarding. Nested functions are not descended
 * into — their returns belong to them.
 */
function soleReturnExpression(fn: FunctionLike): ts.Expression | null {
  if (ts.isArrowFunction(fn) && !ts.isBlock(fn.body)) return fn.body;
  const body = fn.body;
  if (!body || !ts.isBlock(body)) return null;

  const returns: ts.Expression[] = [];
  const visit = (node: ts.Node): void => {
    if (node !== fn && isFunctionLike(node)) return;
    if (ts.isReturnStatement(node)) {
      if (!node.expression) return;
      returns.push(node.expression);
      return;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(body, visit);
  return returns.length === 1 ? returns[0] : null;
}

/**
 * Reduce `node` to the constant text it must start with.
 *
 * Returns {@link UNRESOLVED} when not even the first character is knowable.
 * The distinction matters for the message: "the target is a parameter" and
 * "the constant part stops at `https://`" are different review conversations.
 */
function constantPrefix(
  node: ts.Expression,
  depth: number,
  seen: ReadonlySet<ts.Node>,
): ConstantPrefix | null {
  if (depth > MAX_DEPTH) return UNRESOLVED;
  const expression = unwrap(node);

  if (
    ts.isStringLiteral(expression) ||
    ts.isNoSubstitutionTemplateLiteral(expression)
  ) {
    return { text: expression.text, complete: true };
  }

  if (ts.isTemplateExpression(expression)) {
    let text = expression.head.text;
    for (const span of expression.templateSpans) {
      const inner = constantPrefix(span.expression, depth + 1, seen);
      if (!inner) return { text, complete: false };
      text += inner.text;
      if (!inner.complete) return { text, complete: false };
      text += span.literal.text;
    }
    return { text, complete: true };
  }

  // `BASE + "/things/" + id` — left-associative, so recursion on the left
  // reaches the head of the concatenation first.
  if (
    ts.isBinaryExpression(expression) &&
    expression.operatorToken.kind === ts.SyntaxKind.PlusToken
  ) {
    const left = constantPrefix(expression.left, depth + 1, seen);
    if (!left) return UNRESOLVED;
    if (!left.complete) return { text: left.text, complete: false };
    const right = constantPrefix(expression.right, depth + 1, seen);
    if (!right) return { text: left.text, complete: false };
    return {
      text: left.text + right.text,
      complete: right.complete,
    };
  }

  if (ts.isIdentifier(expression)) {
    const bound = resolveConst(expression.text, expression);
    if (!bound) return UNRESOLVED;
    if (seen.has(bound)) return UNRESOLVED;
    return constantPrefix(bound, depth + 1, new Set(seen).add(bound));
  }

  // A locally-declared URL builder is followed ONE level into its own return
  // expression, which is then held to this same rule. That is stricter than
  // allowlisting the call site: `tasksUrl(...)` passes because its template
  // starts with a const host, and a sibling `badUrl(host)` fails because its
  // does not. A call to an imported function stays unresolved — cross-file
  // analysis is out of scope, so it must be argued for in review.
  if (
    ts.isCallExpression(expression) &&
    ts.isIdentifier(expression.expression)
  ) {
    const fn = resolveFunction(expression.expression.text, expression);
    if (!fn || seen.has(fn)) return UNRESOLVED;
    const returned = soleReturnExpression(fn);
    if (!returned) return UNRESOLVED;
    return constantPrefix(returned, depth + 1, new Set(seen).add(fn));
  }

  // `new Request(url)` — the host lives in the first argument, so recurse into
  // it rather than treating the constructor as opaque. Without this,
  // `fetch(new Request(CONST))` reported the OUTER call as dynamic (the
  // argument is a NewExpression) and would have forced a REVIEWED_DYNAMIC_HOSTS
  // entry for a provably safe call — diluting the one map that has to stay
  // readable. Duo review, !218. The Request itself is still reported as its own
  // call site, so nothing stops being checked.
  if (isRequestConstruction(expression) && expression.arguments?.[0]) {
    return constantPrefix(expression.arguments[0], depth + 1, seen);
  }

  // Property access, `await`, conditionals, `new URL(...)`, template tags,
  // element access, anything else: not knowably constant.
  return UNRESOLVED;
}

/** A short, stable description of an unresolvable target, for the message. */
function describeKind(node: ts.Expression): string {
  const expression = unwrap(node);
  if (ts.isIdentifier(expression)) {
    return "an identifier that is not a const bound to a constant";
  }
  if (ts.isPropertyAccessExpression(expression)) return "a property access";
  if (ts.isElementAccessExpression(expression)) return "an element access";
  if (ts.isCallExpression(expression))
    return "a function call this file cannot resolve to a constant";
  if (ts.isNewExpression(expression)) return "a constructor call";
  if (ts.isConditionalExpression(expression)) return "a conditional";
  if (ts.isAwaitExpression(expression)) return "an awaited value";
  return "a run-time expression";
}

function verdict(
  node: ts.Expression,
): Pick<FetchTarget, "constantHost" | "reason"> {
  const prefix = constantPrefix(node, 0, new Set());
  if (!prefix) {
    return {
      constantHost: false,
      reason: `the target is ${describeKind(node)}, so the host is not fixed at build time`,
    };
  }
  if (prefix.complete) {
    return { constantHost: true, reason: "the whole target is constant" };
  }
  if (establishesConstantHost(prefix.text)) {
    return {
      constantHost: true,
      reason: `the constant prefix ${JSON.stringify(prefix.text)} pins scheme and host; the interpolation can only extend the path or query`,
    };
  }
  return {
    constantHost: false,
    reason: `the constant prefix ${JSON.stringify(prefix.text)} stops before the authority is closed, so the interpolation can change the request target`,
  };
}

/**
 * `fetch(...)` and `globalThis.fetch(...)`. Any `.fetch(` member call counts:
 * the name is the sink, and an object that happens to expose one is worth a
 * review either way.
 */
function isFetchCall(node: ts.Node): node is ts.CallExpression {
  if (!ts.isCallExpression(node)) return false;
  const callee = node.expression;
  if (ts.isIdentifier(callee)) return callee.text === "fetch";
  if (ts.isPropertyAccessExpression(callee))
    return callee.name.text === "fetch";
  return false;
}

/**
 * `new Request(url)`. Included because `fetch(new Request(url))` is the obvious
 * way past a guard that only reads `fetch`'s own first argument — the Request
 * carries the target.
 */
function isRequestConstruction(node: ts.Node): node is ts.NewExpression {
  return (
    ts.isNewExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "Request"
  );
}

/** Collapse the target's source text to one line so it can key an allowlist. */
function targetText(node: ts.Expression, source: ts.SourceFile): string {
  return node.getText(source).replace(/\s+/g, " ").trim();
}

/**
 * Every outbound-request call site in `source`, with a verdict on each target.
 *
 * `fileName` only affects TypeScript's syntax selection (`.tsx` parses JSX), so
 * pass the real path when scanning the tree.
 */
export function scanFetchTargets(
  source: string,
  fileName = "input.ts",
): FetchTarget[] {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

  const sites: FetchTarget[] = [];
  const visit = (node: ts.Node): void => {
    if (isFetchCall(node) || isRequestConstruction(node)) {
      const target = node.arguments?.[0];
      // `new Request()` with no argument is a type error, not a request.
      if (target) {
        const { line } = sourceFile.getLineAndCharacterOfPosition(
          node.getStart(sourceFile),
        );
        sites.push({
          line: line + 1,
          target: targetText(target, sourceFile),
          ...verdict(target),
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);

  // Source order, so a multi-call file reports top to bottom.
  return sites.sort((a, b) => a.line - b.line);
}
