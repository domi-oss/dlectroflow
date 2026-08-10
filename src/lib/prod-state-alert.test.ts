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
import { blocksGuarding, guardParityGaps } from "./ci-schedule-guards";

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
# Any PARSING form fails: -d (GNU and busybox) and -j -f (BSD). "What time is it
# now" still works. The first cut of this stub only looked for a '+%s' argument,
# which every one of those invocations also carries — so it answered a valid epoch
# for all of them, the age was computed after all, and the two tests that depend
# on an unparseable date were passing for the wrong reason.
fmt=""
for arg in "$@"; do
  case "$arg" in
    -d | -j | -f) exit 1 ;;
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
  progressDeadline = 600 as number | null,
  image = "registry.test/dlectroflow:main-0d47b2f",
}: {
  desired?: number;
  available?: number | null;
  ready?: number | null;
  updated?: number | null;
  progressing?: { status: string; reason: string } | null;
  availableCondition?: { status: string; reason: string } | null;
  progressDeadline?: number | null;
  image?: string;
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
  const spec: Record<string, unknown> = {
    replicas: desired,
    template: { spec: { containers: [{ name: "app", image }] } },
  };
  // Absent is the common real case — the chart sets no progressDeadlineSeconds,
  // so Kubernetes' 600s default applies and nothing writes the field.
  if (progressDeadline !== null)
    spec.progressDeadlineSeconds = progressDeadline;
  return { spec, status };
}

