import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  findDataDependentStatements,
  findSeedGaps,
  planSeededDeploy,
  redactStringLiterals,
  dropConstraintAfterWrite,
  tablesInsertedBy,
  type SeedFile,
} from "@/lib/migration-data-harness";
import {
  findLateConstraintDrops,
  stripSqlComments,
  type MigrationFile,
} from "@/lib/focus-sound-migration-hygiene";

/**
 * #190 — unit half of the seeded-migration harness.
 *
 * The harness itself needs Postgres and lives in
 * `migration-data-harness.integration.test.ts`. Everything here is the pure
 * reasoning it depends on, exercised on synthetic input first so each rule can
 * be watched failing on the shape it claims to catch — the split every
 * file-parsing guard in this repo uses (`CLAUDE.md` → Testing).
 *
 * The classifier is deliberately biased towards over-matching. Its output feeds
 * a coverage gate, so a false positive costs one extra seeded row and a false
 * negative costs a migration that is still only ever tested against an empty
 * table. Those are not symmetric, and the second one is what #190 is about.
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

const scan = (sql: string) => findDataDependentStatements([{ name: "m", sql }]);
const shapesOf = (sql: string) => scan(sql).map((s) => `${s.shape}:${s.table}`);

describe("redactStringLiterals", () => {
  it("empties literals so their contents cannot be read as SQL", () => {
    expect(
      redactStringLiterals(`UPDATE "T" SET "c" = 'DELETE FROM "Other"'`),
    ).toBe(`UPDATE "T" SET "c" = ''`);
  });

  it("survives a doubled quote", () => {
    expect(redactStringLiterals(`SELECT 'it''s fine', 1`)).toBe(`SELECT '', 1`);
  });
});

describe("findDataDependentStatements — the shapes whose outcome depends on rows", () => {
  it("flags an UPDATE, which is the shape that caused the 2026-08-07 incident", () => {
    expect(shapesOf(`UPDATE "Settings" SET "focusSound" = 'on';`)).toEqual([
      "update:Settings",
    ]);
  });

  it("flags a DELETE, whose blast radius is invisible on an empty table", () => {
    expect(shapesOf(`DELETE FROM "Task" t WHERE t."id" IS NULL;`)).toEqual([
      "delete:Task",
    ]);
  });

  it("flags SET NOT NULL, which fails if any existing row holds NULL", () => {
    expect(
      shapesOf(`ALTER TABLE "GoogleAuth" ALTER COLUMN "userId" SET NOT NULL;`),
    ).toEqual(["set-not-null:GoogleAuth"]);
  });

  it("flags a newly added CHECK, which is verified against every existing row", () => {
    expect(
      shapesOf(
        `ALTER TABLE "Task" ADD CONSTRAINT "Task_status_check" CHECK ("status" IN ('active'));`,
      ),
    ).toEqual(["add-check-constraint:Task"]);
  });

  it("flags a unique index, which fails on data that already has duplicates", () => {
    expect(
      shapesOf(
        `CREATE UNIQUE INDEX "Settings_workspaceId_key" ON "Settings"("workspaceId");`,
      ),
    ).toEqual(["add-unique-index:Settings"]);
  });

  it("flags a UNIQUE constraint, the other spelling of the same hazard", () => {
    expect(
      shapesOf(
        `ALTER TABLE "Badge" ADD CONSTRAINT "Badge_key_uq" UNIQUE ("key");`,
      ),
    ).toEqual(["add-unique-index:Badge"]);
  });

  it("flags a type change, which fails on existing values that do not fit", () => {
    expect(
      shapesOf(
        `ALTER TABLE "Step" ALTER COLUMN "estMinutes" SET DATA TYPE SMALLINT;`,
      ),
    ).toEqual(["narrow-column-type:Step"]);
  });

  it("flags a foreign key, which fails over orphaned rows", () => {
    expect(
      shapesOf(
        `ALTER TABLE "Task" ADD CONSTRAINT "Task_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id");`,
      ),
    ).toEqual(["add-foreign-key:Task"]);
  });

  it("flags ADD COLUMN … NOT NULL with no DEFAULT, which cannot succeed on a non-empty table", () => {
    expect(
      shapesOf(`ALTER TABLE "Task" ADD COLUMN "ownerId" TEXT NOT NULL;`),
    ).toEqual(["add-not-null-column-without-default:Task"]);
  });

  it("flags VALIDATE CONSTRAINT, where a NOT VALID constraint finally meets the data", () => {
    expect(
      shapesOf(`ALTER TABLE "Task" VALIDATE CONSTRAINT "Task_status_check";`),
    ).toEqual(["validate-constraint:Task"]);
  });

  it("reads inside a DO block, where two committed migrations do their data surgery", () => {
    expect(
      shapesOf(
        `DO $$ BEGIN DELETE FROM "GoogleAuth" WHERE "userId" IS NULL; END $$;`,
      ),
    ).toEqual(["delete:GoogleAuth"]);
  });

  describe("what it must NOT flag", () => {
    it("ignores a table created by the same migration — it provably starts empty", () => {
      expect(
        shapesOf(
          `CREATE TABLE "Playlist" ("id" TEXT NOT NULL);
           CREATE UNIQUE INDEX "Playlist_id_key" ON "Playlist"("id");
           ALTER TABLE "Playlist" ADD CONSTRAINT "Playlist_id_check" CHECK ("id" <> '');`,
        ),
      ).toEqual([]);
    });

    it("ignores ADD CONSTRAINT … NOT VALID, which skips existing rows by definition", () => {
      expect(
        shapesOf(
          `ALTER TABLE "Task" ADD CONSTRAINT "Task_status_check" CHECK ("status" <> '') NOT VALID;`,
        ),
      ).toEqual([]);
    });

    it("ignores ALTER COLUMN … SET DEFAULT, which reaches no stored row", () => {
      expect(
        shapesOf(
          `ALTER TABLE "Settings" ALTER COLUMN "focusSound" SET DEFAULT 'on';`,
        ),
      ).toEqual([]);
    });

    it("ignores DROP CONSTRAINT, DROP COLUMN and a non-unique index", () => {
      expect(
        shapesOf(
          `ALTER TABLE "Settings" DROP CONSTRAINT "Settings_focusSound_check";
           ALTER TABLE "Settings" DROP COLUMN "focusSoundCategory";
           CREATE INDEX "Task_status_idx" ON "Task"("status");`,
        ),
      ).toEqual([]);
    });

    it("ignores ADD COLUMN … NOT NULL that carries a DEFAULT", () => {
      expect(
        shapesOf(
          `ALTER TABLE "Settings" ADD COLUMN "focusSoundCategories" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];`,
        ),
      ).toEqual([]);
    });

    // Found by pointing the classifier at the real tree: seven migrations
    // declare `ON UPDATE CASCADE` on a foreign key, and the UPDATE rule read
    // `CASCADE` as a table name, so the coverage report demanded a seed for a
    // table that does not exist.
    it("does not read the CASCADE in a referential action as a table", () => {
      expect(
        shapesOf(
          `ALTER TABLE "Step" ADD CONSTRAINT "Step_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;`,
        ),
      ).toEqual(["add-foreign-key:Step"]);
    });

    it("does not read the other referential actions as tables either", () => {
      expect(
        shapesOf(
          `ALTER TABLE "Step" ADD CONSTRAINT "s" FOREIGN KEY ("t") REFERENCES "Task"("id") ON UPDATE NO ACTION;
           ALTER TABLE "Step" ADD CONSTRAINT "u" FOREIGN KEY ("t") REFERENCES "Task"("id") ON UPDATE SET NULL;
           ALTER TABLE "Step" ADD CONSTRAINT "v" FOREIGN KEY ("t") REFERENCES "Task"("id") ON UPDATE RESTRICT;`,
        ),
      ).toEqual([
        "add-foreign-key:Step",
        "add-foreign-key:Step",
        "add-foreign-key:Step",
      ]);
    });

    it("does not read a row lock as a write", () => {
      expect(shapesOf(`SELECT 1 FROM "Task" FOR UPDATE OF "Task";`)).toEqual(
        [],
      );
    });

    it("is not fooled by SQL quoted inside a string literal", () => {
      expect(
        shapesOf(
          `INSERT INTO "Log" ("msg") VALUES ('DELETE FROM "Task" and UPDATE "Settings"');`,
        ),
      ).toEqual([]);
    });
  });
});

describe("tablesInsertedBy", () => {
  it("names every table a seed puts rows into", () => {
    expect(
      tablesInsertedBy(
        `INSERT INTO "Workspace" ("id") VALUES ('w');
         -- a comment naming "Task"
         INSERT INTO "Settings" ("id") VALUES ('s');`,
      ),
    ).toEqual(["Settings", "Workspace"]);
  });
});

describe("findSeedGaps", () => {
  const migrations: MigrationFile[] = [
    { name: "0001_a", sql: `CREATE TABLE "Task" ("id" TEXT);` },
    { name: "0002_b", sql: `UPDATE "Task" SET "id" = 'x';` },
  ];

  it("reports a data-dependent statement no seed reaches", () => {
    expect(findSeedGaps(migrations, [])).toEqual([
      { migration: "0002_b", table: "Task", shapes: ["update"] },
    ]);
  });

  it("is satisfied by a seed applied before the migration", () => {
    const seeds: SeedFile[] = [
      { after: "0001_a", sql: `INSERT INTO "Task" ("id") VALUES ('t');` },
    ];
    expect(findSeedGaps(migrations, seeds)).toEqual([]);
  });

  it("is NOT satisfied by a seed applied after it — order is the whole point", () => {
    const seeds: SeedFile[] = [
      { after: "0002_b", sql: `INSERT INTO "Task" ("id") VALUES ('t');` },
    ];
    expect(findSeedGaps(migrations, seeds)).toEqual([
      { migration: "0002_b", table: "Task", shapes: ["update"] },
    ]);
  });

  it("credits rows an earlier migration inserted itself", () => {
    const withOwnInsert: MigrationFile[] = [
      { name: "0001_a", sql: `INSERT INTO "Other" ("id") VALUES ('o');` },
      { name: "0002_b", sql: `UPDATE "Other" SET "id" = 'x';` },
    ];
    expect(findSeedGaps(withOwnInsert, [])).toEqual([]);
  });
});

describe("planSeededDeploy", () => {
  const migrations = ["0001_a", "0002_b", "0003_c", "0004_d"];

  it("splits the deploy at each seed point, in migration order", () => {
    expect(
      planSeededDeploy(migrations, [
        { after: "0003_c", sql: "" },
        { after: "0001_a", sql: "" },
      ]),
    ).toEqual([
      { migrations: ["0001_a"], seedAfter: "0001_a" },
      { migrations: ["0002_b", "0003_c"], seedAfter: "0003_c" },
      { migrations: ["0004_d"] },
    ]);
  });

  it("is one unseeded phase when there are no seeds", () => {
    expect(planSeededDeploy(migrations, [])).toEqual([{ migrations }]);
  });

  it("emits no trailing phase for a seed at the head", () => {
    expect(
      planSeededDeploy(migrations, [{ after: "0004_d", sql: "" }]),
    ).toEqual([{ migrations, seedAfter: "0004_d" }]);
  });

  // A seed named for a migration that has been renamed would otherwise be
  // silently dropped, and the suite would go green having tested nothing — the
  // exact failure mode #190 exists to close.
  it("throws when a seed names a migration that does not exist", () => {
    expect(() =>
      planSeededDeploy(migrations, [{ after: "0009_typo", sql: "" }]),
    ).toThrow(/0009_typo/);
  });

  it("throws on two seeds for the same migration", () => {
    expect(() =>
      planSeededDeploy(migrations, [
        { after: "0002_b", sql: "" },
        { after: "0002_b", sql: "" },
      ]),
    ).toThrow(/0002_b/);
  });
});

describe("dropConstraintAfterWrite — the instrument that re-breaks the fix", () => {
  const sql = `
-- prose that mentions UPDATE "Settings" SET "focusSound" and the DROP
ALTER TABLE "Settings" DROP CONSTRAINT "Settings_focusSound_check";
UPDATE "Settings" SET "focusSound" = 'on' WHERE "focusSound" <> 'off';
ALTER TABLE "Settings" ADD CONSTRAINT "Settings_focusSound_check" CHECK ("focusSound" IN ('off', 'on'));
`;

  it("moves the drop below the write that the old constraint forbids", () => {
    const broken = dropConstraintAfterWrite(sql, "Settings_focusSound_check");
    const dropAt = broken.indexOf(
      `DROP CONSTRAINT "Settings_focusSound_check"`,
    );
    const writeAt = broken.indexOf(`SET "focusSound" = 'on'`);
    expect(dropAt).toBeGreaterThan(writeAt);
  });

  // The two guards have to agree about this file, or one of them is lying:
  // !285's static reader and #190's seeded run are two views of one hazard.
  it("produces a file that !285's static guard also rejects", () => {
    const broken = dropConstraintAfterWrite(sql, "Settings_focusSound_check");
    expect(findLateConstraintDrops([{ name: "m", sql: broken }])).toHaveLength(
      1,
    );
  });

  it("throws rather than returning the input unchanged when the move is a no-op", () => {
    const alreadyLate = `
UPDATE "Settings" SET "focusSound" = 'on';
ALTER TABLE "Settings" DROP CONSTRAINT "Settings_focusSound_check";
`;
    expect(() =>
      dropConstraintAfterWrite(alreadyLate, "Settings_focusSound_check"),
    ).toThrow(/already/i);
  });

  it("throws when the named constraint is never dropped", () => {
    expect(() => dropConstraintAfterWrite(sql, "Settings_nope_check")).toThrow(
      /Settings_nope_check/,
    );
  });

  // #190, raised in review of this MR. Everything below is a shape where the
  // instrument used to answer "done" while having moved nothing — the one
  // failure this function must not have, because the integration test reads its
  // output as "the 2026-08-07 migration, reconstructed" and a silent no-op turns
  // that into "the FIXED migration, run again" while the suite stays green.
  describe("shapes where a statement move cannot produce the broken order", () => {
    it("does not pair a table with a column a LATER statement writes", () => {
      // Nothing here writes Settings.focusSound: the write-detection gap has to
      // cross a `;` to reach the column, and the two halves belong to different
      // statements of one merged body.
      const crossed = `
ALTER TABLE "Settings" DROP CONSTRAINT "Settings_focusSound_check";
DO $$
BEGIN
  UPDATE "Settings" SET "theme" = 'dark';
  UPDATE "Preference" SET "focusSound" = 'on';
END
$$;
`;
      expect(() =>
        dropConstraintAfterWrite(crossed, "Settings_focusSound_check"),
      ).toThrow(/no statement writes/i);
    });

    it("does not read a write quoted inside a string literal as a write", () => {
      const quoted = `
ALTER TABLE "Settings" DROP CONSTRAINT "Settings_focusSound_check";
INSERT INTO "AuditLog" ("message") VALUES ('UPDATE "Settings" SET "focusSound" = x');
`;
      expect(() =>
        dropConstraintAfterWrite(quoted, "Settings_focusSound_check"),
      ).toThrow(/no statement writes/i);
    });

    it("throws when the drop and the write share one DO block", () => {
      // Correctly ordered, but both halves live in one statement — so moving
      // whole statements around cannot put the drop below the write, and the
      // old index-only comparison read "same index" as "nothing to do".
      const merged = `
DO $$
BEGIN
  ALTER TABLE "Settings" DROP CONSTRAINT "Settings_focusSound_check";
  UPDATE "Settings" SET "focusSound" = 'on';
END
$$;
`;
      expect(() =>
        dropConstraintAfterWrite(merged, "Settings_focusSound_check"),
      ).toThrow(/same statement/i);
    });

    it("throws when the drop is ALREADY late inside one DO block", () => {
      const mergedAndLate = `
DO $$
BEGIN
  UPDATE "Settings" SET "focusSound" = 'on';
  ALTER TABLE "Settings" DROP CONSTRAINT "Settings_focusSound_check";
END
$$;
`;
      expect(() =>
        dropConstraintAfterWrite(mergedAndLate, "Settings_focusSound_check"),
      ).toThrow(/already/i);
    });

    it("throws when the constraint is dropped more than once", () => {
      // Moving one of two drops leaves the other where it was, so the file that
      // comes back fails on a duplicate constraint name rather than on 23514.
      const droppedTwice = `
ALTER TABLE "Settings" DROP CONSTRAINT "Settings_focusSound_check";
ALTER TABLE "Settings" ADD CONSTRAINT "Settings_focusSound_check" CHECK ("focusSound" IN ('off'));
ALTER TABLE "Settings" DROP CONSTRAINT "Settings_focusSound_check";
UPDATE "Settings" SET "focusSound" = 'on';
`;
      expect(() =>
        dropConstraintAfterWrite(droppedTwice, "Settings_focusSound_check"),
      ).toThrow(/dropped 2 times/i);
    });
  });

  it("counts a DROP CONSTRAINT IF EXISTS as the drop to move", () => {
    const ifExists = `
ALTER TABLE "Settings" DROP CONSTRAINT IF EXISTS "Settings_focusSound_check";
UPDATE "Settings" SET "focusSound" = 'on';
`;
    const broken = dropConstraintAfterWrite(
      ifExists,
      "Settings_focusSound_check",
    );
    expect(broken.indexOf(`DROP CONSTRAINT IF EXISTS`)).toBeGreaterThan(
      broken.indexOf(`SET "focusSound" = 'on'`),
    );
  });

  it("throws on a constraint name the <Table>_<column>_check convention cannot parse", () => {
    expect(() => dropConstraintAfterWrite(sql, "weird_name")).toThrow(
      /weird_name/,
    );
  });
});

describe("the committed migrations", () => {
  const migrations = readMigrations();

  it("has migrations to reason about", () => {
    expect(migrations.length).toBeGreaterThan(30);
  });

  // The non-zero half of the "an unproven zero is not a result" rule: this
  // classifier returning [] on the real tree would mean it had stopped reading,
  // not that the tree became safe.
  it("contains data-dependent statements, and names the incident's own migration", () => {
    const found = findDataDependentStatements(migrations);
    expect(found.length).toBeGreaterThan(10);
    expect(found.map((f) => f.migration)).toContain(
      "20260806100000_settings_focus_sound_categories",
    );
  });
});

/**
 * #190, raised in review — the seed corpus must not carry a credential literal.
 *
 * `20260713170000_clear_oauth_tokens_for_encryption` states the discipline in
 * its own header: "The token columns are left NULL: this row's job is to exist,
 * and a fake token string in a public repo is a secret-scanner finding waiting
 * to happen." The next seed added to that directory named `accessToken` anyway
 * and gave it a value. That is how a rule written only as a comment fails —
 * nothing reads it, so the file beside it disagrees and both look deliberate.
 *
 * A column not named in an INSERT is NULL, so "do not name it" is the whole
 * check. Comments are stripped first for the same reason every other guard here
 * strips them: a column discussed in a seed's header is not one the seed writes.
 *
 * This is defence in depth rather than a live finding — secret detection runs on
 * every MR and passed on the literal that prompted it. The point is that seeds
 * exist to be copied, the corpus only grows, and the next fake token may not be
 * so obviously fake.
 */
