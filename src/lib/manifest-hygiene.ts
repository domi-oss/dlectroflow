/**
 * #76 — pure helpers for asserting that `package.json` declares every
 * third-party package the repo imports from files Next never bundles. Kept
 * free of `fs` so the parsing is unit-testable on synthetic sources (the
 * lockfile-hygiene and env-drift modules follow the same split); the caller
 * reads the files.
 *
 * Inside `src/`, an undeclared import fails the build. Outside it — the root
 * config files and the `tsx` entrypoints the cluster runs — nothing traces the
 * dependency, so an undeclared package keeps working for exactly as long as
 * some *other* dependency happens to hoist it to the top of `node_modules`,
 * and then fails at deploy time. That is what #76 was.
 */

import { isBuiltin } from "node:module";

/**
 * `source` with comments removed, so a specifier quoted inside a comment (the
 * `// npm install --save-dev prisma dotenv` header Prisma generates, say) is
 * never mistaken for a real import.
 *
 * The line-comment pass refuses to fire when `//` is preceded by `:`, which
 * keeps a `https://…` inside a string from truncating the rest of the line.
 */
export function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/**
 * The package a bare specifier resolves to: `dotenv/config` → `dotenv`,
 * `@testing-library/jest-dom/vitest` → `@testing-library/jest-dom`. Scoped
 * names keep two segments, everything else keeps one.
 */
export function packageNameOf(specifier: string): string {
  const segments = specifier.split("/");
  return specifier.startsWith("@")
    ? segments.slice(0, 2).join("/")
    : segments[0];
}

/**
 * Matches the specifier of a static import, a re-export, a dynamic `import()`
 * and a `require()` — the four ways these files pull in a package.
 */
const SPECIFIER = /(?:\bfrom|\bimport|\brequire)\s*\(?\s*["']([^"']+)["']/g;

/**
 * Specifiers that resolve inside the repo rather than to a package: relative
 * paths, and the `@/…` alias that tsconfig `paths` and vitest both map to
 * `src/`. The alias needs saying explicitly — it opens with `@`, so without
 * this it would be read as the scoped package `@/lib` and reported as an
 * undeclared dependency.
 */
function isInternal(specifier: string): boolean {
  return specifier.startsWith(".") || specifier.startsWith("@/");
}

/**
 * Every third-party package `source` imports, sorted and de-duplicated.
 * Internal specifiers and Node builtins (with or without the `node:` prefix)
 * are dropped, since neither is ever declared in `package.json`.
 */
export function importedPackages(source: string): string[] {
  const names = [...stripComments(source).matchAll(SPECIFIER)]
    .map((match) => match[1])
    .filter((specifier) => !isInternal(specifier) && !isBuiltin(specifier))
    .map(packageNameOf);
  return [...new Set(names)].sort();
}
