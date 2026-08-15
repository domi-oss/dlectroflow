/**
 * #256 — pure helper for one question about `*.integration.test.ts` docblocks:
 * **does this file tell its reader to source `.env` into the test process?**
 *
 * Twelve docblocks handed over `set -a; . ./.env; set +a; npm run test` as the
 * way to run them, under a claim that "vitest does NOT read .env". Both halves
 * were wrong. `config/vitest.config.ts` reads `.env` and `.env.local` and
 * forwards **only** `DATABASE_URL`, parsed into a throwaway object rather than
 * assigned onto `process.env`, because #84 wanted no test able to reach a value
 * it was not given. `set -a` inverts exactly that: it exports every assignment
 * in the file to every test in the run, turning a one-variable allowlist into a
 * whole-environment export.
 *
 * Nothing needed it. Proved in both directions before the sweep, on
 * `braindump-client-key-unique.integration.test.ts`: `env -u DATABASE_URL npm
 * test -- <file>` passes 5/5 because the config supplies the variable, and
 * `DATABASE_URL="" npm test -- <file>` exits 1 with #84's guard message from
 * `config/vitest.setup.ts` — the control that stops the first result being a run
 * which never reached a database.
 *
 * ── Prescribing vs warning, which is the whole difficulty ────────────────────
 * A guard that greps for a phrase is defeated by a file quoting that phrase in
 * order to warn against it, and in this repo that shape has already cost three
 * skipped `deploy_production` runs. It is not hypothetical here: two files
 * (`route.integration.test.ts`, `braindump-client-key-unique.integration.test.ts`)
 * legitimately name the recipe so a reader who saw the old docblock knows why it
 * went. A substring check would red the pipeline on the two sites that are
 * already correct.
 *
 * So the scan unit is the LINE, and within a line **each occurrence of the
 * recipe is judged separately**: an occurrence is left alone only if it is quoted
 * as a code span and the line disavows the recipe. Scoped to the line on purpose
 * — deciding it per docblock would let one negation anywhere in a file wave
 * through a prescription further down, which is the drift this exists to catch.
 * The exact rule and its limits live on {@link prescribesEnvSourcing}.
 *
 * ── What this is, and is not ────────────────────────────────────────────────
 * The **control** is `config/vitest.config.ts`'s one-variable forwarding. This is
 * a hygiene check protecting the *documentation* from telling people to defeat
 * that control, and it is not an adversarial boundary. What it stops is the
 * accidental drift that actually happened — twelve copies of a sentence, each
 * recopied from the last, all twelve on a single line.
 *
 * Its three known limits are stated once, in {@link prescribesEnvSourcing}'s own
 * docstring, and each is asserted in the colocated test. They are deliberately
 * **not** restated here: an earlier draft of this paragraph described the
 * pre-fix behaviour and cited a test that by then proved the opposite, which is
 * the same defect this whole MR is about — a docblock a reader would trust,
 * saying something the code does not do.
 *
 * Kept free of `fs` like every other hygiene module here: the caller reads the
 * files, this module parses, so the parsing can be exercised on synthetic input
 * and shown to fail.
 */

/**
 * The recipe: turn on auto-export, then source the env file. What matters is
 * those two halves, so **each half accepts every spelling that shell accepts**
 * rather than only the one the twelve real sites happened to use —
 *
 *   - auto-export: `set -a` or its long form `set -o allexport`;
 *   - separator: `;` or `&&`;
 *   - sourcing: `.` or `source`, of `./.env` or `.env`.
 *
 * `!350`'s review found this pattern matched only `set -a; . ./.env` while this
 * docstring claimed to be about the two halves generally. Every variant above
 * exports the identical set of values, so recognising one and missing four made
 * the sentence you are reading the same kind of claim the MR is deleting from
 * twelve docblocks — one a reader would trust, describing something the code
 * does not do. Each is now asserted in the colocated test.
 *
 * Whitespace and the trailing `npm test` / `npm run test` stay unconstrained:
 * the defect is the export, not how the run is spelled afterwards. Case stays
 * significant because shell is — `SET -A` is not a command.
 *
 * **Both halves are word-anchored**, which is the other half of accepting every
 * spelling: without `\b` the recipe also matched inside a longer word, so
 * `unset -a; . ./.env` and `set -a; . ./.envrc` were both reported as
 * prescriptions. Neither is one — `unset` is a different command and `.envrc`
 * is a direnv file, not the env file `config/vitest.config.ts` reads. Raised in
 * `!350`'s review, and it mattered because a false positive here reds an
 * unrelated author's pipeline over a docblock that prescribes nothing, which is
 * what the quoted-and-disavowed exemption exists to avoid. The trailing anchor
 * deliberately still admits `.env.local`: that file is read too, so sourcing it
 * exports the same class of values and is the same defect.
 *
 * Global, because a single line can carry the recipe **more than once** — a
 * warning and a bare copy in the same sentence — and each occurrence has to be
 * judged on its own. See {@link prescribesEnvSourcing}.
 */
