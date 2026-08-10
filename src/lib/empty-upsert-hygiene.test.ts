import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { findEmptyUpsertUpdates } from "@/lib/empty-upsert-hygiene";

/**
 * #223 — the guard for a class this repo has now written three times.
 *
 * An upsert with an EMPTY update payload is not atomic. Prisma 6.19 compiles an
 * upsert to a native `INSERT … ON CONFLICT` **only when the update payload is
 * non-empty**; with an empty one it degrades to `BEGIN; SELECT; INSERT; COMMIT`,
 * a read-then-insert at READ COMMITTED, and two concurrent callers from the
 * no-row state both insert. The loser raises P2002.
 *
 * Three sites shipped it — `createOwnFeed`, `getTodaySpark` and the one caught
 * in `!295` — and **two of the three carried a comment asserting the race was
 * closed.** That is why it survived a review each time: the shape reads as
 * though the question had been considered and answered. A reviewer cannot be
 * asked to remember a Prisma compilation rule; a grep can.
 *
 * "Would have caught all three" is a claim worth checking rather than making, so
 * it was run against the real blobs: `calendar-feed.ts:175` and `spark.ts:75` as
 * they stood on `main`, and `shopping-summary-sync.ts:107` at `2b993ea^` on
 * `!295`. Three flagged, at those exact lines — and `!295`'s own fix scans clean,
 * so this guard is not waiting to fail the build when that branch lands.
 *
 * The third one is why the rule looks through a conditional. It was written
 * `update: options.resurface ? { clearedAt: null } : {}`, which the obvious
 * version of this guard walks straight past.
 *
 * ## The rule: `create` and an empty `update` in the same object literal
 *
 * Not "an empty `update` anywhere", which would flag any unrelated object that
 * happened to carry an `update` key, and not "inside an `upsert(` call", which
 * would be defeatable by hoisting the argument into a `const` one line up. The
 * pair is what makes it decidably a Prisma upsert argument — top-level upserts
 * take `where`/`create`/`update`, nested ones take `create`/`update` — wherever
 * it is written, inline or hoisted.
 *
 * ## AST, not a regex, and here that is not hypothetical
 *
 * Both files fixed under #223 now **describe** the defective shape in prose,
 * because a comment claiming a closed race is worse than no comment and the
 * replacements have to say what changed. A regex reports the two modules that
 * exist to prevent the thing, on the very line explaining it — and a guard that
 * cries wolf is a guard that gets relaxed. This repo has shipped a tool that
 * read a comment as code twice already (`manifest-hygiene` #76, `env-drift`
 * #30), which is what `src/lib/source-text.ts` exists for; a parser gets it free.
 *
 * ## The three spellings added in review on `!302`
 *
 * A `??`/`||`/`&&` fallback to `{}`, which is the ternary above in different
 * punctuation; a shorthand `create`, which made the pair invisible and took a
 * literally-empty `update: {}` down with it; and a payload written as a name,
 * resolved to a same-file `const` or not resolved at all. Each has its positive
 * case below AND the control that pins where the resolver gives up — a parameter,
 * a `let`, an import, a destructured name, a mutated object — because a guard
 * that fabricates is one somebody relaxes rather than fixes.
 *
 * ## What is deliberately NOT scanned
 *
 * Test files. Four integration tests seed fixtures with an empty-update upsert
 * (`rewards`, `rollup`, `breakdown-context`, `scoping.harness`), and there is no
 * concurrency in a `beforeAll`. Flagging them would buy nothing and would make
 * the guard's first act be to demand a change with no defect behind it.
 */

const SCANNED_ROOTS = ["src", "prisma"];
const SELF = path.join("src", "lib", "empty-upsert-hygiene.test.ts");

function scannedFiles(): string[] {
  const files: string[] = [];
  for (const root of SCANNED_ROOTS) {
    const entries = readdirSync(root, { recursive: true, encoding: "utf8" });
    for (const entry of entries) {
      if (!/\.(ts|tsx|mts)$/.test(entry)) continue;
      if (/\.test\.(ts|tsx)$/.test(entry)) continue;
      const file = path.join(root, entry);
      if (file === SELF) continue;
      files.push(file);
    }
  }
  return files;
}

/**
 * The two sites #223 converted, named rather than counted.
 *
 * A count would still pass if one regressed and an unrelated file were fixed;
 * naming them is what lets the mutation check below say WHICH one lost its
 * conversion.
 */
const CONVERTED_SITES = ["src/lib/calendar-feed.ts", "src/lib/spark.ts"];

