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
 * A dollar-quote opener — `$$` or `$tag$` — anchored at the start of the slice.
 *
 * #190. To the OUTER lexer the whole body is one opaque token: `;` does not
 * terminate a statement, `--` does not open a comment and `'` does not open a
 * string, so only the matching close tag ends it. Two committed migrations rely
 * on that (`google_auth_orphan_purge` and `google_auth_user_id_not_null` both
 * wrap their data surgery in `DO $$ … $$`), so a lexer that does not know the
 * construct reads their one working statement as a handful of fragments — and
 * `findLateConstraintDrops` then sees "no DROP in this file" rather than a late
 * one, which is a false PASS.
 *
 * Those rules are suspended for the outer lexer only, and reading them as
 * suspended outright is what `stripSqlComments` got wrong for one commit. The
 * body of a `DO` block is PL/pgSQL, which applies the same comment and string
 * rules again from scratch — so where THIS regex ends the body is a question
 * for the outer lexer, while what counts as a comment inside it is a question
 * for the inner one. `stripSqlComments` recurses for exactly that reason.
 *
 * The tag is matched rather than assumed empty because `$$` may legally appear
 * inside a `$body$`-tagged block, and only the matching tag closes it.
 * Positional parameters (`$1`) do not match: a tag is empty or starts with a
 * letter or underscore.
 */
const DOLLAR_QUOTE_OPEN = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/;

/** A dollar-quoted body found in the input, split into its tags and interior. */
interface DollarQuotedBody {
  /** The opening tag, `$$` or `$tag$`. The closing tag is the same string. */
  tag: string;
  /** Everything between the two tags — PL/pgSQL, lexed by its own rules. */
  inner: string;
  /** False when no closing tag was found, i.e. the body ran to end of input. */
  terminated: boolean;
  /** How much of the input the body occupies, both tags included. */
  length: number;
}

/**
 * If a dollar-quoted body opens at `i`, that body; otherwise `null`. An
 * unterminated body runs to the end of the input, which is the only reading
 * that cannot silently resume lexing inside PL/pgSQL.
 *
 * The closing tag is found by a plain search, which is what the OUTER lexer
 * does: it knows nothing of the comments or strings inside, so a `$$` written
 * in what a reader would call a comment still ends the body — and ends it in
 * Postgres too.
 */
