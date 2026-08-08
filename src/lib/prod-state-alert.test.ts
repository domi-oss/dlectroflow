/**
 * `scripts/alert-prod-state.sh`, `scripts/check-prod-replicas.sh`, the duration
 * `scripts/check-prod-drift.sh` now reports, and their CI wiring (#191).
 *
 * Production served stale code on ONE replica instead of two for roughly 24
 * hours and nobody knew. Every signal existed: six failed Helm revisions,
 * `1/2 READY` on the Deployment the whole time, two pods in
 * `Init:CrashLoopBackOff`, and an `alert_pipeline_failure` note that said in as
 * many words that production was not running `main`. It was found by accident.
 *
 * So the gap under test is **delivery**, not detection, and the shape is
 * deliberately the awkward one: not "did the check compute the right answer" —
 * `check-prod-drift.sh` already did — but "did the answer reach somebody who was
 * not already looking at the project, and does the alerter fail LOUDLY when it
 * cannot deliver". A monitor that can die quietly manufactures false confidence,
 * which is worse than no monitor, so the "the alerter is broken" arms get as
 * much coverage here as the alerting ones.
 *
 * Two facts about the alert path are asserted repeatedly because they are the
 * whole point:
 *   1. the script exits NON-ZERO on every non-green outcome — including
 *      "undetermined" and "the POST was rejected" — so the scheduled pipeline
 *      goes red and GitLab's own pipeline-failure notification reaches the
 *      schedule's owner out of band, with no channel to configure; and
 *   2. it never renders an unknown as ✅.
 *
 * The scripts are driven for real with `curl` and `kubectl` stubbed on PATH —
 * the `pipeline-failure-alert.test.ts` / `registry-prune.test.ts` idiom. A
 * re-implementation of a script inside its own test proves nothing about the
 * script.
 */
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO_ROOT = process.cwd();
const ALERT_SCRIPT = join(REPO_ROOT, "scripts/alert-prod-state.sh");
const DRIFT_SCRIPT = join(REPO_ROOT, "scripts/check-prod-drift.sh");
const REPLICAS_SCRIPT = join(REPO_ROOT, "scripts/check-prod-replicas.sh");
const CI_YML = readFileSync(join(REPO_ROOT, ".gitlab-ci.yml"), "utf8");

/**
 * Same guard `pipeline-failure-alert.test.ts` carries: without it a missing tool
 * presents as every assertion failing on an EMPTY stderr, because it was the
 * spawn that failed rather than the script.
 */
for (const tool of ["bash", "jq"]) {
  const found = spawnSync("sh", ["-c", `command -v ${tool}`], {
    encoding: "utf8",
  });
  if (found.status !== 0) {
    throw new Error(
      `${tool} is not on PATH, so the #191 alert scripts cannot be tested. ` +
        `Install it (CI: the apk line in alert_prod_state's before_script).`,
    );
  }
}

const API = "https://gitlab.test/api/v4";
const PROJECT_ID = "4242";
const PROD_URL = "https://prod.test";
const HEAD_SHA = "a9d5b3264c9367f5c535d6ca0666ae8f6bd2588d";
const HEAD_SHORT = HEAD_SHA.slice(0, 7);
const OLD_SHA = "b6e2b945f1c0d3e2a7b48c19d5f60e2b3c8a7d41";
const OLD_SHORT = OLD_SHA.slice(0, 7);
const ISSUE_IID = "45";

/** Copied from pipeline-failure-alert.test.ts — see its header for the routing. */
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

/**
 * Test double for `kubectl`. Routes on a substring of the joined arguments,
 * because the two reads the replica check performs are distinguishable by their
 * resource alone (`deployment` vs `pods`).
 *
 * A route with no body file and a non-zero code models the case that matters
 * most: kubectl present but the read refused (no agent context, RBAC, an
 * unreachable control plane). That must surface as ⚠️ undetermined, never as a
 * pass — "the cluster did not answer" collapsing into "the cluster is healthy"
 * is the unproven green this whole issue is about.
 */
