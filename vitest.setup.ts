// Extends `expect` with @testing-library/jest-dom matchers (toBeInTheDocument,
// toHaveAttribute, etc). Safe to load for node-environment tests too — the
// matchers only touch the DOM when actually called from a jsdom test file.
// Component tests opt into the DOM via a `// @vitest-environment jsdom`
// docblock at the top of the file; the global default stays "node".
import "@testing-library/jest-dom/vitest";
import { expect } from "vitest";
import path from "node:path";

// Deterministic key so token-cipher tests have a valid TOKEN_ENC_KEY.
// (32 bytes of 0x00 as 64 hex chars.) Individual tests may override/delete it.
process.env.TOKEN_ENC_KEY ??= "0".repeat(64);

// #84 — one actionable message when a *.integration.test.ts has no database,
// instead of failing deep inside Prisma.
//
// Before this guard, `npm test` on a checkout with no DATABASE_URL produced 46
// PrismaClientInitializationError stack traces AND reported 43 further tests as
// "skipped" — a Prisma error thrown from a `beforeAll` hook marks that file's
// tests skipped, so more than half the damage read as intentional and hid the
// one-line cause. Naming the missing variable once, per affected file, is the
// whole fix.
//
// Scoped to the *.integration.test.ts convention on purpose:
//   - a unit-only run (`npx vitest run src/lib/spark.test.ts`) stays runnable on
//     a bare checkout, so this never demands infrastructure a test doesn't use;
//   - it throws rather than skipping, so a suite can never quietly run less than
//     it claims. The file is reported as FAILED, which is the honest outcome.
// vitest.config.ts already sources DATABASE_URL from `.env`, so reaching this
// means no database is configured at all.
const testPath = expect.getState().testPath ?? "";
if (/\.integration\.test\.tsx?$/.test(testPath) && !process.env.DATABASE_URL) {
  throw new Error(
    `${path.basename(testPath)} is an integration test: it runs against a real Postgres, but DATABASE_URL is not set.\n\n` +
      `Fix (once):\n` +
      `  1. cp .env.example .env   # as-is — DATABASE_URL is pre-filled; .env must exist before step 2\n` +
      `  2. npm run setup          # starts Postgres in Docker, installs deps, applies migrations\n\n` +
      `Already have a database? Put DATABASE_URL in \`.env\` (or \`.env.local\`, or export it) and re-run.\n` +
      `See CONTRIBUTING.md → "Getting set up". Unit tests need none of this and run on a bare checkout.`,
  );
}
