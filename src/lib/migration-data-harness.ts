/**
 * #190 — the reasoning behind applying migrations to a database that already
 * holds rows.
 *
 * `prisma migrate deploy` against an empty schema proves a migration is
 * syntactically valid and nothing else. CI, the integration suite and every
 * local run do exactly that, so on 2026-08-07 a migration that wrote
 * `focusSound = 'on'` while the constraint forbidding that value was still live
 * passed every gate this project has and then failed in production with
 *
 *     ERROR: new row for relation "Settings" violates check constraint
 *            "Settings_focusSound_check"   (SQLSTATE 23514)
 *
 * Zero rows updated means no constraint is ever evaluated. The defect was not
 * missed; it was **structurally incapable of failing anywhere except
 * production**, and that is a property of every data migration in the tree, not
 * of that one file.
 *
 * `findLateConstraintDrops` in `focus-sound-migration-hygiene.ts` (!285) closes
 * the one shape by reading statement ORDER, needing no database. The five shapes
 * it cannot see all need data:
 *
 *   - `ALTER COLUMN … SET NOT NULL` against a column holding NULLs
 *   - a backfill producing a value a newly added CHECK rejects
 *   - a unique index added over data that already has duplicates
 *   - a type narrowing that existing values do not fit
 *   - a foreign key added over orphaned rows
 *
 * This module is the pure half of the harness that does: which statements' fate
 * depends on stored rows (`findDataDependentStatements`), where the seeded rows
 * have to be injected for those statements to meet any (`planSeededDeploy`),
 * which of them still meet none (`findSeedGaps`), and — the close condition of
 * #190 — an instrument for putting the 2026-08-07 statement order back so the
 * harness can be *watched failing* rather than merely observed passing
 * (`dropConstraintAfterWrite`).
 *
 * `migration-data-harness.integration.test.ts` runs the migrations; this file
 * stays free of `fs` and `child_process` so every rule above is unit-testable on
 * synthetic input, the split `CLAUDE.md` → Testing requires of a guard.
 *
 * ── The classifier over-matches on purpose ───────────────────────────────────
 *
 * Its output feeds a coverage gate. A false positive costs one seeded row; a
 * false negative costs a migration that is still only ever tested empty. So the
 * shape patterns are unanchored — they read inside a `DO $$ … $$` body and a CTE
 * — and where a construct is ambiguous it is treated as data-dependent.
 *
 * The two exceptions are cases where "no data is involved" is a *proof*, not a
 * guess: a table `CREATE`d by the same migration provably starts empty, and
 * `ADD CONSTRAINT … NOT VALID` skips existing rows by definition (its
 * `VALIDATE CONSTRAINT` is where that debt comes due, and is classified).
 */

import {
  splitStatements,
  stripSqlComments,
  type MigrationFile,
} from "./focus-sound-migration-hygiene";

/**
 * A statement shape whose success or failure is decided by rows that are
 * already stored. Named after what the author wrote, not after the error it
 * produces, so a report reads as a to-do list.
 */
export type DataDependentShape =
  | "update"
  | "delete"
  | "set-not-null"
  | "add-check-constraint"
  | "validate-constraint"
  | "add-foreign-key"
  | "add-unique-index"
  | "narrow-column-type"
  | "add-not-null-column-without-default";

export interface DataDependentStatement {
  migration: string;
  /** Comment-stripped, whitespace-collapsed, truncated for readability. */
  statement: string;
  shape: DataDependentShape;
  /** The table whose existing rows decide the outcome. */
  table: string;
}

/** A seed applied immediately after `after`, before the next migration runs. */
export interface SeedFile {
  /** Migration directory name this seed is applied straight after. */
  after: string;
  sql: string;
}

/** A data-dependent statement that still runs against an empty table. */
export interface SeedGap {
  migration: string;
  table: string;
  shapes: DataDependentShape[];
}

/** One `prisma migrate deploy` invocation, plus the seed that follows it. */
export interface DeployPhase {
  /** Migrations applied in this phase, in order. */
  migrations: string[];
  /** `after` of the seed to run once this phase is applied, if any. */
  seedAfter?: string;
}

