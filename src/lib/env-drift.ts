/**
 * CI env-drift gate (#30): pure detection logic for keeping `.env.example`
 * and actual `process.env` usage under src/ in sync in BOTH directions —
 * a var read in code but undocumented, or documented but never read (dead
 * doc / stale key). The Node-specific glue (walking src/, reading files,
 * exit code) lives in scripts/check-env-drift.ts; this module stays pure so
 * it's trivially unit-testable (see env-drift.test.ts).
 */

/**
 * Keys the drift check intentionally ignores in BOTH directions. Extend this
 * deliberately — every entry must say why it's exempt, either because it's a
 * framework/runtime internal never meant to live in `.env.example`, or a
 * deploy-only internal injected exclusively by CI/Helm.
 */
export const ENV_DRIFT_ALLOWLIST: readonly string[] = [
  // Documented (required!) in .env.example, but read directly by Prisma via
  // `env("DATABASE_URL")` in prisma/schema.prisma — never through
  // `process.env` in src/, so the scan can never see it as "used".
  "DATABASE_URL",
  // Node.js runtime — set by the process manager, never user-configured.
  "NODE_ENV",
  // Next.js build-phase internal, set by `next build`/`next dev` themselves
  // (see src/instrumentation.ts's phase guard) — never put in .env.local.
  "NEXT_PHASE",
  // Review-app-only demo workspace pin. Injected exclusively by the Helm
  // review deploy (charts/dlectroflow/templates/deployment.yaml); unset (and
  // meaningless) in production and never set by a developer locally — see
  // prisma/seed.ts and src/proxy.ts for the full explanation.
  "REVIEW_DEMO_WS",
  // Documented in .env.example as a forward-looking BYO-LLM provider seam
  // ("only anthropic is implemented today") — intentionally unread in src/
  // until a second provider lands (see docs/superpowers/specs/
  // 2026-07-06-workspace-access-design.md).
  "LLM_PROVIDER",
];

export interface EnvDriftResult {
  /** Keys read via process.env in src/ but never documented in .env.example. */
  missingFromExample: string[];
  /** Keys documented in .env.example but never read in src/. */
  unusedInExample: string[];
}

/**
 * Diffs the keys actually read in code against the keys documented in
 * `.env.example`, excluding anything in `allowlist` from either direction.
 * Both output arrays are sorted for a stable, readable diff.
 */
export function computeEnvDrift(
  usedKeys: Iterable<string>,
  documentedKeys: Iterable<string>,
  allowlist: Iterable<string> = ENV_DRIFT_ALLOWLIST,
): EnvDriftResult {
  const used = new Set(usedKeys);
  const documented = new Set(documentedKeys);
  const allowed = new Set(allowlist);

  const missingFromExample = [...used]
    .filter((key) => !documented.has(key) && !allowed.has(key))
    .sort();
  const unusedInExample = [...documented]
    .filter((key) => !used.has(key) && !allowed.has(key))
    .sort();

  return { missingFromExample, unusedInExample };
}

// Matches dot-notation (process.env.<KEY>) and bracket-notation
// (process.env["<KEY>"] / process.env['<KEY>']) reads. Deliberately a plain
// regex scan over raw source text (not an AST parse) — simple, dependency-
// free, and matches how the acceptance criteria describes the check
// ("greps/parses process.env usage").
const USED_ENV_KEY_RE =
  /process\.env(?:\.([A-Za-z_][A-Za-z0-9_]*)|\[["']([A-Za-z_][A-Za-z0-9_]*)["']\])/g;

// Also catches destructured reads — `const { FOO, BAR: alias, QUX = "d" } =
// process.env` — which the dot/bracket regex above misses. Without this a key
// read only via destructuring is invisible: a false negative (an undocumented
// read slips through) and, if the key IS in .env.example, a false positive
// ("unused") that fails the pipeline. We grab the `{…}` binding list, then take
// each comma-separated binding's *source* name (the identifier before any `:`
// alias or `=` default). Rest/nested patterns aren't used for env reads.
const DESTRUCTURED_ENV_RE = /\{([^{}]*)\}\s*=\s*process\.env\b/g;
const BINDING_HEAD_RE = /^([A-Za-z_][A-Za-z0-9_]*)/;

/** Extracts the deduped set of env keys read via `process.env` in `source`. */
export function extractUsedEnvKeys(source: string): string[] {
  const keys = new Set<string>();
  for (const match of source.matchAll(USED_ENV_KEY_RE)) {
    const key = match[1] ?? match[2];
    if (key) keys.add(key);
  }
  for (const match of source.matchAll(DESTRUCTURED_ENV_RE)) {
    for (const segment of match[1].split(",")) {
      const name = segment.trim().match(BINDING_HEAD_RE);
      if (name) keys.add(name[1]);
    }
  }
  return [...keys];
}

// Matches a `KEY=` assignment line in .env.example, whether active or
// commented-out — .env.example's own convention documents optional vars as
// `# GOOGLE_CLIENT_ID=` — but not plain prose comments (which never look like
// `ALLCAPS_WORD=`  right after the optional `#`).
const DOCUMENTED_ENV_KEY_RE = /^#?\s*([A-Z_][A-Z0-9_]*)=/;

/** Extracts the deduped set of env keys declared in `.env.example`'s contents. */
export function extractDocumentedEnvKeys(envExample: string): string[] {
  const keys = new Set<string>();
  for (const line of envExample.split("\n")) {
    const match = line.match(DOCUMENTED_ENV_KEY_RE);
    if (match) keys.add(match[1]);
  }
  return [...keys];
}
