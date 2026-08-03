/**
 * CI env-drift gate (#30): pure detection logic for keeping `.env.example`
 * and actual `process.env` usage under src/ in sync in BOTH directions —
 * a var read in code but undocumented, or documented but never read (dead
 * doc / stale key). The Node-specific glue (walking src/, reading files,
 * exit code) lives in scripts/check-env-drift.ts; this module stays pure so
 * it's trivially unit-testable (see env-drift.test.ts).
 *
 * #135 added a SECOND surface pair to the same family, sharing the same
 * detection shape and the same "declared exemption or it's a bug" rule:
 * `.env.prod.example` (Instance B, the Docker Compose self-host path) against
 * the Helm chart's app-facing manifests (Instance A, Kubernetes). See
 * `computeConfigSurfaceDrift` below. The real-file assertions for that pair
 * live in env-drift.test.ts rather than scripts/check-env-drift.ts, matching
 * the other repo-invariant guards (dockerfile-hygiene, manifest-hygiene).
 */

import { stripComments } from "./source-text";

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
  // #135 — baked into the image at BUILD time by the `ARG BUILD_SHA` /
  // `ENV BUILD_SHA=$BUILD_SHA` pair in docker/Dockerfile and
  // docker/Dockerfile.ci, so /api/health can report which commit a container
  // is running. Never operator configuration: putting it in .env.example would
  // invite someone to set it by hand and misreport their own build. See
  // src/lib/build-info.ts.
  "BUILD_SHA",
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
// regex scan (not an AST parse) — simple, dependency-free, and matches how the
// acceptance criteria describes the check ("greps/parses process.env usage").
// It runs over COMMENT-STRIPPED source, not raw text; see extractUsedEnvKeys.
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

/**
 * Extracts the deduped set of env keys read via `process.env` in `source`.
 *
 * Comments come out FIRST (#150). Both patterns above scan text, so prose that
 * *describes* an env read is indistinguishable from code that *performs* one —
 * and the modules most likely to contain such prose are the hygiene modules,
 * whose subject matter is precisely `process.env` handling. !227 (#146) failed
 * this gate twice on a new module's doc comments, reporting `PATH` and an
 * example binding called `A` as undocumented reads. Neither is a variable this
 * app has ever read, and the fix at the time was to reword the documentation:
 * a scanner limitation deciding what a comment is allowed to say.
 *
 * Stripping also repairs a false NEGATIVE the raw-text scan had: a trailing
 * comment on one line of a multi-line destructuring hid the binding on the
 * next, because the comment text ran into the following comma-separated
 * segment. That direction is the more dangerous one — an undocumented read
 * silently passing the gate.
 */
