import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  findLateConstraintDrops,
  findFocusSoundViolations,
  parseFocusSoundCategoryBackfill,
  splitStatements,
  stripSqlComments,
  type MigrationFile,
} from "@/lib/focus-sound-migration-hygiene";
import { FOCUS_SOUND_TRACKS } from "@/lib/focus-sounds";

/**
 * #180 — the guard behind "existing accounts must not change".
 *
 * New accounts now default to sound ON. That is a column default, so it reaches
 * only rows inserted after it — exactly right, and exactly one line of SQL away
 * from being wrong. Somebody tidying up in six months, seeing half the estate on
 * `'off'` and the default saying `'on'`, would reasonably reach for a repair
 * `UPDATE`; this test is what stops them, because "we chose silence" and "we
 * never got round to it" are indistinguishable in the data.
 *
 * The parser is exercised on synthetic input first (so the guard can be watched
 * failing on each shape it claims to catch) and only then pointed at the real
 * `prisma/migrations`.
 */

const MIGRATIONS_DIR = join(process.cwd(), "prisma/migrations");

function readMigrations(): MigrationFile[] {
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
    .map((name) => ({
      name,
      sql: readFileSync(join(MIGRATIONS_DIR, name, "migration.sql"), "utf8"),
    }));
}

describe("stripSqlComments", () => {
  it("removes line and block comments", () => {
    expect(
      stripSqlComments("SELECT 1; -- a note\n/* and\n another */ SELECT 2;"),
    ).toBe("SELECT 1; \n SELECT 2;");
  });

  it("leaves comment markers that are inside a string literal alone", () => {
    const sql = `UPDATE "Settings" SET "note" = 'off -- not a comment';`;
    expect(stripSqlComments(sql)).toBe(sql);
  });

  it("handles a doubled quote inside a literal without swallowing the rest", () => {
    const sql = `SELECT 'it''s fine'; -- gone`;
    expect(stripSqlComments(sql)).toBe(`SELECT 'it''s fine'; `);
  });

  // #190 — PL/pgSQL applies the SAME comment rules as SQL, so a `--` inside a
  // `DO $$ … $$` body is a comment there too. Verified against Postgres 16: a
  // `-- RAISE EXCEPTION …` line inside a DO block neither raises nor is a
  // syntax error, so the body around it is what actually runs.
  //
  // An earlier revision of this file preserved the body verbatim on the theory
  // that `--` was body text. That handed every guard downstream a comment to
  // read as code, which is the failure this file's own docstring exists to
  // rule out — in BOTH directions, and both are tested below.
  it("strips a comment inside a dollar-quoted body, keeping the tags", () => {
    const sql = `DO $$ BEGIN -- gone\n DELETE FROM "GoogleAuth"; END $$; -- gone`;
    expect(stripSqlComments(sql)).toBe(
      `DO $$ BEGIN \n DELETE FROM "GoogleAuth"; END $$; `,
    );
  });

  it("strips a block comment inside a dollar-quoted body", () => {
    expect(stripSqlComments(`DO $$ BEGIN /* gone */ SELECT 1; END $$;`)).toBe(
      `DO $$ BEGIN  SELECT 1; END $$;`,
    );
  });

  // The inner strip is the same lexer, so a marker quoted inside a PL/pgSQL
  // string literal survives exactly as it does at the top level. `RAISE NOTICE`
  // messages in this repo's committed DO blocks are full of prose.
  it("leaves a comment marker inside a string in a dollar-quoted body alone", () => {
    const sql = `DO $$ BEGIN RAISE NOTICE 'a -- b'; END $$;`;
    expect(stripSqlComments(sql)).toBe(sql);
  });

  // A `$$` written inside what reads as a comment still closes the body: the
  // OUTER lexer sees a dollar-quoted string and knows nothing of comments, so
  // this is where Postgres ends it too. Stripping must not extend the body.
  it("does not let a comment inside a body swallow the closing tag", () => {
    expect(stripSqlComments(`DO $$ BEGIN -- x $$; SELECT 1;`)).toBe(
      `DO $$ BEGIN $$; SELECT 1;`,
    );
  });

  // An unterminated body runs to the end of the input — the only reading that
  // cannot silently resume lexing inside PL/pgSQL. Its comments are still
  // comments, and no closing tag may be invented on the way out: emitting one
  // would hand `splitStatements` a body that looks closed and let it split on
  // semicolons that terminate nothing.
  it("strips inside an unterminated body without inventing a closing tag", () => {
    expect(
      stripSqlComments(`SELECT 1; DO $$ BEGIN -- x\n  DELETE FROM "T";`),
    ).toBe(`SELECT 1; DO $$ BEGIN \n  DELETE FROM "T";`);
  });
});