const SOURCES_ENV_FILE =
  /\bset\s+(?:-a|-o\s+allexport)\s*(?:;|&&)\s*(?:\.|source)\s+(?:\.\/)?\.env\b/g;

/**
 * Phrases that turn a mention of the recipe into a warning against it.
 *
 * An explicit list rather than a bare `\bnot\b`: "not" is common enough in
 * ordinary prose that matching it alone would exempt a line like
 * `If DATABASE_URL is not set: set -a; . ./.env; set +a`, which is a
 * prescription wearing a negation about its precondition. Each entry here is a
 * phrase that can only be read as being about the command itself.
 *
 * The list is kept to phrases a person would plausibly write here, and **every
 * alternative has a case in the colocated test** — an alternative nothing
 * asserts is untested code, and it stops the next reader telling a deliberate
 * choice from a typo.
 *
 * The auxiliary verbs are listed **once** and take either spelling,
 * `(?:\s+not|n['’]t)`, rather than as two parallel groups. `!350`'s review found
 * those groups had drifted apart — the spelled-out one covered `did`/`need` and
 * the contraction one did not, so a legitimate `You needn't run …` was flagged
 * as a prescription. Sharing the verb list makes that particular drift
 * unrepresentable instead of relying on someone keeping two lists in step, which
 * is the same failure this MR is sweeping out of twelve docblocks.
 */
const DISAVOWED =
  /\bnever\b|\bavoid\b|\bno longer\b|\binstead of\b|\brather than\b|\bunnecessary\b|\bnot needed\b|\b(?:do|does|did|must|should|need)(?:\s+not|n['’]t)\b/i;

/** A backtick code span. */
const CODE_SPAN = /`[^`]*`/g;

/**
 * The [start, end) offsets of every backtick code span in `line`.
 *
 * Quoting is what separates a command being **discussed** from one being
 * **given**: this repo's prose fences the former and indents the latter. That is
 * a tighter test than measuring the distance between a negation and the command,
 * and a better one, because a bounded distance is a number that has to be tuned
 * against adversarial examples.
 */
function codeSpans(line: string): [number, number][] {
  return [...line.matchAll(CODE_SPAN)].map((m) => [
    m.index,
    m.index + m[0].length,
  ]);
}

/**
 * True when `line` hands the reader the env-sourcing recipe as a thing to run,
 * as opposed to naming it in order to warn against it.
 *
 * **Judged per occurrence, not per line.** A single line can both warn about the
 * recipe and hand over a bare copy of it —
 * `Do not use \`set -a; …\` any more — instead run: set -a; …` — and an
 * exemption that only asked whether *some* quoted mention existed would let the
 * bare copy through. `!350`'s review raised that, and it is the same
 * missed-violation class as the unrelated-negation hole fixed before it. So each
 * occurrence is exempt only if **that** occurrence sits inside a code span and
 * the line disavows the recipe; one bare occurrence condemns the line.
 *
 * ── Three known limits, each asserted in the colocated test ─────────────────
 * This is the authoritative list. Nothing else in the file restates it, because
 * a second copy is what let an earlier draft of the header describe behaviour
 * the code had stopped having.
 *
 * 1. The disavowal must sit on the same line as the command, so a warning that
 *    wraps the command onto a line of its own is flagged. The failure message
 *    says to keep them together, so the red pipeline names its own fix.
 * 2. A mention that is quoted as a code span **and** disavowed **and** still
 *    being prescribed is exempt — `Do not forget to run \`set -a; …\``. That
 *    sentence has to be contorted on purpose.
 * 3. A recipe **split across several docblock lines** (`set -a` on one line,
 *    `. ./.env` on the next) is not detected, because the scan unit is the line.
 *    Joining lines before matching would mean a second detection mode with its
 *    own quoting and disavowal semantics — a disavowal on the first line would
 *    otherwise exempt a prescription on the fourth, reintroducing exactly the
 *    hole this function's per-occurrence check closes. #256 caps this guard at
 *    one assertion for that reason, so the gap is recorded rather than closed.
 *    All twelve real occurrences wrote the recipe on one line.
 *
 * All three are the same trade: this is a drift guard, not an adversarial
 * boundary. The control is `config/vitest.config.ts`'s one-variable forwarding.
 */
export function prescribesEnvSourcing(line: string): boolean {
  const occurrences = [...line.matchAll(SOURCES_ENV_FILE)];
  if (occurrences.length === 0) return false;

  const disavowed = DISAVOWED.test(line);
  const spans = codeSpans(line);
  return occurrences.some((m) => {
    const quoted = spans.some(([from, to]) => m.index >= from && m.index < to);
    return !(quoted && disavowed);
  });
}

/** A prescription found in a file, as a 1-based line number and its text. */
export type EnvSourcingSite = { line: number; text: string };

/**
 * Every line of `source` that prescribes the recipe. Empty for a file that never
 * mentions it, and empty for one that only warns against it.
 */
export function findEnvSourcingPrescriptions(
  source: string,
): EnvSourcingSite[] {
  return source
    .split("\n")
    .map((text, i) => ({ line: i + 1, text: text.trim() }))
    .filter((site) => prescribesEnvSourcing(site.text));
}
