import { defineConfig } from "vitest/config";
import { config as readDotenvFile } from "dotenv";
import path from "node:path";

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
// (`.env.local` beats `.env`): `.env` is where Prisma reads DATABASE_URL from
// and where .env.example documents it, while the README points contributors at
// `.env.local` for values they want to persist.
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
  const parsed = readDotenvFile({ path: file, processEnv: {} }).parsed;
  Object.assign(envFileValues, parsed ?? {});
}
const DATABASE_URL = process.env.DATABASE_URL ?? envFileValues.DATABASE_URL;

export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["./vitest.setup.ts"],
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    ...(DATABASE_URL ? { env: { DATABASE_URL } } : {}),
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
  },
});