const KUBECTL_STUB = `#!/usr/bin/env bash
set -u
args="$*"
printf 'kubectl %s\\n' "$args" >> "$KSTUB_LOG"
while IFS='|' read -r sub bodyf code; do
  [ -n "\${sub:-}" ] || continue
  case "$args" in *"$sub"*) ;; *) continue ;; esac
  if [ -n "$bodyf" ]; then cat "$bodyf"; fi
  if [ "\${code:-0}" != "0" ]; then
    printf 'error from server: stub refused %s\\n' "$sub" >&2
    exit "$code"
  fi
  exit 0
done < "$KSTUB_ROUTES"
printf 'kubectl stub: unrouted %s\\n' "$args" >&2
exit 1
`;

/**
 * Test double for `date`, modelling the awkward implementation the repo has
 * already been bitten by twice: relative parsing unsupported (busybox, and BSD
 * for the GNU spelling) and ISO-8601 parsing unsupported. `+%s` still answers,
 * so "now" is knowable while "when was that commit" is not — which is exactly
 * the arm where the drift check must report the timestamp WITHOUT inventing an
 * age rather than printing a confident wrong number.
 */
const BROKEN_DATE_STUB = `#!/usr/bin/env bash
set -u
fmt=""
for arg in "$@"; do
  case "$arg" in
    +*) fmt="$arg" ;;
  esac
done
case "$fmt" in
  "+%s") echo 1786000000; exit 0 ;;
  *) exit 1 ;;
esac
`;

interface Route {
  method: string;
  match: string;
  body?: unknown;
  code?: number;
}

interface KRoute {
  match: string;
  body?: unknown;
  code?: number;
}

interface Harness {
  routes?: Route[];
  kubectl?: KRoute[];
  env?: Record<string, string | undefined>;
  /** Drop GL_TOKEN — the "never configured" case. */
  noToken?: boolean;
  /** Extra executables to shadow on PATH, keyed by name. */
  bin?: Record<string, string>;
}

interface Result {
  status: number;
  stdout: string;
  stderr: string;
  calls: string[];
  kubectlCalls: string[];
  bodies: unknown[];
  /** The payload POSTed to an issue's notes endpoint, if any. */
  note: { body?: string } | null;
}

function drive(script: string, harness: Harness): Result {
  const work = mkdtempSync(join(tmpdir(), "alert-191-"));
  const bin = join(work, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "curl"), CURL_STUB, { mode: 0o755 });
  writeFileSync(join(bin, "kubectl"), KUBECTL_STUB, { mode: 0o755 });
  for (const [name, source] of Object.entries(harness.bin ?? {})) {
    writeFileSync(join(bin, name), source, { mode: 0o755 });
  }
  writeFileSync(join(work, "served"), "");

  const lines = (harness.routes ?? []).map((route, i) => {
    let bodyFile = "";
    if (route.body !== undefined) {
      bodyFile = join(work, `body-${i}.json`);
      writeFileSync(bodyFile, JSON.stringify(route.body));
    }
    return `${route.method}|${route.match}|${bodyFile}|${route.code ?? 200}`;
  });
  const routesFile = join(work, "routes");
  writeFileSync(routesFile, lines.join("\n") + "\n");

  const kLines = (harness.kubectl ?? []).map((route, i) => {
    let bodyFile = "";
    if (route.body !== undefined) {
      bodyFile = join(work, `k-body-${i}.json`);
      writeFileSync(bodyFile, JSON.stringify(route.body));
    }
    return `${route.match}|${bodyFile}|${route.code ?? 0}`;
  });
  const kRoutesFile = join(work, "k-routes");
  writeFileSync(kRoutesFile, kLines.join("\n") + "\n");

  const log = join(work, "stub.log");
  const kLog = join(work, "kstub.log");
  const bodiesFile = join(work, "stub.bodies");
  for (const file of [log, kLog, bodiesFile]) writeFileSync(file, "");

  // Hermetic on purpose — the ambient environment is NOT spread in. A real
  // GL_TOKEN, CI_* or KUBECONFIG on the machine running the suite would
  // otherwise reach a script whose job is to POST to a GitLab project and read a
  // production cluster.
  const env: NodeJS.ProcessEnv = {
    PATH: `${bin}:${process.env.PATH}`,
    HOME: work,
    NODE_ENV: "test",
    STUB_ROUTES: routesFile,
    STUB_LOG: log,
    STUB_BODIES: bodiesFile,
    STUB_DIR: work,
    KSTUB_ROUTES: kRoutesFile,
    KSTUB_LOG: kLog,
    CI_API_V4_URL: API,
    CI_PROJECT_ID: PROJECT_ID,
    CI_PIPELINE_ID: "9001",
    CI_PIPELINE_URL: "https://gitlab.test/acme/dlectroflow/-/pipelines/9001",
    CI_JOB_NAME: "alert_prod_state",
    PROD_URL,
    ALERT_ISSUE_IID: ISSUE_IID,
    ...(harness.noToken ? {} : { GL_TOKEN: "stub-token" }),
    ...harness.env,
  };
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete env[key];
  }

  // Run from a scratch CWD: the alert script invokes its sibling checks by path
  // relative to itself, and the CWD must not be what makes that work.
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
    kubectlCalls: readLines(kLog),
    bodies,
    note: noteIndex === -1 ? null : (bodies[noteIndex] as { body?: string }),
  };
}

