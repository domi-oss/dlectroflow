/**
 * #146 — child-process environment hygiene: does every process in this repo
 * that can reach `git` get an ALLOW-LISTED environment, and is the repository it
 * operates on named explicitly?
 *
 * `registry-prune.test.ts` spread `process.env` into its git calls and
 * `ci-docs-only.test.ts` passed no `env` at all. Both inherit `GIT_DIR`,
 * `GIT_WORK_TREE`, `GIT_INDEX_FILE` and the object-directory variables, so both
 * read whatever repository the ambient environment named rather than the one
 * `cwd` implied. That produced a *confident wrong answer* — the prune fixture
 * ranked its tags against the runner's own shallow clone — which is the failure
 * mode a test can catch and a code review cannot, because the offending line
 * reads as careful hygiene: it pins git's config, it just does not pin git's
 * repository. `main` was red for 86 minutes and `deploy_production` was skipped.
 *
 * So the fix needs a guard, or the next fixture is written the same way. Two
 * properties, both asserted over the real tree in `git-env-hygiene.test.ts`:
 *
 *   1. the child's environment comes from `isolatedGitEnv()` — the one shared
 *      allow-list — and never from `process.env`;
 *   2. the repository is named on the command line (`git -C <dir>`), so `cwd`
 *      is not the only thing pinning it.
 *
 * ── Scope: TEST files included, unlike the other scanners ────────────────────
 * `fetch-host-hygiene` deliberately skips `*.test.ts` — a test mocking the
 * network is not an SSRF. Here the test files ARE the subject: they are the only
 * things in this repo that shell out to git, and one of them broke production
 * deploys. A scanner that skipped them would have had nothing to look at.
 *
 * ── Kept free of `fs`, like every other hygiene module ───────────────────────
 * The caller reads the files; this module parses. It uses the TypeScript AST for
 * the reason `fetch-host-hygiene` does: a regex cannot tell `process.env` spread
 * wholesale from a single variable read off it by name, and the difference
 * between those two is the entire bug. The first hands the child every variable
 * git looks at; the second is exactly how an allow-list is meant to be built.
 *
 * Which is also why the prose here never spells out a `process.env` dot-read or
 * a destructuring of it: `check-env-drift.ts` greps raw source text, comments
 * included, and skips only `*.test.ts`. A named example in a doc comment here
 * registers as a real env read and fails that gate on a variable that does not
 * exist (#146 — it did, on `PATH` and on an example binding called `A`).
 *
 * ── What it does NOT see ────────────────────────────────────────────────────
 * A git invocation reached through an imported helper, or one whose command is
 * computed at run time, resolves to "unverifiable" and is reported as a
 * violation rather than waved through — the guard fails closed. It also cannot
 * see inside a shell script: for `bash scripts/foo.sh` it reports the script
 * path, and the test reads the script to decide whether git is in play.
 */

import ts from "typescript";

/**
 * The `node:child_process` functions that can start a process. `fork` is absent
 * on purpose: it starts a Node module, not a command, and cannot be `git`.
 */
const CHILD_PROCESS_APIS = new Set([
  "exec",
  "execSync",
  "execFile",
  "execFileSync",
  "spawn",
  "spawnSync",
]);

/** APIs whose first argument is a shell command line rather than a file. */
const SHELL_LINE_APIS = new Set(["exec", "execSync"]);

/** Commands that run whatever they are handed, so their arguments matter. */
const SHELL_COMMANDS = new Set(["sh", "bash", "zsh", "dash", "env"]);

/** The helper every git-reaching call site must take its environment from. */
export const ALLOWLIST_HELPER = "isolatedGitEnv";

/**
 * A git invocation inside a command line. Requires whitespace after the name so
 * that `command -v git` and a path like `foo/gitignore` do not match, and a
 * boundary before it so `legit status` does not.
 */