export function extractUsedEnvKeys(source: string): string[] {
  const code = stripComments(source);
  const keys = new Set<string>();
  for (const match of code.matchAll(USED_ENV_KEY_RE)) {
    const key = match[1] ?? match[2];
    if (key) keys.add(key);
  }
  for (const match of code.matchAll(DESTRUCTURED_ENV_RE)) {
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

// ─── #135: Instance A (Helm) vs Instance B (Docker Compose) ──────────────────

/**
 * The operator-facing config surface of Instance B: the file a self-hoster
 * copies to `.env.prod` and fills in, per docs/self-host-vps.md.
 *
 * Read with `extractDocumentedEnvKeys`, so a commented-out `# KEY=` counts as
 * declared — that is this file family's convention for an OPTIONAL var, and the
 * distinction that matters here is "is this key offered at all", not "is it on
 * by default".
 */
export const ENV_PROD_EXAMPLE_FILE = ".env.prod.example";

/**
 * The operator-facing config surface of Instance A: the chart templates that
 * actually put environment into the APP process.
 *
 * Deliberately just these two. `backup.yaml` and `purge-cronjob.yaml` also
 * carry env (PGPASSWORD, PGSSLMODE, GCS bucket wiring), but that is the
 * cluster's own plumbing for jobs the Compose stack runs from the host's
 * crontab — it is not a knob an operator turns to change how the app behaves,
 * and folding it in would mean allowlisting a pile of keys that were never
 * comparable in the first place. `postgres.yaml` is the same story on the
 * database side.
 *
 * ── The constraint on adding a file here (Duo review on !230) ───────────────
 * The extractor tells env keys from YAML structure by CASE: ALL_CAPS is a key,
 * lowercase is Kubernetes. That is a convention these two manifests happen to
 * hold to, not a rule YAML enforces — so a file containing an all-caps
 * *structural* key (`NODE_PORT: 3000` in a Service, say) would have it counted as
 * an env variable and reported as drift that does not exist.
 *
 * `assertManifestKeysLookLikeEnv` below is the guard, and the test calls it on
 * every file in this list. It is not a comment asking for care: adding a
 * violating file fails the suite by name.
 */
export const CHART_CONFIG_SURFACE_FILES: readonly string[] = [
  "charts/dlectroflow/templates/secret.yaml",
  "charts/dlectroflow/templates/deployment.yaml",
];

/** Which of the two surfaces a deliberate single-surface key belongs to. */
export type ConfigSurface = "chart" | "compose";

/**
 * One written decision that a key is offered on ONE platform only.
 *
 * The exemption is DIRECTIONAL: `declaredOn: "chart"` excuses the key from
 * needing a `.env.prod.example` entry and nothing else. Without that, a single
 * entry would blind both halves of the check.
 */
export interface ConfigSurfaceException {
  key: string;
  /** The surface that legitimately declares this key alone. */
  declaredOn: ConfigSurface;
  /** Why the two platforms cannot share it. Not optional, by design. */
  reason: string;
}

/**
 * Divergences between the two instances' config surfaces that are deliberate.
 *
 * This list is the difference between "different on purpose" and "somebody
 * forgot". #135 was the second: GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET reached
 * production through the chart while the documented self-host path never
 * mentioned them, so a self-hoster got an app whose headline capability — the
 * Google Tasks connect flow — could not succeed, with nothing to explain why.
 *
 * Adding an entry is a decision, so write the reason for a reader who does not
 * already know the two deploy models.
 */
export const CONFIG_SURFACE_ALLOWLIST: readonly ConfigSurfaceException[] = [
  // B2_KEY_ID and B2_APP_KEY were here until #162, exempted because the Compose
  // `backup` service had no off-host upload and so no use for a B2 credential.
  // #162 gave it one (`backup-upload` in docker/docker-compose.prod.yml), which
  // made both entries stale in the sense staleAllowlistEntries means: the key is
  // now on BOTH surfaces. They were deleted in the same commit that added the
  // vars to .env.prod.example, because either half alone fails this check.
  {
    key: "B2_BUCKET",
    declaredOn: "compose",
    reason:
      "Which bucket the Compose `backup-upload` service writes to. The chart " +
      "expresses the same choice as the Helm value `backup.b2.bucket`, read at " +
      "render time by templates/backup.yaml to build the destination URI — a " +
      "chart value, never a container env var, the same shape as " +
      "DLECTROFLOW_IMAGE below. The credentials for it (B2_KEY_ID, " +
      "B2_APP_KEY) are on both surfaces and so are not exempt.",
  },
  {
    key: "B2_PREFIX",
    declaredOn: "compose",
    reason:
      "Pair of B2_BUCKET: the path within the bucket, defaulting to `pg` to " +
      "match the chart's layout so both instances' dumps land side by side. " +
      "The chart's equivalent is the Helm value `backup.b2.prefix`. Worth " +
      "keeping settable rather than hardcoded because the host's application " +
      "key should be scoped to exactly this prefix, and an operator using a " +
      "shared bucket needs the two to agree.",
  },
  {
    key: "DLECTROFLOW_DOMAIN",
    declaredOn: "compose",
    reason:
      "The hostname Caddy obtains its own Let's Encrypt certificate for, so it " +
      "is consumed by docker/Caddyfile, not by the app process. Instance A's " +
      "equivalent is the chart's `.Values.host`, read by ingress.yaml and " +
      "cert-manager; the app there learns its origin from PUBLIC_ORIGIN, which " +
      "both surfaces do declare.",
  },
  {
    key: "DLECTROFLOW_IMAGE",
    declaredOn: "compose",
    reason:
      "Which image the Compose stack runs, defaulting to the locally built " +
      "dlectroflow:local. The chart expresses the same choice as " +
      "`image.repository` + `image.tag`, which CI sets to $CI_COMMIT_SHA — a " +
      "Helm value, never a container env var.",
  },
  {
    key: "POSTGRES_USER",
    declaredOn: "compose",
    reason:
      "Read by the `db` service's postgres image to CREATE the role, and " +
      "interpolated into the DATABASE_URL that docker-compose.prod.yml derives. " +
      "The chart hardcodes the role `dlectroflow` in postgres.yaml and in the " +
      "`dlectroflow.databaseUrl` helper, so there is nothing for an operator to " +
      "set — the cluster's Postgres is not shared with anything else.",
  },
  {
    key: "POSTGRES_DB",
    declaredOn: "compose",
    reason:
      "Same as POSTGRES_USER: it names the database the postgres image creates " +
      "on first boot, and the chart fixes it to `dlectroflow` in postgres.yaml " +
      "and the `dlectroflow.databaseUrl` helper.",
  },
  {
    key: "DATABASE_URL",
    declaredOn: "chart",
    reason:
      "Deliberately absent from .env.prod.example (see that file's header): " +
      "docker-compose.prod.yml composes it from the POSTGRES_* values in the " +
      "app service's `environment:`, which overrides env_file, so the app's " +
      "connection string and the database's own credentials cannot drift apart. " +
      "The chart composes it the same way in the `dlectroflow.databaseUrl` " +
      "helper, adding sslmode=require for the in-cluster TLS the Compose " +
      "stack's private network does not need.",
  },
  {
    key: "APP_ENV",
    declaredOn: "chart",
    reason:
      "Review apps only. It is the positive signal prisma/seed.ts's " +
      "assertReviewEnv guard checks before it will seed demo data, and it is " +
      "rendered only when the chart's env=review. Compose has no review-app " +
      "concept, and a self-hoster must never be able to set it.",
  },
  {
    key: "SEED_REVIEW_APP",
    declaredOn: "chart",
    reason:
      "Review apps only, alongside APP_ENV: the second half of the two-signal " +
      "guard that lets the review-only `seed` initContainer run (#25). Never " +
      "rendered for production, and meaningless on the Compose stack.",
  },
  {
    key: "REVIEW_DEMO_WS",
    declaredOn: "chart",
    reason:
      "Review apps only (#25): the id of the shared, pre-seeded demo workspace " +
      "src/proxy.ts seats every guest into so reviewers land on populated " +
      "content. Unset in production and on the Compose stack, where each guest " +
      "keeps getting an isolated workspace. Also in ENV_DRIFT_ALLOWLIST above.",
  },
];

/**
 * Capability differences between the two platforms that are NOT env keys, so
 * CONFIG_SURFACE_ALLOWLIST cannot hold them. #135 asked for these to be written
 * down rather than merely absent, because "the Compose stack has no rate
 * limiter" is a security posture worth stating out loud, and every one of them
 * has previously been mistaken for an oversight.
 *
 * Documentation-as-code: nothing branches on it. env-drift.test.ts only asserts
 * each entry actually says something, so it cannot rot into empty strings.
 */
export interface PlatformDivergence {
  /** What the difference is about. */
  area: string;
  /** What Instance A (Helm on Kubernetes) does. */
  chart: string;
  /** What Instance B (Docker Compose) does. */
  compose: string;
  /** Why the two cannot be made the same. */
  reason: string;
}

export const PLATFORM_DIVERGENCES: readonly PlatformDivergence[] = [
  {
    area: "Per-IP rate limiting",
    chart:
      "ingress.yaml sets nginx.ingress.kubernetes.io/limit-rps: 20 and " +
      "limit-connections: 20.",
    compose:
      "None. docker/Caddyfile says so explicitly at the point where the limit " +
      "would go.",
    reason:
      "Caddy's rate limiter is a third-party plugin, so shipping it would mean " +
      "building a custom Caddy image and pinning a plugin the project does not " +
      "maintain — for a single-host stack whose realistic answer is " +
      "caddy-ratelimit or a free CDN tier in front. Named in docker/Caddyfile " +
      "so an operator learns it from the file they are editing.",
  },
  {
    area: "Postgres TLS on the wire",
    chart:
      "postgres.yaml runs the server with ssl=on from a cert-manager-issued " +
      "keypair (postgres-tls.yaml); clients connect with sslmode=require.",
    compose:
      "Cleartext. The db service publishes no ports and is reachable only on " +
      "the internal Compose network.",
    reason:
      "In the cluster the app and the database can sit on different nodes, so " +
      "the hop is real network. On one host it is a container-to-container " +
      "bridge with nothing else on it, and requiring TLS there would mean " +
      "generating and rotating a self-signed keypair for a link that never " +
      "leaves the box.",
  },
  {
    area: "Container hardening",
    chart:
      "readOnlyRootFilesystem, runAsNonRoot + runAsUser 1000, seccompProfile " +
      "RuntimeDefault, capabilities drop ALL, and an optional NetworkPolicy " +
      "fencing Postgres :5432 to the app pods.",
    compose:
      "The image's own USER node (uid 1000) and Docker's default seccomp " +
      "profile.",
    reason:
      "These are pod-spec fields with no single-file Compose equivalent that " +
      "behaves the same way, and the writable-path work the read-only root " +
      "filesystem needs (emptyDir mounts for /tmp and /app/.next/cache) has no " +
      "counterpart a self-hoster could be expected to get right. The image " +
      "still never runs as root on either platform.",
  },
  {
    area: "Availability: replicas and PodDisruptionBudget",
    chart:
      "replicas: 2 in production, a soft topology spread across nodes, and a " +
      "PDB covering voluntary evictions.",
    compose: "One app container, restart: unless-stopped.",
    reason:
      "Both are properties of a scheduler that can move workloads between " +
      "nodes. A single-host stack has nowhere to move to, so there is no " +
      "meaningful HA to express — which is the honest trade-off of the ~$6/mo " +
      "VPS deployment docs/running-costs.md recommends.",
  },
  {
    area: "Scheduled jobs as a health signal",
    chart:
      "backup.yaml and purge-cronjob.yaml are CronJobs, so last-run status and " +
      "failures are queryable objects in the cluster.",
    compose:
      "The `backup`, `backup-upload` and `purge` services sit behind a Compose " +
      "profile and are invoked by the host's crontab (docs/self-host-vps.md).",
    reason:
      "Compose has no scheduler and therefore no status object to read. The " +
      "operator's signal is cron's own mail/exit code plus what is actually in " +
      "the bucket, which is why every backup command uses `set -euo pipefail` " +
      "— without it a failed pg_dump leaves a truncated file looking like a " +
      "successful backup (measured: exit 0 and a 20-byte .sql.gz).",
  },
  {
    area: "Backup destinations and credential posture",
    chart:
      "backup.yaml dual-writes: GCS with keyless auth via Workload Identity, " +
      "plus an optional B2 copy. Losing or revoking the B2 key still leaves a " +
      "good backup, which is what makes a long-lived key acceptable there.",
    compose:
      "One off-host destination, B2, via the `backup-upload` service (#162), " +
      "alongside the host's own retained copy in backups/.",
    reason:
      "Workload Identity is a GKE mechanism with no single-host equivalent, so " +
      "the Compose path cannot have the keyless destination and there is " +
      "nothing to dual-write against. The compensation is the key's scope " +
      "rather than a second bucket: the host's application key is limited to " +
      "one bucket, one prefix and writeFiles only, so a compromised host can " +
      "neither read existing backups out nor delete them. The read-capable key " +
      "stays on the operator's workstation, which is where listing, verifying " +
      "and restore drills happen.",
  },
];

/**
 * Matches an env key DECLARED in a Kubernetes/Helm manifest, in the two forms
 * this chart uses:
 *
 *   - a Secret `stringData:` entry — `  ANTHROPIC_API_KEY: {{ … }}`
 *   - a container env entry        — `    - name: PUBLIC_ORIGIN`
 *
 * Both patterns require an ALL-CAPS name, which is what keeps YAML structure
 * (`stringData:`, `metadata:`) and lower-case object names (`- name: app`,
 * `- name: tmp`) out of the result set without a keyword blocklist.
 *
 * A `secretKeyRef`'s `key: DATABASE_URL` is deliberately NOT matched: it is a
 * *reference* to a key declared in secret.yaml, not a second declaration, and
 * counting it would inflate the chart's apparent surface with keys the app is
 * merely being handed. The `- name:` form covers those anyway, since a
 * secretKeyRef always sits under one.
 */
// The invariant both of these lean on, stated because it is a convention rather
// than a YAML rule (Duo review on !230): in these manifests an ALL_CAPS key is an
// env variable and a lowercase one is Kubernetes structure. That is what lets the
// first regex match a `stringData:` entry without also matching `metadata:` or
// `spec:`. It would match an all-caps structural key — `NODE_PORT: 3000` in a
// Service, say — so a new file added to CHART_CONFIG_SURFACE_FILES has to hold to
// the same convention.
const MANIFEST_STRING_DATA_KEY_RE = /^\s*([A-Z_][A-Z0-9_]*):/;
// The trailing `(#.*)?` is not decoration: anchoring straight to `$` meant an
// inline comment — `- name: PUBLIC_ORIGIN # injected by the review deploy` —
// silently failed to count the key, and this check reports uncounted keys as
// DRIFT. So a passing comment on a manifest line would have manufactured a gap
// that does not exist, and the fix for the phantom gap would have been to edit
// the config surface. Fails loud, not quietly wrong.
const MANIFEST_ENV_NAME_RE = /^\s*-\s*name:\s*([A-Z_][A-Z0-9_]*)\s*(#.*)?$/;

/**
 * Kubernetes structural keys that are ALL_CAPS and would therefore be mistaken
 * for env variables. Not exhaustive by construction — it cannot be — which is
 * why the guard below reports anything suspicious rather than only these.
 */
const KNOWN_STRUCTURAL_ALLCAPS = new Set([
  "TCP",
  "UDP",
  "SCTP",
  "HTTP",
  "HTTPS",
]);

/**
 * Throws if a manifest's extracted keys include something that is plainly
 * Kubernetes structure rather than an env variable.
 *
 * The extractor separates the two by CASE (see CHART_CONFIG_SURFACE_FILES), and
 * that convention is unenforceable in YAML itself. This makes adding a violating
 * file to the compared surface fail loudly, by name, instead of quietly
 * inventing drift — which is the failure the case-convention comment warned
 * about but did nothing to prevent (Duo review on !230).
 */
export function assertManifestKeysLookLikeEnv(
  file: string,
  keys: readonly string[],
): void {
  const suspicious = keys.filter((key) => KNOWN_STRUCTURAL_ALLCAPS.has(key));
  if (suspicious.length > 0) {
    throw new Error(
      `${file} declares ${suspicious.join(", ")}, which read as Kubernetes ` +
        `structure rather than environment variables. The config-surface ` +
        `extractor tells the two apart by case, so this file would produce ` +
        `phantom drift. Either drop it from CHART_CONFIG_SURFACE_FILES or ` +
        `teach the extractor the shape it actually needs.`,
    );
  }
}

/**
 * The sorted, deduped set of env keys a chart manifest declares. Sorted so a
 * failure message reads the same way twice.
 */
export function extractManifestEnvKeys(manifest: string): string[] {
  const keys = new Set<string>();
  for (const line of manifest.split("\n")) {
    const match =
      line.match(MANIFEST_STRING_DATA_KEY_RE) ??
      line.match(MANIFEST_ENV_NAME_RE);
    if (match) keys.add(match[1]);
  }
  return [...keys].sort();
}

export interface ConfigSurfaceDriftResult {
  /**
   * Keys an operator can set on the Compose self-host path that have no chart
   * equivalent — the Kubernetes instance cannot tune them without a chart edit.
   */
  missingFromChart: string[];
  /**
   * Keys the chart configures that `.env.prod.example` never mentions — a
   * self-hoster gets an app where that feature cannot work, and no signal why.
   */
  missingFromEnvProdExample: string[];
  /**
   * Allowlist entries that no longer describe reality: the key is now on both
   * surfaces (the divergence was closed) or on neither (the key is gone). Both
   * mean the written exemption is stale and should be deleted, which is what
   * stops the allowlist decaying back into a list of omissions.
   */
  staleAllowlistEntries: string[];
}

/**
 * Diffs the two instances' operator-facing config surfaces, in both directions,
 * excluding the deliberate single-surface keys in `allowlist`. All three output
 * arrays are sorted for a stable, readable diff.
 */
export function computeConfigSurfaceDrift(
  envProdExampleKeys: Iterable<string>,
  chartKeys: Iterable<string>,
  allowlist: readonly ConfigSurfaceException[] = CONFIG_SURFACE_ALLOWLIST,
): ConfigSurfaceDriftResult {
  const compose = new Set(envProdExampleKeys);
  const chart = new Set(chartKeys);

  // Directional: a "compose" exemption only excuses the chart from declaring
  // the key, and vice versa.
  const composeOnly = new Set(
    allowlist.filter((e) => e.declaredOn === "compose").map((e) => e.key),
  );
  const chartOnly = new Set(
    allowlist.filter((e) => e.declaredOn === "chart").map((e) => e.key),
  );

  const missingFromChart = [...compose]
    .filter((key) => !chart.has(key) && !composeOnly.has(key))
    .sort();
  const missingFromEnvProdExample = [...chart]
    .filter((key) => !compose.has(key) && !chartOnly.has(key))
    .sort();

  const staleAllowlistEntries = allowlist
    .filter(({ key, declaredOn }) => {
      const declaring = declaredOn === "compose" ? compose : chart;
      const other = declaredOn === "compose" ? chart : compose;
      // Stale either way round: the key vanished from the surface the exemption
      // is written about, or it turned up on the surface it was excused from.
      return !declaring.has(key) || other.has(key);
    })
    .map((entry) => entry.key)
    .sort();

  return { missingFromChart, missingFromEnvProdExample, staleAllowlistEntries };
}