// ── scripts/check-prod-replicas.sh ───────────────────────────────────────────

/**
 * A Deployment status, shaped as the API returns it.
 *
 * `null` for a replica count means the field is OMITTED, which is what
 * Kubernetes actually does — it never writes `availableReplicas: 0`. `undefined`
 * cannot express that: a destructuring default fires on an explicit
 * `undefined`, so `{ available: undefined }` would silently give back the
 * healthy default and the test would assert nothing.
 */
function deployment({
  desired = 2,
  available = 2 as number | null,
  ready = 2 as number | null,
  updated = 2 as number | null,
  progressing = { status: "True", reason: "NewReplicaSetAvailable" },
  availableCondition = { status: "True", reason: "MinimumReplicasAvailable" },
}: {
  desired?: number;
  available?: number | null;
  ready?: number | null;
  updated?: number | null;
  progressing?: { status: string; reason: string } | null;
  availableCondition?: { status: string; reason: string } | null;
} = {}) {
  const conditions: unknown[] = [];
  if (progressing) {
    conditions.push({
      type: "Progressing",
      lastTransitionTime: "2026-08-06T13:12:00Z",
      ...progressing,
    });
  }
  if (availableCondition) {
    conditions.push({
      type: "Available",
      lastTransitionTime: "2026-08-06T13:12:00Z",
      ...availableCondition,
    });
  }
  const status: Record<string, unknown> = { conditions };
  // availableReplicas and readyReplicas are ABSENT, not 0, when none are — the
  // check must not read a missing field as a healthy one.
  if (available !== null) status.availableReplicas = available;
  if (ready !== null) status.readyReplicas = ready;
  if (updated !== null) status.updatedReplicas = updated;
  return { spec: { replicas: desired }, status };
}

/** A pod list containing one pod whose `migrate` initContainer is wedged. */
function podsWithWedgedMigrate(message: string) {
  return {
    items: [
      {
        metadata: { name: "dlectroflow-7c9f4b6d8-2xk9p" },
        status: {
          phase: "Pending",
          conditions: [{ type: "Ready", status: "False" }],
          initContainerStatuses: [
            {
              name: "migrate",
              ready: false,
              restartCount: 41,
              state: {
                waiting: { reason: "CrashLoopBackOff", message },
              },
              lastState: {
                terminated: { reason: "Error", exitCode: 1, message },
              },
            },
          ],
          containerStatuses: [],
        },
      },
    ],
  };
}

function replicas(harness: Harness = {}): Result {
  return drive(REPLICAS_SCRIPT, {
    kubectl: [{ match: "deployment", body: deployment() }],
    ...harness,
  });
}