/**
 * Replace the contents of every string literal with nothing.
 *
 * Comment stripping is not enough on its own: `INSERT INTO "Log" VALUES
 * ('DELETE FROM "Task"')` inserts a row and deletes nothing, and a classifier
 * that reads the literal would demand a seed for `Task` on the strength of a log
 * message. Values are irrelevant here — only table names and statement shape
 * are — so emptying literals costs nothing and removes the class.
 *
 * A doubled quote is Postgres's escape for a quote inside a literal, so it is
 * lexed as one literal rather than two: `'it''s'` collapses to a single `''`.
 * Getting that wrong would not leak content, but it would leave a run of empty
 * literals where the SQL has one value, which is harder to read in a report.
 *
 * Deliberately applied inside dollar-quoted bodies too. A `RAISE NOTICE` string
 * is not SQL, and letting it through would be the one way a message could ask
 * the classifier for a seed the migration does not need.
 */
export function redactStringLiterals(sql: string): string {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    if (sql[i] !== "'") {
      out += sql[i];
      i += 1;
      continue;
    }
    out += "''";
    i += 1;
    while (i < sql.length) {
      if (sql[i] !== "'") {
        i += 1;
      } else if (sql[i + 1] === "'") {
        i += 2; // an escaped quote: still inside the same literal
      } else {
        i += 1; // the closing quote
        break;
      }
    }
  }
  return out;
}

/**
 * Every pattern that reads a table name out of a statement, built once at module
 * load rather than per statement.
 *
 * `IDENT` is an optionally-quoted identifier (`"Settings"` or `Settings`). It is
 * interpolated into the sources below, which is why they are assembled with
 * `new RegExp` — but they are assembled ONCE, from module constants only, so
 * nothing a caller passes ever reaches a pattern. That matters twice over:
 * `focus-sound-migration-hygiene.ts` records that a per-call dynamic pattern is a
 * SAST finding even when every input is a literal, and there are ~700 statements
 * to classify, each of which would otherwise recompile nine patterns.
 */
const IDENT = `"?([A-Za-z_][A-Za-z0-9_]*)"?`;

const ALTER_TABLE = new RegExp(
  `\\bALTER\\s+TABLE\\s+(?:ONLY\\s+)?${IDENT}`,
  "i",
);

/**
 * `UPDATE <table>`, excluding the two contexts where `UPDATE` is not a statement:
 * `SELECT … FOR UPDATE OF t` is a row lock, and `ON UPDATE CASCADE` is a
 * referential action on a foreign key. Seven committed migrations declare the
 * latter, and without the lookbehind the rule reported a table called `CASCADE`.
 */
const UPDATE_TABLE = new RegExp(
  `(?<!\\b(?:FOR|ON)\\s+)\\bUPDATE\\s+(?:ONLY\\s+)?${IDENT}`,
  "i",
);

const DELETE_TABLE = new RegExp(
  `\\bDELETE\\s+FROM\\s+(?:ONLY\\s+)?${IDENT}`,
  "i",
);

const CREATE_UNIQUE_INDEX = new RegExp(
  `\\bCREATE\\s+UNIQUE\\s+INDEX\\s+(?:CONCURRENTLY\\s+)?(?:IF\\s+NOT\\s+EXISTS\\s+)?"?\\w+"?\\s+ON\\s+(?:ONLY\\s+)?${IDENT}`,
  "i",
);

const CREATE_TABLE = new RegExp(
  `\\bCREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${IDENT}`,
  "i",
);

const INSERT_INTO = new RegExp(
  `\\bINSERT\\s+INTO\\s+(?:ONLY\\s+)?${IDENT}`,
  "gi",
);

/**
 * Words that can follow a shape keyword in the position an identifier would
 * occupy but are never a table name. Belt-and-braces behind the lookbehinds
 * below: `ON UPDATE SET NULL` and `ON UPDATE NO ACTION` put a bare keyword
 * exactly where the UPDATE rule looks for its target, and a report naming a
 * table called `SET` sends a reader hunting for a model that does not exist.
 *
 * Unquoted because that is how Postgres spells a keyword; every table in this
 * schema is written quoted and PascalCase, so nothing legitimate collides.
 */