/** A pod list containing one pod whose `migrate` initContainer is wedged. */
function podsWithWedgedMigrate(
  message: string,
  image = "registry.test/dlectroflow:main-0d47b2f",
) {
  return {
    items: [
      {
        metadata: {
          name: "dlectroflow-7c9f4b6d8-2xk9p",
          creationTimestamp: "2026-08-06T13:12:00Z",
        },
        spec: { containers: [{ name: "app", image }] },
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

  it("alerts on a rollout past its deadline even at FULL availability", () => {
    // The hole a second look at the P3009 case found. `maxSurge` is 25% of 2 = 1,
    // so a new rollout adds ONE pod and the two old ones keep serving. If the new
    // pod's `migrate` initContainer is wedged, `availableReplicas` stays at 2 —
    // and a check that returns ✅ as soon as `available >= desired` never looks at
    // the `Progressing` condition and calls a failed deploy healthy.
    //
    // That is the exact shape of the incident's FIRST hours, before the atomic
    // rollback took the old pods down too, and it is the shape that repeats on
    // every merge afterwards because P3009 blocks each later migration. Full
    // availability is not the same claim as a healthy Deployment.
    const run = replicas({
      kubectl: [
        {
          match: "deployment",
          body: deployment({
            available: 2,
            ready: 2,
            updated: 1,
            progressing: {
              status: "False",
              reason: "ProgressDeadlineExceeded",
            },
          }),
        },
        {
          match: "pods",
          body: podsWithWedgedMigrate(
            "Error: P3009 migrate found failed migrations in the target database",
          ),
        },
      ],
    });
    expect(run.status).toBe(1);
    expect(run.stdout).toContain("ProgressDeadlineExceeded");
    expect(run.stdout).toContain("P3009");
    expect(run.stdout).not.toContain("✅");
  });

  it("stays green at full availability while a rollout is legitimately mid-flight", () => {
    // The counterpart, so the rule above does not simply alert on every deploy:
    // `updated < desired` with `Progressing` still True and inside its deadline is
    // what a healthy rollout looks like from the outside.
    const run = replicas({
      kubectl: [
        {
          match: "deployment",
          body: deployment({
            available: 2,
            ready: 2,
            updated: 1,
            progressing: { status: "True", reason: "ReplicaSetUpdated" },
          }),
        },
      ],
    });
    expect(run.status).toBe(0);
    expect(run.stdout).not.toContain("🔴");
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

  it("says the missing replica has no pod at all when none is failing readiness", () => {
    // Found while sweeping the alerter for the collapse Duo named, and it is the
    // same disease: the branch written to explain a genuinely confusing state
    // never rendered, so the note showed a bare "pods that are not ready:"
    // heading with nothing under it and the reader was told nothing at all.
    //
    // `jq -r … | join("\n")` writes a single NEWLINE for an empty list, so the
    // file is 1 byte and `[ -s ]` on it is always true whenever the pod read
    // succeeded. Degraded with every listed pod Ready is real — the missing
    // replica has no pod object at all (unschedulable, quota, a ReplicaSet that
    // cannot create) — and it is the shape where "look at the pods" is the wrong
    // next step, which is precisely why the branch exists.
    const run = replicas({
      kubectl: [
        { match: "deployment", body: deployment({ available: 1, ready: 1 }) },
        { match: "pods", body: { items: [] } },
      ],
    });
    expect(run.status).toBe(1);
    expect(run.stdout).toContain("no pod at all");
    expect(run.stdout).toContain("scheduling, quota");
    expect(run.stdout).not.toContain("pods that are not ready");
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

  it("stays quiet for a rollout that has not exceeded its progress deadline", () => {
    // MEASURED false positive, 2026-08-07: `kubectl get deploy` read `1/2` in
    // production and it was an ordinary transient — the two pods were 62s and
    // 21s old, the second still in `Init:1/3`, and BOTH were already on the new
    // image. `rollout status` returned "successfully rolled out" 90 seconds
    // later. An hourly probe has a real chance of landing inside a rollout, so
    // alerting on the ready count alone would cry wolf several times a week and
    // the alert would be muted — taking the real one with it.
    //
    // The discriminator is NOT a timer of our own. Kubernetes already runs one:
    // `progressDeadlineSeconds` (600s by default) flips `Progressing` to False
    // with reason `ProgressDeadlineExceeded` when a rollout is genuinely stuck.
    // That IS the "degraded for more than N minutes" #191 asks for, so this arm
    // defers to it rather than re-implementing it with a clock this repo has
    // already been burned by twice.
    const run = replicas({
      kubectl: [
        {
          match: "deployment",
          body: deployment({
            available: 1,
            ready: 1,
            updated: 1,
            progressing: { status: "True", reason: "ReplicaSetUpdated" },
          }),
        },
        { match: "pods", body: { items: [] } },
      ],
    });
    expect(run.status).toBe(0);
    expect(run.stdout).not.toContain("🔴");
    // Not a tick either: nothing was verified healthy, it was verified
    // self-limiting. Those are different claims and only one of them is true.
    expect(run.stdout).not.toContain("✅");
    expect(run.stdout).toMatch(/rollout/i);
    expect(run.stdout).toContain("600");
  });

  it("alerts on a stuck rollout — the deadline is what tells them apart", () => {
    // The real incident, 24 hours of it. `helm upgrade --atomic --timeout 20m`
    // kept timing out, and 20m is past the 600s deadline, so `Progressing` read
    // False the whole time. After the atomic rollback the OLD spec's pods also
    // failed, because a wedged migration blocks every image's `migrate deploy` —
    // so it never recovered on its own and never stopped being past the deadline.
    const run = replicas({
      kubectl: [
        {
          match: "deployment",
          body: deployment({
            available: 1,
            ready: 1,
            updated: 1,
            progressing: {
              status: "False",
              reason: "ProgressDeadlineExceeded",
            },
          }),
        },
        { match: "pods", body: { items: [] } },
      ],
    });
    expect(run.status).toBe(1);
    expect(run.stdout).toContain("🔴");
    expect(run.stdout).toContain("ProgressDeadlineExceeded");
  });

  it("alerts when a pod is lost after the rollout completed", () => {
    // `Progressing` True with reason `NewReplicaSetAvailable` means the rollout
    // FINISHED. Degraded after that is not a rollout in flight, it is a replica
    // that went away and is not coming back on its own — the `1/2` that does not
    // move. No deadline will ever flip for this shape, so deferring to one would
    // mean never alerting at all.
    const run = replicas({
      kubectl: [
        {
          match: "deployment",
          body: deployment({ available: 1, ready: 1, updated: 2 }),
        },
        { match: "pods", body: { items: [] } },
      ],
    });
    expect(run.status).toBe(1);
  });

  it("alerts on a rolling deployment whose deadline is too long to rely on", () => {
    // The quiet arm above is only safe because Kubernetes promises to flip the
    // condition within `progressDeadlineSeconds`. If that value is raised beyond
    // the alerting cadence, the promise no longer holds and silence stops being
    // self-limiting — so the property this arm depends on is checked rather than
    // assumed. Without this, one Helm value could turn the monitor off silently.
    const run = replicas({
      kubectl: [
        {
          match: "deployment",
          body: deployment({
            available: 1,
            ready: 1,
            updated: 1,
            progressing: { status: "True", reason: "ReplicaSetUpdated" },
            progressDeadline: 86400,
          }),
        },
        { match: "pods", body: { items: [] } },
      ],
    });
    expect(run.status).toBe(1);
    expect(run.stdout).toContain("86400");
  });

  it("reports whether any pod is on a different image than the current spec", () => {
    // The other half of the measured discriminator: during the transient both
    // pods were on the NEW image; during the outage the surviving pod was the
    // STALE one. A human reading the alert needs that line, and it costs nothing
    // — both images are already in the two documents fetched.
    const run = replicas({
      kubectl: [
        {
          match: "deployment",
          body: deployment({
            available: 1,
            ready: 1,
            image: "registry.test/dlectroflow:main-newsha",
          }),
        },
        {
          match: "pods",
          body: podsWithWedgedMigrate(
            "Error: P3009",
            "registry.test/dlectroflow:main-oldsha",
          ),
        },
      ],
    });
    expect(run.status).toBe(1);
    expect(run.stdout).toContain("main-newsha");
    expect(run.stdout).toContain("main-oldsha");
    expect(run.stdout).toMatch(/different image|stale/i);
  });

  it("neutralises angle brackets in a container message", () => {
    // A BARE `<tag>` breaks the whole surrounding document's Markdown rendering
    // on GitLab — a gotcha this project has already paid for once in an MR
    // description. Stripping backticks is not enough: the message is
    // cluster-supplied text spliced into a note on a public project, and one
    // `<img …>` in a Prisma error would take the rest of the alert's rendering
    // with it, which is the note being unreadable at exactly the wrong moment.
    const run = replicas({
      kubectl: [
        { match: "deployment", body: deployment({ available: 1, ready: 1 }) },
        {
          match: "pods",
          body: podsWithWedgedMigrate("boom <img src=x onerror=alert(1)> end"),
        },
      ],
    });
    expect(run.status).toBe(1);
    expect(run.stdout).not.toContain("<");
    expect(run.stdout).not.toContain(">");
    // The surrounding text still survives, so the message is neutralised rather
    // than discarded.
    expect(run.stdout).toContain("boom");
    expect(run.stdout).toContain("end");
  });

  it("rejects a non-numeric REPLICAS_MAX_PROGRESS_DEADLINE instead of trusting it", () => {
    // Duo review finding: every other operator-settable number in these scripts
    // is validated with a `case … *[!0-9]*` guard — the k8s `deadline` here,
    // `LOOKBACK` and `GRACE` in the siblings — and this one was not. Left
    // unvalidated, `[ "$deadline" -le "$MAX_DEADLINE" ]` is a bash error rather
    // than a comparison, the quiet arm is skipped, and a healthy rolling deploy
    // reads as an alert. A typo in a variable should not turn a monitor into a
    // false-alarm generator.
    const run = replicas({
      kubectl: [
        {
          match: "deployment",
          body: deployment({
            available: 1,
            ready: 1,
            updated: 1,
            progressing: { status: "True", reason: "ReplicaSetUpdated" },
          }),
        },
        { match: "pods", body: { items: [] } },
      ],
      env: { REPLICAS_MAX_PROGRESS_DEADLINE: "30m" },
    });
    // Falls back to the default, so the rollout is still correctly quiet.
    expect(run.status).toBe(0);
    expect(run.stderr).toMatch(/REPLICAS_MAX_PROGRESS_DEADLINE/);
    expect(run.stdout).not.toContain("🔴");
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
    // No age at all, in either direction. The original assertion here only
    // forbade a NEGATIVE one, which a stub that quietly answered every `date`
    // invocation satisfied while computing an age anyway.
    expect(run.stdout).not.toMatch(/hours?\*{0,2} ago/);
    expect(run.stdout).not.toMatch(/under an hour/);
  });

  it("reads a numeric UTC offset as an offset, not as UTC", () => {
    // MEASURED against the live API while verifying this script: GitLab returns
    // `committed_date` as `2026-08-07T09:27:36.000+01:00` — a numeric offset, NOT
    // a `Z` suffix. The first cut stripped everything from the first `.` onward,
    // which removed the fractional seconds AND the offset together, and then
    // parsed the remainder as UTC. The age came out exactly one hour too large in
    // BST, and would be wrong by the offset anywhere else.
    //
    // Asserted as an equivalence rather than against a fixed number, so the test
    // does not need a frozen clock: `09:27:36+01:00` and `08:27:36Z` are the same
    // instant, so both must produce the same age. A parser that drops the offset
    // makes them differ by exactly one hour.
    const hoursFrom = (committed: string) => {
      const out = drift({
        compare: { commits: [{ id: OLD_SHA, committed_date: committed }] },
      }).stdout;
      const match = out.match(/\*\*(\d+) hours?\*\* ago/);
      expect(match, `no age in: ${out}`).not.toBeNull();
      return Number(match?.[1]);
    };
    expect(hoursFrom("2026-08-07T09:27:36.000+01:00")).toBe(
      hoursFrom("2026-08-07T08:27:36.000Z"),
    );
    // And a negative offset moves the other way, so the sign is honoured rather
    // than merely stripped.
    expect(hoursFrom("2026-08-07T04:27:36.000-04:00")).toBe(
      hoursFrom("2026-08-07T08:27:36.000Z"),
    );
  });

  /** A commit date `minutes` in the past, in the offset form GitLab really sends. */
  const minutesAgo = (minutes: number) =>
    new Date(Date.now() - minutes * 60_000)
      .toISOString()
      .replace("Z", "+00:00");

  it("alerts on a recent divergence by default, so existing callers are unchanged", () => {
    // `ops_digest` and `alert_pipeline_failure` both call this script and both
    // WANT drift reported the instant it exists — the latter runs immediately
    // after a pipeline failed, where "the deploy may still be in flight" is
    // exactly the wrong reading. So the grace below is opt-in and off by default.
    const run = drift({
      compare: { commits: [{ id: OLD_SHA, committed_date: minutesAgo(3) }] },
    });
    expect(run.status).toBe(1);
    expect(run.stdout).toContain("🔴");
  });

  it("holds a divergence younger than DRIFT_GRACE_SECONDS", () => {
    // The same reasoning as the replica check's rollout arm, and consistency
    // matters more than either case on its own: an hourly check WILL land inside
    // a normal deploy, where production is legitimately a commit or two behind
    // for a few minutes. Alerting there would fire a spurious email every few
    // days, and a channel that cries wolf gets muted — which is what took the
    // real alert down in the first place.
    const run = drift({
      compare: { commits: [{ id: OLD_SHA, committed_date: minutesAgo(3) }] },
      env: { DRIFT_GRACE_SECONDS: "1500" },
    });
    // 3, not 0 (!293 review). This spec used to assert 0 and so pinned the bug:
    // the two lines below already said "not a tick — nothing was verified in
    // sync", and 0 is precisely the code that means it was. The caller composes
    // its headline from exit codes alone, so returning 0 here published
    // "✅ production has recovered" over a stdout that carries no ✅ at all.
    // The assertion and the return value have to agree about what happened.
    expect(run.status).toBe(3);
    expect(run.stdout).not.toContain("🔴");
    // Not a tick either — nothing was verified in sync, only verified too young
    // to conclude from.
    expect(run.stdout).not.toContain("✅");
    expect(run.stdout).toMatch(/deploy/i);
  });

  it("alerts once the divergence is older than the grace", () => {
    const run = drift({
      compare: { commits: [{ id: OLD_SHA, committed_date: minutesAgo(90) }] },
      env: { DRIFT_GRACE_SECONDS: "1500" },
    });
    expect(run.status).toBe(1);
    expect(run.stdout).toContain("🔴");
  });

  it("alerts rather than holding when the age cannot be established", () => {
    // The grace can only be applied to an age that is known. With no usable
    // `date` there is no age, and the safe direction is to alert — a grace that
    // silently swallows every divergence on an image whose `date` cannot parse
    // ISO-8601 would be a monitor switched off by its own helper.
    const run = drift({
      compare: { commits: [{ id: OLD_SHA, committed_date: minutesAgo(3) }] },
      env: { DRIFT_GRACE_SECONDS: "1500" },
      bin: { date: BROKEN_DATE_STUB },
    });
    expect(run.status).toBe(1);
    expect(run.stdout).toContain("🔴");
  });

  it("picks the oldest missing commit by INSTANT, not by string order", () => {
    // Duo review finding, and a sharp one: the selection step used jq's `min`,
    // which is lexicographic on raw `committed_date` strings that still carry
    // their own UTC offsets. Lexicographic order on non-normalised offsets is not
    // chronological order, so the same offset bug this file takes great care over
    // in the ARITHMETIC was re-introduced in the SELECTION.
    //
    // These two disagree: `05:00-04:00` is 09:00Z, `09:27:36+01:00` is 08:27:36Z.
    // The second is genuinely older; the first sorts first as a string. Choosing
    // the string minimum understates the drift, which is the direction that makes
    // an alert reassuring — the worst way for it to be wrong.
    const run = drift({
      compare: {
        commits: [
          { id: OLD_SHA, committed_date: "2026-08-07T05:00:00.000-04:00" },
          { id: HEAD_SHA, committed_date: "2026-08-07T09:27:36.000+01:00" },
        ],
      },
    });
    expect(run.status).toBe(1);
    expect(run.stdout).toContain("2026-08-07T09:27:36");
    expect(run.stdout).not.toContain("2026-08-07T05:00:00");
  });

  it("keeps the oldest PARSED instant when only some timestamps can be read", () => {
    // The MIXED case, which the test above does not reach: one timestamp the
    // image's `date` cannot convert alongside two it can. The age is suppressed
    // either way and that part is right — an unreadable timestamp could be older
    // than anything that was read, so any number computed from the rest would
    // understate the drift. But the INSTANT was replaced with the plain string
    // minimum of the RAW dates, which is the very lexicographic hazard
    // `iso_to_epoch` exists to remove, thrown away one line after it had already
    // produced the right answer.
    //
    // `05:00-04:00` is 09:00Z and sorts first as a string; `09:27:36+01:00` is
    // 08:27:36Z and is 32 minutes older. Reporting the first says the drift began
    // later than it provably did — understating it, which is the direction that
    // makes an alert reassuring and the one #191 exists to prevent.
    const run = drift({
      compare: {
        commits: [
          { id: OLD_SHA, committed_date: "2026-08-07T05:00:00.000-04:00" },
          { id: HEAD_SHA, committed_date: "2026-08-07T09:27:36.000+01:00" },
          { id: "c".repeat(40), committed_date: "not-a-timestamp" },
        ],
      },
    });
    expect(run.status).toBe(1);
    expect(run.stdout).toContain("2026-08-07T09:27:36");
    expect(run.stdout).not.toContain("2026-08-07T05:00:00");
    // Still no age, for the reason above.
    expect(run.stdout).not.toMatch(/hours?\*{0,2} ago/);
    expect(run.stdout).not.toMatch(/under an hour/);
    // And the note says which claim it is making: the oldest of the ones that
    // could be read is not provably the oldest, so the reader is told the drift
    // may be older rather than being handed a bare instant that looks exact.
    expect(run.stdout).toMatch(/may be older/i);
  });

  it("says the instant is unproven when NO timestamp can be read", () => {
    // The other arm of the same branch. With nothing converted there is no
    // ordering to be had at all, so the string that sorted first is shown because
    // it is all there is — but it must not be labelled "the oldest commit
    // production is missing", which is a chronological claim nothing here
    // supports once there is more than one candidate.
    const run = drift({
      compare: {
        commits: [
          { id: OLD_SHA, committed_date: "2026-08-06T13:12:00.000Z" },
          { id: HEAD_SHA, committed_date: "2026-08-07T09:00:00.000Z" },
        ],
      },
      bin: { date: BROKEN_DATE_STUB },
    });
    expect(run.status).toBe(1);
    expect(run.stdout).toContain("2026-08-06T13:12");
    expect(run.stdout).not.toMatch(/hours?\*{0,2} ago/);
    expect(run.stdout).toMatch(/may be older/i);
    expect(run.stdout).not.toMatch(
      /`2026-08-06T13:12[^`]*` \(the oldest commit production is missing\)/,
    );
  });

  it("prints no stray backslash before a backtick", () => {
    // A `\`` inside a SINGLE-quoted printf format is passed to printf verbatim
    // and renders as a literal backslash — invisible in a shell script, visible
    // to every reader of the note. Found in check-prod-replicas.sh's rollout arm;
    // asserted here because the note IS the product and no other check can see it.
    expect(drift().stdout).not.toContain("\\`");
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
  /** The oldest missing commit's date, for the deploy-in-flight grace. */
  committedDate?: string;
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
            {
              id: OLD_SHA,
              committed_date:
                scenario.committedDate ?? "2026-08-06T13:12:00.000Z",
            },
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

/**
 * The fingerprint line the alerter writes so it can recognise its own state.
 *
 * This must be the marker the script REALLY emits, including the job name in
 * backticks. The first version wrote `_alert-prod-state fingerprint: …_` —
 * hyphens, no backticks — which the script never produces; it only matched
 * because the lookup regex was loose enough to accept anything containing the
 * word. Tightening the regex so an unrelated comment cannot spoof a fingerprint
 * is what exposed it. The round-trip test below is the real guard: it feeds a
 * note the script itself wrote straight back in, so the writer and the reader
 * cannot drift apart again.
 */
function noteWithFingerprint(fingerprint: string) {
  return [
    {
      id: 10,
      body: `### something happened\n\n_\`alert_prod_state\` fingerprint: \`${fingerprint}\`_`,
    },
  ];
}

describe("scripts/alert-prod-state.sh — the healthy path is silent", () => {
  it("does not alert on a deploy that is still in flight", () => {
    // The composite of both grace arms, and the case an hourly schedule meets
    // most often: a merge landed minutes ago, production has not caught up yet,
    // and a rollout is under way. Neither half is an incident and the pair must
    // not add up to one.
    const run = alert({
      prodSha: OLD_SHORT,
      committedDate: new Date(Date.now() - 4 * 60_000)
        .toISOString()
        .replace("Z", "+00:00"),
      deploy: deployment({
        available: 1,
        ready: 1,
        updated: 1,
        progressing: { status: "True", reason: "ReplicaSetUpdated" },
      }),
    });
    expect(run.status).toBe(0);
    expect(run.note).toBeNull();
  });

  /**
   * !293 review, found independently by two reviewers, and the spec above is
   * why it was missed: with no note on record the post is suppressed, so the
   * composed headline is never rendered and `note === null` passes over the top
   * of it. The state that POSTS is the same rollout **with a prior alert
   * fingerprint on record** — and that is the state an hourly monitor meets in
   * the middle of every incident, because each merged fix restarts the
   * `progressDeadlineSeconds` window.
   *
   * What it used to produce, reproduced verbatim before the fix:
   *
   *     ### ✅ production has recovered — on `main`, fully replicated
   *     - `deployment/dlectroflow`: **1/2** replicas available
   *     - 🔄 a rollout is in progress and has not yet exceeded its deadline
   *     Nothing to do.
   *     @handle — cleared, no action needed.
   *
   * Exit 0, so no pipeline mail either. An unproven green addressed to the
   * on-call by name, five lines above evidence reading `1/2`, emitted by the
   * monitor written to abolish unproven greens.
   *
   * Asserted on the words rather than on the severity string: the words are the
   * product, and they are what somebody acts on at 3am.
   */
  it("never words an in-flight deploy as a recovery, even with an alert on record", () => {
    const run = alert({
      prodSha: OLD_SHORT,
      committedDate: new Date(Date.now() - 4 * 60_000)
        .toISOString()
        .replace("Z", "+00:00"),
      deploy: deployment({
        available: 1,
        ready: 1,
        updated: 1,
        progressing: { status: "True", reason: "ReplicaSetUpdated" },
      }),
      notes: noteWithFingerprint("drift=1 replicas=1"),
    });

    // It posts — the state genuinely changed since the alert, and saying nothing
    // would leave the reader with the alert as the last word.
    expect(run.note).not.toBeNull();
    const body = run.note?.body ?? "";
    expect(body).not.toMatch(/recovered/i);
    expect(body).not.toMatch(/fully replicated/i);
    expect(body).not.toMatch(/cleared, no action needed/i);
    expect(body).not.toMatch(/Nothing to do\./);
    // And the positive half, so this cannot pass by posting nothing useful.
    expect(body).toMatch(/deploy is in flight/i);
    expect(body).toMatch(/not.*all-clear/i);
    // Still exit 0: an ordinary deploy must not wake anyone.
    expect(run.status).toBe(0);
  });

  /**
   * The other direction, so the fix cannot be read as "never say recovered".
   * Two proven ticks after an alert is exactly when the channel must close its
   * own loop.
   */
  it("still reports a real recovery after an alert", () => {
    const run = alert({ notes: noteWithFingerprint("drift=1 replicas=1") });
    expect(run.status).toBe(0);
    expect(run.note?.body ?? "").toMatch(/production has recovered/i);
  });

  it("posts nothing and exits 0 when production is current and fully replicated", () => {
    // An alert channel that emits on every healthy run gets muted within a week,
    // and takes the real alert with it.
    const run = alert();
    expect(run.status).toBe(0);
    expect(run.note).toBeNull();
    expect(run.calls.some((c) => c.startsWith("POST"))).toBe(false);
  });

  it("does not mistake a failed notes read for a first run", () => {
    // Duo review finding, and it is the sharper half of the "fails open" claim.
    // A failed notes read leaves `last_fp` empty — indistinguishable from a
    // genuinely first run — so the healthy path took the "nothing on record, stay
    // quiet" shortcut and dropped a recovery note on a transient HTTP error.
    //
    // Which is worse than the duplicate the design was willing to accept: with no
    // recovery marker written, the newest fingerprint on the issue stays the OLD
    // alert, so the next recurrence of the same signature reads as "unchanged
    // since the last note" and a real new incident is silently suppressed.
    //
    // So the quiet shortcut now requires the read to have actually succeeded.
    const run = alert({ notes: false });
    expect(run.note?.body).toContain("✅");
    // And it says why it appeared, so a reader is not told production "recovered"
    // from something that may never have been broken.
    expect(run.note?.body?.toLowerCase()).toContain("de-duplication");
    expect(run.status).toBe(0);
  });

  it("stays quiet on a healthy run when the read SUCCEEDS and finds nothing", () => {
    // The counterpart, so the fix above does not simply post every hour: an
    // empty-but-successful read is a real first run and silence is correct.
    const run = alert({ notes: [] });
    expect(run.note).toBeNull();
    expect(run.status).toBe(0);
  });

  it("does not claim the job keeps failing in a note that says all is well", () => {
    // The note is the product, and a line that is false on the good days is a
    // line nobody reads on the bad ones. Caught by rendering a real note against
    // production rather than by any assertion: the healthy headline said
    // "recovered" directly above "the job's exit code keeps failing".
    const healthy = alert({ notes: noteWithFingerprint("drift=1 replicas=0") });
    expect(healthy.note?.body).toContain("fingerprint: `drift=0 replicas=0`");
    expect(healthy.note?.body).not.toMatch(/keeps failing/);
    // Still said where it IS true.
    const bad = alert({ prodSha: OLD_SHORT });
    expect(bad.note?.body).toMatch(/keeps failing/);
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

  it("recognises a fingerprint it wrote itself — round trip", () => {
    // The writer and the reader of the fingerprint are the same script, and a
    // marker that only a hand-written fixture matches is a de-duplicator that
    // never de-duplicates in production — silently, and in the direction of
    // repeating every alert every hour until the channel is muted.
    //
    // So this takes the note the FIRST run actually posted, feeds that exact body
    // back as the issue's existing note, and asserts the second run stays quiet.
    // No fixture is involved, so no fixture can be wrong.
    const first = alert({ prodSha: OLD_SHORT });
    expect(first.note?.body).toBeTypeOf("string");
    const second = alert({
      prodSha: OLD_SHORT,
      notes: [{ id: 99, body: first.note?.body }],
    });
    expect(second.note).toBeNull();
    expect(second.status).not.toBe(0);
    expect(second.stdout).toContain("unchanged");
  });

  it("ignores a fingerprint-shaped line in somebody else's comment", () => {
    // A human quoting an old alert, or another job with its own marker, must not
    // be able to suppress a real alert.
    const run = alert({
      prodSha: OLD_SHORT,
      notes: [
        {
          id: 98,
          body: "I think the fingerprint: `drift=1 replicas=0` is stale",
        },
      ],
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

  it("does not blame a migration when it could not read anything", () => {
    // Duo review finding. The recovery text was identical for every non-healthy
    // severity and opened with "a failed migration blocks every later one, so
    // start there" — including when the state is UNDETERMINED because the cluster
    // could not be read or production was unreachable. Sending an on-call
    // responder to the migrations at 2am when the actual problem is that the check
    // has no credentials is a wrong first instruction, and the note is the
    // product.
    const run = alert({ prodSha: null, deploy: false });
    expect(run.status).not.toBe(0);
    expect(run.note?.body).not.toMatch(/failed migration/i);
    expect(run.note?.body?.toLowerCase()).toMatch(/establish|could not/);
  });

  it("does not blame a migration for a drift-only alert either", () => {
    // Same finding, the other arm: production behind `main` with every replica
    // available is a deploy that did not happen, not a wedged migration.
    const run = alert({ prodSha: OLD_SHORT });
    expect(run.status).not.toBe(0);
    expect(run.note?.body).not.toMatch(/failed migration/i);
  });

  it("DOES point at the migration path when replicas are the problem", () => {
    // The counterpart, so the fix does not simply delete the useful guidance:
    // this is the shape where a wedged migration is the likeliest cause.
    const run = alert({
      deploy: deployment({ available: 1, ready: 1 }),
      pods: podsWithWedgedMigrate("Error: P3009"),
    });
    expect(run.status).not.toBe(0);
    expect(run.note?.body).toMatch(/migration/i);
    expect(run.note?.body).toContain("§ 19");
  });

  /**
   * The claim "every replica is available" in a note where the replica check
   * exited **2**.
   *
   * This is the defining bug of #191 wearing the alerter's own clothes: the
   * three-state contract exists so "we could not look" never renders as "it is
   * fine", and a recovery instruction that opens by asserting capacity is fine —
   * on the strength of a `kubectl` read that was REFUSED — is that collapse
   * committed in the one sentence somebody acts on at 3am.
   *
   * Asserted as a pair on purpose. The negative alone is satisfied by deleting
   * the sentence, which would throw away a true and useful fact on the arm where
   * the check really did return 0.
   */
  it("never claims availability off a replica check that returned UNDETERMINED", () => {
    const unknown = alert({ prodSha: OLD_SHORT, deploy: false });
    expect(unknown.status).not.toBe(0);
    expect(unknown.note?.body).not.toMatch(
      /every replica[^.\n]{0,24}available/i,
    );
    expect(unknown.note?.body).toMatch(
      /replica count could not be determined/i,
    );

    // Same alert, replica check genuinely green: the claim is proven, so it stays.
    const proven = alert({ prodSha: OLD_SHORT });
    expect(proven.note?.body).toMatch(/every replica[^.\n]{0,24}available/i);
    expect(proven.note?.body).not.toMatch(
      /replica count could not be determined/i,
    );
  });

  it("carries BOTH recovery paths when drift and replicas alert together", () => {
    // Duo review finding. The guidance was picked from one check rather than
    // composed from both, so a simultaneous alert sent the reader to the
    // migrations and never mentioned that the deploy had not landed either.
    const run = alert({
      prodSha: OLD_SHORT,
      deploy: deployment({ available: 1, ready: 1 }),
      pods: podsWithWedgedMigrate("Error: P3009"),
    });
    expect(run.status).not.toBe(0);
    // The replica half.
    expect(run.note?.body).toContain("§ 19");
    expect(run.note?.body).toMatch(/migration/i);
    // The drift half, which used to be dropped entirely.
    expect(run.note?.body).toContain("deploy_production");
    expect(run.note?.body).toContain("#147");
  });

  it("names an undetermined companion in the headline, not one clean fault", () => {
    // The sibling of the finding above, found by sweeping for the same `!= 1`
    // shape: the headline chain also treated 0 and 2 alike, so a proven fault
    // beside a check that could not read anything rendered as a complete,
    // single-fault diagnosis. The headline is the line that gets read.
    const driftProven = alert({ prodSha: OLD_SHORT, deploy: false });
    expect(driftProven.note?.body?.split("\n")[0]).toMatch(/undetermined/i);

    const replicasProven = alert({
      prodSha: null,
      deploy: deployment({ available: 1, ready: 1 }),
      pods: podsWithWedgedMigrate("Error: P3009"),
    });
    expect(replicasProven.note?.body?.split("\n")[0]).toMatch(/undetermined/i);

    // And a genuinely single-fault alert is NOT hedged, or the word stops
    // meaning anything.
    expect(
      alert({ prodSha: OLD_SHORT }).note?.body?.split("\n")[0],
    ).not.toMatch(/undetermined/i);
  });

  it("says WHICH check could not be established, not merely that one could not", () => {
    // "Could not determine" is a third answer, not a softer way of saying
    // unhealthy — so the note has to name the check it applies to. The old text
    // said "one of the two checks", which is also simply untrue when BOTH of
    // them failed to read anything, as here.
    const run = alert({ prodSha: null, deploy: false });
    expect(run.status).not.toBe(0);
    expect(run.note?.body).toMatch(
      /whether production is running `main` could not be determined/i,
    );
    expect(run.note?.body).toMatch(/replica count could not be determined/i);
    expect(run.note?.body).not.toMatch(/one of the two checks/i);
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

  it("falls back to OPS_DIGEST_ISSUE_IID when ALERT_ISSUE_IID is unset", () => {
    // Duo review finding, and a fair one: the MR description calls this the
    // load-bearing default — "the alert lands on the standing ops issue" — and
    // nothing exercised it, because `drive()` always sets `ALERT_ISSUE_IID`. The
    // fallback is the reason this job needs no new setup at all, so it is exactly
    // the line that should not be taken on trust.
    //
    // Asserted on the URL rather than on "a note was posted": posting to the
    // WRONG issue would satisfy the weaker assertion while sending the alert
    // somewhere nobody is looking, which is the failure this whole MR is about.
    const FALLBACK_IID = "33";
    const run = drive(ALERT_SCRIPT, {
      routes: [
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
          method: "GET",
          match: "/repository/compare",
          body: {
            commits: [
              { id: OLD_SHA, committed_date: "2026-08-06T13:12:00.000Z" },
            ],
          },
        },
        { method: "GET", match: `/issues/${FALLBACK_IID}/notes`, body: [] },
        {
          method: "POST",
          match: `/issues/${FALLBACK_IID}/notes`,
          body: { id: 1 },
          code: 201,
        },
      ],
      kubectl: [
        { match: "deployment", body: deployment() },
        { match: "pods", body: { items: [] } },
      ],
      env: {
        ALERT_ISSUE_IID: undefined,
        OPS_DIGEST_ISSUE_IID: FALLBACK_IID,
      },
    });
    expect(run.status).not.toBe(0);
    expect(run.note?.body).toContain("🔴");
    expect(
      run.calls.some((c) =>
        c.startsWith(
          `POST ${API}/projects/${PROJECT_ID}/issues/${FALLBACK_IID}/notes`,
        ),
      ),
      `POSTs were: ${run.calls.filter((c) => c.startsWith("POST")).join(", ")}`,
    ).toBe(true);
    // And nothing reached the iid the harness normally uses, so the assertion
    // above cannot be satisfied by the default leaking through.
    expect(run.calls.join("\n")).not.toContain(`/issues/${ISSUE_IID}/`);
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

  /**
   * !293 review — the one property the whole MR rests on, and the only one
   * nothing pinned. Adding `allow_failure: true` to this job left **260 tests
   * across seven CI-hygiene suites green**, verified by applying exactly that
   * mutation.
   *
   * It is a plausible edit, not a contrived one: quietening a flapping monitor
   * mid-incident is precisely when someone would reach for it. The job would go
   * on exiting non-zero and go on posting its note — and the pipeline would stay
   * green, so GitLab would send the schedule owner nothing. That is channel 1,
   * the one the runbook calls out as needing no configuration and being
   * impossible to forget, silently removed.
   *
   * `.deploy_base` is checked too rather than assumed: `extends` inherits, so a
   * later `allow_failure` added there would arrive here without touching this
   * block.
   */
  it("never allows failure — the red pipeline IS the alert channel", () => {
    expect(job).not.toMatch(/^\s+allow_failure:\s*true/m);
    const base = (CI_YML.split(/^\.deploy_base:$/m)[1] ?? "").split(/^\S/m)[0];
    expect(base).not.toBe("");
    expect(base).not.toMatch(/^\s+allow_failure:\s*true/m);
  });

  it("stays in the maintenance stage and keeps its hang timeout", () => {
    // Both are overrides and both are load-bearing. `.deploy_base` puts a job in
    // `deploy`, and a monitor carrying deploy semantics is a monitor that gets
    // reasoned about as a deployment. The timeout is what turns a hung check —
    // the cluster unreachable, `curl` never answering — into a red pipeline
    // rather than a job that sits there being neither healthy nor an alert.
    expect(job).toMatch(/^\s+stage: maintenance\b/m);
    expect(job).toMatch(/^\s+timeout: \d+m\b/m);
  });
});

describe("the schedule-flag guards", () => {
  /**
   * `.gitlab-ci.yml` states the rule: "Each flag variable gets a `when: never`
   * guard on every OTHER scheduled job… Add a flag, add its guards." Without it, a
   * monitor schedule running every hour would ALSO rebuild the image, re-run every
   * scanner and post an ops digest — 24 times a day.
   *
   * This used to be asserted with line arithmetic: every `SECURITY_ASSESSMENT`
   * guard had to have a `PROD_STATE_CHECK` guard exactly two lines below it, plus
   * `expect(count).toBeGreaterThan(4)`. Duo review flagged it and was right — that
   * asserts incidental formatting, not intent. Reordering conditions inside a rule
   * block, or inserting one comment between two guards, failed a test whose
   * subject was untouched, and the magic 4 described a different job's rule count.
   *
   * The parsing now lives in `src/lib/ci-schedule-guards.ts`, which is a pure
   * module with a colocated test that exercises it on synthetic input — so the
   * assertion can be shown to catch a missing guard rather than merely passing.
   */
  it("guards PROD_STATE_CHECK wherever any other flag is guarded", () => {
    expect(guardParityGaps(CI_YML)).toEqual([]);
    // Named separately so this test fails if the flag is dropped entirely, which
    // "no gaps" alone would be perfectly happy about.
    const blocks = blocksGuarding(CI_YML, "PROD_STATE_CHECK");
    expect(
      blocks,
      `PROD_STATE_CHECK is guarded in: ${blocks.join(", ")}`,
    ).toContain("ops_digest");
    expect(blocks.length).toBeGreaterThan(1);
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

describe("the runbook sections the alert points at", () => {
  /**
   * An alert whose "what to do next" line cites a section that does not exist is
   * worse than one that cites nothing, because the reader spends their first
   * minute of an incident looking for it.
   *
   * This caught a real error while #191 was being written: the note pointed at
   * "§ 17 for the wedged-migration path" and § 17 is the container registry. The
   * migration path was not documented anywhere at all — the recovery had been
   * performed once and never written down. No cluster, no API and no pipeline was
   * needed to see that; only reading the diff's own prose against the file it
   * refers to, which is the cheapest class of bug there is.
   */
  const RUNBOOK = readFileSync(
    join(REPO_ROOT, "docs/deploy-runbook.md"),
    "utf8",
  );
  const script = readFileSync(ALERT_SCRIPT, "utf8");

  it("every § the alert cites is a real heading", () => {
    const cited = [...script.matchAll(/§ (\d+)/g)].map((m) => Number(m[1]));
    expect(cited.length).toBeGreaterThan(0);
    const headings = new Set(
      [...RUNBOOK.matchAll(/^## (\d+)[.b]/gm)].map((m) => Number(m[1])),
    );
    for (const section of cited) {
      expect(
        headings.has(section),
        `alert-prod-state.sh cites § ${section}, which docs/deploy-runbook.md does not have`,
      ).toBe(true);
    }
  });

  it("documents the monitor and the wedged-migration recovery it points at", () => {
    expect(RUNBOOK).toMatch(/^## 18\. .*monitor/im);
    expect(RUNBOOK).toMatch(/^## 19\. .*P3009/im);
    // The setup the operator actually has to perform, in the file they read to
    // deploy. A schedule that exists only in project settings is invisible.
    expect(RUNBOOK).toContain("PROD_STATE_CHECK=true");
    expect(RUNBOOK).toContain("ALERT_MENTION");
    // The escalation question #191 asked to DECIDE rather than leave to accident.
    expect(RUNBOOK).toMatch(/waits until morning/i);
  });
});