describe("scripts/check-prod-replicas.sh", () => {
  it("exits 0 and says so when every desired replica is available", () => {
    const run = replicas();
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("2/2");
    expect(run.stdout).toContain("✅");
  });

  it("exits 1 when fewer replicas are available than desired", () => {
    // THE incident reading. `1/2 READY` for a day, invisible to a SHA
    // comparison: production reported the right commit from its one surviving
    // pod, so `check-prod-drift.sh` alone would have said ✅ the entire time.
    const run = replicas({
      kubectl: [
        { match: "deployment", body: deployment({ available: 1, ready: 1 }) },
        { match: "pods", body: { items: [] } },
      ],
    });
    expect(run.status).toBe(1);
    expect(run.stdout).toContain("1/2");
    expect(run.stdout).toContain("🔴");
    expect(run.stdout).not.toContain("✅");
  });

  it("treats an absent availableReplicas as zero available, not as healthy", () => {
    // Kubernetes omits the field rather than writing 0. `.status.availableReplicas`
    // read with a `// 0` default is correct; read as "missing means fine" it
    // reports a totally-down Deployment as green.
    const run = replicas({
      kubectl: [
        {
          match: "deployment",
          body: deployment({ available: null, ready: null }),
        },
        { match: "pods", body: { items: [] } },
      ],
    });
    expect(run.status).toBe(1);
    expect(run.stdout).toContain("0/2");
  });

  it("exits 2 — never 0 — when the cluster read is refused", () => {
    const run = replicas({
      kubectl: [{ match: "deployment", code: 1 }],
    });
    expect(run.status).toBe(2);
    expect(run.stdout).toContain("⚠️");
    expect(run.stdout).not.toContain("✅");
    expect(run.stdout.toLowerCase()).toContain("undetermined");
  });

  it("exits 2 when the Deployment reports no desired replica count", () => {
    // `0 of 0 available` is arithmetically satisfied and operationally
    // meaningless. A spec without `replicas` means the read did not return what
    // was asked for, which is an unknown.
    const run = replicas({
      kubectl: [{ match: "deployment", body: { spec: {}, status: {} } }],
    });
    expect(run.status).toBe(2);
    expect(run.stdout.toLowerCase()).toContain("undetermined");
  });

  it("names the wedged initContainer and its reason when degraded", () => {
    // P3009 is the reason this is worth the extra request: a failed Prisma
    // migration blocks every LATER migration, so the damage compounds with each
    // merge. It shows up nowhere except the initContainer's message.
    const run = replicas({
      kubectl: [
        { match: "deployment", body: deployment({ available: 1, ready: 1 }) },
        {
          match: "pods",
          body: podsWithWedgedMigrate(
            "Error: P3009 migrate found failed migrations in the target database",
          ),
        },
      ],
    });
    expect(run.status).toBe(1);
    expect(run.stdout).toContain("migrate");
    expect(run.stdout).toContain("CrashLoopBackOff");
    expect(run.stdout).toContain("P3009");
  });

  it("neutralises backticks and newlines in a container message", () => {
    // The message is cluster-supplied text that the caller splices into a note
    // on an issue in a PUBLIC project. A message containing a fence would break
    // out of the code block and take the rest of the note's rendering with it;
    // one containing a leading slash on its own line would be a GitLab quick
    // action executed with the alerter's token.
    const run = replicas({
      kubectl: [
        { match: "deployment", body: deployment({ available: 1, ready: 1 }) },
        {
          match: "pods",
          body: podsWithWedgedMigrate("```\n/close\n```oops"),
        },
      ],
    });
    expect(run.status).toBe(1);
    expect(run.stdout).not.toContain("```");
    // Every line of the report is a Markdown bullet or a fence the script owns;
    // no line may begin with a slash.
    for (const line of run.stdout.split("\n")) {
      expect(line.trimStart().startsWith("/")).toBe(false);
    }
  });

  it("reads the deployment and namespace from env, defaulting to production", () => {
    const run = replicas();
    expect(run.kubectlCalls.join("\n")).toContain("dlectroflow-prod");
    const custom = drive(REPLICAS_SCRIPT, {
      kubectl: [{ match: "deployment", body: deployment() }],
      env: { REPLICAS_NAMESPACE: "other-ns", REPLICAS_DEPLOYMENT: "other-dep" },
    });
    expect(custom.kubectlCalls.join("\n")).toContain("other-ns");
    expect(custom.kubectlCalls.join("\n")).toContain("other-dep");
  });
});