describe("splitStatements", () => {
  it("splits on terminating semicolons and collapses whitespace", () => {
    expect(
      splitStatements("ALTER TABLE a\n  ADD b;\n\nUPDATE c\n SET d = 1;"),
    ).toEqual(["ALTER TABLE a ADD b", "UPDATE c SET d = 1"]);
  });

  it("does not split on a semicolon inside a string literal", () => {
    expect(splitStatements(`UPDATE t SET c = 'a;b';`)).toEqual([
      `UPDATE t SET c = 'a;b'`,
    ]);
  });

  // #190 — two committed migrations wrap their data surgery in a `DO $$ … $$`
  // block (google_auth_orphan_purge, google_auth_user_id_not_null), and a
  // PL/pgSQL body is semicolon-separated by definition. Split naively, the one
  // statement that does the work becomes five fragments, none of which is a
  // statement any guard here can reason about — and `findLateConstraintDrops`
  // then reads a DROP that is genuinely late as "no DROP in this file", which
  // is a false green rather than a missed warning.
  it("does not split on the semicolons inside a dollar-quoted body", () => {
    const sql = `DO $$ BEGIN DELETE FROM "GoogleAuth"; END $$;\nUPDATE t SET c = 1;`;
    expect(splitStatements(sql)).toEqual([
      `DO $$ BEGIN DELETE FROM "GoogleAuth"; END $$`,
      `UPDATE t SET c = 1`,
    ]);
  });

  it("recognises a tagged dollar quote and is not closed by a bare $$", () => {
    const sql = `DO $body$ SELECT '$$'; $body$;\nSELECT 2;`;
    expect(splitStatements(sql)).toEqual([
      `DO $body$ SELECT '$$'; $body$`,
      `SELECT 2`,
    ]);
  });
});

