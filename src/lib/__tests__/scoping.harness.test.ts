import { describe, it, expect } from "vitest";
import { Prisma } from "@prisma/client";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * #35 Phase A — the workspace-scoping harness.
 *
 * The spec's "the owner sees usage numbers, never content" rule is only true if
 * no cross-workspace read path exists. This codebase has shipped an IDOR bug
 * before (#21), so that has to be structural rather than aspirational.
 *
 * The OBVIOUS version of this test is a trap and was rejected: filtering the
 * models that carry `workspaceId` and then asserting they are absent from a set
 * of models that don't is tautological — it can only fail if someone adds
 * `workspaceId` to an exempt model, and would otherwise pass forever while
 * proving nothing.
 *
 * What actually has to be true is that every Prisma call against a
 * workspace-scoped model is constrained to one workspace. That is a
 * source-level property, so this scans for it, with two rules:
 *
 *  1. STRICT — the call's own arguments must mention `workspaceId`. Applied to
 *     every read and every set-wide write, because those are the operations
 *     that can return or modify another workspace's rows on their own.
 *
 *  2. ENCLOSING-FUNCTION — `workspaceId` must appear earlier in the same
 *     function. Applied to single-row writes by primary key, which this
 *     codebase performs as a scoped `findFirst({ where: { id, workspaceId } })`
 *     guard followed by `update({ where: { id } })`. The guard is the
 *     authorization check; deleting it fails this rule, which is the point.
 */

// Reviewed and deliberately unscoped, each with a stated reason. Adding to this
// map is a security decision and should be argued for in review.
const REVIEWED_UNSCOPED: Record<string, string> = {};

// Operations whose own arguments must carry workspaceId.
const STRICT_OPS = [
  "findMany",
  "findFirst",
  "findFirstOrThrow",
  "findUnique",
  "findUniqueOrThrow",
  "aggregate",
  "groupBy",
  "create",
  "createMany",
  "updateMany",
  "deleteMany",
] as const;

// Operations addressed by primary key, where the authorization check is a
// scoped statement earlier in the same function.
const GUARDED_OPS = ["count", "update", "delete", "upsert"] as const;

/** Prisma model names that carry a workspaceId column, camelCased as the
 *  client exposes them. */
function scopedModels(): string[] {
  return Prisma.dmmf.datamodel.models
    .filter((m) => m.fields.some((f) => f.name === "workspaceId"))
    .map((m) => m.name[0].toLowerCase() + m.name.slice(1));
}

function sourceFiles(): string[] {
  return readdirSync("src", { recursive: true, encoding: "utf8" })
    .filter((f) => /\.(ts|tsx)$/.test(f) && !f.includes(".test."))
    .map((f) => path.join("src", f));
}

/** The full argument text of a call, matched by balancing parentheses — a
 *  non-greedy regex stops at the first `)` inside a nested object. */
function callArgs(src: string, openParenIndex: number): string {
  let depth = 0;
  for (let i = openParenIndex; i < src.length; i++) {
    if (src[i] === "(") depth++;
    else if (src[i] === ")") {
      depth--;
      if (depth === 0) return src.slice(openParenIndex, i + 1);
    }
  }
  return src.slice(openParenIndex);
}

/**
 * Source text from the start of the enclosing named function to `index`.
 *
 * The boundary is the nearest `function ` keyword, NOT the nearest arrow: these
 * writes are routinely performed inside a `prisma.$transaction(async (tx) => …)`
 * callback whose authorization check sits just outside it, in the same exported
 * server action. Cutting at the arrow would report those as unscoped.
 */
function enclosingFunctionPrefix(src: string, index: number): string {
  const before = src.slice(0, index);
  const boundary = before.lastIndexOf("function ");
  return boundary === -1 ? before : before.slice(boundary);
}

/**
 * Did the enclosing function already constrain a scoped model to a workspace?
 *
 * This is the authorization check for by-id writes: the codebase reads
 * `findFirst({ where: { id, workspaceId } })` first and then writes by primary
 * key, sometimes writing a related row reached THROUGH that scoped read (an
 * item's task). Requiring merely that the word `workspaceId` appears would not
 * bite, because `const workspaceId = await currentWorkspaceId()` is on the
 * first line of every one of these functions. Requiring a scoped *query* means
 * deleting the guard fails the harness.
 */
function establishesScope(prefix: string, models: string[]): boolean {
  const re = new RegExp(
    `(?:prisma|tx|db)\\.(?:${models.join("|")})\\.\\w+\\(`,
    "g",
  );
  for (const m of prefix.matchAll(re)) {
    const args = callArgs(prefix, m.index + m[0].length - 1);
    if (args.includes("workspaceId")) return true;
  }
  return false;
}

type Offender = { file: string; call: string; rule: string };

function scan(): Offender[] {
  const models = scopedModels();
  const offenders: Offender[] = [];
  // `tx` and `db` are the transaction/injected-client aliases this codebase uses.
  const receivers = "(?:prisma|tx|db)";

  for (const file of sourceFiles()) {
    if (REVIEWED_UNSCOPED[file]) continue;
    const src = readFileSync(file, "utf8");
    for (const model of models) {
      const re = new RegExp(
        `${receivers}\\.${model}\\.(${[...STRICT_OPS, ...GUARDED_OPS].join("|")})\\(`,
        "g",
      );
      for (const m of src.matchAll(re)) {
        const op = m[1] as (typeof STRICT_OPS | typeof GUARDED_OPS)[number];
        const openParen = m.index + m[0].length - 1;
        const args = callArgs(src, openParen);
        if (args.includes("workspaceId")) continue;

        if ((STRICT_OPS as readonly string[]).includes(op)) {
          offenders.push({
            file,
            call: `${model}.${op}`,
            rule: "call must filter by workspaceId",
          });
          continue;
        }
        // GUARDED_OPS: accept only if the enclosing function already
        // constrained a scoped model to a workspace.
        const prefix = enclosingFunctionPrefix(src, m.index);
        if (!establishesScope(prefix, models)) {
          offenders.push({
            file,
            call: `${model}.${op}`,
            rule: "enclosing function runs no workspace-scoped query first",
          });
        }
      }
    }
  }
  return offenders;
}

describe("workspace-scoping harness", () => {
  it("finds the scoped models at all (guards against silently matching nothing)", () => {
    // If a refactor renamed the column, every rule below would vacuously pass.
    expect(scopedModels().length).toBeGreaterThanOrEqual(8);
  });

  it("scans a real number of source files", () => {
    expect(sourceFiles().length).toBeGreaterThan(50);
  });

  it("every prisma call against a workspace-scoped model is workspace-constrained", () => {
    const offenders = scan().map((o) => `${o.file}: ${o.call} — ${o.rule}`);
    expect(offenders).toEqual([]);
  });

  it("no source file references the removed owner-workspace constant", () => {
    // Comments discussing the removal are fine; a live reference is not, so
    // strip line comments before matching.
    const hits = sourceFiles().filter((f) =>
      readFileSync(f, "utf8")
        .split("\n")
        .some(
          (line) =>
            !line.trimStart().startsWith("//") &&
            !line.trimStart().startsWith("*") &&
            line.includes("OWNER_WORKSPACE_ID"),
        ),
    );
    expect(hits).toEqual([]);
  });
});
