/**
 * #175 — the drift gate behind the offline capture queue's orphan window.
 *
 * Two surfaces state the same fact and neither can read the other:
 *
 *  * the **server's** guest-sandbox TTL, `GUEST_SANDBOX_TTL_HOURS`, defaulting to
 *    24 in `guestSandboxTtlHours` (`src/lib/purge.ts`);
 *  * the **client's** orphan window, `CAPTURE_ORPHAN_WINDOW_HOURS`
 *    (`src/lib/capture-queue.ts`), which decides when a queued capture whose
 *    workspace can no longer be resolved is removed.
 *
 * The browser cannot read the first: it is a server variable, and this repo has
 * no `NEXT_PUBLIC_*` variables at all — the only occurrence of that prefix
 * anywhere is a comment in `settings/page.tsx` explaining why a client component
 * cannot read a non-public one. So the client holds its own number, and the
 * failure this exists to prevent is the two drifting: the client expiring
 * captures at 24 hours while sandboxes live for 72 destroys unsaved words whose
 * workspace still resolves, which is the one outcome the design forbids
 * everywhere else. **It is also a promise on a legal page** — `/privacy` states
 * the retention as three triggers and the third of them, *"until it can no longer
 * be saved to any account you can reach"*, **is** this constant in prose.
 *
 * ── Why this family and not one of the two obvious candidates ────────────────
 *
 * Neither of the checks a reader reaches for can see a value drift:
 *
 *  * `enum-constraint-sync` queries `pg_constraint WHERE contype = 'c'`. It
 *    polices CHECK constraints and the enum/range/length registries; a TypeScript
 *    constant is not a database constraint and is invisible to it.
 *  * `env-drift` diffs **key sets** in both directions — a key read but
 *    undocumented, or documented but unread. `computeConfigSurfaceDrift` takes an
 *    `Iterable<string>` of *keys*; **no value is ever compared**, so a 24
 *    becoming a 72 passes it.
 *
 * `log-retention` (#157) is the right member of the family. Its own docblock
 * states this exact principle — *"two surfaces stating the same fact must state
 * the same fact"* — and its helpers exist to read a declared default out of one
 * file and compare it against a number in another. This module is that shape:
 * **no `fs`**, so the parsing is unit-testable on synthetic input, with the
 * colocated `.test.ts` reading the real files.
 *
 * ── The two rules that keep it from passing vacuously ────────────────────────
 *
 *  1. **Both extractors return `null` rather than a guess**, and `null` fails the
 *     assertion. Lifted from `shellDefault`'s own discipline: *"an absent default
 *     fails the … assertion loudly instead of comparing two things that are both
 *     missing."* A rename is exactly how this class of guard starts reading as
 *     coverage while asserting nothing, so the test feeds each parser a renamed
 *     source and requires a failure.
 *  2. **The assertion is `client >= server`, not equality.** Erring long only
 *     delays reclaiming bytes; erring short deletes a capture whose workspace was
 *     going to resolve again. A gate that reds on a safe change is a gate people
 *     relax.
 *
 * ⚠️ **What it cannot see, said rather than asserted around.** CI can compare the
 * two **defaults**. It cannot see that a self-host sets
 * `GUEST_SANDBOX_TTL_HOURS=72`, so on that deployment the comparison this gate
 * makes is not the one that matters. Same boundary `log-retention` reports as
 * **undetermined rather than clean**; here it is carried by the client constant's
 * own comment and by `docs/legal.md`'s Guest TTL row, which is the registry tying
 * this TTL to the places user-facing prose states it.
 *
 * Both parsers are **string scans, not regexes built from their arguments** —
 * `regexp-source-hygiene` is a compensating control for a demoted CWE-185 rule
 * and would reject the `new RegExp(name)` form, and `log-retention`'s own
 * docblock records making this same choice for this same reason.
 */
import { stripComments } from "./source-text";

/** The server variable whose default the client window must not fall below. */
export const SERVER_TTL_ENV_VAR = "GUEST_SANDBOX_TTL_HOURS";

/** The client constant that states the same fact. */
export const CLIENT_WINDOW_CONSTANT = "CAPTURE_ORPHAN_WINDOW_HOURS";

/**
 * Characters that may follow an identifier without extending it.
 *
 * The boundary check is what stops `GUEST_SANDBOX_TTL_HOURS` matching inside
 * `GUEST_SANDBOX_TTL_HOURS_LEGACY` — a silent false positive that would read the
 * wrong number and report the surfaces as agreeing.
 */
function isIdentifierChar(ch: string): boolean {
  return /[A-Za-z0-9_$]/.test(ch);
}

/**
 * A plain integer literal, or `null`.
 *
 * `_` separators are accepted because this repo writes `10_000`; anything else —
 * an expression, a call, another identifier — is `null`, because a parser that
 * guessed at a derived value is a parser that can be wrong in silence.
 */
function numberLiteral(raw: string): number | null {
  const text = raw.trim();
  if (text === "") return null;
  const digits = text.replace(/_/g, "");
  if (!/^\d+$/.test(digits)) return null;
  const value = Number(digits);
  return Number.isFinite(value) ? value : null;
}

/**
 * The literal fallback in a `process.env.NAME ?? n` read, or `null`.
 *
 * Comments are stripped first: `purge.ts` names the number in its own docblock
 * ("default 24"), so a parser that read prose would find a number without reading
 * any code — and would keep finding one after the code stopped agreeing with it.
 */
export function envNumberDefault(source: string, name: string): number | null {
  const marker = `process.env.${name}`;
  const code = stripComments(source);
  let from = 0;
  for (;;) {
    const at = code.indexOf(marker, from);
    if (at === -1) return null;
    from = at + marker.length;
    // Not a prefix of a longer variable name.
    if (isIdentifierChar(code.charAt(from))) continue;

    const rest = code.slice(from);
    const nullish = rest.indexOf("??");
    if (nullish === -1) continue;
    // The `??` has to be the next thing, not one that belongs to a later read.
    if (rest.slice(0, nullish).trim() !== "") continue;

    // The fallback runs to whatever closes the expression.
    const tail = rest.slice(nullish + 2);
    const end = tail.search(/[),;\n]/);
    const value = numberLiteral(end === -1 ? tail : tail.slice(0, end));
    if (value !== null) return value;
  }
}

/**
 * The value of `export const NAME = <literal>;`, or `null`.
 *
 * Line-oriented, which is enough for the one shape this repo writes and is the
 * same trade `shellDefault` makes. A constant reformatted across two lines would
 * read as absent — a **failure**, which is the safe direction for a gate.
 */
export function tsNumberConstant(source: string, name: string): number | null {
  const declaration = `export const ${name}`;
  for (const line of stripComments(source).split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(declaration)) continue;
    const after = trimmed.slice(declaration.length);
    // `export const FOO_MAX = 72` must not answer a question about `FOO`.
    if (isIdentifierChar(after.charAt(0))) continue;
    const eq = after.indexOf("=");
    if (eq === -1) continue;
    // A type annotation between the name and the `=` is fine; anything else is
    // not this declaration.
    const rhs = after.slice(eq + 1);
    const end = rhs.indexOf(";");
    const value = numberLiteral(end === -1 ? rhs : rhs.slice(0, end));
    if (value !== null) return value;
  }
  return null;
}
