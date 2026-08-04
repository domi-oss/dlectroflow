/**
 * `scripts/alert-pipeline-failure.sh`, `scripts/check-prod-drift.sh` and their
 * CI wiring (#147, split out of #146).
 *
 * Pipeline `2721968532` on `main` failed in `test_app`. `deploy_production` sits
 * in a **later stage**, so it was **skipped, not failed** — the pipeline's own
 * red tick was the only signal that the merge never reached production, and
 * nobody was looking at it. `main` stayed red for 86 minutes; prod caught up by
 * accident when the next MR merged. It was noticed while auditing environments
 * for an unrelated reason.
 *
 * So the shape under test is deliberately the awkward one: **not** "the deploy
 * job failed" but "an earlier stage failed, therefore the deploy silently did
 * not happen". A check that only fired on a failed `deploy_production` would not
 * have caught the incident that prompted the issue, and that is asserted here
 * rather than left to the CI file's comments.
 *
 * Both scripts are driven for real with `curl` stubbed on PATH — the
 * `registry-prune.test.ts` / `security-assessment.test.ts` idiom. A
 * re-implementation of a script in its own test proves nothing about the script.
 */
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseJobNeeds } from "./ci-job-deps";

const REPO_ROOT = process.cwd();
const ALERT_SCRIPT = join(REPO_ROOT, "scripts/alert-pipeline-failure.sh");
const DRIFT_SCRIPT = join(REPO_ROOT, "scripts/check-prod-drift.sh");
const DIGEST_SCRIPT = join(REPO_ROOT, "scripts/ops-digest.sh");
const CI_YML = readFileSync(join(REPO_ROOT, ".gitlab-ci.yml"), "utf8");

/**
 * The scripts are bash and shell out to jq; Alpine (which `test_app` runs on)
 * ships neither by default. Without this guard a missing tool presents as every
 * assertion failing on an EMPTY stderr, because it was the *spawn* that failed.
 * Fail once, clearly — the same guard registry-prune.test.ts carries.
 */
for (const tool of ["bash", "jq"]) {
  const found = spawnSync("sh", ["-c", `command -v ${tool}`], {
    encoding: "utf8",
  });
  if (found.status !== 0) {
    throw new Error(
      `${tool} is not on PATH, so the #147 alert scripts cannot be tested. ` +
        `Install it (CI: the apk line in test_app's before_script).`,
    );
  }
}

const API = "https://gitlab.test/api/v4";
const PROJECT_ID = "4242";
const PROD_URL = "https://prod.test";
/** A full SHA-1 and the 7-character form /api/health reports (#135). */
const HEAD_SHA = "a9d5b3264c9367f5c535d6ca0666ae8f6bd2588d";
const HEAD_SHORT = HEAD_SHA.slice(0, 7);
const OLD_SHA = "b6e2b945f1c0d3e2a7b48c19d5f60e2b3c8a7d41";
const OLD_SHORT = OLD_SHA.slice(0, 7);

/**
 * Test stub for curl. Understands only the flags these scripts pass, including
 * the `-o file -w '%{http_code}'` idiom `ops-digest.sh` established — a status
 * code has to be forgeable, because "prod is unreachable" and "prod is running
 * an old commit" must not collapse into the same answer.
 *
 * Routes are `METHOD|url-substring|body-file|http-code`, matched in order.
 * Unserved routes win first, so two routes with the same substring serve two
 * different responses in sequence; once all matching routes are used they are
 * reusable, so a URL fetched twice (the digest and the drift check both read
 * `/api/health`) does not need to be listed twice. Anything unmatched exits
 * non-zero, which is what makes "the script never called the notes endpoint"
 * assertable.
 *
 * A route whose match starts with `=` is an EXACT url match. `ops-digest.sh`
 * probes the bare site root, and no substring of `https://prod.test/` is unique
 * to it — a substring route would also swallow `/api/health` and answer the
 * wrong body.
 */
