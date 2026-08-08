import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import {
  findClientDbLeaks,
  hasUseClientDirective,
  hasUseServerDirective,
  importedModules,
  instantiatesDbClient,
  type ModuleFacts,
} from "@/lib/client-server-boundary";

/**
 * #199 — no `"use client"` module may reach the database client.
 *
 * `src/lib/db.ts` runs `new PrismaClient()` at MODULE SCOPE, so importing it from
 * anywhere in a client component's graph does two things: it bundles the whole
 * Prisma client into the browser (measured: two chunks of 156 KB each, carrying the
 * string "unable to run in this browser"), and it throws the moment that chunk is
 * evaluated.
 *
 * **`next build` is green either way**, which is why this is a gate and not a note.
 * `shopping-summary-card.tsx` shipped exactly this on its first draft — a client
 * component importing a pure-looking helper from a module that also held the DB
 * sync — and nothing in the repo could see it. The unit suite imports modules in
 * node, where a server-only import is simply available; the e2e suite renders pages,
 * and that card only appears for a workspace with the feature on AND a non-empty
 * shopping list, which no spec had. It was found by grepping the built chunks, which
 * is not a repeatable way to find it again.
 *
 * The synthetic-graph tests below come first, because a guard that can only be
 * exercised against the repo cannot be shown to FAIL — the house rule for every
 * file-parsing check here.
 */

const ROOT = process.cwd();

/** Every `.ts`/`.tsx` module under `src/`, tests excluded. */
function sourceFiles(): string[] {
  return readdirSync(path.join(ROOT, "src"), {
    recursive: true,
    encoding: "utf8",
  })
    .filter((f) => /\.(ts|tsx)$/.test(f) && !f.includes(".test."))
    .map((f) => path.join("src", f));
}

/**
 * Resolve an import specifier to a repo-relative module path, trying the four
 * spellings this tree uses. Returns null for something outside `src/` — a package,
 * or a `.css` — which is correctly not part of this walk.
 */
function resolve(fromFile: string, specifier: string): string | null {
  const base = specifier.startsWith("@/")
    ? path.join("src", specifier.slice(2))
    : path.join(path.dirname(fromFile), specifier);
  for (const candidate of [
    `${base}.ts`,
    `${base}.tsx`,
    path.join(base, "index.ts"),
    path.join(base, "index.tsx"),
  ]) {
    try {
      readFileSync(path.join(ROOT, candidate), "utf8");
      return candidate;
    } catch {
      // Not this spelling — try the next.
    }
  }
  return null;
}

function realModules(): ModuleFacts[] {
  return sourceFiles().map((file) => {
    const source = readFileSync(path.join(ROOT, file), "utf8");
    return {
      path: file,
      isClientEntry: hasUseClientDirective(source),
      isServerBoundary: hasUseServerDirective(source),
      instantiatesDbClient: instantiatesDbClient(source),
      imports: importedModules(source)
        .map((s) => resolve(file, s))
        .filter((p): p is string => p !== null),
    };
  });
}

describe("hasUseClientDirective", () => {
  it("sees the directive", () => {
    expect(hasUseClientDirective('"use client";\nexport const a = 1;')).toBe(
      true,
    );
  });

  it("sees it after another directive", () => {
    expect(hasUseClientDirective('"use strict";\n"use client";\n')).toBe(true);
  });

  // The false positive a regex would produce: this repo names the directive in
  // prose in several module docs.
  it("does not see it in a comment", () => {
    expect(
      hasUseClientDirective('// a "use client" module would...\nexport {};'),
    ).toBe(false);
  });

  it("does not see it after real code", () => {
    expect(hasUseClientDirective('const a = 1;\n"use client";')).toBe(false);
  });

  it("tells the two directives apart", () => {
    expect(hasUseServerDirective('"use server";\n')).toBe(true);
    expect(hasUseClientDirective('"use server";\n')).toBe(false);
    expect(hasUseServerDirective('"use client";\n')).toBe(false);
  });
});

describe("instantiatesDbClient", () => {
  it("sees a module-scope construction", () => {
    expect(instantiatesDbClient("export const p = new PrismaClient();")).toBe(
      true,
    );
  });

  // src/lib/db.ts's real shape: nested inside a `??` expression, so a check that
  // only looked at top-level statements would miss it.
  it("sees one nested in an expression", () => {
    expect(
      instantiatesDbClient(
        "export const p = globalForPrisma.prisma ?? new PrismaClient({ log: [] });",
      ),
    ).toBe(true);
  });

  it("does not see a mention in prose", () => {
    expect(
      instantiatesDbClient("// never call new PrismaClient() here\nexport {};"),
    ).toBe(false);
  });
});

describe("importedModules", () => {
  it("collects alias, relative, re-export and dynamic VALUE imports", () => {
    const source = [
      'import { a } from "@/lib/a";',
      'import b from "./b";',
      'export { c } from "@/lib/c";',
      'const d = await import("@/lib/d");',
      'import react from "react";',
    ].join("\n");
    expect(importedModules(source)).toEqual([
      "@/lib/a",
      "./b",
      "@/lib/c",
      "@/lib/d",
    ]);
  });

  // The exclusion that stopped this guard demanding a module split for a TYPE:
  // `roundup-card.tsx` has `import type { Rollup } from "@/lib/rollup"`, and
  // rollup.ts imports the database — none of which reaches a bundle.
  it("ignores a type-only import, which is erased", () => {
    expect(importedModules('import type { R } from "@/lib/rollup";')).toEqual(
      [],
    );
    expect(importedModules('export type { R } from "@/lib/rollup";')).toEqual(
      [],
    );
  });

  it("still counts a declaration that mixes inline type and value specifiers", () => {
    expect(importedModules('import { type A, b } from "@/lib/mixed";')).toEqual(
      ["@/lib/mixed"],
    );
  });

  it("ignores a path named in a comment", () => {
    expect(importedModules("// see @/lib/db for why\nexport {};")).toEqual([]);
  });
});