describe("findEmptyUpsertUpdates — the parser, on synthetic input", () => {
  it("flags the inline form, which is how all three shipped", () => {
    const findings = findEmptyUpsertUpdates(
      `await prisma.calendarFeed.upsert({
         where: { userId },
         create: { userId, token: mintFeedToken() },
         update: {},
       });`,
      "synthetic.ts",
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].line).toBe(4);
    expect(findings[0].reason).toContain("skipDuplicates");
  });

  it("flags it however the empty object is spaced or commented", () => {
    // `getTodaySpark` wrote it as `update: {}, // if two requests race…`, and
    // nothing stops the next one writing it across three lines.
    expect(
      findEmptyUpsertUpdates(
        `await prisma.dailySpark.upsert({
           where: { workspaceId_date: { workspaceId, date } },
           create: { date, workspaceId, quote, source },
           update: {
             // if two requests race, keep the first
           },
         });`,
        "synthetic.ts",
      ),
    ).toHaveLength(1);
  });

  it("flags the HOISTED form, which keying on `upsert(` would miss", () => {
    // The evasion a call-site-anchored guard invites: move the argument one line
    // up and the call expression no longer contains an object literal to read.
    // Keying on the `create` + empty-`update` pair sees it wherever it is written.
    const findings = findEmptyUpsertUpdates(
      `const args = {
         where: { userId },
         create: { userId, token },
         update: {},
       };
       await prisma.calendarFeed.upsert(args);`,
      "synthetic.ts",
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].line).toBe(4);
  });

  it("flags a nested upsert, which takes create + update and no where", () => {
    expect(
      findEmptyUpsertUpdates(
        `await prisma.user.update({
           where: { id },
           data: { feed: { upsert: { create: { token }, update: {} } } },
         });`,
        "synthetic.ts",
      ),
    ).toHaveLength(1);
  });

  it("flags a CONDITIONAL whose other branch is empty — the third real instance", () => {
    // Verbatim from `!295` before `2b993ea` fixed it: `syncShoppingSummary` wrote
    // `update: options.resurface ? { clearedAt: null } : {}`. Prisma decides which
    // SQL to emit per call, from the payload it is actually handed, so every
    // `resurface: false` write took the non-atomic path — and this is the one of
    // the three that a guard keyed on "the initializer IS an empty object" would
    // have walked straight past. Checked against the real blob, not imagined.
    const findings = findEmptyUpsertUpdates(
      `await prisma.shoppingSummary.upsert({
         where: { workspaceId },
         create: { workspaceId },
         update: options.resurface ? { clearedAt: null } : {},
       });`,
      "synthetic.ts",
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].line).toBe(4);
  });

  it("flags a conditional whose FIRST branch is the empty one", () => {
    expect(
      findEmptyUpsertUpdates(
        `await m.upsert({ where: { id }, create: { id }, update: fresh ? {} : { seen } });`,
        "synthetic.ts",
      ),
    ).toHaveLength(1);
  });

  it("does NOT flag a conditional with two non-empty branches", () => {
    expect(
      findEmptyUpsertUpdates(
        `await m.upsert({
           where: { id },
           create: { id },
           update: resurface ? { clearedAt: null } : { touchedAt: new Date() },
         });`,
        "synthetic.ts",
      ),
    ).toEqual([]);
  });

  it("sees through parentheses, which change nothing and hide everything", () => {
    expect(
      findEmptyUpsertUpdates(
        `await m.upsert({ where: { id }, create: { id }, update: ({}) });`,
        "synthetic.ts",
      ),
    ).toHaveLength(1);
  });

  it("flags a `??` fallback to empty — the ternary's other spelling", () => {
    // Raised in review on `!302`. `a ?? {}` IS `a != null ? a : {}`: same
    // construct, same defect, and the guard was built for the ternary. Every
    // call that finds `maybeChanges` nullish hands Prisma an empty payload and
    // takes the read-then-insert path, which is the whole rationale — Prisma
    // picks its SQL per call, from what it is actually handed.
    const findings = findEmptyUpsertUpdates(
      `await prisma.shoppingSummary.upsert({
         where: { workspaceId },
         create: { workspaceId },
         update: maybeChanges ?? {},
       });`,
      "synthetic.ts",
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].line).toBe(4);
  });

  it("flags a `||` fallback to empty", () => {
    expect(
      findEmptyUpsertUpdates(
        `await m.upsert({ where: { id }, create: { id }, update: changes || {} });`,
        "synthetic.ts",
      ),
    ).toHaveLength(1);
  });

  it("flags `&& {}`, where the empty payload is the TRUTHY branch", () => {
    // `&&` yields its right operand, so this is empty exactly when `resurface`
    // is true — the mirror image of the `??`/`||` case rather than a new one.
    expect(
      findEmptyUpsertUpdates(
        `await m.upsert({ where: { id }, create: { id }, update: resurface && {} });`,
        "synthetic.ts",
      ),
    ).toHaveLength(1);
  });

  it("flags an empty payload at the end of a `??` chain", () => {
    expect(
      findEmptyUpsertUpdates(
        `await m.upsert({ where: { id }, create: { id }, update: explicit ?? cached ?? {} });`,
        "synthetic.ts",
      ),
    ).toHaveLength(1);
  });

  it("flags a `??` nested inside a conditional branch", () => {
    expect(
      findEmptyUpsertUpdates(
        `await m.upsert({
           where: { id },
           create: { id },
           update: resurface ? { clearedAt: null } : (changes ?? {}),
         });`,
        "synthetic.ts",
      ),
    ).toHaveLength(1);
  });

  it("does NOT flag a `??` between two payloads that are never empty", () => {
    // The control for the rule above. A fallback is only the defect when the
    // thing being fallen back to is empty as written.
    expect(
      findEmptyUpsertUpdates(
        `await m.upsert({
           where: { id },
           create: { id },
           update: patch ?? { touchedAt: new Date() },
         });`,
        "synthetic.ts",
      ),
    ).toEqual([]);
  });

  it("sees through `as`, which asserts a type and changes no value", () => {
    // Plausible in this codebase specifically: an empty payload is the one shape
    // Prisma's generated input types will not infer usefully, so it is where
    // somebody reaches for an assertion.
    expect(
      findEmptyUpsertUpdates(
        `await m.upsert({
           where: { id },
           create: { id },
           update: {} as Prisma.CalendarFeedUpdateInput,
         });`,
        "synthetic.ts",
      ),
    ).toHaveLength(1);
  });

  it("sees through `satisfies` and `!`, for the same reason", () => {
    expect(
      findEmptyUpsertUpdates(
        `await m.upsert({ where: { id }, create: { id }, update: {} satisfies U });
         await n.upsert({ where: { id }, create: { id }, update: ({} as U)! });`,
        "synthetic.ts",
      ),
    ).toHaveLength(2);
  });

  it("flags a SHORTHAND `create` beside a literally empty `update`", () => {
    // Raised in review on `!302`, and the half that needs no resolution at all:
    // only the PRESENCE of `create` decides the object is a Prisma upsert
    // argument. `ts.isPropertyAssignment` is false for a shorthand, so the
    // literal `update: {}` two keys along went unreported — a defect written
    // out in full, missed on a technicality about the key beside it.
    const findings = findEmptyUpsertUpdates(
      `const create = { userId, token };
       await prisma.calendarFeed.upsert({ where: { userId }, create, update: {} });`,
      "synthetic.ts",
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].line).toBe(2);
  });

  it("flags a SHORTHAND `update` bound to an empty literal in scope", () => {
    // The hoist evasion the guard already claims to defeat, one level deeper:
    // the object is not hoisted, the PROPERTY is.
    const findings = findEmptyUpsertUpdates(
      `const update = {};
       await prisma.calendarFeed.upsert({
         where: { userId },
         create: { userId, token },
         update,
       });`,
      "synthetic.ts",
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].line).toBe(5);
  });

  it("flags `update: payload` — the same evasion, the commoner spelling", () => {
    // `!281` settled this on `braindump-to-task-hygiene`: resolving only the
    // shorthand leaves one hazard with two syntaxes and covers the rarer one.
    const findings = findEmptyUpsertUpdates(
      `const payload = {};
       await m.upsert({ where: { id }, create: { id }, update: payload });`,
      "synthetic.ts",
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].line).toBe(2);
  });

  it("resolves the NEAREST binding, not the file's first", () => {
    // Two `update` declarations in sibling scopes, one empty and one not. A
    // file-wide "first match" walk gets BOTH call sites wrong — a miss in one
    // direction and a fabricated finding in the other. That is not hypothetical:
    // it is the regression the sibling guard shipped and had to fix on `!281`.
    const findings = findEmptyUpsertUpdates(
      `export async function a() {
         const update = { token };
         await m.upsert({ where: { id }, create: { id }, update });
       }
       export async function b() {
         const update = {};
         await m.upsert({ where: { id }, create: { id }, update });
       }`,
      "synthetic.ts",
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].line).toBe(7);
  });

  it("does NOT flag a shorthand shadowed by a PARAMETER", () => {
    // The nearest binding wins even when it cannot be read. Resolving past a
    // parameter to an unrelated outer literal is how a resolver invents a
    // finding, and a false positive is what gets a guard relaxed rather than
    // fixed.
    expect(
      findEmptyUpsertUpdates(
        `const update = {};
         export async function write(update: Prisma.CalendarFeedUpdateInput) {
           await m.upsert({ where: { id }, create: { id }, update });
         }`,
        "synthetic.ts",
      ),
    ).toEqual([]);
  });

  it("does NOT flag a `let`, which can be filled in before the call", () => {
    expect(
      findEmptyUpsertUpdates(
        `let update = {};
         if (resurface) update = { clearedAt: null };
         await m.upsert({ where: { id }, create: { id }, update });`,
        "synthetic.ts",
      ),
    ).toEqual([]);
  });

  it("does NOT flag a const whose object is MUTATED before the call", () => {
    // `const` freezes the binding, not the object. A payload assembled key by
    // key is the legitimate way to write a conditional update, and it is empty
    // only at runtime — the boundary this guard states rather than guesses past.
    expect(
      findEmptyUpsertUpdates(
        `const update = {};
         if (resurface) update.clearedAt = null;
         await m.upsert({ where: { id }, create: { id }, update });`,
        "synthetic.ts",
      ),
    ).toEqual([]);
  });

  it("does NOT flag an identifier bound to a call, which is not knowably empty", () => {
    expect(
      findEmptyUpsertUpdates(
        `const update = buildPatch(options);
         await m.upsert({ where: { id }, create: { id }, update });`,
        "synthetic.ts",
      ),
    ).toEqual([]);
  });

  it("does NOT flag an identifier IMPORTED from another file", () => {
    // Same-file only, deliberately: reading across files needs a `Program`, and
    // this module takes source text so its parsing stays unit-testable on
    // synthetic input. An unreadable binding is a miss, never a guess.
    expect(
      findEmptyUpsertUpdates(
        `import { update } from "./defaults";
         await m.upsert({ where: { id }, create: { id }, update });`,
        "synthetic.ts",
      ),
    ).toEqual([]);
  });

  it("does NOT flag a DESTRUCTURED binding", () => {
    expect(
      findEmptyUpsertUpdates(
        `const { update } = args;
         await m.upsert({ where: { id }, create: { id }, update });`,
        "synthetic.ts",
      ),
    ).toEqual([]);
  });

  it("does NOT flag a shorthand resolving to a NON-empty literal", () => {
    expect(
      findEmptyUpsertUpdates(
        `const update = { token: mintFeedToken() };
         await m.upsert({ where: { id }, create: { id }, update });`,
        "synthetic.ts",
      ),
    ).toEqual([]);
  });

  it("still flags when the same word appears elsewhere as a KEY", () => {
    // `other.update` and `{ update: … }` spell the same word in positions where
    // it is a member name rather than the binding, and counting either as a use
    // of the binding would make the resolver give up on a real offender.
    const findings = findEmptyUpsertUpdates(
      `const update = {};
       log(config.update, { update: true });
       await m.upsert({ where: { id }, create: { id }, update });`,
      "synthetic.ts",
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].line).toBe(3);
  });

  it("does NOT flag the two-statement split `!295` settled on", () => {
    // The wanted shape for a write that must not update anything: an upsert for
    // the branch that has a payload, `createMany` + `skipDuplicates` for the one
    // that does not. If the guard flagged this there would be nowhere to go.
    expect(
      findEmptyUpsertUpdates(
        `if (resurface) {
           await prisma.shoppingSummary.upsert({
             where: { workspaceId },
             create: { workspaceId },
             update: { clearedAt: null },
           });
           return;
         }
         await prisma.shoppingSummary.createMany({
           data: { workspaceId },
           skipDuplicates: true,
         });`,
        "synthetic.ts",
      ),
    ).toEqual([]);
  });

  it("reports every offender in a file, not just the first", () => {
    expect(
      findEmptyUpsertUpdates(
        `await a.upsert({ where: { x }, create: { x }, update: {} });
         await b.upsert({ where: { y }, create: { y }, update: {} });`,
        "synthetic.ts",
      ),
    ).toHaveLength(2);
  });

  it("does NOT flag a NON-empty update — the shape Prisma compiles atomically", () => {
    // `regenerateOwnFeed` and `refreshTodaySpark` are both correct as written:
    // a non-empty payload is what makes Prisma emit `ON CONFLICT DO UPDATE`.
    expect(
      findEmptyUpsertUpdates(
        `await prisma.calendarFeed.upsert({
           where: { userId },
           create: { userId, token: mintFeedToken() },
           update: { token: mintFeedToken(), rotatedAt: new Date() },
         });`,
        "synthetic.ts",
      ),
    ).toEqual([]);
  });

  it("does NOT flag a spread, which is not knowably empty", () => {
    // A guard that guesses is a guard that gets relaxed. `{ ...patch }` may hold
    // anything at runtime, so it is not the defective shape as written.
    expect(
      findEmptyUpsertUpdates(
        `await m.upsert({ where: { id }, create: { id }, update: { ...patch } });`,
        "synthetic.ts",
      ),
    ).toEqual([]);
  });

  it("does NOT flag an empty `update` with no `create` beside it", () => {
    // The other half of the pair. An unrelated object carrying an `update` key —
    // a reducer's action map, a config default — is not a Prisma upsert argument
    // and must not start failing the build.
    expect(
      findEmptyUpsertUpdates(
        `const handlers = { create: null, remove: noop };
         const policy = { update: {}, refresh: {} };`,
        "synthetic.ts",
      ),
    ).toEqual([]);
  });

  it("does NOT flag the conversion that replaced it", () => {
    // `createManyAndReturn` + `skipDuplicates` is the wanted shape. If the guard
    // flagged it, the only way out would be to relax the guard.
    expect(
      findEmptyUpsertUpdates(
        `const [created] = await prisma.calendarFeed.createManyAndReturn({
           data: { userId, token: mintFeedToken() },
           skipDuplicates: true,
           select: { token: true },
         });`,
        "synthetic.ts",
      ),
    ).toEqual([]);
  });

  it("does NOT flag a mention in a COMMENT — the reason this is an AST", () => {
    // Both files fixed under #223 quote the defective shape while explaining the
    // replacement. A regex reports them, on the line that documents the fix.
    expect(
      findEmptyUpsertUpdates(
        `// The old \`upsert({ where, create: { userId }, update: {} })\` was not
         // atomic — Prisma only compiles ON CONFLICT when the payload is non-empty.
         const x = 1;`,
        "synthetic.ts",
      ),
    ).toEqual([]);
  });

  it("parses TSX without treating the generic as a tag", () => {
    // The scan covers `.tsx`, and a `.tsx` parsed as `.ts` (or the reverse) throws
    // away half the file's nodes silently rather than erroring.
    expect(
      findEmptyUpsertUpdates(
        `export function C() {
           void save({ where: { id }, create: { id }, update: {} });
           return <div className="x">hi</div>;
         }`,
        "synthetic.tsx",
      ),
    ).toHaveLength(1);
  });
});