const CURL_STUB = `#!/usr/bin/env bash
set -u
method=GET; url=""; data=""; out=""; wfmt=""; failfast=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    -X) method="$2"; shift 2 ;;
    -H) shift 2 ;;
    -d) data="$2"; shift 2 ;;
    --data-urlencode) data="$2"; shift 2 ;;
    -o) out="$2"; shift 2 ;;
    -w) wfmt="$2"; shift 2 ;;
    --max-time) shift 2 ;;
    -f|--fail) failfast=1; shift ;;
    -*) shift ;;
    *) url="$1"; shift ;;
  esac
done
case "$data" in
  @*) data="$(cat "\${data#@}")" ;;
esac
printf '%s %s\\n' "$method" "$url" >> "$STUB_LOG"
# Exactly ONE line per call, so the log and the body file stay index-aligned —
# jq pretty-prints the payloads, and a multi-line body would silently shift
# every later call's body onto the wrong request.
printf '%s\\n' "$(printf '%s' "$data" | tr '\\n' ' ')" >> "$STUB_BODIES"
served="$STUB_DIR/served"
serve() {
  local bodyf="$1" code="\${2:-200}"
  if [ -n "$bodyf" ]; then
    if [ -n "$out" ]; then cat "$bodyf" > "$out"; else cat "$bodyf"; fi
  elif [ -n "$out" ]; then
    : > "$out"
  fi
  [ -n "$wfmt" ] && printf '%s' "$code"
  if [ "$failfast" = 1 ] && [ "$code" -ge 400 ]; then exit 22; fi
  exit 0
}
# Pass 1: an unserved route. Pass 2: any route, so a repeated URL still answers.
for pass in 1 2; do
  i=0
  while IFS='|' read -r m sub bodyf code; do
    [ -n "\${m:-}" ] || continue
    i=$((i + 1))
    [ "$m" = "$method" ] || continue
    case "$sub" in
      '='*) [ "$url" = "\${sub#=}" ] || continue ;;
      *) case "$url" in *"$sub"*) ;; *) continue ;; esac ;;
    esac
    if [ "$pass" = 1 ]; then
      grep -qx "$i" "$served" 2>/dev/null && continue
    fi
    printf '%s\\n' "$i" >> "$served"
    serve "$bodyf" "\${code:-200}"
  done < "$STUB_ROUTES"
done
printf 'stub: unrouted %s %s\\n' "$method" "$url" >&2
exit 22
`;

interface Route {
  method: string;
  match: string;
  body?: unknown;
  code?: number;
}

interface Harness {
  routes: Route[];
  env?: Record<string, string | undefined>;
  /** Drop GL_TOKEN — the "never configured" case. */
  noToken?: boolean;
  /** Extra executables to shadow on PATH, keyed by name (see DATE_STUB). */
  bin?: Record<string, string>;
}

/**
 * Test double for `date`, modelling the awkward implementation: relative parsing
 * unsupported (busybox, and BSD for the GNU spelling), `@epoch` supported, and
 * `+%s` answering with something that is not an epoch.
 *
 * That last part is the one that matters. Duo review on !251 flagged
 * `date -d "@$(($(date +%s) - 604800))"` as a `set -e` hazard; measured on bash
 * 3.2 it is not — but the nested arithmetic quietly evaluates junk to `0`, so
 * the offset becomes `-604800` and the digest reports "failed pipelines in the
 * last 7 days" for a window starting in **1969**. A wrong number under a
 * confident label, which is the failure class #147 exists to close.
 */
const DATE_STUB = `#!/usr/bin/env bash
set -u
fmt=""; dflag=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -u) shift ;;
    -d) dflag="$2"; shift 2 ;;
    -v*) exit 1 ;;
    +*) fmt="$1"; shift ;;
    *) shift ;;
  esac
done
if [ -n "$dflag" ]; then
  case "$dflag" in
    @-*) echo "1969-12-25T00:00:00Z"; exit 0 ;;
    @*) echo "2026-07-27T00:00:00Z"; exit 0 ;;
    *) exit 1 ;;
  esac
fi
case "$fmt" in
  "+%s") echo "not-an-epoch"; exit 0 ;;
  *) echo "2026-08-03"; exit 0 ;;
esac
`;

/**
 * Test double for `gcloud`, shadowing any real one (#157).
 *
 * `ops-digest.sh` calls `scripts/check-log-retention.sh`, which reaches for
 * `gcloud`. This harness puts its stub bin in front of the ambient PATH rather
 * than replacing it, so on a contributor's machine with the SDK installed the
 * digest tests would otherwise shell out to a live cloud project — read-only,
 * but non-deterministic, slow, and dependent on whichever project happened to
 * be active. Failing with an unclassifiable error models the CI reality
 * (no Google Cloud credential in this pipeline) and pins the digest to the
 * ⚠️ undetermined arm, which is the state those tests should see.
 */
const GCLOUD_STUB = `#!/usr/bin/env bash
echo "ERROR: no credential in this environment" >&2
exit 1
`;

interface Result {
  status: number;
  stdout: string;
  stderr: string;
  calls: string[];
  bodies: unknown[];
  /** The payload POSTed to an issue's notes endpoint, if any. */
  note: { body?: string } | null;
}

