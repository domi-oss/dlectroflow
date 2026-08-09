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