describe("the real tree", () => {
  it("scans a plausible number of files", () => {
    // A zero from a scanner that visited nothing looks exactly like a clean tree.
    // This is the cheapest thing that can tell them apart.
    expect(scannedFiles().length).toBeGreaterThan(100);
  });

  it("reaches prisma/ as well as src/, where a seed script would write one", () => {
    // The three `prisma/*.ts` scripts talk to the database directly and are
    // outside `src`, so a root list that grew from another guard's would miss
    // them entirely.
    expect(scannedFiles()).toContain(path.join("prisma", "seed.ts"));
  });

  it("has no empty-update upsert in any non-test source", () => {
    const offenders: string[] = [];
    for (const file of scannedFiles()) {
      for (const finding of findEmptyUpsertUpdates(
        readFileSync(file, "utf8"),
        file,
      )) {
        offenders.push(`${file}:${finding.line} — ${finding.reason}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  /**
   * The zero above, proved rather than asserted.
   *
   * A clean scan is worth exactly as much as the evidence that the same scanner
   * returns non-zero on the same files. So each converted site has its
   * conversion undone — the precise edit that reintroduces #223 — and the
   * detector has to notice.
   */
  it.each(CONVERTED_SITES)("%s would be flagged if it regressed", (file) => {
    const mutated = readFileSync(file, "utf8").replace(
      /await prisma\.(\w+)\.createManyAndReturn\(\{\n\s*data: \{([^}]*)\},/,
      "await prisma.$1.upsert({\n    where: { id },\n    create: {$2},\n    update: {},",
    );
    expect(mutated).not.toBe(readFileSync(file, "utf8")); // the mutation applied
    expect(findEmptyUpsertUpdates(mutated, file).length).toBeGreaterThan(0);
  });

  it.each(CONVERTED_SITES)("%s uses skipDuplicates today", (file) => {
    expect(readFileSync(file, "utf8")).toContain("skipDuplicates: true");
  });
});