// ── scripts/check-prod-drift.sh — the duration (#191) ────────────────────────

interface DriftScenario {
  head?: { id: string } | null;
  health?: unknown | null;
  compare?: unknown | null;
  env?: Record<string, string | undefined>;
  bin?: Record<string, string>;
}

function drift(scenario: DriftScenario = {}): Result {
  const head = scenario.head === undefined ? { id: HEAD_SHA } : scenario.head;
  const health =
    scenario.health === undefined
      ? { status: "ok", sha: OLD_SHORT }
      : scenario.health;
  const compare =
    scenario.compare === undefined
      ? {
          commits: [
            { id: OLD_SHA, committed_date: "2026-08-06T13:12:00.000Z" },
            { id: HEAD_SHA, committed_date: "2026-08-07T09:00:00.000Z" },
          ],
        }
      : scenario.compare;
  return drive(DRIFT_SCRIPT, {
    routes: [
      {
        method: "GET",
        match: "/repository/commits/",
        body: head,
        code: head ? 200 : 500,
      },
      {
        method: "GET",
        match: "/api/health",
        body: health,
        code: health ? 200 : 503,
      },
      {
        method: "GET",
        match: "/repository/compare",
        body: compare,
        code: compare ? 200 : 500,
      },
    ],
    env: scenario.env,
    bin: scenario.bin,
  });
}

describe("scripts/check-prod-drift.sh reports how long production has been behind", () => {
  it("dates the drift from the oldest commit production is missing", () => {
    // #191's second ask. A failed deploy is an EVENT and is easy to miss;
    // "production has been behind `main` for N hours" is a STATE and stays true
    // until somebody fixes it. The commit count alone does not say whether this
    // happened four minutes ago (a deploy still running) or yesterday.
    const run = drift();
    expect(run.status).toBe(1);
    expect(run.stdout).toContain("2026-08-06T13:12");
    expect(run.stdout).toMatch(/\bhours?\b/);
  });

  it("reports the timestamp without inventing an age when date cannot parse it", () => {
    // busybox `date` (the alpine images) parses neither a relative offset nor an
    // ISO-8601 instant. A wrong number under a confident label is the failure
    // class this repo has already paid for twice, so the age is dropped and the
    // instant is still printed.
    const run = drift({ bin: { date: BROKEN_DATE_STUB } });
    expect(run.status).toBe(1);
    expect(run.stdout).toContain("2026-08-06T13:12");
    expect(run.stdout).not.toMatch(/-\d+ hours/);
  });

  it("still exits 0 with no duration line when production is in sync", () => {
    const run = drift({ health: { status: "ok", sha: HEAD_SHORT } });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("✅");
  });
});

// ── scripts/alert-prod-state.sh ──────────────────────────────────────────────

interface AlertScenario {
  /** Drift check outcome, driven through the real script's inputs. */
  prodSha?: string | null;
  headSha?: string;
  /** Deployment JSON for the replica check; `false` refuses the read. */
  deploy?: unknown | false;
  pods?: unknown;
  /** Existing notes on the alert issue; `false` makes the read fail. */
  notes?: unknown | false;
  /** HTTP code the notes POST answers with. */
  postCode?: number;
  env?: Record<string, string | undefined>;
  noToken?: boolean;
}

