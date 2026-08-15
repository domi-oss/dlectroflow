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
 * So the unit of judgement is the LINE, and the question is whether that line
 * disavows the recipe rather than handing it over. Line-scoped on purpose:
 * deciding it per docblock would let one negation anywhere in a file wave
 * through a prescription further down, which is the drift this exists to catch.
 *
 * ── What this is, and is not ────────────────────────────────────────────────
 * The **control** is `config/vitest.config.ts`'s one-variable forwarding. This is
 * a hygiene check protecting the *documentation* from telling people to defeat
 * that control, and it is not an adversarial boundary: a line carrying a
 * negation about something else while still prescribing the recipe is exempted
 * (asserted in the colocated test, so the limit is recorded rather than
 * discovered). What it stops is the accidental drift that actually happened —
 * twelve copies of a sentence, each recopied from the last.
 *
 * Kept free of `fs` like every other hygiene module here: the caller reads the
 * files, this module parses, so the parsing can be exercised on synthetic input
 * and shown to fail.
 */

/**
 * The recipe. Tolerant of the whitespace and of `npm test` / `npm run test`,
 * because what matters is `set -a` followed by sourcing the env file — the two
 * halves that together export it — not how the run is spelled afterwards.
 */
const SOURCES_ENV_FILE = /set\s+-a\s*;\s*\.\s+\.\/\.env/;

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
 */
const DISAVOWED =
  /\bnever\b|\bavoid\b|\bno longer\b|\binstead of\b|\brather than\b|\bunnecessary\b|\bnot needed\b|\b(?:do|does|did|must|should|need)\s+not\b|\b(?:do|does|must|should)n['’]t\b/i;

/**
 * The recipe sitting inside a backtick code span, i.e. **quoted rather than
 * handed over**.
 *
 * This is the second half of the exemption, and it is what stops a disavowal
 * elsewhere in the sentence waving a prescription through — `!350`'s review
 * raised exactly that (a line reading "You should not skip the DB setup; run:
 * set -a; …" carries a disavowal phrase but still prescribes the command).
 *
 * Requiring the code span is a tighter answer than measuring the distance
 * between the negation and the command, and a better one: a bounded distance is
 * a number that has to be tuned against adversarial examples, whereas the code
 * span is how this repo's prose already distinguishes a command being discussed
 * from one being given. Every real warning in the tree quotes it; every
 * prescription wrote it bare, as something to copy.
 */
const QUOTED_RECIPE = /`[^`]*set\s+-a\s*;\s*\.\s+\.\/\.env[^`]*`/;

/**
 * True when `line` hands the reader the env-sourcing recipe as a thing to run,
 * as opposed to naming it in order to warn against it.
 *
 * A mention is exempt only when it is **both** quoted as a code span **and**
 * disavowed on the same line. Both are required because either alone is
 * reachable by an ordinary prescription: a bare command with an unrelated
 * negation nearby, or a quoted command someone is telling you to run.
 *
 * The residual is documented and asserted in the colocated test: a line that
 * quotes the recipe AND carries a disavowal phrase AND still prescribes it is
 * exempt. That sentence has to be contorted on purpose, and this is a drift
 * guard rather than an adversarial boundary — the control is
 * `config/vitest.config.ts`'s one-variable forwarding, not this.
 */
export function prescribesEnvSourcing(line: string): boolean {
  if (!SOURCES_ENV_FILE.test(line)) return false;
  return !(QUOTED_RECIPE.test(line) && DISAVOWED.test(line));
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