const GIT_INVOCATION = /(^|[\s;&|(`$])git\s/;

/** How the child's environment is built. */
export type EnvSource =
  /** From {@link ALLOWLIST_HELPER}: the shared allow-list. */
  | "allowlist"
  /** `process.env` spread, assigned or rest-destructured into it. */
  | "ambient"
  /** No `env` option at all — the child inherits the parent's whole one. */
  | "inherited"
  /** Built some other way, or by something this file cannot follow. */
  | "unverifiable";

/** One child-process call site and the verdicts on it. */
export interface ChildProcessCall {
  /** 1-based line of the call, for the failure message. */
  line: number;
  /** The `node:child_process` function called, e.g. `execFileSync`. */
  api: string;
  /** The command, when it resolves to a constant; `null` when it does not. */
  command: string | null;
  /** True when this call runs `git`, directly or through a shell line. */
  runsGit: boolean;
  /**
   * Shell scripts this call runs, as written in the source (e.g.
   * `scripts/prune-registry.sh`). A script can invoke git itself, which the
   * caller decides by reading it — see the module comment.
   */
  scripts: string[];
  /** Where the child's environment comes from. */
  env: EnvSource;
  /** Why, in a sentence — stated for the passing verdict too, so a review can
   *  check the reasoning rather than just the label. */
  envReason: string;
  /** True when the repository is named on the command line (`-C`/`--git-dir`). */
  pinsRepository: boolean;
}

/**
 * How far to follow `const` bindings. The deepest real chain is two hops
 * (`env: GIT_ENV` → `const GIT_ENV = isolatedGitEnv({…})`), so four leaves room
 * without letting a pathological file spin. Running out resolves to
 * "unverifiable", which fails closed.
 */
const MAX_DEPTH = 4;

/** Strip the wrappers that do not change a value. */
function unwrap(node: ts.Expression): ts.Expression {
  let current = node;
  for (;;) {
    if (
      ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isSatisfiesExpression(current) ||
      ts.isNonNullExpression(current)
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

/**
 * What the nearest `const` named `name` is bound to, walking outwards from
 * `from`.
 *
 * `"ambient-rest"` is the `const { …, ...rest } = process.env` shape — the one
 * `registry-prune.test.ts` used to launder the ambient environment through a
 * list of exclusions. It is not an expression, so it needs its own answer.
 * (Spelling the excluded names out here would trip the env-drift gate; see the
 * module comment.)
 *
 * `let` and `var` return `null`: a rebindable name is only as constant as the
 * last write to it, and proving that needs flow analysis this module does not
 * do. So does a parameter, which shadows anything further out — stopping at the
 * first binding of the name, whatever kind it is, is what keeps a shadowed
 * lookup from reporting the outer value (the mistake `fetch-host-hygiene` fixed
 * in !218).
 */
function bindingOf(
  name: string,
  from: ts.Node,
): ts.Expression | "ambient-rest" | null {
  for (let scope: ts.Node | undefined = from; scope; scope = scope.parent) {
    if (
      ts.isFunctionDeclaration(scope) ||
      ts.isFunctionExpression(scope) ||
      ts.isArrowFunction(scope) ||
      ts.isMethodDeclaration(scope)
    ) {
      for (const parameter of scope.parameters) {
        if (ts.isIdentifier(parameter.name) && parameter.name.text === name) {
          return null;
        }
      }
    }
    for (const statement of statementsOf(scope)) {
      if (!ts.isVariableStatement(statement)) continue;
      const isConst =
        (statement.declarationList.flags & ts.NodeFlags.Const) !== 0;
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) {
          if (declaration.name.text !== name) continue;
          if (!isConst) return null;
          return declaration.initializer ?? null;
        }
        if (ts.isObjectBindingPattern(declaration.name)) {
          for (const element of declaration.name.elements) {
            if (!ts.isIdentifier(element.name)) continue;
            if (element.name.text !== name) continue;
            // `...rest` of the ambient environment: everything the exclusion
            // list above it did not think to name.
            if (
              element.dotDotDotToken &&
              declaration.initializer &&
              isAmbientEnv(declaration.initializer, 0, new Set())
            ) {
              return "ambient-rest";
            }
            return null;
          }
        }
      }
    }
  }
  return null;
}

/** `process.env` itself. */
function isProcessEnv(node: ts.Expression): boolean {
  const expression = unwrap(node);
  return (
    ts.isPropertyAccessExpression(expression) &&
    expression.name.text === "env" &&
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === "process"
  );
}

/**
 * Does `node` carry the ambient environment as a WHOLE object?
 *
 * `{ ...process.env }`, `process.env`, `Object.assign({}, process.env)` and a
 * rest binding of it all do. A single named read — PATH, say — does not:
 * reading one variable by name is how the allow-list is built, and conflating
 * the two would make this guard unusable. That distinction is the reason this
 * module parses TypeScript instead of grepping for `process.env`.
 */
function isAmbientEnv(
  node: ts.Expression,
  depth: number,
  seen: ReadonlySet<ts.Node>,
): boolean {
  if (depth > MAX_DEPTH) return false;
  const expression = unwrap(node);
  if (seen.has(expression)) return false;
  const nextSeen = new Set(seen).add(expression);

  if (isProcessEnv(expression)) return true;

  if (ts.isIdentifier(expression)) {
    const bound = bindingOf(expression.text, expression);
    if (bound === "ambient-rest") return true;
    return bound ? isAmbientEnv(bound, depth + 1, nextSeen) : false;
  }

  if (ts.isObjectLiteralExpression(expression)) {
    return expression.properties.some(
      (property) =>
        ts.isSpreadAssignment(property) &&
        isAmbientEnv(property.expression, depth + 1, nextSeen),
    );
  }

  // `Object.assign(target, ...sources)` merges every argument into the result,
  // so any ambient one contaminates it.
  if (
    ts.isCallExpression(expression) &&
    ts.isPropertyAccessExpression(expression.expression) &&
    expression.expression.name.text === "assign"
  ) {
    return expression.arguments.some((argument) =>
      isAmbientEnv(argument, depth + 1, nextSeen),
    );
  }

  return false;
}

/** Does `node` come from {@link ALLOWLIST_HELPER}, directly or spread in? */
function usesAllowlistHelper(
  node: ts.Expression,
  depth: number,
  seen: ReadonlySet<ts.Node>,
): boolean {
  if (depth > MAX_DEPTH) return false;
  const expression = unwrap(node);
  if (seen.has(expression)) return false;
  const nextSeen = new Set(seen).add(expression);

  if (
    ts.isCallExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === ALLOWLIST_HELPER
  ) {
    return true;
  }

  if (ts.isIdentifier(expression)) {
    const bound = bindingOf(expression.text, expression);
    return bound && bound !== "ambient-rest"
      ? usesAllowlistHelper(bound, depth + 1, nextSeen)
      : false;
  }

  if (ts.isObjectLiteralExpression(expression)) {
    return expression.properties.some(
      (property) =>
        ts.isSpreadAssignment(property) &&
        usesAllowlistHelper(property.expression, depth + 1, nextSeen),
    );
  }

  return false;
}

/** The constant string `node` must be, or `null`. Follows one `const` hop. */
function constantString(
  node: ts.Expression,
  depth: number,
  seen: ReadonlySet<ts.Node>,
): string | null {
  if (depth > MAX_DEPTH) return null;
  const expression = unwrap(node);
  if (seen.has(expression)) return null;
  const nextSeen = new Set(seen).add(expression);

  if (
    ts.isStringLiteral(expression) ||
    ts.isNoSubstitutionTemplateLiteral(expression)
  ) {
    return expression.text;
  }
  if (ts.isIdentifier(expression)) {
    const bound = bindingOf(expression.text, expression);
    return bound && bound !== "ambient-rest"
      ? constantString(bound, depth + 1, nextSeen)
      : null;
  }
  return null;
}

/**
 * Every constant string reachable from `node`: literals, the constants an
 * identifier is bound to, template heads and tails, array elements, and the
 * arguments of a call such as `join(process.cwd(), "scripts/foo.sh")`.
 *
 * Nested functions are not entered — their strings belong to them, not to this
 * invocation. This is deliberately generous rather than exact: it feeds the
 * "does this call name a `.sh` file / mention git / pass `-C`" questions, where
 * seeing too much means a call gets *checked* and seeing too little means it
 * silently does not.
 */
function reachableStrings(
  node: ts.Expression,
  depth: number,
  seen: ReadonlySet<ts.Node>,
): string[] {
  if (depth > MAX_DEPTH) return [];
  const expression = unwrap(node);
  if (seen.has(expression)) return [];
  const nextSeen = new Set(seen).add(expression);
  const recurse = (child: ts.Expression): string[] =>
    reachableStrings(child, depth + 1, nextSeen);

  if (
    ts.isStringLiteral(expression) ||
    ts.isNoSubstitutionTemplateLiteral(expression)
  ) {
    return [expression.text];
  }
  if (ts.isTemplateExpression(expression)) {
    return [
      expression.head.text,
      ...expression.templateSpans.flatMap((span) => [
        ...recurse(span.expression),
        span.literal.text,
      ]),
    ];
  }
  if (ts.isIdentifier(expression)) {
    const bound = bindingOf(expression.text, expression);
    return bound && bound !== "ambient-rest" ? recurse(bound) : [];
  }
  if (ts.isArrayLiteralExpression(expression)) {
    return expression.elements.flatMap((element) =>
      ts.isSpreadElement(element)
        ? recurse(element.expression)
        : recurse(element),
    );
  }
  if (ts.isCallExpression(expression)) {
    return expression.arguments.flatMap((argument) => recurse(argument));
  }
  if (
    ts.isBinaryExpression(expression) &&
    expression.operatorToken.kind === ts.SyntaxKind.PlusToken
  ) {
    return [...recurse(expression.left), ...recurse(expression.right)];
  }
  return [];
}

/** The `env` property of an options object, or `undefined` when there is none. */
function envProperty(
  options: ts.ObjectLiteralExpression,
): ts.Expression | null {
  for (const property of options.properties) {
    if (
      ts.isPropertyAssignment(property) &&
      (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) &&
      property.name.text === "env"
    ) {
      return property.initializer;
    }
    // `{ env }` — shorthand for `{ env: env }`.
    if (
      ts.isShorthandPropertyAssignment(property) &&
      property.name.text === "env"
    ) {
      return property.name;
    }
  }
  return null;
}

/**
 * The options object of a child-process call: the last argument that is (or is a
 * `const` bound to) an object literal.
 *
 * Positional rules differ per API — `execFileSync(file, args, options)`,
 * `execSync(command, options)`, `execFile(file, args, options, callback)` — and
 * arguments are arrays, not objects, so "the last object literal" identifies it
 * for all of them without a table to keep in step.
 */
function optionsObject(
  call: ts.CallExpression,
): ts.ObjectLiteralExpression | null {
  for (let i = call.arguments.length - 1; i >= 1; i--) {
    const candidate = unwrap(call.arguments[i]);
    if (ts.isObjectLiteralExpression(candidate)) return candidate;
    if (ts.isIdentifier(candidate)) {
      const bound = bindingOf(candidate.text, candidate);
      if (bound && bound !== "ambient-rest") {
        const resolved = unwrap(bound);
        if (ts.isObjectLiteralExpression(resolved)) return resolved;
      }
    }
  }
  return null;
}

/**
 * What a file imported from `node:child_process`: local name → API name (so
 * `import { execFileSync as run }` is followed), plus any namespace binding.
 */
interface ChildProcessBindings {
  local: Map<string, string>;
  namespaces: Set<string>;
}

/**
 * Resolve the imports, rather than matching on the callee's NAME.
 *
 * `exec` and `execSync` are also `RegExp.prototype.exec` and better-sqlite3's
 * `db.exec`, and this repo's own parsers are full of `/…/.exec(buffer)`. A
 * name-matching scanner would report every one of them as a child process, and a
 * guard whose output is mostly noise is a guard people stop reading.
 */
function childProcessBindings(sourceFile: ts.SourceFile): ChildProcessBindings {
  const bindings: ChildProcessBindings = {
    local: new Map(),
    namespaces: new Set(),
  };
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;
    // Not named `module`: `@next/next/no-assign-module-variable` bans that
    // identifier outright, because assigning it breaks webpack's CommonJS wrapper.
    const specifier = statement.moduleSpecifier.text;
    if (specifier !== "node:child_process" && specifier !== "child_process") {
      continue;
    }

    const clause = statement.importClause;
    if (!clause) continue;
    // `import cp from "node:child_process"` — CommonJS interop, so the default
    // binding is the module object.
    if (clause.name) bindings.namespaces.add(clause.name.text);
    const named = clause.namedBindings;
    if (!named) continue;
    if (ts.isNamespaceImport(named)) {
      bindings.namespaces.add(named.name.text);
      continue;
    }
    for (const element of named.elements) {
      const api = (element.propertyName ?? element.name).text;
      if (CHILD_PROCESS_APIS.has(api)) {
        bindings.local.set(element.name.text, api);
      }
    }
  }
  return bindings;
}

/** `execFileSync(…)` and `childProcess.execFileSync(…)` alike. */
function childProcessApi(
  call: ts.CallExpression,
  bindings: ChildProcessBindings,
): string | null {
  const callee = unwrap(call.expression);
  if (ts.isIdentifier(callee)) return bindings.local.get(callee.text) ?? null;
  if (
    ts.isPropertyAccessExpression(callee) &&
    ts.isIdentifier(callee.expression) &&
    bindings.namespaces.has(callee.expression.text) &&
    CHILD_PROCESS_APIS.has(callee.name.text)
  ) {
    return callee.name.text;
  }
  return null;
}

function envVerdict(
  call: ts.CallExpression,
): Pick<ChildProcessCall, "env" | "envReason"> {
  const options = optionsObject(call);
  if (!options) {
    return {
      env: "inherited",
      envReason:
        "no options object, so the child inherits the whole parent environment",
    };
  }
  const env = envProperty(options);
  if (!env) {
    return {
      env: "inherited",
      envReason:
        "no `env` option, so the child inherits the whole parent environment",
    };
  }
  if (isAmbientEnv(env, 0, new Set())) {
    return {
      env: "ambient",
      envReason:
        "`process.env` is carried in as a whole object, so every variable the " +
        "parent has reaches the child — including the ones nobody listed",
    };
  }
  if (usesAllowlistHelper(env, 0, new Set())) {
    return {
      env: "allowlist",
      envReason: `built from ${ALLOWLIST_HELPER}(), which starts from {}`,
    };
  }
  return {
    env: "unverifiable",
    envReason: `an \`env\` this file cannot follow back to ${ALLOWLIST_HELPER}()`,
  };
}

/** Args that name the repository, so `cwd` is not the only thing pinning it. */
function namesRepository(strings: readonly string[]): boolean {
  return strings.some(
    (value) =>
      value === "-C" ||
      / -C(\s|$)/.test(value) ||
      value === "--git-dir" ||
      value.startsWith("--git-dir=") ||
      value.includes(" --git-dir"),
  );
}

/**
 * Every child-process call site in `source`, with verdicts on each.
 *
 * `fileName` only affects TypeScript's syntax selection (`.tsx` parses JSX), so
 * pass the real path when scanning the tree.
 */
export function scanChildProcessCalls(
  source: string,
  fileName = "input.ts",
): ChildProcessCall[] {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

  const bindings = childProcessBindings(sourceFile);
  // Nothing imported means nothing can be spawned. Bail before walking, so a
  // file that merely uses `/…/.exec(text)` is not even considered.
  if (bindings.local.size === 0 && bindings.namespaces.size === 0) return [];

  const calls: ChildProcessCall[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const api = childProcessApi(node, bindings);
      if (api && node.arguments.length > 0) {
        const command = constantString(node.arguments[0], 0, new Set());
        const argumentStrings = node.arguments
          .slice(1)
          .flatMap((argument) => reachableStrings(argument, 0, new Set()));
        const commandStrings = reachableStrings(
          node.arguments[0],
          0,
          new Set(),
        );

        // A shell runs whatever string it is handed, so its arguments are where
        // git hides; `exec`/`execSync` take that string as the command itself.
        const throughShell =
          SHELL_LINE_APIS.has(api) ||
          (command !== null && SHELL_COMMANDS.has(basename(command)));
        const runsGit =
          (command !== null && basename(command) === "git") ||
          (throughShell &&
            [...commandStrings, ...argumentStrings].some((value) =>
              GIT_INVOCATION.test(value),
            ));

        const { line } = sourceFile.getLineAndCharacterOfPosition(
          node.getStart(sourceFile),
        );
        calls.push({
          line: line + 1,
          api,
          command,
          runsGit,
          scripts: [...commandStrings, ...argumentStrings].filter((value) =>
            value.endsWith(".sh"),
          ),
          pinsRepository: namesRepository([
            ...commandStrings,
            ...argumentStrings,
          ]),
          ...envVerdict(node),
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);

  // Source order, so a multi-call file reports top to bottom.
  return calls.sort((a, b) => a.line - b.line);
}

/** Last path segment, so `/usr/bin/git` is recognised as git. */
function basename(command: string): string {
  return command.split("/").pop() ?? command;
}