function dollarQuotedBodyAt(sql: string, i: number): DollarQuotedBody | null {
  if (sql[i] !== "$") return null;
  const open = DOLLAR_QUOTE_OPEN.exec(sql.slice(i));
  if (!open) return null;
  const tag = open[0];
  const close = sql.indexOf(tag, i + tag.length);
  if (close === -1) {
    return {
      tag,
      inner: sql.slice(i + tag.length),
      terminated: false,
      length: sql.length - i,
    };
  }
  return {
    tag,
    inner: sql.slice(i + tag.length, close),
    terminated: true,
    length: close + tag.length - i,
  };
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
 *
 * ── A dollar-quoted body is stripped too, recursively (#190) ─────────────────
 *
 * PL/pgSQL applies the SAME comment rules as SQL, so `--` and `/* … *​/` inside a
 * `DO $$ … $$` body are comments there as well. Verified against Postgres 16: a
 * `-- RAISE EXCEPTION …` line inside a DO block neither raises nor is a syntax
 * error. Preserving the body verbatim — as this did briefly while the lexer was
 * being taught that `;` does not terminate a statement inside one — handed
 * every guard downstream a comment to read as code, and both directions the
 * docstring above warns about became reachable one level down:
 *
 *  - a comment SATISFYING a guard, the false pass. `-- only rows where
 *    "focusSound" <> 'off' are meant to change` written above an unguarded
 *    `UPDATE` inside a DO block supplies rule 1's guard clause and the write
 *    goes through. That is the 2026-08-07 incident with a comment on top.
 *  - a comment TRIGGERING one, the false accusation. `-- never do this:
 *    UPDATE "Settings" SET "focusShuffle" = true;` fails the build.
 *
 * Recursion, not a second lexer, because a body may hold another dollar quote
 * and because the marker-inside-a-string rule has to hold at every depth. It
 * terminates: `inner` is always at least one tag shorter than the input.
 *
 * The tags themselves are re-emitted so `splitStatements` still sees the body
 * and still refuses to split on the semicolons inside it. Only the interior
 * changes, and only by losing characters that Postgres also ignores.
 *
 * A dollar-quoted string used as DATA rather than code (`SELECT $$a -- b$$`)
 * is stripped by the same rule, which is a deliberate over-reach in the safe
 * direction: nothing inside a data literal is ever executed, so removing text
 * from one can only discard a match that was never a statement.
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
    const body = dollarQuotedBodyAt(sql, i);
    if (body !== null) {
      out +=
        body.tag +
        stripSqlComments(body.inner) +
        (body.terminated ? body.tag : "");
      i += body.length;
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
 * Split on the semicolons that separate one piece of SQL from the next, i.e.
 * those outside a string literal — and, when `dollarQuotedBodiesAreOpaque`, the
 * ones inside a `DO $$ … $$` body as well. Blank pieces are dropped and
 * whitespace is collapsed, so SQL written across twelve lines matches the same
 * way as SQL written across one.
 */
function splitOnSemicolons(
  sql: string,
  dollarQuotedBodiesAreOpaque: boolean,
): string[] {
  const statements: string[] = [];
  let current = "";
  let inString = false;
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    if (inString) {
      current += c;
      if (c === "'") inString = false;
      i += 1;
      continue;
    }
    if (c === "'") {
      inString = true;
      current += c;
      i += 1;
      continue;
    }
    // #190 — a `DO $$ … $$` body is semicolon-separated PL/pgSQL, so it has to
    // be consumed whole or the one statement that does the work becomes several
    // that are not statements at all. Taken verbatim: `stripSqlComments` has
    // already removed the body's comments, and nothing else in it is this
    // function's business.
    if (dollarQuotedBodiesAreOpaque) {
      const body = dollarQuotedBodyAt(sql, i);
      if (body !== null) {
        current += sql.slice(i, i + body.length);
        i += body.length;
        continue;
      }
    }
    if (c === ";") {
      statements.push(current);
      current = "";
      i += 1;
      continue;
    }
    current += c;
    i += 1;
  }
  statements.push(current);
  return statements
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter((s) => s.length > 0);
}

/**
 * Split comment-stripped SQL into statements on the semicolons that terminate
 * one, i.e. those outside a string literal and outside a dollar-quoted body.
 */
export function splitStatements(sql: string): string[] {
  return splitOnSemicolons(sql, true);
}

/**
 * One statement broken into the pieces that RUN one after another inside it:
 * for anything but a `DO $$ … $$` block that is the statement itself, and for
 * such a block it is the PL/pgSQL statements the body holds.
 *
 * #190, raised in review. `splitStatements` keeping a body whole is right for
 * `findLateConstraintDrops`, which has to know what runs before what — but the
 * three rules in `findFocusSoundViolations` are per-statement questions, and
 * asking one of a whole body lets any statement in it answer for its
 * neighbours. Both directions of the warning at the top of this file came back
 * one level down, and the false-pass direction is the 2026-08-07 incident
 * itself:
 *
 *  - `UPDATE "Settings" SET "focusSound" = 'on'; UPDATE "Settings" SET "theme"
 *    = 'dark' WHERE "focusSound" <> 'off';` in one body. Rule 1 read the guard
 *    off the SECOND statement and let the first through — an unguarded flip
 *    passing the guard written to stop it.
 *  - the mirror image, `setClauseOf` stopping at an EARLIER statement's `WHERE`
 *    and never reaching the flip at all.
 *  - and `ADD COLUMN … DEFAULT 'off'; ALTER COLUMN … SET DEFAULT true;`, where
 *    rule 2's DEFAULT capture ran to the end of the body and read a sanctioned
 *    pair as a violation — the false accusation that gets a guard deleted.
 *
 * Dollar-quote tags are not treated as opaque here precisely because we are
 * already inside one; string literals still are, so a `;` in a value does not
 * split anything.
 *
 * Exported because `migration-data-harness.ts` asks per-statement questions of
 * the same input and had the same hole (#190, raised in review of !292): every
 * rule there reads its table from the FIRST `ALTER TABLE` in what it is given,
 * so a body holding two of them attributed the second one's constraint to the
 * first one's table — a false accusation against one table and, worse, silence
 * about the other. One splitter rather than two, for the reason `isBefore` is
 * shared: two copies of this reasoning have already drifted apart once.
 */
export function splitInnerStatements(statement: string): string[] {
  return splitOnSemicolons(statement, false);
}

/**
 * How many characters the string literal starting at `text[i]` occupies, or 0
 * when no literal starts there.
 *
 * Postgres escapes a quote inside a literal by doubling it, so `'it''s'` is ONE
 * literal and not two — the same rule `stripSqlComments` and `splitOnSemicolons`
 * already lex by, factored out here because the two scans below need to skip a
 * literal wholesale rather than merely notice they are inside one.
 *
 * An unterminated literal is read as running to the end of the input. That is
 * the reading that cannot silently resume lexing inside a value: the alternative
 * is treating the opening quote as ordinary text, which hands every scan below a
 * string's contents to read as SQL.
 */
function stringLiteralLengthAt(text: string, i: number): number {
  if (text[i] !== "'") return 0;
  let j = i + 1;
  while (j < text.length) {
    if (text[j] !== "'") j += 1;
    else if (text[j + 1] === "'")
      j += 2; // an escaped quote, still inside
    else return j + 1 - i; // the closing quote
  }
  return text.length - i;
}

/**
 * The pieces of `text` separated by the commas that are OUTSIDE every bracket
 * and every string literal — i.e. the commas that end one clause and begin the
 * next, rather than the ones separating a function's arguments or a value list's
 * values.
 *
 * #190. Shared by both halves of the migration guards, for the reason `isBefore`
 * and `splitInnerStatements` are shared rather than copied: this reasoning has
 * already drifted apart once per module that re-derived it. Its two callers ask
 * the same question of different clauses —
 *
 *  - `migration-data-harness.ts` bounds one `ALTER TABLE` action at the next,
 *    because every suppression there (`NOT VALID`, `DEFAULT`) belongs to the
 *    clause it is written in, and read wider the LAST clause's `NOT VALID`
 *    excuses every validated constraint in front of it;
 *  - `setClauseOf` below bounds one `SET` assignment at the next, because an
 *    `UPDATE` may write several columns and only the first was ever read.
 *
 * Depth-tracked rather than a lookahead for the next clause keyword: that would
 * need a list of every word a clause can open with, and a missing entry fails
 * the expensive way, by letting the clause over-run and borrow from its
 * neighbour. Brackets of both kinds count, because `numeric(10, 2)`,
 * `FOREIGN KEY ("a", "b")`, `IN ('off', 'on')` and `ARRAY['lofi', 'rain']` are
 * all one value written with a comma in it — the array form is not theoretical,
 * `20260806100000_settings_focus_sound_categories` writes one.
 *
 * String literals are skipped whole, which is what stops a migration's stored
 * prose from being read as SQL. These files quote SQL in their data as well as
 * in their comments, and a literal holding `, "focusSound" = 'on'` would
 * otherwise open a clause that no statement executes — the false-accusation
 * direction, which costs the same as a miss because the next author it blocks
 * deletes the guard.
 *
 * A stray `)` cannot drive the depth negative, so malformed SQL degrades into
 * MORE pieces rather than one long one. That is the safe direction: a clause cut
 * short can only lose a trailing suppression and over-report.
 */
export function splitTopLevelCommas(text: string): string[] {
  const pieces: string[] = [];
  let depth = 0;
  let start = 0;
  let i = 0;
  while (i < text.length) {
    const literal = stringLiteralLengthAt(text, i);
    if (literal > 0) {
      i += literal;
      continue;
    }
    const c = text[i];
    if (c === "(" || c === "[") depth += 1;
    else if (c === ")" || c === "]") depth = Math.max(0, depth - 1);
    else if (c === "," && depth === 0) {
      pieces.push(text.slice(start, i));
      start = i + 1;
    }
    i += 1;
  }
  pieces.push(text.slice(start));
  return pieces;
}

/**
 * `UPDATE "Settings" …` — the only table whose focus preferences exist.
 *
 * Not anchored to the start of the statement (#190). `UPDATE "Settings"` is the
 * write wherever it appears, and two shapes put it somewhere other than the
 * first token:
 *
 *  - inside a `DO $$ … $$` body, the form two committed migrations already use
 *    for data surgery. Anchoring missed those before the lexer knew about
 *    dollar quotes as well as after — the fragment began `DO $$ BEGIN UPDATE …`
 *    either way — so this is a pre-existing hole, not one the lexer opened.
 *  - behind a CTE: `WITH picked AS (…) UPDATE "Settings" SET …`, which
 *    `20260804120000_google_auth_user_id_not_null` shows is a shape this repo
 *    reaches for.
 *
 * The cost of un-anchoring is that a `Settings` UPDATE quoted inside a string
 * literal now reads as one. Rules 1 and 3 are the same shape of over-match the
 * `ADD COLUMN` rule below has always been, and the direction is the safe one: a
 * guard that asks for a `<> 'off'` clause it did not need is an argument, while
 * a guard that misses the write is the incident.
 */
const SETTINGS_UPDATE = /\bUPDATE\s+"?Settings"?\b/i;

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
const SILENT_ADD_COLUMN_DEFAULTS: ReadonlyMap<
  string,
  { allowed: RegExp; description: string }
> = new Map([
  ["focusSound", { allowed: /^'off'$/i, description: "'off'" }],
  [
    "focusSoundCategories",
    {
      allowed: /^(ARRAY\s*\[\s*\]|'\{\}')(\s*::\s*TEXT\s*\[\s*\])?$/i,
      description: "an empty array",
    },
  ],
  ["focusShuffle", { allowed: /^false$/i, description: "false" }],
]);

/**
 * `ALTER TABLE "Settings" …` — the only table these columns live on. Unanchored
 * for the same reason as `SETTINGS_UPDATE` above: an `ADD COLUMN` issued from
 * inside a `DO $$ … $$` body writes its default into every existing row exactly
 * as one written at the top level does (#190).
 */
const SETTINGS_ALTER = /\bALTER\s+TABLE\s+"?Settings"?\b/i;

/**
 * `ADD COLUMN <name> … DEFAULT <expr>`, capturing both.
 *
 * One static pattern that reads the column NAME out of the statement, rather
 * than one pattern compiled per column from a template. Static because a
 * dynamically constructed pattern is a SAST finding (CWE-1333-adjacent) even
 * when every interpolated value is a literal from the table above — and because
 * reading the name once beats recompiling three patterns for every statement in
 * every migration.
 */
const ADD_COLUMN_WITH_DEFAULT =
  /\bADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?"?(\w+)"?\b[\s\S]*?\bDEFAULT\s+(.+?)\s*$/i;

/** `SET`, as a whole word, at the head of the slice it is tested against. */
const SET_KEYWORD = /^SET\b/i;

/**
 * The words that end a SET clause. Everything after one of them belongs to the
 * statement but is not an assignment: `FROM` opens a join list, `WHERE` chooses
 * rows, `RETURNING` describes the output. `RETURNING` matters most, because its
 * comma-separated list of expressions is the one place after a SET clause where
 * `"column" = value` is legal — and reading one as a write would accuse a
 * migration of a change it only reports on.
 */
const SET_CLAUSE_END = /^(?:WHERE|FROM|RETURNING)\b/i;

/** Longest word `SET_CLAUSE_END` can match, plus one for its trailing boundary. */
const LONGEST_CLAUSE_END = "RETURNING".length + 1;

/** Characters that continue a word, so a keyword starting here is not one. */
const WORD_CHARACTER = /[A-Za-z0-9_$"]/;

/**
 * The SET clause of the `UPDATE` that begins at `from`: the assignments, and
 * nothing else.
 *
 * Scanned rather than matched, because all three bounds are questions about
 * nesting that a regex cannot ask (#190, raised in review of !292):
 *
 *  - it ends at the first `WHERE`/`FROM`/`RETURNING` **at depth zero**. Bounding
 *    at the first one in the text instead loses every assignment after a
 *    subquery — `SET "a" = (SELECT … WHERE …), "b" = 2` stops inside the
 *    parentheses and never sees `"b"`, which is the miss direction a naive fix
 *    for the multi-column gap walks straight into;
 *  - it ends at a depth-zero `;`, so inside a merged `DO $$ … $$` body one
 *    statement's clause cannot run into the next one's. The single-assignment
 *    scan this replaces got that from `[^;]*?` and a clause split does not get
 *    it for free: run on, and the first `UPDATE`'s table is credited with a
 *    later statement's column;
 *  - string literals are skipped whole, so a `;` or a clause keyword stored as
 *    data ends nothing.
 *
 * Returns `""` when no `SET` is reached before the statement does — which is not
 * valid SQL for an `UPDATE`, and is therefore reported as "this statement
 * assigns nothing" rather than by borrowing the next statement's clause.
 */
function setClauseOf(statement: string, from = 0): string {
  let depth = 0;
  let start = -1;
  let i = from;
  while (i < statement.length) {
    const literal = stringLiteralLengthAt(statement, i);
    if (literal > 0) {
      i += literal;
      continue;
    }
    const c = statement[i];
    if (c === "(" || c === "[") depth += 1;
    else if (c === ")" || c === "]") depth = Math.max(0, depth - 1);
    else if (c === ";" && depth === 0) break;
    else if (depth === 0 && !WORD_CHARACTER.test(statement[i - 1] ?? " ")) {
      if (start === -1) {
        if (SET_KEYWORD.test(statement.slice(i, i + "SET".length + 1))) {
          start = i + "SET".length;
          i = start;
          continue;
        }
      } else if (
        SET_CLAUSE_END.test(statement.slice(i, i + LONGEST_CLAUSE_END))
      ) {
        break;
      }
    }
    i += 1;
  }
  return start === -1 ? "" : statement.slice(start, i);
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
    const outer = splitStatements(stripSqlComments(file.sql));
    for (const statement of outer.flatMap(splitInnerStatements)) {
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
      if (SETTINGS_ALTER.test(statement)) {
        const added = ADD_COLUMN_WITH_DEFAULT.exec(statement);
        const rule = added && SILENT_ADD_COLUMN_DEFAULTS.get(added[1]);
        if (added && rule) {
          const declared = added[2].trim();
          if (!rule.allowed.test(declared)) {
            add(
              `adds Settings.${added[1]} with DEFAULT ${declared}, which is written into every existing row — an ADD COLUMN default may only be ${rule.description}; use ALTER COLUMN … SET DEFAULT for the new-account value`,
            );
          }
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
  const outer = splitStatements(stripSqlComments(sql));
  for (const statement of outer.flatMap(splitInnerStatements)) {
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

/**
 * Where something sits in a migration: which statement, and where inside it.
 *
 * #190 — the second half stopped being redundant when `splitStatements` learned
 * to keep a `DO $$ … $$` body whole, because everything in such a body shares
 * one statement index while still running in written order.
 *
 * Exported with `isBefore` below because `dropConstraintAfterWrite` in
 * `migration-data-harness.ts` asks the same question about the same two
 * statements, and it asked it with a bare index comparison until review of
 * !292 caught the two answers disagreeing (#190). Two orderings of one
 * migration is a defect whichever of them is wrong, so there is now one.
 */
export interface SqlPosition {
  statement: number;
  offset: number;
}

/** Whether `a` runs before `b`. Statement first, then offset within it. */
export function isBefore(a: SqlPosition, b: SqlPosition): boolean {
  return a.statement === b.statement
    ? a.offset < b.offset
    : a.statement < b.statement;
}

/**
 * `DROP CONSTRAINT "<name>"`, capturing the name for `parseCheckConstraintName`
 * to accept or reject.
 *
 * `IF EXISTS` is accepted because it is the same drop, and missing it does not
 * cost a warning — it costs the whole check. An unrecognised drop leaves the
 * column absent from the map, which is the branch that means "no CHECK on this
 * column in this file" and returns clean (#190).
 *
 * It matches ANY constraint name and lets the parser below decide, rather than
 * spelling the convention inline (#190, raised in review of !292). Spelled in
 * two places it was spelled two ways: this one admitted an underscore in the
 * table half and `migration-data-harness.ts`'s did not.
 *
 * Global, and every match is read: a merged `DO $$ … $$` body is one statement
 * that may drop several constraints.
 */
const DROP_CONSTRAINT = /DROP\s+CONSTRAINT\s+(?:IF\s+EXISTS\s+)?"([^"]+)"/gi;

/** `<Table>_<column>_check` — this repo's check-constraint naming convention. */
const CHECK_CONSTRAINT_NAME = /^([A-Za-z0-9_]+)_([A-Za-z0-9]+)_check$/;

/**
 * The table and column a check constraint's name says it guards, or `null` if
 * the name does not follow the convention.
 *
 * The ONE reading of `<Table>_<column>_check` in this repo (#190, raised in
 * review of !292). It had two, and they disagreed about the table half. A
 * constraint on a table named `Focus_Session` was therefore one this file's
 * guard reports on and one `dropConstraintAfterWrite` refused to reconstruct:
 * the static half and the seeded half of #190 covered different sets of files,
 * and the difference only shows on the file that needs both. Sharing the
 * reasoning is the same move `isBefore` and `splitInnerStatements` are here for.
 *
 * The table half admits `_` and the column half does not, which is what makes
 * `Focus_Session_mode_check` split as `Focus_Session` + `mode`: the first group
 * is greedy, so the column is whatever sits between the last `_` and `_check`.
 * Prisma spells every column in this schema camelCase, so nothing legitimate is
 * lost to that.
 *
 * Case-sensitive, deliberately: Postgres writes the suffix it generates in lower
 * case, and the two spellings of this convention only ever agreed on names where
 * case did not vary. A name that differs by case would key the drop map
 * differently from the write scan anyway, so matching it loosely never bought a
 * comparison — it bought a `dropAtByColumn` entry no write can ever match.
 */
export function parseCheckConstraintName(
  name: string,
): { table: string; column: string } | null {
  const m = CHECK_CONSTRAINT_NAME.exec(name);
  return m ? { table: m[1], column: m[2] } : null;
}

/** `UPDATE "<Table>"`, capturing the table. Global: a merged body holds many. */
const UPDATE_TARGET = /\bUPDATE\s+"([A-Za-z0-9_]+)"/gi;

/**
 * `"<column>" =` at the HEAD of one SET assignment, capturing the column.
 *
 * Anchored, which is what separates the column being written from the columns
 * being read: `SET "a" = "b"` writes `a` and merely reads `b`, and only the
 * left-hand side of the assignment is a write. The comparison operators are
 * excluded for free — `"a" <> 'x'` and `"a" >= 1` put a character between the
 * name and the `=` that `\s*` does not admit.
 *
 * Quoted names only, as this scan has always required: every column in this
 * schema is written quoted, and the drop map is keyed by the case-sensitive
 * `<Table>_<column>_check` convention, so an unquoted spelling could not be
 * matched against it anyway.
 */
const ASSIGNED_COLUMN = /^\s*"([A-Za-z0-9]+)"\s*=/;

/** A column an `UPDATE` assigns, and where in the statement that write runs. */
interface ColumnWrite {
  table: string;
  column: string;
  /**
   * Offset of the `UPDATE` keyword, not of the assignment. A statement's writes
   * all land at once, so every column one assigns shares the position the
   * statement itself runs at — and taking the assignment's own offset would
   * order two columns of one `SET` against each other, which nothing does.
   */
  offset: number;
}

/**
 * Every column each `UPDATE` in `statement` assigns.
 *
 * EVERY column (#190, raised in review of !292). This read `UPDATE "<Table>" …
 * SET "<column>" =` as one pattern and then looked for the next `UPDATE`, so in
 * `SET "typeface" = …, "focusSound" = 'on'` the second assignment onwards was
 * invisible. A `DROP CONSTRAINT` left below a write to a column assigned second
 * therefore passed a guard that exists for precisely that shape — the
 * 2026-08-07 incident with a comma in front of it, and a false negative, which
 * is the direction that reaches production. No committed migration writes two
 * columns in one `SET` today, which is why the real-tree scan could not see it;
 * it is one line of SQL away.
 *
 * The clause is split the way `migration-data-harness.ts` splits an `ALTER
 * TABLE`'s actions — the shared `splitTopLevelCommas` — rather than by widening
 * the pattern, because a wider pattern reads the `WHERE` clause, a `RETURNING`
 * expression and any SQL stored in a string literal as writes too.
 */
function columnWritesIn(statement: string): ColumnWrite[] {
  const writes: ColumnWrite[] = [];
  // `matchAll` builds its own iterator from the pattern's source and flags, so
  // sharing a `g`-flagged constant carries no `lastIndex` between calls.
  for (const target of statement.matchAll(UPDATE_TARGET)) {
    const clause = setClauseOf(statement, target.index + target[0].length);
    for (const assignment of splitTopLevelCommas(clause)) {
      const assigned = ASSIGNED_COLUMN.exec(assignment);
      if (assigned) {
        writes.push({
          table: target[1],
          column: assigned[1],
          offset: target.index,
        });
      }
    }
  }
  return writes;
}

/**
 * A write that a still-live CHECK constraint would reject (#180 / the 2026-08-07
 * production incident).
 *
 * `20260806100000_settings_focus_sound_categories` wrote `focusSound = 'on'`
 * and only THEN dropped `Settings_focusSound_check`, which permitted `'off'`
 * plus ten `lofi_*` track ids and nothing else. Every existing row violated it:
 *
 *     ERROR: new row for relation "Settings" violates check constraint
 *            "Settings_focusSound_check"   (SQLSTATE 23514)
 *
 * The transaction rolled back, Prisma recorded a failed migration, and P3009
 * then refused every later migration — no deploy reached the cluster for two
 * days while `main` moved on.
 *
 * **It could not fail anywhere but production.** Steps 2–5 of that file are
 * `UPDATE`s, and CI, the integration suite and every local run migrate a fresh,
 * EMPTY `Settings` table. Zero rows updated means no constraint is ever
 * evaluated, so the migration passed every gate the project has. Only real rows
 * expose it — which is the definition of a check that cannot be shown to fail.
 *
 * This guard closes that by reading the ORDER of statements rather than their
 * effect, so it needs no database and no data. Within one migration: if a
 * column is written and that column's CHECK constraint is dropped later in the
 * same file, the drop is too late.
 *
 * ── Order is a position, not a statement index (#190) ────────────────────────
 *
 * Once `splitStatements` keeps a `DO $$ … $$` body whole, a drop and a write
 * that both live inside one block share a statement index, and an index
 * comparison can only read "same index" as "not earlier" — so the correctly
 * ordered shape could never pass, for any input. That matters more than a
 * missing warning would: this repo already uses `DO $$ … $$` for data surgery
 * (`google_auth_orphan_purge`, `google_auth_user_id_not_null`), so the first
 * author to drop-then-write inside one would meet a guard that cannot be
 * satisfied, and the fix a blocked author reaches for is deleting the guard.
 *
 * So the comparison is `(statement, offset within the statement)`, which reads
 * a PL/pgSQL body the way Postgres runs it — top to bottom. For every statement
 * outside such a block the two orderings agree, because the offsets only ever
 * break a tie the statement indices already lost.
 *
 * For the same reason both scans take EVERY match in a statement rather than
 * the first: one statement used to hold at most one write and one drop, and a
 * merged body holds as many as the author wrote. Reading only the first let a
 * late write hide behind an earlier, innocent one.
 *
 * And every column each write ASSIGNS, not just the first (#190, raised in
 * review of !292). One `UPDATE` may set several — `SET "typeface" = …,
 * "focusSound" = 'on'` — and a scan that stopped at the first assignment let a
 * late drop on a column written second through, which is the 2026-08-07 shape
 * with a comma in front of it. `columnWritesIn` below reads the SET clause and
 * splits it; the miss and the false accusation are both pinned in the colocated
 * test, because widening a scan is the cheap way to buy the second.
 *
 * The constraint→column mapping leans on this repo's naming convention,
 * `<Table>_<column>_check`, which every constraint in `prisma/migrations`
 * follows. A constraint named otherwise is skipped rather than guessed at —
 * a false accusation would get the guard relaxed, and a guard that cries wolf
 * is worse than none.
 */
export function findLateConstraintDrops(
  files: readonly MigrationFile[],
): MigrationViolation[] {
  const violations: MigrationViolation[] = [];

  for (const file of files) {
    const statements = splitStatements(stripSqlComments(file.sql));

    // Where each column's CHECK constraint is dropped. The LAST drop wins, as
    // it always has: a second drop of the same constraint name in one file
    // means something re-added it in between, so the constraint is live again.
    const dropAtByColumn = new Map<string, SqlPosition>();
    statements.forEach((s, statement) => {
      for (const m of s.matchAll(DROP_CONSTRAINT)) {
        // A constraint named otherwise is skipped rather than guessed at, which
        // is the "no CHECK on this column in this file" branch — see the
        // docstring below on why a false accusation is the worse error here.
        const named = parseCheckConstraintName(m[1]);
        if (!named) continue;
        dropAtByColumn.set(`${named.table}.${named.column}`, {
          statement,
          offset: m.index,
        });
      }
    });

    statements.forEach((s, statement) => {
      for (const write of columnWritesIn(s)) {
        const dropAt = dropAtByColumn.get(`${write.table}.${write.column}`);
        const writeAt = { statement, offset: write.offset };
        if (dropAt === undefined || isBefore(dropAt, writeAt)) continue;
        const dropWhere =
          dropAt.statement === statement
            ? "later in that same statement (a DO $$ … $$ body runs top to " +
              "bottom, so a drop below the write is still below it)"
            : `at statement ${dropAt.statement + 1}`;
        violations.push({
          migration: file.name,
          statement: s.replace(/\s+/g, " ").trim().slice(0, 160),
          reason:
            `writes "${write.column}" at statement ${statement + 1} but drops ` +
            `"${write.table}_${write.column}_check" ${dropWhere}. The old ` +
            `constraint is still live when the write runs, so any EXISTING row ` +
            `whose new value it forbids fails with SQLSTATE 23514 and rolls the ` +
            `whole migration back. Move the DROP above the write; only the ` +
            `replacement ADD belongs after it.`,
        });
      }
    });
  }

  return violations;
}