describe("findFocusSoundViolations — the shapes it must catch", () => {
  const scan = (sql: string) => findFocusSoundViolations([{ name: "m", sql }]);

  // #190 — raised in review of the dollar-quote lexer fix. Neither of these was
  // caught before it either (splitting on the semicolons inside the body left a
  // fragment beginning `DO $$ BEGIN UPDATE …`, which an anchored pattern misses
  // just the same), so this is a pre-existing hole rather than one the lexer
  // opened — but it is exactly the class of hole this MR exists to close, and
  // both shapes are one line of SQL away from being written.
  it("flags an unguarded flip written inside a DO block", () => {
    expect(
      scan(
        `DO $$ BEGIN UPDATE "Settings" SET "focusSound" = 'on'; END $$;`,
      ).map((v) => v.reason),
    ).toEqual([expect.stringContaining("without excluding rows")]);
  });

  it("flags an unguarded flip written behind a CTE", () => {
    expect(
      scan(
        `WITH picked AS (SELECT "id" FROM "Workspace") UPDATE "Settings" SET "focusSound" = 'on' WHERE "workspaceId" IN (SELECT "id" FROM picked);`,
      ),
    ).toHaveLength(1);
  });

  it("flags a shuffle rewrite inside a DO block", () => {
    expect(
      scan(`DO $$ BEGIN UPDATE "Settings" SET "focusShuffle" = true; END $$;`),
    ).toHaveLength(1);
  });

  it("flags an ADD COLUMN default written inside a DO block", () => {
    expect(
      scan(
        `DO $$ BEGIN ALTER TABLE "Settings" ADD COLUMN "focusSound" TEXT NOT NULL DEFAULT 'on'; END $$;`,
      ),
    ).toHaveLength(1);
  });

  it("flags an unguarded flip of focusSound to 'on'", () => {
    const found = scan(`UPDATE "Settings" SET "focusSound" = 'on';`);
    expect(found).toHaveLength(1);
    expect(found[0].reason).toMatch(/without excluding rows/i);
  });

  it("flags a flip hidden in a CASE expression", () => {
    const found = scan(
      `UPDATE "Settings" SET "focusSound" = CASE WHEN "focusShuffle" THEN 'on' ELSE "focusSound" END;`,
    );
    expect(found).toHaveLength(1);
  });

  it("flags a WHERE clause that narrows by something other than the off state", () => {
    const found = scan(
      `UPDATE "Settings" SET "focusSound" = 'on' WHERE "createdAt" < now();`,
    );
    expect(found).toHaveLength(1);
  });

  it("allows the shape-preserving rewrite: only rows that already meant sound", () => {
    expect(
      scan(
        `UPDATE "Settings" SET "focusSound" = 'on' WHERE "focusSound" <> 'off';`,
      ),
    ).toEqual([]);
  });

  it("flags an ADD COLUMN whose DEFAULT backfills a playlist into every row", () => {
    const found = scan(
      `ALTER TABLE "Settings" ADD COLUMN "focusSoundCategories" TEXT[] NOT NULL DEFAULT ARRAY['ambient-lofi']::TEXT[];`,
    );
    expect(found).toHaveLength(1);
    expect(found[0].reason).toMatch(/written into every existing row/i);
  });

  it("allows an ADD COLUMN defaulting to the empty array", () => {
    expect(
      scan(
        `ALTER TABLE "Settings" ADD COLUMN "focusSoundCategories" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];`,
      ),
    ).toEqual([]);
  });

  it("allows ALTER COLUMN … SET DEFAULT — the mechanism #180 actually uses", () => {
    expect(
      scan(
        `ALTER TABLE "Settings" ALTER COLUMN "focusSoundCategories" SET DEFAULT ARRAY['ambient-lofi']::TEXT[];
         ALTER TABLE "Settings" ALTER COLUMN "focusSound" SET DEFAULT 'on';
         ALTER TABLE "Settings" ALTER COLUMN "focusShuffle" SET DEFAULT true;`,
      ),
    ).toEqual([]);
  });

  it("flags any migration that rewrites focusShuffle on existing rows", () => {
    const found = scan(`UPDATE "Settings" SET "focusShuffle" = true;`);
    expect(found).toHaveLength(1);
    expect(found[0].reason).toMatch(/taste setting|new accounts only/i);
  });

  it("cannot be satisfied by prose — a guard quoted in a comment does not count", () => {
    // The failure mode this repo has already paid for twice: a tool reading a
    // comment as code. Here it would be the dangerous direction — an unguarded
    // UPDATE passing because some paragraph elsewhere says `<> 'off'`.
    const found = scan(
      `-- Only rows where "focusSound" <> 'off' are meant to change.\nUPDATE "Settings" SET "focusSound" = 'on';`,
    );
    expect(found).toHaveLength(1);
  });

  it("cannot be tripped by prose either — a comment alone is not a statement", () => {
    expect(
      scan(`-- UPDATE "Settings" SET "focusSound" = 'on';\nSELECT 1;`),
    ).toEqual([]);
  });

  // #190, raised in review — the same two directions, one level down. Once the
  // patterns stopped being anchored so they could see inside a `DO $$ … $$`
  // body, a comment written in that body became indistinguishable from a
  // statement unless the body is comment-stripped too.
  it("cannot be satisfied by prose inside a DO block", () => {
    const found = scan(
      `DO $$ BEGIN\n  -- Only rows where "focusSound" <> 'off' are meant to change.\n  UPDATE "Settings" SET "focusSound" = 'on';\nEND $$;`,
    );
    expect(found).toHaveLength(1);
  });

  it("cannot be tripped by prose inside a DO block", () => {
    expect(
      scan(
        `DO $$ BEGIN\n  -- Never do this: UPDATE "Settings" SET "focusShuffle" = true;\n  RAISE NOTICE 'nothing to do';\nEND $$;`,
      ),
    ).toEqual([]);
  });
});