function drive(script: string, harness: Harness): Result {
  const work = mkdtempSync(join(tmpdir(), "alert-147-"));
  const bin = join(work, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "curl"), CURL_STUB, { mode: 0o755 });
  writeFileSync(join(bin, "gcloud"), GCLOUD_STUB, { mode: 0o755 });
  for (const [name, source] of Object.entries(harness.bin ?? {})) {
    writeFileSync(join(bin, name), source, { mode: 0o755 });
  }
  writeFileSync(join(work, "served"), "");

  const lines = harness.routes.map((route, i) => {
    let bodyFile = "";
    if (route.body !== undefined) {
      bodyFile = join(work, `body-${i}.json`);
      writeFileSync(bodyFile, JSON.stringify(route.body));
    }
    return `${route.method}|${route.match}|${bodyFile}|${route.code ?? 200}`;
  });
  const routesFile = join(work, "routes");
  writeFileSync(routesFile, lines.join("\n") + "\n");

  const log = join(work, "stub.log");
  const bodiesFile = join(work, "stub.bodies");
  writeFileSync(log, "");
  writeFileSync(bodiesFile, "");

  // Hermetic on purpose — the ambient environment is NOT spread in. A real
  // GL_TOKEN or CI_* on the machine running the suite would otherwise reach a
  // script whose job is to POST to a GitLab project.
  const env: NodeJS.ProcessEnv = {
    PATH: `${bin}:${process.env.PATH}`,
    HOME: work,
    NODE_ENV: "test",
    STUB_ROUTES: routesFile,
    STUB_LOG: log,
    STUB_BODIES: bodiesFile,
    STUB_DIR: work,
    CI_API_V4_URL: API,
    CI_PROJECT_ID: PROJECT_ID,
    CI_PROJECT_URL: "https://gitlab.test/acme/dlectroflow",
    CI_PIPELINE_ID: "2721968532",
    CI_PIPELINE_URL:
      "https://gitlab.test/acme/dlectroflow/-/pipelines/2721968532",
    CI_COMMIT_SHA: HEAD_SHA,
    CI_COMMIT_SHORT_SHA: HEAD_SHORT,
    CI_COMMIT_REF_NAME: "main",
    CI_JOB_NAME: "alert_pipeline_failure",
    PROD_URL,
    ALERT_ISSUE_IID: "33",
    ...(harness.noToken ? {} : { GL_TOKEN: "stub-token" }),
    ...harness.env,
  };
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete env[key];
  }

  // Run from the repo root: the alert script invokes its sibling drift script by
  // path relative to itself, and the CWD must not be what makes that work.
  const proc = spawnSync("bash", [script], {
    encoding: "utf8",
    env,
    cwd: work,
  });

  const readLines = (file: string) =>
    readFileSync(file, "utf8").split("\n").slice(0, -1);
  const calls = readLines(log);
  const bodies = readLines(bodiesFile).map((line) => {
    try {
      return JSON.parse(line) as unknown;
    } catch {
      return line;
    }
  });
  const noteIndex = calls.findIndex((call) =>
    /^POST .*\/issues\/\d+\/notes/.test(call),
  );

  return {
    status: proc.status ?? -1,
    stdout: proc.stdout ?? "",
    stderr: proc.stderr ?? "",
    calls,
    bodies,
    note: noteIndex === -1 ? null : (bodies[noteIndex] as { body?: string }),
  };
}

// ── scripts/check-prod-drift.sh ──────────────────────────────────────────────

interface DriftScenario {
  /** What `GET /repository/commits/<ref>` returns; null → HTTP 500. */
  head?: { id: string } | null;
  /** What `GET /api/health` returns; null → HTTP 503. */
  health?: unknown | null;
  /** What `GET /repository/compare` returns. */
  compare?: { commits: unknown[] } | null;
  env?: Record<string, string | undefined>;
}

function drift(scenario: DriftScenario = {}): Result {
  const head = scenario.head === undefined ? { id: HEAD_SHA } : scenario.head;
  const health =
    scenario.health === undefined
      ? { status: "ok", sha: HEAD_SHORT }
      : scenario.health;
  const compare =
    scenario.compare === undefined
      ? { commits: [{}, {}, {}] }
      : scenario.compare;
  return drive(DRIFT_SCRIPT, {
    routes: [
      {
        method: "GET",
        match: "/repository/compare",
        ...(compare === null ? { code: 500 } : { body: compare }),
      },
      {
        method: "GET",
        match: "/repository/commits/",
        ...(head === null ? { code: 500 } : { body: head }),
      },
      {
        method: "GET",
        match: "/api/health",
        ...(health === null ? { code: 503 } : { body: health }),
      },
    ],
    env: scenario.env,
  });
}