const NOT_A_TABLE = new Set([
  "cascade",
  "restrict",
  "set",
  "no",
  "action",
  "default",
  "only",
]);

/**
 * The table an `ALTER TABLE` statement targets, or `null` if this is not one.
 * `ONLY` is accepted because Postgres allows it and a migration that used it
 * would otherwise slip past every ALTER-based rule below.
 */
function alteredTable(statement: string): string | null {
  return ALTER_TABLE.exec(statement)?.[1] ?? null;
}

/**
 * `ADD COLUMN` clauses of one statement, as `[name, rest-of-clause]`.
 *
 * Postgres allows several in one `ALTER TABLE`, and only the clause a column
 * belongs to says whether that column has a DEFAULT — reading the whole
 * statement would let one defaulted column vouch for an undefaulted sibling.
 */
function addColumnClauses(statement: string): string[] {
  return [
    ...statement.matchAll(
      /\bADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?[\s\S]*?(?=(?:,\s*)?\bADD\s+COLUMN\b|$)/gi,
    ),
  ].map((m) => m[0]);
}

/**
 * `NOT VALID` tells Postgres to add the constraint without checking stored rows,
 * so such a statement cannot fail on data. The debt moves to the matching
 * `VALIDATE CONSTRAINT`, which this module classifies in its own right — so
 * skipping it here loses no coverage.
 */
const NOT_VALID = /\bNOT\s+VALID\b/i;

/**
 * Every rule, each answering "does this statement's outcome depend on rows that
 * already exist?" and, if so, on which table.
 *
 * Order is irrelevant: a statement may match several (`ALTER TABLE … ADD
 * COLUMN … NOT NULL, ADD CONSTRAINT … CHECK`) and every match is reported,
 * because they are separate hazards with separate fixes.
 */
const RULES: ReadonlyArray<{
  shape: DataDependentShape;
  table: (statement: string) => string | null;
}> = [
  {
    shape: "update",
    table: (s) => UPDATE_TABLE.exec(s)?.[1] ?? null,
  },
  {
    shape: "delete",
    table: (s) => DELETE_TABLE.exec(s)?.[1] ?? null,
  },
  {
    shape: "set-not-null",
    table: (s) =>
      /\bALTER\s+(?:COLUMN\s+)?"?\w+"?\s+SET\s+NOT\s+NULL\b/i.test(s)
        ? alteredTable(s)
        : null,
  },
  {
    shape: "add-check-constraint",
    table: (s) =>
      /\bADD\s+(?:CONSTRAINT\s+"?\w+"?\s+)?CHECK\b/i.test(s) &&
      !NOT_VALID.test(s)
        ? alteredTable(s)
        : null,
  },
  {
    shape: "validate-constraint",
    table: (s) =>
      /\bVALIDATE\s+CONSTRAINT\b/i.test(s) ? alteredTable(s) : null,
  },
  {
    shape: "add-foreign-key",
    table: (s) =>
      /\bADD\s+(?:CONSTRAINT\s+"?\w+"?\s+)?FOREIGN\s+KEY\b/i.test(s) &&
      !NOT_VALID.test(s)
        ? alteredTable(s)
        : null,
  },
  {
    // Both spellings of "these values must now be distinct": a unique index and
    // a UNIQUE table constraint. A PRIMARY KEY added to an existing table is the
    // same hazard plus a NOT NULL, and is caught here too.
    shape: "add-unique-index",
    table: (s) => {
      const index = CREATE_UNIQUE_INDEX.exec(s);
      if (index) return index[1];
      return /\bADD\s+(?:CONSTRAINT\s+"?\w+"?\s+)?(?:UNIQUE|PRIMARY\s+KEY)\b/i.test(
        s,
      )
        ? alteredTable(s)
        : null;
    },
  },
  {
    shape: "narrow-column-type",
    table: (s) =>
      /\bALTER\s+(?:COLUMN\s+)?"?\w+"?\s+(?:SET\s+DATA\s+)?TYPE\b/i.test(s)
        ? alteredTable(s)
        : null,
  },
  {
    // No DEFAULT means Postgres has to write NULL into every existing row and
    // then reject it. On an empty table it is a one-line schema change; on a
    // populated one it cannot succeed at all.
    shape: "add-not-null-column-without-default",
    table: (s) =>
      addColumnClauses(s).some(
        (clause) =>
          /\bNOT\s+NULL\b/i.test(clause) && !/\bDEFAULT\b/i.test(clause),
      )
        ? alteredTable(s)
        : null,
  },
];