describe("the real prisma/migrations", () => {
  const migrations = readMigrations();

  it("reads a non-empty set of migrations (the scan is looking at something)", () => {
    expect(migrations.length).toBeGreaterThan(0);
    expect(migrations.some((m) => m.sql.includes("focusSound"))).toBe(true);
  });

  it("contains no migration that changes an existing account's focus sound", () => {
    const violations = findFocusSoundViolations(migrations);
    expect(
      violations,
      violations
        .map((v) => `${v.migration}: ${v.reason}\n    ${v.statement}`)
        .join("\n"),
    ).toEqual([]);
  });

  // The conversion nothing at runtime can contradict: a row storing a track id
  // becomes a row storing that track's category. Comparing the migration's CASE
  // against the catalogue itself, rather than a second hand-typed list, is what
  // makes a single-character slip in one of ten pairs fail here.
  it("maps every bundled track to its own category when converting #70's rows", () => {
    const backfill = migrations
      .map((m) => parseFocusSoundCategoryBackfill(m.sql))
      .find((map) => Object.keys(map).length > 0);
    expect(
      backfill,
      "no migration backfills focusSoundCategories from a track id",
    ).toBeDefined();

    const expected = Object.fromEntries(
      FOCUS_SOUND_TRACKS.map((t) => [t.id, t.category]),
    );
    expect(backfill).toEqual(expected);
  });
});

/**
 * The guard behind the 2026-08-07 production incident.
 *
 * Synthetic first, so it can be watched failing on the exact shape it claims to
 * catch — which matters more here than usual, because the bug it exists for was
 * INVISIBLE to every other gate. The real migration's `UPDATE`s touch zero rows
 * on an empty database, so CI, the integration suite and every local run passed
 * it. Only production had rows.
 */
describe("findLateConstraintDrops — synthetic", () => {
  const file = (sql: string) => [{ name: "20260101000000_x", sql }];

  it("flags a write that lands before its constraint is dropped", () => {
    const v = findLateConstraintDrops(
      file(`
        UPDATE "Settings" SET "focusSound" = 'on' WHERE "focusSound" <> 'off';
        ALTER TABLE "Settings" DROP CONSTRAINT "Settings_focusSound_check";
        ALTER TABLE "Settings" ADD CONSTRAINT "Settings_focusSound_check"
          CHECK ("focusSound" IN ('off', 'on'));
      `),
    );
    expect(v).toHaveLength(1);
    expect(v[0].reason).toMatch(/still live when the write runs/);
  });

  it("passes once the drop moves above the write — the actual fix", () => {
    expect(
      findLateConstraintDrops(
        file(`
          ALTER TABLE "Settings" DROP CONSTRAINT "Settings_focusSound_check";
          UPDATE "Settings" SET "focusSound" = 'on' WHERE "focusSound" <> 'off';
          ALTER TABLE "Settings" ADD CONSTRAINT "Settings_focusSound_check"
            CHECK ("focusSound" IN ('off', 'on'));
        `),
      ),
    ).toEqual([]);
  });

  it("ignores a write to a column with no CHECK constraint in the file", () => {
    expect(
      findLateConstraintDrops(
        file(`UPDATE "Settings" SET "typeface" = 'figtree';`),
      ),
    ).toEqual([]);
  });

  // A drop for a DIFFERENT column must not excuse the write.
  it("matches on the column, not merely on the presence of a drop", () => {
    const v = findLateConstraintDrops(
      file(`
        UPDATE "Settings" SET "focusSound" = 'on';
        ALTER TABLE "Settings" DROP CONSTRAINT "Settings_focusSoundCategory_check";
      `),
    );
    expect(v).toEqual([]);
  });

  // The comment in the real migration names the constraint; a commented-out
  // drop is not a drop.
  it("does not count a drop that only appears in a comment", () => {
    const v = findLateConstraintDrops(
      file(`
        UPDATE "Settings" SET "focusSound" = 'on';
        -- ALTER TABLE "Settings" DROP CONSTRAINT "Settings_focusSound_check";
      `),
    );
    expect(v).toHaveLength(0);
  });
});

