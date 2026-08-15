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
  isBefore,
  parseCheckConstraintName,
  redactStringLiterals,
  splitInnerStatements,
  splitStatements,
  splitTopLevelCommas,
  stripSqlComments,
  type MigrationFile,
  type SqlPosition,
} from "./focus-sound-migration-hygiene";

/**
 * A statement shape whose success or failure is decided by rows that are
 * already stored. Named after what the author wrote, not after the error it
 * produces, so a report reads as a to-do list.
 */
export type DataDependentShape =
  | "update"
  | "delete"
  | "backfill-insert-select"
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
 *
 * Global, because one statement can hold two writes: see the note on `RULES`.
 */
const UPDATE_TABLE = new RegExp(
  `(?<!\\b(?:FOR|ON)\\s+)\\bUPDATE\\s+(?:ONLY\\s+)?${IDENT}`,
  "gi",
);

/** `DELETE FROM <table>`. Global for the same reason as `UPDATE_TABLE`. */
const DELETE_TABLE = new RegExp(
  `\\bDELETE\\s+FROM\\s+(?:ONLY\\s+)?${IDENT}`,
  "gi",
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
 * `INSERT INTO … SELECT` — a BACKFILL, and the sixth shape whose outcome depends
 * on stored rows (#233).
 *
 * The five listed in this module's docblock are all shapes that FAIL on data the
 * author did not expect. This one is the mirror image and was the blind spot: it
 * cannot fail on an empty source, it silently writes NOTHING, and every gate this
 * project has would report a clean pass on a backfill that never ran. That is
 * precisely the structural property #190 exists to remove — "the defect was not
 * missed; it was structurally incapable of failing anywhere except production" —
 * applied to the one statement shape that populates a new table from an old one.
 *
 * The tables that decide the outcome are the SOURCES, not the target: the target is
 * usually created by the same migration and therefore provably empty. So this rule
 * reads the `FROM`/`JOIN` clauses, and it is asked only of statements that are an
 * `INSERT … SELECT` — a bare `FROM` rule would also match the `UPDATE … FROM
 * (subquery)` shape seven committed migrations use, where the `update` rule has
 * already named the right table.
 */
const IS_INSERT_SELECT = /\bINSERT\s+INTO\b[\s\S]*?\bSELECT\b/i;
const FROM_OR_JOIN_TABLE = new RegExp(
  `\\b(?:FROM|JOIN)\\s+(?:ONLY\\s+)?${IDENT}`,
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
 * Where one `ADD COLUMN` ends inside a clause: at the next `ADD COLUMN`, or at
 * the end of the clause. Kept alongside the comma split rather than replaced by
 * it — the comma is what Postgres requires, not what every hand-edited migration
 * in this tree reliably contains.
 */
const ADD_COLUMN_CLAUSE =
  /\bADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?[\s\S]*?(?=\bADD\s+COLUMN\b|$)/gi;

/**
 * The `ADD COLUMN` clauses of one statement, each bounded at its own end.
 *
 * Only the clause a column belongs to says whether that column has a DEFAULT.
 * Read wider, the finding disappears, and three different neighbours have been
 * caught supplying the DEFAULT (#190, raised in review of !292):
 *
 *  - a defaulted sibling `ADD COLUMN` in the same `ALTER TABLE`;
 *  - a `SET DEFAULT` in the NEXT statement of a merged `DO $$ … $$` body — now
 *    unreachable, because `readableStatements` splits those before this runs;
 *  - a sibling clause of the same statement: `, ALTER COLUMN "other" SET
 *    DEFAULT …`, or a foreign key's `ON DELETE SET DEFAULT`, which is a
 *    referential action and not a column default at all.
 *
 * Postgres lets one `ALTER TABLE` carry any number of actions, and the boundary
 * between two of them is a comma outside every bracket — `splitTopLevelCommas`,
 * shared with the `SET`-clause scan in `focus-sound-migration-hygiene.ts` for
 * the reason `isBefore` and `parseCheckConstraintName` are shared: two copies of
 * this reasoning have already drifted apart once.
 */
function addColumnClauses(statement: string): string[] {
  return splitTopLevelCommas(statement).flatMap((clause) =>
    [...clause.matchAll(ADD_COLUMN_CLAUSE)].map((m) => m[0]),
  );
}

/**
 * `NOT VALID` tells Postgres to add the constraint without checking stored rows,
 * so such a statement cannot fail on data. The debt moves to the matching
 * `VALIDATE CONSTRAINT`, which this module classifies in its own right — so
 * skipping it here loses no coverage.
 */
const NOT_VALID = /\bNOT\s+VALID\b/i;

/** The two `ADD CONSTRAINT` shapes Postgres verifies against stored rows. */
const ADD_CHECK = /\bADD\s+(?:CONSTRAINT\s+"?\w+"?\s+)?CHECK\b/i;
const ADD_FOREIGN_KEY = /\bADD\s+(?:CONSTRAINT\s+"?\w+"?\s+)?FOREIGN\s+KEY\b/i;

/**
 * Whether `statement` adds at least one constraint of this shape that Postgres
 * will check against rows that already exist — i.e. one not marked `NOT VALID`.
 *
 * Asked once per CLAUSE, so the `NOT VALID` that excuses a constraint can only
 * be the one written on that constraint. #190, raised in review of !292, twice:
 * first when a whole `DO $$ … $$` body reached here as one statement and one
 * clause's `NOT VALID` silenced every constraint in the body, and again when
 * bounding at `;` turned out to stop at the statement rather than at the clause
 * — so
 *
 *     ALTER TABLE "T" ADD CONSTRAINT "a" CHECK (…),
 *                     ADD CONSTRAINT "b" CHECK (…) NOT VALID;
 *
 * reported nothing at all, though `a` is checked against every existing row.
 *
 * The colocated test covers both orderings of that pair, because the old
 * `([^;]*)` capture was greedy: the FIRST match consumed the rest of the
 * statement, leaving `matchAll` nothing to iterate, so exactly one clause was
 * ever examined and a `NOT VALID` anywhere in the statement — in front of the
 * validated constraint or behind it — decided the answer for all of them.
 */
function addsAValidatedConstraint(statement: string, adds: RegExp): boolean {
  return splitTopLevelCommas(statement).some(
    (clause) => adds.test(clause) && !NOT_VALID.test(clause),
  );
}

/**
 * One rule's answer, as a list. `null` and "no table" are the same thing, and a
 * rule that can only ever name one table says so by going through this.
 */
function one(table: string | null): string[] {
  return table === null ? [] : [table];
}

/**
 * Every table a `g`-flagged table pattern names in `statement`, in order and
 * deduplicated — a statement that writes one table twice is still one table to
 * seed, and reporting it twice would put a duplicate line in a coverage report
 * an author is meant to work through.
 */
function every(pattern: RegExp, statement: string): string[] {
  // `matchAll` builds its own iterator from the pattern's source and flags, so
  // sharing a `g`-flagged constant carries no `lastIndex` between calls.
  return [...new Set([...statement.matchAll(pattern)].map((m) => m[1]))];
}

/**
 * Every rule, each answering "does this statement's outcome depend on rows that
 * already exist?" and, if so, on which tables.
 *
 * Order is irrelevant: a statement may match several (`ALTER TABLE … ADD
 * COLUMN … NOT NULL, ADD CONSTRAINT … CHECK`) and every match is reported,
 * because they are separate hazards with separate fixes.
 *
 * TABLES rather than a table (#190, raised in review of !292). Seven of the nine
 * rules can only name one, because they read the target of the single `ALTER
 * TABLE` or `CREATE … INDEX` that a statement is — but `UPDATE` and `DELETE` can
 * appear twice in one statement, through a data-modifying CTE:
 *
 *     WITH removed AS (DELETE FROM "A" … RETURNING "id")
 *     DELETE FROM "B" WHERE … IN (SELECT "id" FROM removed);
 *
 * `20260804120000_google_auth_user_id_not_null` already writes in that shape.
 * Reading the first match only, the coverage gate demanded a seed for `A` and
 * never mentioned `B` — one statement, one hazard reported and one hidden.
 */
const RULES: ReadonlyArray<{
  shape: DataDependentShape;
  tables: (statement: string) => string[];
}> = [
  {
    shape: "update",
    tables: (s) => every(UPDATE_TABLE, s),
  },
  {
    shape: "delete",
    tables: (s) => every(DELETE_TABLE, s),
  },
  {
    // See the note on IS_INSERT_SELECT: a backfill's SOURCES decide whether it
    // wrote anything, and an empty source makes it a silent no-op rather than a
    // failure — the one shape here that reads as a clean pass having done nothing.
    //
    // The INSERT's own TARGET is excluded, and that is not a convenience. A
    // backfill's target is normally a table created moments earlier and therefore
    // provably empty, and an idempotency guard reads it on purpose —
    // `WHERE NOT EXISTS (SELECT 1 FROM "EngagementDay")` is the shape #233 uses to
    // make a re-run a no-op. Counting that as a source demanded a seed for the very
    // table the statement exists to populate, which is unsatisfiable: seeding it
    // would disable the guard and stop the backfill running at all.
    shape: "backfill-insert-select",
    tables: (s) => {
      if (!IS_INSERT_SELECT.test(s)) return [];
      const target = INSERT_INTO.exec(s)?.[1];
      INSERT_INTO.lastIndex = 0; // `g`-flagged and shared; see `every`
      return every(FROM_OR_JOIN_TABLE, s).filter((t) => t !== target);
    },
  },
  {
    shape: "set-not-null",
    tables: (s) =>
      /\bALTER\s+(?:COLUMN\s+)?"?\w+"?\s+SET\s+NOT\s+NULL\b/i.test(s)
        ? one(alteredTable(s))
        : [],
  },
  {
    shape: "add-check-constraint",
    tables: (s) =>
      addsAValidatedConstraint(s, ADD_CHECK) ? one(alteredTable(s)) : [],
  },
  {
    shape: "validate-constraint",
    tables: (s) =>
      /\bVALIDATE\s+CONSTRAINT\b/i.test(s) ? one(alteredTable(s)) : [],
  },
  {
    shape: "add-foreign-key",
    tables: (s) =>
      addsAValidatedConstraint(s, ADD_FOREIGN_KEY) ? one(alteredTable(s)) : [],
  },
  {
    // Both spellings of "these values must now be distinct": a unique index and
    // a UNIQUE table constraint. A PRIMARY KEY added to an existing table is the
    // same hazard plus a NOT NULL, and is caught here too.
    shape: "add-unique-index",
    tables: (s) => {
      const index = CREATE_UNIQUE_INDEX.exec(s);
      if (index) return [index[1]];
      return /\bADD\s+(?:CONSTRAINT\s+"?\w+"?\s+)?(?:UNIQUE|PRIMARY\s+KEY)\b/i.test(
        s,
      )
        ? one(alteredTable(s))
        : [];
    },
  },
  {
    shape: "narrow-column-type",
    tables: (s) =>
      /\bALTER\s+(?:COLUMN\s+)?"?\w+"?\s+(?:SET\s+DATA\s+)?TYPE\b/i.test(s)
        ? one(alteredTable(s))
        : [],
  },
  {
    // No DEFAULT means Postgres has to write NULL into every existing row and
    // then reject it. On an empty table it is a one-line schema change; on a
    // populated one it cannot succeed at all.
    shape: "add-not-null-column-without-default",
    tables: (s) =>
      addColumnClauses(s).some(
        (clause) =>
          /\bNOT\s+NULL\b/i.test(clause) && !/\bDEFAULT\b/i.test(clause),
      )
        ? one(alteredTable(s))
        : [],
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

/**
 * Statements, comment-stripped, literal-redacted, whitespace-collapsed — and
 * split down to the pieces that actually RUN one after another.
 *
 * The inner split is what makes every rule below a question about one statement
 * (#190, raised in review of !292). `splitStatements` keeps a `DO $$ … $$` body
 * whole, which `findLateConstraintDrops` needs and nothing here does: each rule
 * reads its table from the FIRST `ALTER TABLE` it can see, so a body holding two
 * of them blamed the first table for the second one's constraint and said
 * nothing at all about the second — a false accusation and a missing seed from
 * one statement. `findFocusSoundViolations` reached the same conclusion one
 * module over, which is why `splitInnerStatements` is shared rather than copied.
 */
function readableStatements(sql: string): string[] {
  return splitStatements(redactStringLiterals(stripSqlComments(sql))).flatMap(
    splitInnerStatements,
  );
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
        for (const table of rule.tables(statement)) {
          if (NOT_A_TABLE.has(table.toLowerCase())) continue;
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
      // NUL separates the two halves because neither a migration directory
      // name nor a table name can contain one, so no pair of distinct keys
      // can collide. Written as an escape, not a literal: a raw NUL in the
      // source makes `grep`, `git grep` and `file` treat this module as a
      // binary and silently skip it.
      const key = `${found.migration}\u0000${found.table}`;
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

/**
 * Every match of `pattern` across `statements`, as running-order positions.
 *
 * Every match, not the first: a merged `DO $$ … $$` body is one statement that
 * may hold several writes, and reading only the first let a late one hide
 * behind an earlier, innocent one — the same reason `findLateConstraintDrops`
 * takes them all (#190).
 */
function positionsOf(
  statements: readonly string[],
  pattern: RegExp,
): SqlPosition[] {
  const found: SqlPosition[] = [];
  statements.forEach((s, statement) => {
    for (const m of s.matchAll(pattern)) {
      found.push({ statement, offset: m.index });
    }
  });
  return found;
}

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
 * unparseable name, no such DROP, more than one DROP, no matching write, a DROP
 * already late, or a DROP the move cannot reach — because a silent no-op here
 * would turn "the harness caught it" into "the harness was handed a working
 * file". Nothing downstream can tell those apart: the integration test reads
 * whatever comes back as "the 2026-08-07 migration, reconstructed", so an
 * unchanged file makes it deploy the FIXED migration and pass.
 *
 * ── The two ways it used to no-op, both found reviewing !292 (#190) ──────────
 *
 *  - The write scan spanned `[\s\S]*?`, so inside a merged `DO $$ … $$` body it
 *    crossed a `;` and paired one statement's `UPDATE "T"` with a later
 *    statement's `SET "c" =`. `setClauseOf` next door bounds the same gap at the
 *    statement for the same reason; this one did not, and would happily move a
 *    DROP below a write that no statement performs. Detection therefore
 *    runs over a literal-REDACTED copy too, which is what makes `[^;]` safe on
 *    the second gap — the only semicolons a real `UPDATE` holds sit in its
 *    values — and closes the neighbouring hole where a `Settings` UPDATE quoted
 *    inside an `INSERT`'s string literal read as a write.
 *
 *  - The order check compared statement INDICES while `findLateConstraintDrops`
 *    had been upgraded to `(statement, offset)`. A drop and a write merged into
 *    one `DO` block share an index, so `dropAt > writeAt` was false whichever
 *    way round they ran: the already-broken shape escaped its guard, and the
 *    correctly-ordered one was "reordered" by splicing a statement out and back
 *    into its own slot. Both returned the input, silently. The comparison is
 *    now the shared `isBefore`, imported rather than re-implemented so the two
 *    functions cannot drift apart a second time — and when the two do share a
 *    statement the answer is an error, because moving whole statements cannot
 *    reorder a PL/pgSQL body from the outside.
 *
 * Comments do not survive: the return value is the statement sequence, joined,
 * which is precisely the property under test.
 */
export function dropConstraintAfterWrite(
  sql: string,
  constraint: string,
): string {
  // The same reading of the convention `findLateConstraintDrops` uses (#190,
  // raised in review of !292). Two spellings of it disagreed about the table
  // half, so a constraint on a table with an underscore in its name was one the
  // static guard reports on and this instrument refused to reconstruct.
  const named = parseCheckConstraintName(constraint);
  if (!named) {
    throw new Error(
      `"${constraint}" does not follow the <Table>_<column>_check convention, so the column it guards cannot be derived.`,
    );
  }
  const { table, column } = named;
  const statements = splitStatements(stripSqlComments(sql));
  // Detection reads a literal-redacted copy; the RESULT is rebuilt from the
  // originals, because what this function returns has to be a runnable
  // migration. Redaction only ever shortens a literal, so it cannot reorder
  // anything — two offsets taken from the same probe stay comparable.
  const probes = statements.map(redactStringLiterals);

  // Interpolated, but only from `constraint`, `table` and `column`, all three
  // already through `parseCheckConstraintName` — an anchored pattern that admits
  // nothing but `[A-Za-z0-9_]`, so no regex metacharacter can reach either
  // source.
  const drops = positionsOf(
    probes,
    new RegExp(
      `\\bDROP\\s+CONSTRAINT\\s+(?:IF\\s+EXISTS\\s+)?"?${constraint}"?`,
      "gi",
    ),
  );
  if (drops.length === 0) {
    throw new Error(`no statement drops "${constraint}".`);
  }
  if (drops.length > 1) {
    throw new Error(
      `"${constraint}" is dropped ${drops.length} times, and moving one drop would leave the others where they are — the file that came back would fail on a duplicate constraint name rather than on 23514.`,
    );
  }
  const [dropAt] = drops;

  const writes = positionsOf(
    probes,
    new RegExp(
      `\\bUPDATE\\s+"?${table}"?\\b[^;]*?\\bSET\\b[^;]*?"?${column}"?\\s*=`,
      "gi",
    ),
  );
  // The LAST write: the drop has to land below every one of them.
  const writeAt = writes.at(-1);
  if (writeAt === undefined) {
    throw new Error(
      `no statement writes "${table}"."${column}", so there is nothing for the drop of "${constraint}" to be late for.`,
    );
  }
  if (!isBefore(dropAt, writeAt)) {
    throw new Error(
      `"${constraint}" is already dropped after the write to "${table}"."${column}" — this migration is the broken shape, not the fixed one.`,
    );
  }
  if (dropAt.statement === writeAt.statement) {
    throw new Error(
      `the drop of "${constraint}" and the write to "${table}"."${column}" are in the same statement (statement ${dropAt.statement + 1}, a DO $$ … $$ body runs top to bottom), so moving whole statements cannot put the drop below the write. Reorder the body itself, or split it into separate statements.`,
    );
  }

  const reordered = [...statements];
  const [drop] = reordered.splice(dropAt.statement, 1);
  // The write's index shifted down by one when the earlier DROP was removed, so
  // it is now the index the DROP has to land after.
  reordered.splice(writeAt.statement, 0, drop);
  return reordered.map((s) => `${s};`).join("\n\n");
}
