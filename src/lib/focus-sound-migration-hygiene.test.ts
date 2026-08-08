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

  // #190 — a `--` inside a PL/pgSQL body is body text, not a comment. Stripping
  // it deletes the rest of that line of executable SQL, so the statement the
  // guards then read is not the statement Postgres runs.
  it("leaves a comment marker inside a dollar-quoted body alone", () => {
    const sql = `DO $$ BEGIN -- keep me\n DELETE FROM "GoogleAuth"; END $$; -- gone`;
    expect(stripSqlComments(sql)).toBe(
      `DO $$ BEGIN -- keep me\n DELETE FROM "GoogleAuth"; END $$; `,
    );
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
