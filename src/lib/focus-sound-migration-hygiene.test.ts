import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
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