/**
 * #190, raised in review of the dollar-quote lexer fix — the knock-on it has on
 * a guard this diff never edits.
 *
 * `splitStatements` now keeps a `DO $$ … $$` body whole, so a drop and a write
 * that both live inside one block land at the SAME statement index. An ordering
 * check written as `dropIndex < writeIndex` reads "same" as "too late", which
 * would make the correctly-ordered shape unconditionally fail and the shapes
 * hiding behind a first match unconditionally pass. Both directions are pinned
 * here: the false accusation, because a guard that cries wolf is the one that
 * gets deleted, and the miss, because that is the 2026-08-07 incident again.
 */
describe("findLateConstraintDrops — order inside a merged DO block", () => {
  const file = (sql: string) => [{ name: "20260101000000_x", sql }];

  it("passes a drop that precedes the write inside the same DO block", () => {
    expect(
      findLateConstraintDrops(
        file(`
          DO $$
          BEGIN
            ALTER TABLE "Settings" DROP CONSTRAINT "Settings_focusSound_check";
            UPDATE "Settings" SET "focusSound" = 'on' WHERE "focusSound" <> 'off';
          END
          $$;
        `),
      ),
    ).toEqual([]);
  });

  it("flags a write that precedes the drop inside the same DO block", () => {
    const v = findLateConstraintDrops(
      file(`
        DO $$
        BEGIN
          UPDATE "Settings" SET "focusSound" = 'on';
          ALTER TABLE "Settings" DROP CONSTRAINT "Settings_focusSound_check";
        END
        $$;
      `),
    );
    expect(v).toHaveLength(1);
    expect(v[0].reason).toMatch(/still live when the write runs/);
    // The two are one statement now, so "at statement 1 … at statement 1" would
    // send the reader hunting for a second statement that does not exist.
    expect(v[0].reason).toMatch(/same statement/);
  });

  // One statement used to hold at most one write, so reading only the first was
  // free. A merged body holds several, and the late one hid behind an innocent
  // earlier one.
  it("reads every write in a merged block, not just the first", () => {
    const v = findLateConstraintDrops(
      file(`
        DO $$
        BEGIN
          UPDATE "Settings" SET "typeface" = 'figtree';
          UPDATE "Settings" SET "focusSound" = 'on';
          ALTER TABLE "Settings" DROP CONSTRAINT "Settings_focusSound_check";
        END
        $$;
      `),
    );
    expect(v.map((x) => x.reason)).toEqual([
      expect.stringContaining('writes "focusSound"'),
    ]);
  });

  // Same for drops: the block's first drop is not necessarily the one that
  // covers the column being written.
  it("reads every drop in a merged block, not just the first", () => {
    const v = findLateConstraintDrops(
      file(`
        DO $$
        BEGIN
          ALTER TABLE "Settings" DROP CONSTRAINT "Settings_typeface_check";
          UPDATE "Settings" SET "focusSound" = 'on';
          ALTER TABLE "Settings" DROP CONSTRAINT "Settings_focusSound_check";
        END
        $$;
      `),
    );
    expect(v).toHaveLength(1);
    expect(v[0].reason).toMatch(/Settings_focusSound_check/);
  });

  // The gap between `UPDATE "T"` and `SET "c" =` may not cross a statement
  // boundary. Unbounded, the first UPDATE in a merged body swallows the next
  // one's SET clause and the guard scans a table/column pair that was never
  // written — here `"Other".focusSound`, which has no constraint, so the real
  // late write disappears entirely.
  it("does not pair one write's table with a later write's column", () => {
    const v = findLateConstraintDrops(
      file(`
        DO $$
        BEGIN
          UPDATE "Other" SET typeface = 'figtree';
          UPDATE "Settings" SET "focusSound" = 'on';
          ALTER TABLE "Settings" DROP CONSTRAINT "Settings_focusSound_check";
        END
        $$;
      `),
    );
    expect(v).toHaveLength(1);
    expect(v[0].reason).toMatch(/writes "focusSound"/);
  });

  // `DROP CONSTRAINT IF EXISTS` is the same drop. Missing it does not merely
  // lose a warning: an unrecognised drop reads as "this column has no CHECK in
  // this file", which is the passing branch.
  it("counts a DROP CONSTRAINT IF EXISTS as a drop", () => {
    const v = findLateConstraintDrops(
      file(`
        UPDATE "Settings" SET "focusSound" = 'on';
        ALTER TABLE "Settings" DROP CONSTRAINT IF EXISTS "Settings_focusSound_check";
      `),
    );
    expect(v).toHaveLength(1);
    expect(v[0].reason).toMatch(/still live when the write runs/);
  });

  // #190, raised in review. A phantom drop quoted ABOVE the write must not
  // shadow the real one below it.
  //
  // Worth naming precisely, because the review that raised this expected a
  // false PASS here and that direction is in fact unreachable: the map keeps
  // the LAST drop in the file, so for it to sit before the write every drop
  // including the real late one would have to sit before the write too. A
  // comment can therefore only ever ADD a drop this guard reports on — the
  // false-accusation direction, covered by the test below. The false PASS is
  // real, but it lands in `findFocusSoundViolations`, where a `<> 'off'`
  // written in prose satisfies rule 1's guard check.
  it("does not let a commented-out DROP shadow the real late one", () => {
    const v = findLateConstraintDrops(
      file(`
        DO $$
        BEGIN
          -- The constraint goes first:
          -- ALTER TABLE "Settings" DROP CONSTRAINT "Settings_focusSound_check";
          UPDATE "Settings" SET "focusSound" = 'on';
          ALTER TABLE "Settings" DROP CONSTRAINT "Settings_focusSound_check";
        END
        $$;
      `),
    );
    expect(v).toHaveLength(1);
    expect(v[0].reason).toMatch(/still live when the write runs/);
  });

  // The reachable direction, and it needs the "last drop wins" tie-break to bite:
  // a phantom drop quoted BELOW the write overwrites the real one recorded
  // above it, so a correctly ordered file is accused of the incident. A guard
  // that cries wolf gets deleted by the next author it blocks, which is how a
  // false accusation ends up costing the same as a false pass.
  it("is not tripped into a false accusation by a commented-out drop", () => {
    expect(
      findLateConstraintDrops(
        file(`
          ALTER TABLE "Settings" DROP CONSTRAINT "Settings_focusSound_check";
          DO $$
          BEGIN
            UPDATE "Settings" SET "focusSound" = 'on' WHERE "focusSound" <> 'off';
            -- Until #180 we dropped it here instead:
            -- ALTER TABLE "Settings" DROP CONSTRAINT "Settings_focusSound_check";
          END
          $$;
        `),
      ),
    ).toEqual([]);
  });
});

describe("findLateConstraintDrops — the committed migrations", () => {
  it("no migration writes to a column whose CHECK it drops too late", () => {
    const violations = findLateConstraintDrops(readMigrations());
    expect(
      violations,
      violations
        .map((v) => `${v.migration}: ${v.reason}\n  ${v.statement}`)
        .join("\n\n"),
    ).toEqual([]);
  });

  // Proves the scan above is looking at something. A zero from a scanner
  // pointed at nothing is indistinguishable from a zero that means clean.
  it("actually read the migration this guard was written for", () => {
    const names = readMigrations().map((m) => m.name);
    expect(names).toContain("20260806100000_settings_focus_sound_categories");
    expect(names.length).toBeGreaterThan(30);
  });
});