/** Tables this SQL creates, which therefore hold no pre-existing rows. */
function tablesCreatedBy(statements: readonly string[]): Set<string> {
  const created = new Set<string>();
  for (const s of statements) {
    // `CREATE TABLE … AS SELECT` would arrive populated; the repo has none, and
    // treating one as empty would be wrong, so it is excluded explicitly.
    if (/\bAS\s+SELECT\b/i.test(s)) continue;
    const m = CREATE_TABLE.exec(s);
    if (m) created.add(m[1]);
  }
  return created;
}

/** Statements, comment-stripped, literal-redacted and whitespace-collapsed. */
function readableStatements(sql: string): string[] {
  return splitStatements(redactStringLiterals(stripSqlComments(sql)));
}

/**
 * Every statement across `files` whose outcome depends on rows that already
 * exist. An empty result would mean the tree contains no data migrations at all,
 * which is why the colocated test asserts the real tree returns a non-empty one.
 */
export function findDataDependentStatements(
  files: readonly MigrationFile[],
): DataDependentStatement[] {
  const found: DataDependentStatement[] = [];
  for (const file of files) {
    const statements = readableStatements(file.sql);
    const createdHere = tablesCreatedBy(statements);
    for (const statement of statements) {
      for (const rule of RULES) {
        const table = rule.table(statement);
        if (!table || NOT_A_TABLE.has(table.toLowerCase())) continue;
        if (createdHere.has(table)) continue;
        found.push({
          migration: file.name,
          statement: statement.slice(0, 160),
          shape: rule.shape,
          table,
        });
      }
    }
  }
  return found;
}

/** Tables this SQL inserts rows into, sorted, deduplicated. */
export function tablesInsertedBy(sql: string): string[] {
  const tables = new Set<string>();
  for (const statement of readableStatements(sql)) {
    // `matchAll` builds its own iterator from the pattern's source and flags, so
    // sharing a `g`-flagged constant here carries no `lastIndex` between calls.
    for (const m of statement.matchAll(INSERT_INTO)) {
      tables.add(m[1]);
    }
  }
  return [...tables].sort();
}

/**
 * Data-dependent statements that would still run against an empty table.
 *
 * A statement in migration M on table T is covered when some earlier point in
 * the timeline put a row in T: either a seed applied after a migration before M,
 * or an `INSERT` inside a migration before M. The second case is real coverage
 * and is credited — `20260706130912_workspaces` seeds the owner `Workspace`
 * itself, so every later constraint on that table meets a row on any database.
 *
 * `files` must be in migration order (the directory names sort chronologically,
 * which is what Prisma relies on too).
 */
export function findSeedGaps(
  files: readonly MigrationFile[],
  seeds: readonly SeedFile[],
): SeedGap[] {
  const seedsByAfter = new Map(seeds.map((s) => [s.after, s]));
  const populated = new Set<string>();
  const gaps = new Map<string, SeedGap>();

  for (const file of files) {
    for (const found of findDataDependentStatements([file])) {
      if (populated.has(found.table)) continue;
      const key = `${found.migration} ${found.table}`;
      const gap = gaps.get(key);
      if (gap) {
        if (!gap.shapes.includes(found.shape)) gap.shapes.push(found.shape);
      } else {
        gaps.set(key, {
          migration: found.migration,
          table: found.table,
          shapes: [found.shape],
        });
      }
    }
    // Rows this migration inserts, and then the seed that follows it, are both
    // in place for every LATER migration — hence after the scan, not before.
    for (const table of tablesInsertedBy(file.sql)) populated.add(table);
    const seed = seedsByAfter.get(file.name);
    if (seed)
      for (const table of tablesInsertedBy(seed.sql)) populated.add(table);
  }

  return [...gaps.values()];
}

