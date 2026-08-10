import { defineConfig } from "vitest/config";
import { config as readDotenvFile } from "dotenv";
import path from "node:path";

// #133 — this file lives in `config/`, not the repo root, so every path below
// is resolved from `REPO_ROOT` rather than being written relative to the
// config or left to `process.cwd()`.
//
// Two different resolution bases used to coincide at the root and no longer do:
// Vitest resolves `root`, `setupFiles` and `include` against THIS FILE's
// directory, while `dotenv` resolves against `process.cwd()`. Pinning both to
// the repo root is what keeps `npm test` (cwd = root) and an editor extension
// or a `vitest --config config/vitest.config.ts` run from a subdirectory
// (cwd = anywhere) behaving identically. A test suite whose file list silently
// depends on the directory it was launched from is the failure this avoids.
const REPO_ROOT = path.resolve(__dirname, "..");

// #84 — make `npm test` work on a by-the-book local setup.
//
// The *.integration.test.ts files need a real Postgres, and `npm run setup`
// leaves the connection string in `.env` (Prisma's own convention — see
// prisma.config.ts, which loads it via `dotenv/config`). Nothing, however, put
// it on `process.env` for a *test* run: Vite keeps `.env` values on
// `import.meta.env`, and Prisma Client — unlike the Prisma CLI — never reads
// `.env` itself. So a contributor who followed the README exactly still got a
// wall of Prisma errors from `npm test` until they exported DATABASE_URL by
// hand, which is documented nowhere.
//
// Both local conventions are honoured, in Next.js's own precedence order
// (`.env.local` beats `.env`): `.env` is where Prisma reads DATABASE_URL from,
// and since #91 it is also the file `.env.example` and the README tell you to
// create (`cp .env.example .env`), while `.env.local` stays the Next-only
// override a contributor may keep runtime values in — see README → "Which
// file: .env vs .env.local".
//
// A real env file in this repo also holds API keys and the token-encryption
// key, so this deliberately forwards ONLY DATABASE_URL, and parses into a
// throwaway object (`processEnv: {}`) instead of mutating process.env — no test
// can reach a secret it wasn't already given. A real environment variable still
// wins, which is how CI supplies its own database (see test_app in
// .gitlab-ci.yml, where no env file exists).
const envFileValues: Record<string, string | undefined> = {};
for (const file of [".env", ".env.local"]) {
  // `processEnv: {}` is dotenv's opt-out from mutating the real process.env:
  // values land in this throwaway object, and we pick out only DATABASE_URL.
  // Absolute (#133): dotenv resolves a relative path against `process.cwd()`,
  // which is the repo root under `npm test` but need not be under any other
  // caller — and a missed env file here does not error, it just silently drops
  // DATABASE_URL and turns every integration test into a Prisma failure.
  const parsed = readDotenvFile({
    path: path.join(REPO_ROOT, file),
    processEnv: {},
  }).parsed;
  Object.assign(envFileValues, parsed ?? {});
}
const DATABASE_URL = process.env.DATABASE_URL ?? envFileValues.DATABASE_URL;

export default defineConfig({
  // The repo root, not `config/` (#133). Vitest derives `root` from the config
  // file's directory, and `include` below is resolved against it — left
  // unset, the globs would be looking for `config/src/**` and the suite would
  // collect zero test files while still exiting 0.
  root: REPO_ROOT,
  test: {
    environment: "node",
    setupFiles: [path.join(__dirname, "vitest.setup.ts")],
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    // #191 — Vitest's 5000 ms default is a WALL-CLOCK budget, and nine test
    // files in `src/lib/` drive a real `scripts/*.sh` through a blocking
    // `spawnSync`, several of them with `curl` and `kubectl` stubbed on PATH
    // (the `pipeline-failure-alert` / `registry-prune` / `prod-state-alert`
    // idiom). Those tests spend their time waiting on child processes that
    // compete for the same cores as every other worker, so their wall clock
    // stretches with suite-wide load while the code under test is unchanged.
    //
    // MEASURED, same tree, one file: the heaviest case in
    // `prod-state-alert.test.ts` spawns four subprocesses and takes ~1.0 s run
    // on its own — and 7.1 s inside a full 298-file run, where it blew the
    // default and failed. Three other full runs of that same tree were green,
    // which is the signature of a budget being crossed rather than a bug.
    //
    // 30 s is chosen to be far above the loaded worst case and far below
    // anything a genuinely hung test would reach; it only costs time on a
    // failure. Raising it is not papering over a slow test — a red pipeline
    // caused by CPU contention says nothing about the code, and teaches people
    // to re-run rather than read the failure.
    testTimeout: 30_000,
    ...(DATABASE_URL ? { env: { DATABASE_URL } } : {}),
  },
  resolve: {
    alias: { "@": path.join(REPO_ROOT, "src") },
  },
});
