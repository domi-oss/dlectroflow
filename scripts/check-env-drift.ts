/**
 * CI env-drift gate (#30).
 *
 * Fails the pipeline when process.env usage under src/ and the keys
 * documented in .env.example fall out of sync in either direction:
 *   - a var read in src/ but never documented in .env.example, or
 *   - a var documented in .env.example but never read in src/.
 *
 * Intentional exceptions (framework internals, deploy-only injected vars,
 * forward-looking seams) live in the ENV_DRIFT_ALLOWLIST in
 * src/lib/env-drift.ts, with a comment explaining each one.
 *
 * Run locally: npm run check:env
 * Wired into the test_app CI job — see .gitlab-ci.yml.
 *
 * This file is intentionally thin Node-specific glue (walk src/, read
 * .env.example, print, set the exit code); the actual diff logic is the
 * pure, unit-tested computeEnvDrift/extractUsedEnvKeys/
 * extractDocumentedEnvKeys functions in src/lib/env-drift.ts.
 */
import { readFileSync, readdirSync } from "node:fs";
import { extname, join } from "node:path";
import {
  computeEnvDrift,
  extractDocumentedEnvKeys,
  extractUsedEnvKeys,
} from "../src/lib/env-drift";

const ROOT = new URL("..", import.meta.url).pathname;
const SRC_DIR = join(ROOT, "src");
const ENV_EXAMPLE_PATH = join(ROOT, ".env.example");
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx"]);
// *.test.ts(x) are excluded: what needs documenting in .env.example is what
// the SHIPPED app reads. Test files often embed process.env.<KEY>-shaped
// text as literal fixtures/mocks (not real reads), which would otherwise
// register as false "used" keys — this repo's own env-drift.test.ts is an
// example. In practice every real key is also read by the non-test module
// it's testing, so this loses no genuine drift signal.
const TEST_FILE_RE = /\.test\.tsx?$/;

function listSourceFiles(dir: string): string[] {
  // `recursive: true` (Node 18.17+; the engine requires >=20.19) walks
  // subdirectories via the OS instead of manual recursion, which also avoids
  // the `entry.isDirectory()`-is-false-for-symlinked-dirs blind spot.
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        SOURCE_EXTENSIONS.has(extname(entry.name)) &&
        !TEST_FILE_RE.test(entry.name),
    )
    .map((entry) => join(entry.parentPath ?? entry.path, entry.name));
}

function main(): void {
  const usedKeys = new Set<string>();
  for (const file of listSourceFiles(SRC_DIR)) {
    const contents = readFileSync(file, "utf8");
    for (const key of extractUsedEnvKeys(contents)) usedKeys.add(key);
  }

  let envExampleContents: string;
  try {
    envExampleContents = readFileSync(ENV_EXAMPLE_PATH, "utf8");
  } catch {
    console.error(
      `env-drift check FAILED — could not read ${ENV_EXAMPLE_PATH}`,
    );
    console.error("Make sure .env.example exists at the project root.");
    process.exitCode = 1;
    return;
  }
  const documentedKeys = extractDocumentedEnvKeys(envExampleContents);
  const { missingFromExample, unusedInExample } = computeEnvDrift(
    usedKeys,
    documentedKeys,
  );

  if (missingFromExample.length === 0 && unusedInExample.length === 0) {
    console.log(
      `env-drift check passed: ${usedKeys.size} key(s) read in src/, ${documentedKeys.length} documented in .env.example — no drift.`,
    );
    return;
  }

  console.error(
    "env-drift check FAILED — .env.example is out of sync with src/:\n",
  );
  if (missingFromExample.length > 0) {
    console.error("  Read in src/ but missing from .env.example:");
    for (const key of missingFromExample) console.error(`    - ${key}`);
    console.error("");
  }
  if (unusedInExample.length > 0) {
    console.error("  Documented in .env.example but never read in src/:");
    for (const key of unusedInExample) console.error(`    - ${key}`);
    console.error("");
  }
  console.error(
    "Fix by documenting the missing key(s) in .env.example, removing the stale one(s), " +
      "or — if intentional — adding the key to ENV_DRIFT_ALLOWLIST in src/lib/env-drift.ts " +
      "with a comment explaining why it's exempt.",
  );
  process.exitCode = 1;
}

main();
