import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";

/**
 * #256 — no `*.integration.test.ts` docblock may tell a reader to source `.env`
 * into the test process.
 *
 * Twelve docblocks carried `set -a; . ./.env; set +a; npm run test` as the way to
 * run them, under a claim that "vitest does NOT read .env". Both halves were
 * wrong. `config/vitest.config.ts` reads `.env` and `.env.local` and forwards
 * **only** `DATABASE_URL`, into a throwaway object rather than onto
 * `process.env` — deliberately, and #84's comment there says why: no test can
 * reach a value it was not given. `set -a` inverts that: it exports every
 * assignment in the file to every test in the run, turning a one-variable
 * allowlist into a whole-environment export.
 *
 * Nothing needed the recipe. Proved in both directions before the sweep, on
 * `braindump-client-key-unique.integration.test.ts`:
 *
 *   - `env -u DATABASE_URL npm test -- <file>` → 5 passed, exit 0. The config
 *     supplied the variable; the shell had none to give.
 *   - `DATABASE_URL="" npm test -- <file>` → exit 1, with #84's guard message
 *     from `config/vitest.setup.ts`. That is the control that makes the pass
 *     above non-vacuous rather than a test that never touched a database.
 *
 * ── Why this distinguishes prescribing from warning ─────────────────────────
 * A guard that greps for a phrase is defeated by a file that quotes the phrase
 * in order to warn against it, and in this repo that has already cost three
 * skipped production deploys. It is not hypothetical here either: two files
 * (`route.integration.test.ts` and `braindump-client-key-unique.integration.test.ts`)
 * legitimately name the recipe so a reader who saw the old docblock knows why it
 * went. A bare substring check would red the pipeline on the two files that are
 * already correct.
 *
 * So the unit of judgement is the LINE, and the test is whether that line
 * disavows the recipe. `⚠️ So do NOT run \`set -a; …\`` passes; a line that
 * simply hands the command over does not. The limitation is deliberate and
 * asserted below: the disavowal has to sit on the same line as the recipe. A
 * warning that wraps the command onto a line of its own fails, and the failure
 * message says to keep them together — a red pipeline that names its own fix,
 * rather than a check that can be talked past.
 *
 * ── Scope, and why it is one assertion ──────────────────────────────────────
 * Only the harmful half is guarded. The false "vitest does NOT read .env"
 * sentence is wrong but inert, and it cannot lead anywhere on its own: anyone who
 * re-derives the export command from it trips this guard. One check on the
 * reachable harm, no companion module, per #256's cap.
 *
 * This file is a `.test.ts`, not a `.integration.test.ts`, so the sweep below
 * cannot collect the fixtures on this page. It needs no database.
 */

/** The recipe, tolerant of the whitespace and `npm test` / `npm run test` variants. */
const SOURCES_ENV_FILE = /set\s+-a\s*;\s*\.\s+\.\/\.env/;

/**
 * Words that turn a mention of the recipe into a warning against it. `\bnot\b`
 * covers "do not"/"does not"/"is not" without a separate case for each.
 */
const DISAVOWED = /\b(?:not|never|don['’]t|avoid|instead\s+of)\b/i;

/**
 * True when `line` hands the reader the env-sourcing recipe as a thing to run,
 * as opposed to naming it in order to warn against it.
 *
 * Line-scoped on purpose — see the docblock. Deciding this across a whole
 * docblock would mean one negation anywhere in the file waving through a
 * prescription later in it, which is the failure this is meant to catch.
 */
function prescribesEnvSourcing(line: string): boolean {
  return SOURCES_ENV_FILE.test(line) && !DISAVOWED.test(line);
}

// Resolved against THIS file rather than `process.cwd()`, so the sweep still
// covers the tree when vitest is launched from a subdirectory — the same reason
// `config/vitest.config.ts` pins its own paths (#133).
const SRC_DIR = new URL("../", import.meta.url);
const REPO_ROOT = new URL("../../", import.meta.url);

/** Every `*.integration.test.ts` under `src/`, as a repo-relative path. */
function integrationTestFiles(): string[] {
  return readdirSync(SRC_DIR, { recursive: true, encoding: "utf8" })
    .filter((f) => f.endsWith(".integration.test.ts"))
    .map((f) => `src/${f.replaceAll("\\", "/")}`)
    .sort();
}

describe("integration-test docblock hygiene (#256)", () => {
  // These come first: a guard that can only be exercised against the real tree
  // cannot be shown to FAIL, which is this repo's house rule for every
  // file-parsing check (see client-server-boundary.test.ts).
  describe("the check itself", () => {
    it("flags the recipe handed over as a command", () => {
      expect(
        prescribesEnvSourcing(" *   set -a; . ./.env; set +a; npm run test"),
      ).toBe(true);
      expect(
        prescribesEnvSourcing(" * Run: set -a; . ./.env; set +a; npm test"),
      ).toBe(true);
    });

    it("does not flag a line warning against the recipe", () => {
      expect(
        prescribesEnvSourcing(
          " * ⚠️ So do NOT run `set -a; . ./.env; set +a; npm test`. It was in this docblock,",
        ),
      ).toBe(false);
      expect(
        prescribesEnvSourcing(
          " * Never `set -a; . ./.env; set +a` — the config forwards DATABASE_URL already.",
        ),
      ).toBe(false);
    });

    it("ignores lines that do not mention the recipe at all", () => {
      expect(prescribesEnvSourcing(" * Needs the real Postgres.")).toBe(false);
      expect(prescribesEnvSourcing("  set -e")).toBe(false);
      // `set -a` without sourcing the env file is not the defect.
      expect(prescribesEnvSourcing(" *   set -a; npm run test")).toBe(false);
    });

    it("requires the disavowal on the same line as the recipe", () => {
      // Asserted rather than left implicit: this is the one shape that a reader
      // could reasonably write and still fail. The failure message below names
      // the fix, so the red pipeline is self-explaining.
      const wrapped = [
        " * Do not run the old recipe:",
        " *   set -a; . ./.env; set +a; npm run test",
      ];
      expect(wrapped.filter(prescribesEnvSourcing)).toHaveLength(1);
    });
  });

  it("no integration-test docblock tells you to source .env", () => {
    const files = integrationTestFiles();
    // Guards against a silently-empty sweep: a zero here would otherwise read
    // as a pass while nothing had been looked at.
    expect(files.length).toBeGreaterThan(20);

    const offenders = files.flatMap((file) => {
      const source = readFileSync(new URL(file, REPO_ROOT), "utf8");
      return source
        .split("\n")
        .map((line, i) => ({ file, line: i + 1, text: line.trim() }))
        .filter((hit) => prescribesEnvSourcing(hit.text));
    });

    expect(
      offenders,
      offenders.length === 0
        ? ""
        : `These docblocks hand the reader \`set -a; . ./.env; set +a\`, which exports every ` +
            `assignment in the env file to every test in the run. ` +
            `config/vitest.config.ts already forwards DATABASE_URL — and only DATABASE_URL — ` +
            `from .env and .env.local (#84), so an integration test needs nothing but a ` +
            `reachable Postgres. Delete the command; say what the file needs instead.\n\n` +
            `If you are WARNING against the recipe rather than prescribing it, keep the ` +
            `negation ("do NOT run", "never") on the SAME LINE as the command.\n\n` +
            offenders.map((o) => `  ${o.file}:${o.line}  ${o.text}`).join("\n"),
    ).toEqual([]);
  });
});