function alert(scenario: AlertScenario = {}): Result {
  const prodSha =
    scenario.prodSha === undefined ? HEAD_SHORT : scenario.prodSha;
  const headSha = scenario.headSha ?? HEAD_SHA;
  const deploy = scenario.deploy === undefined ? deployment() : scenario.deploy;
  const notes = scenario.notes === undefined ? [] : scenario.notes;
  return drive(ALERT_SCRIPT, {
    routes: [
      { method: "GET", match: "/repository/commits/", body: { id: headSha } },
      {
        method: "GET",
        match: "/api/health",
        body: prodSha === null ? null : { status: "ok", sha: prodSha },
        code: prodSha === null ? 503 : 200,
      },
      {
        method: "GET",
        match: "/repository/compare",
        body: {
          commits: [
            { id: OLD_SHA, committed_date: "2026-08-06T13:12:00.000Z" },
          ],
        },
      },
      {
        method: "GET",
        match: `/issues/${ISSUE_IID}/notes`,
        body: notes === false ? undefined : notes,
        code: notes === false ? 500 : 200,
      },
      {
        method: "POST",
        match: `/issues/${ISSUE_IID}/notes`,
        body: { id: 1 },
        code: scenario.postCode ?? 201,
      },
    ],
    kubectl:
      deploy === false
        ? [{ match: "deployment", code: 1 }]
        : [
            { match: "deployment", body: deploy },
            { match: "pods", body: scenario.pods ?? { items: [] } },
          ],
    env: scenario.env,
    noToken: scenario.noToken,
  });
}

/** The fingerprint line the alerter writes so it can recognise its own state. */
function noteWithFingerprint(fingerprint: string) {
  return [
    {
      id: 10,
      body: `### something happened\n\n_alert-prod-state fingerprint: \`${fingerprint}\`_`,
    },
  ];
}

describe("scripts/alert-prod-state.sh — the healthy path is silent", () => {
  it("posts nothing and exits 0 when production is current and fully replicated", () => {
    // An alert channel that emits on every healthy run gets muted within a week,
    // and takes the real alert with it.
    const run = alert();
    expect(run.status).toBe(0);
    expect(run.note).toBeNull();
    expect(run.calls.some((c) => c.startsWith("POST"))).toBe(false);
  });

  it("posts a recovery note when the previous run had alerted", () => {
    // Without this, the fingerprint chain cannot tell a NEW incident from the
    // one already reported: the alerter would still be carrying the old
    // fingerprint as its most recent word and would suppress the next identical
    // failure. Closing the loop is also what makes the channel trustworthy.
    const run = alert({ notes: noteWithFingerprint("drift=1 replicas=0") });
    expect(run.status).toBe(0);
    expect(run.note?.body).toContain("✅");
    expect(run.note?.body?.toLowerCase()).toContain("recovered");
  });
});