/**
 * The migrations split into `prisma migrate deploy` phases, each followed by the
 * seed named for its last migration.
 *
 * Seeds are applied at the schema version they were written against, and the
 * rows then travel forward through every later migration exactly as production
 * rows do — which is the property that makes one seed test thirty migrations.
 *
 * Throws rather than skipping when a seed names a migration that is not there.
 * A renamed migration would otherwise silently disable its seed and leave the
 * suite green having tested an empty table again.
 */
export function planSeededDeploy(
  migrations: readonly string[],
  seeds: readonly SeedFile[],
): DeployPhase[] {
  const known = new Set(migrations);
  const seen = new Set<string>();
  for (const seed of seeds) {
    if (!known.has(seed.after)) {
      throw new Error(
        `migration seed names "${seed.after}", which is not a migration in prisma/migrations. ` +
          `Rename the seed to match the migration it is applied after, or delete it.`,
      );
    }
    if (seen.has(seed.after)) {
      throw new Error(
        `two migration seeds are both applied after "${seed.after}"; merge them into one file.`,
      );
    }
    seen.add(seed.after);
  }

  const phases: DeployPhase[] = [];
  let pending: string[] = [];
  for (const migration of migrations) {
    pending.push(migration);
    if (seen.has(migration)) {
      phases.push({ migrations: pending, seedAfter: migration });
      pending = [];
    }
  }
  if (pending.length > 0) phases.push({ migrations: pending });
  return phases;
}

/** `<Table>_<column>_check` — the constraint naming convention of this repo. */
const CHECK_CONSTRAINT_NAME = /^([A-Za-z0-9]+)_([A-Za-z0-9]+)_check$/;

/**
 * The same migration with `constraint`'s `DROP` moved below the last statement
 * that writes the column it guards — i.e. the statement order of the migration
 * that took production down on 2026-08-07.
 *
 * This exists because #190 must not be closed on a harness that passes. A
 * harness observed only on a fixed tree is a green light that proves nothing was
 * looked at, so the integration test builds this file and requires the harness
 * to fail on it with SQLSTATE 23514. Deriving it from the real migration rather
 * than storing a copy of the pre-fix file means the demonstration cannot rot
 * into a test of a 160-line fixture nothing else reads.
 *
 * It throws in every case where the result would not be the intended shape —
 * unparseable name, no such DROP, no matching write, or a DROP that is already
 * late — because a silent no-op here would turn "the harness caught it" into
 * "the harness was handed a working file".
 *
 * Comments do not survive: the return value is the statement sequence, joined,
 * which is precisely the property under test.
 */
export function dropConstraintAfterWrite(
  sql: string,
  constraint: string,
): string {
  const named = CHECK_CONSTRAINT_NAME.exec(constraint);
  if (!named) {
    throw new Error(
      `"${constraint}" does not follow the <Table>_<column>_check convention, so the column it guards cannot be derived.`,
    );
  }
  const [, table, column] = named;
  const statements = splitStatements(stripSqlComments(sql));

  const dropAt = statements.findIndex((s) =>
    new RegExp(`\\bDROP\\s+CONSTRAINT\\s+"?${constraint}"?`, "i").test(s),
  );
  if (dropAt === -1) {
    throw new Error(`no statement drops "${constraint}".`);
  }

  const writes = new RegExp(
    `\\bUPDATE\\s+"?${table}"?\\b[\\s\\S]*?\\bSET\\b[\\s\\S]*?"?${column}"?\\s*=`,
    "i",
  );
  let writeAt = -1;
  statements.forEach((s, i) => {
    if (writes.test(s)) writeAt = i;
  });
  if (writeAt === -1) {
    throw new Error(
      `no statement writes "${table}"."${column}", so there is nothing for the drop of "${constraint}" to be late for.`,
    );
  }
  if (dropAt > writeAt) {
    throw new Error(
      `"${constraint}" is already dropped after the write to "${table}"."${column}" — this migration is the broken shape, not the fixed one.`,
    );
  }

  const reordered = [...statements];
  const [drop] = reordered.splice(dropAt, 1);
  // `writeAt` shifted down by one when the earlier DROP was removed, so
  // `writeAt` is now the index the DROP has to land after.
  reordered.splice(writeAt, 0, drop);
  return reordered.map((s) => `${s};`).join("\n\n");
}
