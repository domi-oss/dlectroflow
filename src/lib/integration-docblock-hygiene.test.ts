import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import {
  findEnvSourcingPrescriptions,
  prescribesEnvSourcing,
} from "@/lib/integration-docblock-hygiene";

/**
 * #256 — no `*.integration.test.ts` docblock may tell a reader to source `.env`
 * into the test process. The reasoning, the two control commands and the reason
 * this is line-scoped rather than a substring match are all in the module's
 * docblock.
 *
 * The synthetic cases come first, because a guard exercised only against the
 * real tree cannot be shown to FAIL — the house rule for every file-parsing
 * check here (see `client-server-boundary.test.ts`).
 *
 * This file is a `.test.ts`, not a `.integration.test.ts`, so the sweep below
 * cannot collect the fixtures on this page. It needs no database.
 */

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
  describe("prescribesEnvSourcing", () => {
    it("flags the recipe handed over as a command", () => {
      expect(
        prescribesEnvSourcing(" *   set -a; . ./.env; set +a; npm run test"),
      ).toBe(true);
      expect(
        prescribesEnvSourcing(" * Run: set -a; . ./.env; set +a; npm test"),
      ).toBe(true);
      // Whitespace and the `npm test` / `npm run test` split are both tolerated:
      // the defect is the export, not how the run is spelled after it.
      expect(prescribesEnvSourcing("set -a ; . ./.env ; set +a")).toBe(true);
    });

    it("does not flag a line warning against the recipe", () => {
      // The exact line the two already-corrected files carry. A substring check
      // would red the pipeline on both of them.
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
      expect(
        prescribesEnvSourcing(
          " * `set -a; . ./.env; set +a` is not needed and never was.",
        ),
      ).toBe(false);
    });

    it("ignores lines that do not mention the recipe", () => {
      expect(prescribesEnvSourcing(" * Needs the real Postgres.")).toBe(false);
      expect(prescribesEnvSourcing("  set -e")).toBe(false);
      // `set -a` without sourcing the env file exports nothing from it.
      expect(prescribesEnvSourcing(" *   set -a; npm run test")).toBe(false);
    });

    it("is not fooled by a negation about something else", () => {
      // Why the disavowal list is explicit phrases rather than a bare `\bnot\b`:
      // this line negates the *precondition*, not the command, and still hands
      // the command over.
      expect(
        prescribesEnvSourcing(
          " * If DATABASE_URL is not set: set -a; . ./.env; set +a; npm test",
        ),
      ).toBe(true);
    });

    it("requires the disavowal on the same line as the recipe", () => {
      // Recorded rather than left to be discovered: this is the one shape a
      // reader could reasonably write and still fail. The sweep's failure
      // message names the fix, so the red pipeline explains itself.
      expect(
        [
          " * Do not run the old recipe:",
          " *   set -a; . ./.env; set +a; npm run test",
        ].filter(prescribesEnvSourcing),
      ).toHaveLength(1);
    });

    it("accepts a whole docblock and reports the offending line numbers", () => {
      const source = [
        "/**",
        " * Needs the real Postgres.",
        " *   set -a; . ./.env; set +a; npm run test",
        " */",
      ].join("\n");
      expect(findEnvSourcingPrescriptions(source)).toEqual([
        { line: 3, text: "*   set -a; . ./.env; set +a; npm run test" },
      ]);
      expect(findEnvSourcingPrescriptions("/** Needs Postgres. */")).toEqual(
        [],
      );
    });
  });

  it("no integration-test docblock tells you to source .env", () => {
    const files = integrationTestFiles();
    // Guards against a silently-empty sweep: a zero here would otherwise read as
    // a pass while nothing had been looked at.
    expect(files.length).toBeGreaterThan(20);

    const offenders = files.flatMap((file) =>
      findEnvSourcingPrescriptions(
        readFileSync(new URL(file, REPO_ROOT), "utf8"),
      ).map((site) => ({ file, ...site })),
    );

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