describe("scripts/alert-prod-state.sh — delivery", () => {
  it("posts and exits non-zero when production is behind main", () => {
    const run = alert({ prodSha: OLD_SHORT });
    expect(run.status).not.toBe(0);
    expect(run.note?.body).toContain("🔴");
    expect(run.note?.body).toContain("2026-08-06T13:12");
  });

  it("posts and exits non-zero when replicas are below desired", () => {
    const run = alert({ deploy: deployment({ available: 1, ready: 1 }) });
    expect(run.status).not.toBe(0);
    expect(run.note?.body).toContain("1/2");
  });

  it("carries the P3009 initContainer message into the note", () => {
    const run = alert({
      deploy: deployment({ available: 1, ready: 1 }),
      pods: podsWithWedgedMigrate(
        "Error: P3009 migrate found failed migrations in the target database",
      ),
    });
    expect(run.status).not.toBe(0);
    expect(run.note?.body).toContain("P3009");
  });

  it("mentions the owner so GitLab raises a to-do, not just a note", () => {
    // A note on an issue nobody is subscribed to is the bug being fixed: the
    // #45 note during the incident was posted, correct, and never read. A
    // mention is what turns "written down" into "delivered" — it raises a to-do
    // AND emails, and it needs no channel to configure.
    const run = alert({
      prodSha: OLD_SHORT,
      env: { ALERT_MENTION: "@someone" },
    });
    expect(run.note?.body).toContain("@someone");
  });

  it("ignores an ALERT_MENTION that is not a bare handle", () => {
    // Interpolated unvalidated, this is arbitrary Markdown — and arbitrary
    // GitLab quick actions — in a note posted with an `api`-scoped token.
    const run = alert({
      prodSha: OLD_SHORT,
      env: { ALERT_MENTION: "@someone\n/close" },
    });
    expect(run.status).not.toBe(0);
    expect(run.note?.body).not.toContain("/close");
    expect(run.stderr).toContain("ALERT_MENTION");
  });

  it("does not repeat an identical alert, but still exits non-zero", () => {
    // The note is the detail channel and repeating it is noise. The RED PIPELINE
    // is the nagging channel, so suppressing the duplicate note must not
    // suppress the exit code.
    const run = alert({
      prodSha: OLD_SHORT,
      notes: noteWithFingerprint("drift=1 replicas=0"),
    });
    expect(run.status).not.toBe(0);
    expect(run.note).toBeNull();
    expect(run.stdout).toContain("unchanged");
  });

  it("posts when the state differs from the last alert", () => {
    const run = alert({
      prodSha: OLD_SHORT,
      deploy: deployment({ available: 1, ready: 1 }),
      notes: noteWithFingerprint("drift=1 replicas=0"),
    });
    expect(run.status).not.toBe(0);
    expect(run.note?.body).toContain("🔴");
  });

  it("posts anyway when the de-duplication read fails", () => {
    // Fails OPEN, deliberately: a duplicate note is a nuisance, a suppressed
    // alert is the incident. The direction of this failure is the whole design.
    const run = alert({ prodSha: OLD_SHORT, notes: false });
    expect(run.status).not.toBe(0);
    expect(run.note?.body).toContain("🔴");
  });
});

describe("scripts/alert-prod-state.sh — the alerter cannot fail quietly", () => {
  it("exits non-zero and never says ✅ when the facts cannot be established", () => {
    // Both halves unknown: production unreachable and the cluster read refused.
    // "Could not tell" must reach a human exactly as loudly as "broken",
    // because an unknown nobody can see is indistinguishable from a pass.
    const run = alert({ prodSha: null, deploy: false });
    expect(run.status).not.toBe(0);
    expect(run.note?.body).toContain("⚠️");
    expect(run.note?.body).not.toContain("✅");
    expect(run.note?.body?.toLowerCase()).toContain("undetermined");
  });

  it("exits non-zero and prints the whole note when the POST is rejected", () => {
    // The alert about a silent failure failing silently would be its own
    // punchline. If the channel is broken the content still has to survive, in
    // the job log, and the job still has to go red so the pipeline notification
    // is the fallback channel.
    const run = alert({ prodSha: OLD_SHORT, postCode: 422 });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("422");
    expect(run.stdout + run.stderr).toContain("🔴");
  });

  it("exits non-zero when it has no token to deliver with", () => {
    // Unlike alert_pipeline_failure, an unconfigured state monitor must NOT be
    // quietly green: this job's entire purpose is to be the thing that notices,
    // so "I cannot deliver" is itself the alert. It still prints the state.
    const run = alert({ prodSha: OLD_SHORT, noToken: true });
    expect(run.status).not.toBe(0);
    expect(run.stdout + run.stderr).toContain("GL_TOKEN");
    expect(run.stdout + run.stderr).toContain("🔴");
  });

  it("exits non-zero when no alert issue is configured", () => {
    const run = alert({
      prodSha: OLD_SHORT,
      env: { ALERT_ISSUE_IID: undefined, OPS_DIGEST_ISSUE_IID: undefined },
    });
    expect(run.status).not.toBe(0);
    expect(run.stdout + run.stderr).toContain("ALERT_ISSUE_IID");
  });

  it("is green only when both checks are green — never on a partial answer", () => {
    // The one assertion that pins the contract: the ONLY zero-exit outcomes are
    // "everything verified healthy". Any other combination is non-zero.
    const combinations: Array<[AlertScenario, boolean]> = [
      [{}, true],
      [{ prodSha: OLD_SHORT }, false],
      [{ prodSha: null }, false],
      [{ deploy: deployment({ available: 1, ready: 1 }) }, false],
      [{ deploy: false }, false],
    ];
    for (const [scenario, green] of combinations) {
      const run = alert(scenario);
      expect(
        run.status === 0,
        `${JSON.stringify(scenario)} expected green=${green}`,
      ).toBe(green);
    }
  });
});