describe("scripts/check-prod-drift.sh", () => {
  it("reports in sync, and exits 0, when prod is running main's HEAD", () => {
    const result = drift();
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/✅ production is running `main`/);
    expect(result.stdout).toContain(HEAD_SHORT);
  });

  it("compares by prefix, so a 7-char health SHA matches a 40-char HEAD", () => {
    // #135 shortens to 7; GitLab's own `short_id` is 8 and `id` is 40. A
    // naive string equality here would report permanent drift, i.e. an alert
    // that fires always and therefore says nothing.
    const result = drift({
      health: { status: "ok", sha: HEAD_SHA.slice(0, 12) },
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/✅ production is running `main`/);
  });

  it("reports how many commits behind, and exits 1, when prod is stale", () => {
    const result = drift({ health: { status: "ok", sha: OLD_SHORT } });
    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/3 commits behind/);
    expect(result.stdout).toContain(OLD_SHORT);
    expect(result.stdout).toContain(HEAD_SHA);
  });

  it("says diverged, not behind, when prod's commit is not an ancestor of main", () => {
    // A `helm rollback`, or history that was rewritten: the compare endpoint
    // reports no commits between them yet the SHAs differ. "0 commits behind"
    // would read as "in sync", which is the exact false all-clear #147 is about.
    const result = drift({
      health: { status: "ok", sha: OLD_SHORT },
      compare: { commits: [] },
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/diverged|not an ancestor/i);
  });

  it("still reports drift when the commit count is unavailable", () => {
    // Degrade to "drifted, count unknown" — never to "in sync".
    const result = drift({
      health: { status: "ok", sha: OLD_SHORT },
      compare: null,
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/behind|diverged/i);
  });

  it("exits 2 and names the surface when prod health is unreachable", () => {
    // An unproven zero is not a result: 503 must not read as "in sync".
    const result = drift({ health: null });
    expect(result.status).toBe(2);
    expect(result.stdout).not.toMatch(/✅ production is running/);
    expect(result.stdout).toMatch(/could not determine/i);
    expect(result.stdout).toMatch(/503/);
  });

  it("exits 2 when main's HEAD cannot be read", () => {
    const result = drift({ head: null });
    expect(result.status).toBe(2);
    expect(result.stdout).toMatch(/could not determine/i);
  });

  it("treats a null sha as undetermined, not as drift", () => {
    // An image built without the BUILD_SHA build arg reports `sha: null`
    // (src/lib/build-info.ts). That is a build-wiring problem, and calling it
    // "prod is on the wrong commit" would send someone chasing the wrong thing.
    const result = drift({ health: { status: "ok", sha: null } });
    expect(result.status).toBe(2);
    expect(result.stdout).toMatch(/could not determine/i);
  });

  it("refuses to echo a health `sha` that is not a SHA", () => {
    // /api/health is unauthenticated and its body is reflected into a GitLab
    // note. build-info.ts validates on the way out; this validates on the way
    // in, because the consumer is the one embedding it in Markdown.
    const result = drift({
      health: { status: "ok", sha: "[click](https://evil.test) `rm -rf`" },
    });
    expect(result.status).toBe(2);
    expect(result.stdout).not.toContain("evil.test");
    expect(result.stdout).toMatch(/not a valid|could not determine/i);
  });
});

// ── scripts/alert-pipeline-failure.sh ────────────────────────────────────────

interface Job {
  name: string;
  stage: string;
  status: string;
  allow_failure?: boolean;
  failure_reason?: string;
  web_url?: string;
}

/** The incident's job list: test_app failed in `build`, so the deploy skipped. */
const INCIDENT_JOBS: Job[] = [
  { name: "build_app", stage: "build", status: "success" },
  {
    name: "test_app",
    stage: "build",
    status: "failed",
    failure_reason: "script_failure",
    web_url: "https://gitlab.test/acme/dlectroflow/-/jobs/111",
  },
  { name: "build_image", stage: "build_image", status: "skipped" },
  { name: "semgrep-sast", stage: "test", status: "success" },
  { name: "deploy_production", stage: "deploy", status: "skipped" },
  { name: "alert_pipeline_failure", stage: "maintenance", status: "running" },
];

interface AlertScenario {
  jobs?: Job[] | null;
  health?: unknown | null;
  head?: { id: string } | null;
  compare?: { commits: unknown[] } | null;
  noToken?: boolean;
  env?: Record<string, string | undefined>;
}

function alert(scenario: AlertScenario = {}): Result {
  const jobs = scenario.jobs === undefined ? INCIDENT_JOBS : scenario.jobs;
  const health =
    scenario.health === undefined
      ? { status: "ok", sha: OLD_SHORT }
      : scenario.health;
  const head = scenario.head === undefined ? { id: HEAD_SHA } : scenario.head;
  const compare =
    scenario.compare === undefined
      ? { commits: [{}, {}, {}] }
      : scenario.compare;
  return drive(ALERT_SCRIPT, {
    routes: [
      {
        method: "GET",
        match: "/jobs",
        ...(jobs === null ? { code: 403 } : { body: jobs }),
      },
      {
        method: "GET",
        match: "/repository/compare",
        ...(compare === null ? { code: 500 } : { body: compare }),
      },
      {
        method: "GET",
        match: "/repository/commits/",
        ...(head === null ? { code: 500 } : { body: head }),
      },
      {
        method: "GET",
        match: "/api/health",
        ...(health === null ? { code: 503 } : { body: health }),
      },
      { method: "POST", match: "/notes", body: { id: 1 } },
    ],
    noToken: scenario.noToken,
    env: scenario.env,
  });
}

describe("scripts/alert-pipeline-failure.sh", () => {
  it("posts a note naming the failed job, its stage and its failure reason", () => {
    const result = alert();
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.note).not.toBeNull();
    const body = result.note?.body ?? "";
    expect(body).toContain("test_app");
    expect(body).toContain("build");
    expect(body).toContain("script_failure");
  });

  it("says deploy_production was SKIPPED and that it should have deployed", () => {
    // THE point of the job. A skipped deploy is indistinguishable from a
    // docs-only pipeline that correctly skipped one — unless something says so.
    const body = alert().note?.body ?? "";
    expect(body).toMatch(/deploy_production/);
    expect(body).toMatch(/skipped/i);
    expect(body).toMatch(
      /did not (reach|deploy)|never reached|should have deployed/i,
    );
  });

  it("fires on an earlier-stage failure, not only on a failed deploy job", () => {
    // The incident shape: nothing in the job list has status `failed` except a
    // `build`-stage job. A check keyed on deploy_production failing sees
    // nothing here, which is why this assertion is separate from the one above.
    const result = alert();
    expect(result.note?.body).toContain("test_app");
    expect(
      INCIDENT_JOBS.find((j) => j.name === "deploy_production")?.status,
    ).toBe("skipped");
  });

  it("embeds the main-vs-production drift comparison", () => {
    const body = alert().note?.body ?? "";
    expect(body).toMatch(/3 commits behind/);
    expect(body).toContain(OLD_SHORT);
  });

  it("compares production against `main`, not against the pipeline's own ref", () => {
    // Found by the verification run on this branch: with the drift ref defaulting
    // to $CI_COMMIT_REF_NAME the note read `HTTP 404` and "undetermined", because
    // production only ever deploys `main` and no other ref answers the question.
    // The job's rules keep it to `main` today, so this is a latent bug rather
    // than a live one — which is exactly the kind that survives a rule change.
    const body =
      alert({ env: { CI_COMMIT_REF_NAME: "some/other-branch" } }).note?.body ??
      "";
    expect(body).toContain("Production vs `main`");
    expect(body).not.toMatch(/Production vs `some\/other-branch`/);
  });

  it("never renders a run of blank lines", () => {
    // The optional mention and non-blocking-failure lines are empty in the
    // common case and a heredoc keeps their blank line. Cosmetic, but the note
    // is the whole product, and the verification run rendered three in a row.
    const body = alert().note?.body ?? "";
    expect(body).not.toMatch(/\n[ \t]*\n[ \t]*\n/);
    expect(body).not.toMatch(/\n\s*$/);
  });

  it("posts JSON, never form-encoded", () => {
    // The note body carries Markdown tables and backticks; URL-encoding these
    // POSTs is how they come back 400/415 (the repo's standing rule).
    const result = alert();
    const call = result.calls.find((c) => /\/notes/.test(c)) ?? "";
    expect(call).toMatch(/^POST /);
    expect(typeof result.note).toBe("object");
    expect(result.note?.body).toBeTypeOf("string");
  });

  it("does not fire when the only failure was allow_failure", () => {
    // On `main` the scanners run with allow_failure: true so a flake cannot
    // block a production deploy. An alert that shouted about those would be
    // tuned out within a week, and then the real one would be too.
    const result = alert({
      jobs: [
        { name: "build_app", stage: "build", status: "success" },
        {
          name: "container_scanning",
          stage: "test",
          status: "failed",
          allow_failure: true,
        },
        { name: "deploy_production", stage: "deploy", status: "success" },
      ],
    });
    expect(result.status).toBe(0);
    expect(result.note).toBeNull();
    expect(result.stdout).toMatch(/no blocking/i);
  });

  it("never lists itself as a failed job", () => {
    const result = alert({
      jobs: [
        ...INCIDENT_JOBS.filter((j) => j.name !== "alert_pipeline_failure"),
        {
          name: "alert_pipeline_failure",
          stage: "maintenance",
          status: "failed",
          failure_reason: "script_failure",
        },
      ],
    });
    const body = result.note?.body ?? "";
    expect(body).toContain("test_app");
    // Its own row would make every alert self-referential and, on a retry,
    // report the previous attempt as the cause.
    expect(body).not.toMatch(/\|\s*\[?`?alert_pipeline_failure/);
  });

  it("names the endpoint, status and response body when the POST is rejected", () => {
    // Duo review on !251. `curl -f` aborts with nothing but "The requested URL
    // returned error: 422". This is the one write the job performs and the whole
    // point of it, so an alert about a silent failure must not fail silently.
    const result = drive(ALERT_SCRIPT, {
      routes: [
        { method: "GET", match: "/jobs", body: INCIDENT_JOBS },
        {
          method: "GET",
          match: "/repository/compare",
          body: { commits: [{}] },
        },
        {
          method: "GET",
          match: "/repository/commits/",
          body: { id: HEAD_SHA },
        },
        {
          method: "GET",
          match: "/api/health",
          body: { status: "ok", sha: OLD_SHORT },
        },
        {
          method: "POST",
          match: "/notes",
          code: 422,
          body: { message: { body: ["is missing"] } },
        },
      ],
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/422/);
    expect(result.stderr).toMatch(/\/issues\/33\/notes/);
    expect(result.stderr).toMatch(/is missing/);
  });

  it("fails loudly when the jobs API cannot be read", () => {
    // "0 failed jobs" because the API returned 403 is a false all-clear with a
    // timestamp on it — the highest-risk report there is.
    const result = alert({ jobs: null });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/403|could not read/i);
    expect(result.note).toBeNull();
  });

  it("previews instead of posting when GL_TOKEN is unset", () => {
    // The ops_digest precedent: an unconfigured token is "not set up yet" and
    // must not turn into a second failure nobody can act on.
    const result = alert({ noToken: true });
    expect(result.status).toBe(0);
    expect(result.note).toBeNull();
    expect(result.stdout).toMatch(/GL_TOKEN/);
    expect(result.stdout).toContain("test_app");
  });

  it("falls back to OPS_DIGEST_ISSUE_IID when ALERT_ISSUE_IID is unset", () => {
    // Zero new one-time setup: the standing digest issue is already configured
    // and is already where this project sends CI output a human reads.
    const result = alert({
      env: { ALERT_ISSUE_IID: undefined, OPS_DIGEST_ISSUE_IID: "16" },
    });
    expect(result.status).toBe(0);
    expect(result.calls.some((c) => c.includes("/issues/16/notes"))).toBe(true);
  });

  it("previews when no alert issue is configured at all", () => {
    const result = alert({
      env: { ALERT_ISSUE_IID: undefined, OPS_DIGEST_ISSUE_IID: undefined },
    });
    expect(result.status).toBe(0);
    expect(result.note).toBeNull();
    expect(result.stdout).toContain("test_app");
  });

  it("mentions the configured handle so GitLab raises a to-do", () => {
    const body = alert({ env: { ALERT_MENTION: "@someone" } }).note?.body ?? "";
    expect(body).toContain("@someone");
  });

  it("refuses a malformed ALERT_MENTION rather than injecting it", () => {
    const result = alert({
      env: { ALERT_MENTION: "@x](https://evil.test) /merge" },
    });
    expect(result.status).toBe(0);
    expect(result.note?.body).not.toContain("evil.test");
    expect(result.note?.body).not.toContain("/merge");
    expect(result.stderr).toMatch(/ALERT_MENTION/);
  });
});

// ── the weekly digest's drift backstop ───────────────────────────────────────

describe("scripts/ops-digest.sh", () => {
  /**
   * The digest also runs `check-registry-drain.sh` (#113). Its GraphQL calls
   * are routed here rather than left unserved, so the digest's happy path is
   * exercised end to end. Without these the suite still passed — because the
   * drain check bailed early on a missing `CI_PROJECT_PATH` and reported
   * "undetermined", which reads as a working test and proves nothing. An
   * unexercised green is the exact failure #113 is made of, so it is not one to
   * leave in the suite that came out of #113.
   */
  const DRAIN_NOW = "2026-08-04T00:00:00Z";
  const drainDaysAgo = (days: number) =>
    new Date(Date.parse(DRAIN_NOW) - days * 86_400_000)
      .toISOString()
      .replace(".000Z", "Z");
  const registryRoutes = (): Route[] => [
    {
      method: "POST",
      match: "/api/graphql",
      body: {
        data: {
          project: {
            containerExpirationPolicy: {
              enabled: true,
              cadence: "EVERY_DAY",
              keepN: "TEN_TAGS",
              olderThan: "SEVEN_DAYS",
              nameRegex: ".*",
              nameRegexKeep: "(latest|main-.*|prod|v.*)",
              nextRunAt: drainDaysAgo(0.8),
            },
            containerRepositories: {
              nodes: [
                {
                  id: "gid://gitlab/ContainerRepository/777",
                  path: "acme/dlectroflow",
                  status: null,
                  tagsCount: 12,
                  expirationPolicyCleanupStatus: "UNSCHEDULED",
                  expirationPolicyStartedAt: drainDaysAgo(1.8),
                },
              ],
            },
          },
        },
      },
    },
    {
      method: "POST",
      match: "/api/graphql",
      body: {
        data: {
          containerRepository: {
            tags: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: Array.from({ length: 12 }, (_, i) => ({
                name: i.toString(16).padStart(40, "a"),
                createdAt: drainDaysAgo(i * 0.4),
              })),
            },
          },
        },
      },
    },
  ];

  const digestRoutes = (behind: number): Route[] => [
    {
      method: "GET",
      match: "/repository/compare",
      body: { commits: Array.from({ length: behind }, () => ({})) },
    },
    { method: "GET", match: "/repository/commits/", body: { id: HEAD_SHA } },
    {
      method: "GET",
      match: "/api/health",
      body: { status: "ok", sha: OLD_SHORT },
    },
    { method: "GET", match: `=${PROD_URL}/`, body: {} },
    ...registryRoutes(),
    { method: "GET", match: "/pipelines", body: [] },
    { method: "GET", match: "/merge_requests", body: [] },
    { method: "GET", match: "/vulnerabilities", body: [] },
    { method: "GET", match: "/issues?state=opened", body: [] },
    { method: "POST", match: "/notes", body: { id: 1 } },
  ];

  it("carries the registry drain check into the posted digest (#113)", () => {
    const result = drive(DIGEST_SCRIPT, {
      routes: digestRoutes(0),
      env: {
        OPS_DIGEST_ISSUE_IID: "16",
        ALERT_ISSUE_IID: undefined,
        CI_PROJECT_PATH: "acme/dlectroflow",
        REGISTRY_DRAIN_NOW: DRAIN_NOW,
      },
    });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    const body = result.bodies.find(
      (b) => typeof b === "string" && b.includes("ops digest"),
    ) as string;
    // The verdict AND the facts behind it, so a reader can disagree with the
    // verdict without re-running anything.
    expect(body).toMatch(/registry cleanup policy is draining/);
    expect(body).toMatch(/name_regex_keep/);
    expect(body).toMatch(/UNSCHEDULED/);
  });

  it("drops the 7-day window rather than inventing a 1969 one", () => {
    // Duo review on !251, mechanism corrected — see DATE_STUB. With a `date`
    // that cannot parse relative strings and answers `+%s` with junk, the
    // nested-arithmetic form produced `updated_after=1969-12-25`, i.e. an
    // all-time count under a "last 7d" label. Degrading to a stated "all time"
    // is the only honest option.
    const result = drive(DIGEST_SCRIPT, {
      routes: digestRoutes(2),
      bin: { date: DATE_STUB },
      env: { OPS_DIGEST_ISSUE_IID: "16", ALERT_ISSUE_IID: undefined },
    });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.calls.some((c) => c.includes("updated_after"))).toBe(false);
    expect(result.calls.some((c) => c.includes("1969"))).toBe(false);
    const body = result.bodies.find(
      (b) => typeof b === "string" && b.includes("ops digest"),
    ) as string;
    expect(body).toMatch(/all time/);
    expect(body).not.toMatch(/last 7d/);
  });

  it("reports whether production is running main", () => {
    // The on-failure hook only catches divergence caused by a failed pipeline.
    // A `helm rollback`, a manual scale-down or an --atomic rollback of a
    // "successful" deploy all diverge main from prod with a GREEN pipeline, so
    // the weekly digest carries the same comparison as a catch-all.
    const result = drive(DIGEST_SCRIPT, {
      routes: [
        {
          method: "GET",
          match: "/repository/compare",
          body: { commits: [{}, {}] },
        },
        {
          method: "GET",
          match: "/repository/commits/",
          body: { id: HEAD_SHA },
        },
        {
          method: "GET",
          match: "/api/health",
          body: { status: "ok", sha: OLD_SHORT },
        },
        { method: "GET", match: `=${PROD_URL}/`, body: {} },
        { method: "GET", match: "/pipelines", body: [] },
        { method: "GET", match: "/merge_requests", body: [] },
        { method: "GET", match: "/vulnerabilities", body: [] },
        { method: "GET", match: "/issues?state=opened", body: [] },
        { method: "POST", match: "/notes", body: { id: 1 } },
      ],
      env: { OPS_DIGEST_ISSUE_IID: "16", ALERT_ISSUE_IID: undefined },
    });
    expect(result.status).toBe(0);
    const posted = result.calls.some((c) => c.includes("/issues/16/notes"));
    expect(posted).toBe(true);
    const body = result.bodies.find(
      (b) => typeof b === "string" && b.includes("ops digest"),
    ) as string;
    expect(body).toMatch(/2 commits behind/);
  });
});

// ── the CI wiring ────────────────────────────────────────────────────────────

describe("the alert_pipeline_failure CI job", () => {
  const job = (CI_YML.split(/^alert_pipeline_failure:$/m)[1] ?? "").split(
    /^\S/m,
  )[0];
  const rules = (job.split(/^ {2}rules:$/m)[1] ?? "").split("\n");

  it("exists", () => {
    expect(job).not.toBe("");
  });

  it("runs the alert script", () => {
    expect(job).toContain("scripts/alert-pipeline-failure.sh");
  });

  it("runs on failure, on main, and nowhere else", () => {
    const ifs = rules.filter((line) => line.includes("if:"));
    expect(ifs).toEqual([
      `    - if: '$CI_PIPELINE_SOURCE == "schedule"'`,
      `    - if: '$CI_COMMIT_BRANCH == "main"'`,
    ]);
    // The schedule guard first: a scheduled rescan never deploys, so it cannot
    // cause the divergence this job exists to catch, and the digest already
    // counts failed main pipelines. Also keeps Renovate/prune/assessment quiet.
    expect(rules.join("\n")).toMatch(
      /if: '\$CI_PIPELINE_SOURCE == "schedule"'\s*\n\s*when: never/,
    );
    // on_failure declared IN the rule, not only at job level: a rule that
    // matches without its own `when` is the ambiguous form.
    expect(rules.join("\n")).toMatch(
      /if: '\$CI_COMMIT_BRANCH == "main"'\s*\n\s*when: on_failure/,
    );
  });

  it("never runs on a merge-request pipeline", () => {
    // A red MR pipeline is already in front of the person who pushed it, and it
    // cannot make main and production diverge.
    expect(job).not.toContain("merge_request_event");
  });

  it("declares no needs, so `on_failure` means any earlier stage", () => {
    // `needs: []` would scope on_failure to an EMPTY set of jobs — the alert
    // would never fire. Stage-level semantics are load-bearing here, so the
    // absence of `needs` is deliberate and asserted.
    expect(parseJobNeeds(CI_YML, "alert_pipeline_failure")).toEqual({
      kind: "absent",
    });
    // …and `dependencies: []` keeps that from downloading every earlier stage's
    // artifacts (the #145 expiry trap) while leaving stage ordering intact.
    expect(job).toMatch(/^\s+dependencies: \[\]/m);
  });

  it("sits in the last stage, after deploy", () => {
    expect(job).toMatch(/^\s+stage: maintenance\s*(#.*)?$/m);
    const stages = (CI_YML.split(/^stages:$/m)[1] ?? "").split(/^\S/m)[0];
    const order = stages
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("- "))
      .map((line) => line.slice(2).split("#")[0].trim())
      .filter(Boolean);
    // deploy_production must have reached its final status before the alert
    // reads it — otherwise it reports `created` instead of `skipped`.
    expect(order.indexOf("maintenance")).toBeGreaterThan(
      order.indexOf("deploy"),
    );
  });

  it("is not interruptible", () => {
    expect(job).toMatch(/^\s+interruptible: false/m);
  });

  it("installs the tools its script shells out to", () => {
    expect(job).toMatch(/apk add[^\n]*\bcurl\b/);
    expect(job).toMatch(/apk add[^\n]*\bjq\b/);
    expect(job).toMatch(/apk add[^\n]*\bbash\b/);
  });
});

describe("the ops_digest CI job", () => {
  const job = (CI_YML.split(/^ops_digest:$/m)[1] ?? "").split(/^\S/m)[0];

  it("still runs only on schedules", () => {
    // Adding the drift backstop must not change when the digest runs.
    const ifs = (job.split(/^ {2}rules:$/m)[1] ?? "")
      .split("\n")
      .filter((line) => line.includes("if:"));
    expect(ifs).toEqual([
      `    - if: '$CI_PIPELINE_SOURCE == "schedule" && $RENOVATE_RUN == "true"'`,
      `    - if: '$CI_PIPELINE_SOURCE == "schedule" && $REGISTRY_PRUNE == "true"'`,
      `    - if: '$CI_PIPELINE_SOURCE == "schedule" && $SECURITY_ASSESSMENT == "true"'`,
      `    - if: '$CI_PIPELINE_SOURCE == "schedule"'`,
    ]);
  });
});
