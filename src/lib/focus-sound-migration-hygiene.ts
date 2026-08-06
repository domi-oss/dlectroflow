/**
 * #180 — pure helpers for asking every Prisma migration one question: **would
 * this start playing music at somebody who chose silence?**
 *
 * `Settings.focusSound` now defaults to `"on"` for NEW accounts, which is the
 * point of #180: with a full catalogue live, a default of `"off"` hides the
 * feature behind a page most people never open. A Prisma column default applies
 * only to rows inserted after it, so that change cannot reach an existing
 * account — and it must stay that way. Turning audio on for someone who
 * deliberately turned it off is a bad surprise with no undo for the startle, and
 * it is a one-line migration away at any point in the future.
 *
 * So the guarantee is not "we did not write that migration"; it is "a migration
 * like that fails the build". The three rules below are the shapes such a
 * migration would actually take:
 *
 *  1. an `UPDATE "Settings"` that writes `'on'` into `focusSound` without
 *     excluding the rows that already say `'off'`;
 *  2. an `ADD COLUMN` for a focus-sound column carrying a value-bearing DEFAULT
 *     — unlike `ALTER COLUMN … SET DEFAULT`, an ADD COLUMN default is written
 *     into every existing row, so it is a data migration wearing a schema
 *     migration's clothes;
 *  3. an `UPDATE "Settings"` that touches `focusShuffle` at all — the shuffle
 *     default also changed in #180 and there is no legitimate reason for a
 *     migration to rewrite a taste setting.
 *
 * `ALTER COLUMN … SET DEFAULT` is deliberately NOT a violation. It is the whole
 * mechanism by which #180 changes the defaults for new accounts while leaving
 * every existing row alone, so a guard that flagged it would be a guard against
 * the intended change.
 *
 * ── Comments are stripped first, and that is load-bearing ────────────────────
 *
 * Migrations in this repo carry long prose headers explaining the decision, and
 * that prose quotes SQL — `20260804170000_settings_focus_sound_category` spends
 * forty lines discussing `focusSound` values it does not write. Matching the raw
 * text would let a comment fail the build, and worse, would let a comment
 * SATISFY a guard: a real unguarded `UPDATE` would pass rule 1 as long as some
 * paragraph elsewhere in the file mentioned `<> 'off'`. Both directions have
 * bitten this repo before (env-drift and a fabricated review finding), so the
 * scanner works on comment-stripped, individually-split statements.
 *
 * Kept free of `fs` so the parsing is unit-testable on synthetic input — the
 * same split `manifest-hygiene`, `lockfile-hygiene`, `dockerfile-hygiene`,
 * `fetch-host-hygiene`, `revalidation-hygiene` and `backup-hygiene` use; the
 * caller reads the files. `focus-sound-migration-hygiene.test.ts` holds the
 * assertions and reads the real `prisma/migrations`.
 *
 * ── Why not a SQL parser ─────────────────────────────────────────────────────
 *
 * `CLAUDE.md` prefers a structural parse to a regex for anything reasoning about
 * code shapes, and this does the structural part that matters: strings are
 * lexed, comments removed, statements split on the semicolons that are actually
 * statement terminators. Beyond that the questions are lexical ("does this
 * statement's SET clause name this column"), the repo has no SQL grammar in its
 * dependencies, and adding one to guard nine migration files would be a supply
 * chain cost with no matching benefit.
 */

/** One migration file, as the caller read it off disk. */
export interface MigrationFile {
  /** The migration directory name, e.g. `20260806100000_settings_…`. */
  name: string;
  sql: string;
}

/** A statement that would change a preference an existing account already set. */
export interface MigrationViolation {
  migration: string;
  /** The offending statement, comment-stripped and whitespace-collapsed. */
  statement: string;
  reason: string;
}

/**
 * Remove `--` line comments and `/* … *​/` block comments, leaving string
 * literals untouched.
 *
 * Hand-lexed rather than regexed because both comment markers are legal
 * *inside* a string literal, and a migration that backfills a slug is exactly
 * the kind of file that holds one. Postgres escapes a quote inside a literal by
 * doubling it, which falls out of this loop for free: the closing quote ends the
 * string and the very next character re-opens it.
 */