describe("the seed corpus", () => {
  const SEEDS_DIR = join(process.cwd(), "src/lib/__tests__/migration-seeds");

  /**
   * Columns whose value is a credential, so a seed must leave them NULL:
   * `GoogleAuth.accessToken` / `.refreshToken` and `User.llmKeyEnc` are
   * credentials to a THIRD party, and `CalendarFeed.token` is a bearer
   * capability — possession of it is the entire authorization.
   */
  const CREDENTIAL_COLUMNS = [
    "accessToken",
    "refreshToken",
    "llmKeyEnc",
    "token",
  ];

  /** Every column named in an `INSERT INTO "T" (…)` column list. */
  function insertedColumns(sql: string): string[] {
    return [
      ...stripSqlComments(sql).matchAll(
        /INSERT\s+INTO\s+"?\w+"?\s*\(([^)]*)\)/gi,
      ),
    ].flatMap((m) => m[1].split(",").map((c) => c.trim().replace(/"/g, "")));
  }

  const seeds = readdirSync(SEEDS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => ({
      name: f,
      columns: insertedColumns(readFileSync(join(SEEDS_DIR, f), "utf8")),
    }));

  // The non-zero half of "an unproven zero is not a result": a parser that read
  // nothing would report a clean corpus for every input, forever.
  it("reads column lists out of the corpus it is checking", () => {
    expect(seeds.length).toBeGreaterThan(3);
    expect(seeds.flatMap((s) => s.columns)).toContain("workspaceId");
  });

  it("names no credential column, so every seeded credential is NULL", () => {
    expect(
      seeds.flatMap((s) =>
        s.columns
          .filter((c) => CREDENTIAL_COLUMNS.includes(c))
          .map((c) => `${s.name} writes ${c}`),
      ),
    ).toEqual([]);
  });
});