describe("findClientDbLeaks", () => {
  const m = (over: Partial<ModuleFacts>): ModuleFacts => ({
    path: "src/x.ts",
    isClientEntry: false,
    isServerBoundary: false,
    instantiatesDbClient: false,
    imports: [],
    ...over,
  });

  it("reports a leak two hops away, and names the whole path", () => {
    // The exact shape of the bug: the client component's own import looks
    // harmless, and the offence is one hop further in.
    const leaks = findClientDbLeaks([
      m({ path: "card.tsx", isClientEntry: true, imports: ["helper.ts"] }),
      m({ path: "helper.ts", imports: ["db.ts"] }),
      m({ path: "db.ts", instantiatesDbClient: true }),
    ]);
    expect(leaks).toEqual([
      { entry: "card.tsx", via: ["card.tsx", "helper.ts", "db.ts"] },
    ]);
  });

  it("passes a client component whose helper is pure", () => {
    expect(
      findClientDbLeaks([
        m({ path: "card.tsx", isClientEntry: true, imports: ["pure.ts"] }),
        m({ path: "pure.ts" }),
        m({ path: "db.ts", instantiatesDbClient: true }),
      ]),
    ).toEqual([]);
  });

  it("does not fault a SERVER module for importing the database", () => {
    expect(
      findClientDbLeaks([
        m({ path: "page.tsx", imports: ["db.ts"] }),
        m({ path: "db.ts", instantiatesDbClient: true }),
      ]),
    ).toEqual([]);
  });

  // The framework's intended pattern, and every settings section in this repo does
  // it: a client component calls a server action, which of course touches the
  // database. Next.js replaces the action module with a client reference, so nothing
  // behind it is bundled. Without this rule the guard reported 27 leaks, 26 of them
  // this shape.
  it('stops at a "use server" module instead of calling it a leak', () => {
    expect(
      findClientDbLeaks([
        m({ path: "card.tsx", isClientEntry: true, imports: ["action.ts"] }),
        m({ path: "action.ts", isServerBoundary: true, imports: ["db.ts"] }),
        m({ path: "db.ts", instantiatesDbClient: true }),
      ]),
    ).toEqual([]);
  });

  it("still reports a leak that goes AROUND a server module", () => {
    // The control for the rule above: the exclusion must not become a way to hide a
    // real leak reachable by another edge.
    const leaks = findClientDbLeaks([
      m({
        path: "card.tsx",
        isClientEntry: true,
        imports: ["action.ts", "helper.ts"],
      }),
      m({ path: "action.ts", isServerBoundary: true, imports: ["db.ts"] }),
      m({ path: "helper.ts", imports: ["db.ts"] }),
      m({ path: "db.ts", instantiatesDbClient: true }),
    ]);
    expect(leaks).toHaveLength(1);
    expect(leaks[0].via).toEqual(["card.tsx", "helper.ts", "db.ts"]);
  });

  // Duo review, !295 — the entry node itself was never tested, because the leak
  // check was gated on `via.length > 1`. A `"use client"` file that inlines
  // `new PrismaClient()` — or `src/lib/db.ts` itself growing the directive — passed
  // silently, which is the exact thing this guard exists to catch, with zero hops.
  it("reports a client entry that instantiates the database itself", () => {
    expect(
      findClientDbLeaks([
        m({
          path: "card.tsx",
          isClientEntry: true,
          instantiatesDbClient: true,
        }),
      ]),
    ).toEqual([{ entry: "card.tsx", via: ["card.tsx"] }]);
  });

  it("survives an import cycle rather than recursing forever", () => {
    expect(
      findClientDbLeaks([
        m({ path: "a.ts", isClientEntry: true, imports: ["b.ts"] }),
        m({ path: "b.ts", imports: ["a.ts"] }),
      ]),
    ).toEqual([]);
  });
});

describe("the real tree", () => {
  const modules = realModules();

  // Guards the guard. Every assertion below is an absence, and an absence over an
  // empty or mis-resolved module list is vacuous — the "nothing found" failure.
  it("found the client entry points and the database module", () => {
    expect(modules.length).toBeGreaterThan(100);
    const clients = modules.filter((m) => m.isClientEntry);
    expect(clients.length).toBeGreaterThan(20);
    const db = modules.filter((m) => m.instantiatesDbClient).map((m) => m.path);
    expect(db).toContain("src/lib/db.ts");
  });

  it("resolved imports rather than dropping them", () => {
    // If `resolve` returned null for everything, every graph would be one node deep
    // and no leak could ever be found.
    const card = modules.find((m) =>
      m.path.endsWith("components/inbox/shopping-summary-card.tsx"),
    );
    expect(card?.isClientEntry).toBe(true);
    expect(card?.imports).toContain("src/lib/shopping-summary.ts");
  });

  it("no client component can reach the database client", () => {
    const leaks = findClientDbLeaks(modules);
    expect(
      leaks,
      leaks.map((l) => `${l.entry} → ${l.via.join(" → ")}`).join("\n"),
    ).toEqual([]);
  });
});