export function stripSqlComments(sql: string): string {
  let out = "";
  let i = 0;
  let inString = false;
  while (i < sql.length) {
    const c = sql[i];
    if (inString) {
      out += c;
      if (c === "'") inString = false;
      i += 1;
      continue;
    }
    if (c === "'") {
      inString = true;
      out += c;
      i += 1;
      continue;
    }
    if (c === "-" && sql[i + 1] === "-") {
      while (i < sql.length && sql[i] !== "\n") i += 1;
      continue;
    }
    if (c === "/" && sql[i + 1] === "*") {
      i += 2;
      while (i < sql.length && !(sql[i] === "*" && sql[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/**
 * Split comment-stripped SQL into statements on the semicolons that terminate
 * one, i.e. those outside a string literal. Blank statements are dropped and
 * whitespace is collapsed, so a statement written across twelve lines matches
 * the same way as one written across one.
 */
export function splitStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = "";
  let inString = false;
  for (const c of sql) {
    if (inString) {
      current += c;
      if (c === "'") inString = false;
      continue;
    }
    if (c === "'") {
      inString = true;
      current += c;
      continue;
    }
    if (c === ";") {
      statements.push(current);
      current = "";
      continue;
    }
    current += c;
  }
  statements.push(current);
  return statements
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter((s) => s.length > 0);
}

/** `UPDATE "Settings" …` — the only table whose focus preferences exist. */
const SETTINGS_UPDATE = /^UPDATE\s+"?Settings"?\b/i;

/**
 * The DEFAULT an `ADD COLUMN` may carry for each focus-sound column: the value
 * that means "this account has not asked for anything", because an ADD COLUMN
 * default is written into every existing row.
 *
 * `focusSound` may only arrive defaulting to `'off'`, `focusSoundCategories`
 * only to an empty array, `focusShuffle` only to `false`. The new-account
 * defaults #180 introduces are applied by `ALTER COLUMN … SET DEFAULT` instead,
 * which touches nothing already stored.
 */
const SILENT_ADD_COLUMN_DEFAULTS: ReadonlyArray<{
  column: string;
  allowed: RegExp;
  description: string;
}> = [
  { column: "focusSound", allowed: /^'off'$/i, description: "'off'" },
  {
    column: "focusSoundCategories",
    allowed: /^(ARRAY\s*\[\s*\]|'\{\}')(\s*::\s*TEXT\s*\[\s*\])?$/i,
    description: "an empty array",
  },
  { column: "focusShuffle", allowed: /^false$/i, description: "false" },
];

/** The SET clause of an UPDATE — everything between `SET` and `WHERE`/end. */
function setClauseOf(statement: string): string {
  const m = /\bSET\b([\s\S]*?)(?:\bWHERE\b|$)/i.exec(statement);
  return m ? m[1] : "";
}

/**
 * Every statement across `files` that would rewrite a focus-sound preference an
 * existing account already holds. An empty result is the passing state.
 */
export function findFocusSoundViolations(
  files: readonly MigrationFile[],
): MigrationViolation[] {
  const violations: MigrationViolation[] = [];
  for (const file of files) {
    for (const statement of splitStatements(stripSqlComments(file.sql))) {
      const add = (reason: string) =>
        violations.push({ migration: file.name, statement, reason });

      if (SETTINGS_UPDATE.test(statement)) {
        const setClause = setClauseOf(statement);

        // Rule 1. Deliberately over-matching: any Settings UPDATE whose SET
        // clause names focusSound and whose text contains the literal 'on' has
        // to carry the guard, whether it assigns 'on' directly or through a
        // CASE. A guard that only understood one of those two spellings would
        // be trivially side-stepped by writing the other.
        if (/"?focusSound"?\s*=/i.test(setClause) && /'on'/i.test(statement)) {
          const guarded = /"?focusSound"?\s*(?:<>|!=)\s*'off'/i.test(statement);
          if (!guarded) {
            add(
              `writes 'on' into Settings.focusSound without excluding rows that already say 'off' — add a "focusSound" <> 'off' guard, or do not write the column at all`,
            );
          }
        }

        // Rule 3. Shuffle is a taste setting; #180 changed only what a NEW
        // account starts with. There is no shape of "repair" here that is not a
        // migration overwriting somebody's choice.
        if (/"?focusShuffle"?\s*=/i.test(setClause)) {
          add(
            "rewrites Settings.focusShuffle on existing rows — the #180 default change applies to new accounts only",
          );
        }
      }

      // Rule 2. `ADD COLUMN … DEFAULT x` backfills x into every existing row;
      // `ALTER COLUMN … SET DEFAULT x` does not, and is the intended mechanism.
      for (const {
        column,
        allowed,
        description,
      } of SILENT_ADD_COLUMN_DEFAULTS) {
        const m = new RegExp(
          `\\bADD\\s+COLUMN\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?"?${column}"?\\b[\\s\\S]*?\\bDEFAULT\\s+(.+?)\\s*$`,
          "i",
        ).exec(statement);
        if (m && !allowed.test(m[1].trim())) {
          add(
            `adds Settings.${column} with DEFAULT ${m[1].trim()}, which is written into every existing row — an ADD COLUMN default may only be ${description}; use ALTER COLUMN … SET DEFAULT for the new-account value`,
          );
        }
      }
    }
  }
  return violations;
}

/**
 * The track-id → category-slug map a `CASE` expression declares, read out of the
 * statement that backfills `focusSoundCategories`.
 *
 * #180's migration has to convert a stored track id into the category that track
 * belongs to, and a typo in one of ten `WHEN … THEN` pairs is a silent wrong
 * playlist for whoever picked that track — nothing at runtime would ever
 * disagree with it. Returning the map lets the colocated test compare it against
 * the real catalogue rather than against a second hand-typed list.
 *
 * Returns `{}` when no such statement exists.
 */
export function parseFocusSoundCategoryBackfill(
  sql: string,
): Record<string, string> {
  const map: Record<string, string> = {};
  for (const statement of splitStatements(stripSqlComments(sql))) {
    if (!SETTINGS_UPDATE.test(statement)) continue;
    if (!/"?focusSoundCategories"?\s*=/i.test(setClauseOf(statement))) continue;
    if (!/\bCASE\b/i.test(statement)) continue;
    for (const [, from, to] of statement.matchAll(
      /\bWHEN\s+'([^']*)'\s+THEN\s+ARRAY\s*\[\s*'([^']*)'\s*\]/gi,
    )) {
      map[from] = to;
    }
  }
  return map;
}