// ── the CI wiring ────────────────────────────────────────────────────────────

describe("the alert_prod_state CI job", () => {
  const job = (CI_YML.split(/^alert_prod_state:$/m)[1] ?? "").split(/^\S/m)[0];

  it("exists", () => {
    expect(job).not.toBe("");
  });

  it("runs only on its own schedule", () => {
    const rules = (job.split(/^ {2}rules:$/m)[1] ?? "")
      .split("\n")
      .filter((line) => line.includes("if:"));
    expect(rules).toEqual([
      `    - if: '$CI_PIPELINE_SOURCE == "schedule" && $PROD_STATE_CHECK == "true"'`,
    ]);
  });

  it("needs nothing, so a red build cannot suppress the monitor", () => {
    expect(job).toMatch(/^\s+needs: \[\]\s*(#.*)?$/m);
  });

  it("is not interruptible", () => {
    expect(job).toMatch(/^\s+interruptible: false\s*(#.*)?$/m);
  });

  it("extends .deploy_base, which is what gives it kubectl and the agent", () => {
    // The replica reading cannot come from `/api/health`: a container cannot see
    // its own Deployment's replica count. It needs the cluster, and the agent
    // context .deploy_base already configures is the credential that exists.
    expect(job).toMatch(/^\s+extends: \.deploy_base\b/m);
  });

  it("does not retry, so a flaky run cannot mask a real alert", () => {
    expect(job).not.toMatch(/^\s+retry:/m);
  });
});

describe("the schedule-flag guards", () => {
  /**
   * `.gitlab-ci.yml` states the rule: "Each flag variable gets a `when: never`
   * guard on every OTHER scheduled job… Add a flag, add its guards." Without it,
   * a monitor schedule running every hour would ALSO rebuild the image, re-run
   * every scanner and post an ops digest — 24 times a day.
   *
   * Mirrors `security-assessment.test.ts`'s structural assertion rather than
   * counting, so a future flag added to only some rule blocks fails here.
   */
  const lines = CI_YML.split("\n");
  const guardIndexes = (flag: string) =>
    lines
      .map((line, i) => (line.includes(`$${flag} == "true"'`) ? i : -1))
      .filter((i) => i !== -1);

  it("guards the same rule blocks SECURITY_ASSESSMENT guards", () => {
    const isGuard = (i: number) => lines[i + 1]?.trim() === "when: never";
    const assessment = guardIndexes("SECURITY_ASSESSMENT").filter(isGuard);
    const monitor = guardIndexes("PROD_STATE_CHECK").filter(isGuard);
    expect(assessment.length).toBeGreaterThan(4);
    expect(monitor).toHaveLength(assessment.length);
    for (const [n, index] of assessment.entries()) {
      expect(monitor[n], `guard missing near line ${index + 1}`).toBe(
        index + 2,
      );
    }
  });

  it("keeps ops_digest off the monitor schedule", () => {
    // ops_digest's last rule is a bare `schedule` catch-all, so without an
    // explicit guard the hourly monitor schedule would post an hourly digest.
    const job = (CI_YML.split(/^ops_digest:$/m)[1] ?? "").split(/^\S/m)[0];
    expect(job).toContain('$PROD_STATE_CHECK == "true"');
  });

  it("documents the fifth schedule where the other four are listed", () => {
    const header = CI_YML.split("variables:")[0];
    expect(header).toMatch(/PROD_STATE_CHECK=true/);
    expect(header).toMatch(/production state/i);
  });
});
