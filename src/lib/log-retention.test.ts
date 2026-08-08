/**
 * `scripts/check-log-retention.sh`, its repo-side consistency guard and its
 * wiring into the weekly digest (#157).
 *
 * ── The failure this is about ────────────────────────────────────────────────
 * Two independent settings have to agree before a single log line is kept, and
 * neither can see the other: the cluster's `loggingConfig`, which decides what
 * to ship, and the project's `logging.googleapis.com` service, which decides
 * whether anything accepts it. With only the first in place the cluster ships
 * logs to somewhere that will not take them — nothing errors, and an
 * application log line lives in a running pod's buffer until Autopilot recycles
 * the pod. Each setting reads as correct on its own, so nothing surfaces the
 * contradiction.
 *
 * So the thing under test is not "is logging configured" — that question can
 * answer yes while the answer is worthless. It is **"can a log line
 * be read back?"**, asked of the artefact, and it is deliberately built so that
 * the three outcomes stay three:
 *
 *   0  a real entry was read back inside the window, and the bucket keeps it
 *      for at least as long as this repo says it should
 *   1  proven not retained
 *   2  undetermined — the check could not see, which is an unknown and NOT an
 *      all-clear
 *
 * The `check-prod-drift.sh` contract, on purpose: same exit codes, same
 * "Markdown bullets, no heading" stdout, same rule that a caller collapsing 2
 * into 0 has reintroduced the bug. The two most dangerous cases each get their
 * own test — **a successful query that returns nothing is `1`, not `0`**, and a
 * query that could not run is `2`, not `1`.
 *
 * ── Why the script, and not a CI job that reads the API state ────────────────
 * There is no Google Cloud credential in this project's CI. `deploy_production`
 * authenticates to the cluster through the GitLab Kubernetes agent
 * (`kubectl config use-context "$AGENT_CONTEXT"`) and `.gitlab-ci.yml` contains
 * no `gcloud`, no `cloud-sdk` image and no `GOOGLE_APPLICATION_CREDENTIALS`. A
 * job asserting "the project-level API is enabled" could therefore only ever
 * report that it could not look — and a guard that quietly stops guarding is
 * the fault being fixed, not a fix for it. What CI *can* enforce without a
 * credential is that the repo's own surfaces still agree with each other, and
 * that the digest publishes an unknown as an unknown; both are asserted below.
 *
 * The script is driven for real with `gcloud` stubbed on PATH — the
 * `pipeline-failure-alert.test.ts` / `registry-prune.test.ts` idiom. A
 * re-implementation of a script inside its own test proves nothing about the
 * script.
 */
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { retentionDaysFlags, shellDefault } from "./log-retention";
import { stripShellComments } from "./source-text";

const REPO_ROOT = process.cwd();
const SCRIPT = join(REPO_ROOT, "scripts/check-log-retention.sh");
const DIGEST = join(REPO_ROOT, "scripts/ops-digest.sh");
const RUNBOOK = join(REPO_ROOT, "docs/deploy-runbook.md");
const CI_YML = join(REPO_ROOT, ".gitlab-ci.yml");

/**
 * Same guard `pipeline-failure-alert.test.ts` carries: without it a missing
 * `bash` presents as every assertion failing on an EMPTY stderr, because it was
 * the *spawn* that failed rather than the script.
 */
{
  const found = spawnSync("sh", ["-c", "command -v bash"], {
    encoding: "utf8",
  });
  if (found.status !== 0) {
    throw new Error(
      "bash is not on PATH, so scripts/check-log-retention.sh cannot be " +
        "tested. Install it (CI: the apk line in test_app's before_script).",
    );
  }
}

/**
 * A project id shaped like a real one. Every assertion that this string never
 * reaches stdout is load-bearing: the digest posts its output as a note on an
 * issue in a **public** project, so the script reports *categories* of failure
 * and never echoes an identifier or a raw provider error.
 */
const PROJECT = "stub-prod-project-8471";

/**
 * Test stub for `gcloud`. Routes are `argv-substring|exit-code|body`, matched in
 * order against the space-joined argv; the first match wins. A non-zero code
 * sends the body to stderr instead of stdout, which is how a provider error
 * message is forged. An unrouted call exits 64 and says so on stderr, so "the
 * script asked something nobody expected" is a visible failure rather than a
 * silently empty answer.
 */
const GCLOUD_STUB = `#!/usr/bin/env bash
set -u
argv="$*"
printf '%s\\n' "$argv" >> "$STUB_LOG"
while IFS='|' read -r sub code body; do
  [ -n "\${sub:-}" ] || continue
  case "$argv" in *"$sub"*) ;; *) continue ;; esac
  if [ "\${code:-0}" = "0" ]; then
    [ -n "\${body:-}" ] && printf '%s\\n' "$body"
    exit 0
  fi
  [ -n "\${body:-}" ] && printf '%s\\n' "$body" >&2
  exit "$code"
done < "$STUB_ROUTES"
printf 'stub: unrouted gcloud %s\\n' "$argv" >&2
exit 64
`;

interface Route {
  /** Substring of the space-joined argv. */
  match: string;
  code?: number;
  body?: string;
}

interface Harness {
  routes: Route[];
  env?: Record<string, string | undefined>;
  /** Omit the `gcloud` stub entirely — the "not installed" case. */
  noGcloud?: boolean;
}

interface Result {
  status: number;
  stdout: string;
  stderr: string;
  /** One line per `gcloud` invocation, space-joined argv. */
  calls: string[];
}

/** The real gcloud message, verbatim in shape, for a disabled service. */
const SERVICE_DISABLED_ERR =
  "ERROR: (gcloud.logging.read) PERMISSION_DENIED: Cloud Logging API has not " +
  `been used in project ${PROJECT} before or it is disabled. Enable it by ` +
  `visiting https://console.developers.google.com/apis/api/logging.googleapis.com/overview?project=${PROJECT} ` +
  "then retry. reason: SERVICE_DISABLED";

/**
 * The external commands `check-log-retention.sh` shells out to, plus the two
 * that make it runnable at all: `bash` itself, which `spawnSync` and the stubs'
 * `#!/usr/bin/env bash` both resolve through PATH. Everything else the script
 * uses is a shell builtin. Symlinked into a private directory so PATH can be
 * exactly `<stubs>:<these>` and nothing else — see `drive`.
 */
const REQUIRED_TOOLS = ["bash", "mktemp", "cat", "rm"];

function resolveTool(name: string): string {
  const found = spawnSync("sh", ["-c", `command -v ${name}`], {
    encoding: "utf8",
  });
  const path = (found.stdout ?? "").trim();
  if (found.status !== 0 || path === "") {
    throw new Error(`${name} is not on PATH, so the #157 check cannot be run.`);
  }
  return path;
}

function drive(harness: Harness): Result {
  const work = mkdtempSync(join(tmpdir(), "logret-157-"));
  const bin = join(work, "bin");
  mkdirSync(bin);
  if (!harness.noGcloud) {
    writeFileSync(join(bin, "gcloud"), GCLOUD_STUB, { mode: 0o755 });
  }

  // A PATH built from nothing, not the ambient one with a stub in front. On a
  // machine where gcloud is installed under /usr/bin — which is where a package
  // manager puts it — an inherited PATH means the `noGcloud` case silently
  // finds the REAL gcloud and interrogates whatever project happens to be
  // active. Read-only or not, a test that reaches a live cloud project is not a
  // test, and it would pass on a laptop with no gcloud and behave differently
  // on one with it.
  const tools = join(work, "tools");
  mkdirSync(tools);
  for (const name of REQUIRED_TOOLS) {
    symlinkSync(resolveTool(name), join(tools, name));
  }

  const routesFile = join(work, "routes");
  writeFileSync(
    routesFile,
    harness.routes
      .map((r) => `${r.match}|${r.code ?? 0}|${r.body ?? ""}`)
      .join("\n") + "\n",
  );
  const log = join(work, "stub.log");
  writeFileSync(log, "");

  // Hermetic: the ambient environment is NOT spread in either. A real gcloud
  // configuration on the machine running the suite must never reach a script
  // whose job is to interrogate a production project.
  const env: NodeJS.ProcessEnv = {
    PATH: `${bin}:${tools}`,
    HOME: work,
    NODE_ENV: "test",
    STUB_ROUTES: routesFile,
    STUB_LOG: log,
    LOG_PROJECT: PROJECT,
    ...harness.env,
  };
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete env[key];
  }

  const run = spawnSync("bash", [SCRIPT], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env,
  });
  return {
    status: run.status ?? -1,
    stdout: run.stdout ?? "",
    stderr: run.stderr ?? "",
    calls: readFileSync(log, "utf8").split("\n").filter(Boolean),
  };
}

/** Everything healthy: API enabled, both reads answer, bucket keeps 30 days. */
const healthyRoutes = (): Route[] => [
  { match: "services list", body: "logging.googleapis.com" },
  {
    match: `namespace_name="dlectroflow-prod"`,
    body: "2026-08-04T09:12:00.123456Z",
  },
  { match: "logging read", body: "2026-08-04T09:12:04.998001Z" },
  { match: "logging buckets describe", body: "30" },
];

// ── the pure helpers ─────────────────────────────────────────────────────────

describe("shellDefault", () => {
  it("reads the default out of a `${VAR:-value}` binding", () => {
    expect(
      shellDefault(
        'LOG_RETENTION_DAYS="${LOG_RETENTION_DAYS:-30}"',
        "LOG_RETENTION_DAYS",
      ),
    ).toBe("30");
  });

  it("reads an unquoted binding", () => {
    expect(shellDefault("FRESHNESS=${FRESHNESS:-1h}", "FRESHNESS")).toBe("1h");
  });

  it("returns null when the variable is not bound", () => {
    expect(
      shellDefault('OTHER="${OTHER:-7}"', "LOG_RETENTION_DAYS"),
    ).toBeNull();
  });

  it("returns null for a binding with no `:-` default", () => {
    // `FOO="$FOO"` declares nothing about what the value should be, and
    // guessing one would let the consistency test below pass vacuously.
    expect(shellDefault('FOO="$FOO"', "FOO")).toBeNull();
  });

  it("ignores a binding that only appears inside a comment", () => {
    // The #30 / #76 / #150 fault, in shell: this repo writes long explanatory
    // headers, and the script most likely to be misread is the one whose
    // subject matter IS the value being parsed.
    const source = [
      '# Historically LOG_RETENTION_DAYS="${LOG_RETENTION_DAYS:-7}" — see #157.',
      'LOG_RETENTION_DAYS="${LOG_RETENTION_DAYS:-30}"',
    ].join("\n");
    expect(shellDefault(source, "LOG_RETENTION_DAYS")).toBe("30");
  });

  it("returns null when the only occurrence is commented out", () => {
    expect(
      shellDefault(
        '# LOG_RETENTION_DAYS="${LOG_RETENTION_DAYS:-7}"',
        "LOG_RETENTION_DAYS",
      ),
    ).toBeNull();
  });

  it("does not treat a `#` inside a single-quoted string as a comment", () => {
    expect(
      shellDefault(`FILTER='severity#x'\nDAYS="\${DAYS:-30}"`, "DAYS"),
    ).toBe("30");
  });
});

describe("retentionDaysFlags", () => {
  it("finds every --retention-days flag", () => {
    expect(
      retentionDaysFlags("a --retention-days=30 b --retention-days=400 c"),
    ).toEqual([30, 400]);
  });

  it("accepts the space-separated spelling gcloud also takes", () => {
    expect(retentionDaysFlags("--retention-days 30")).toEqual([30]);
  });

  it("returns an empty array when the flag is absent", () => {
    expect(
      retentionDaysFlags("gcloud logging buckets describe _Default"),
    ).toEqual([]);
  });
});

// ── the repo's own surfaces agree (no credential needed) ─────────────────────

describe("the retention window is stated once", () => {
  const script = readFileSync(SCRIPT, "utf8");
  const runbook = readFileSync(RUNBOOK, "utf8");

  it("the script declares a default retention window", () => {
    expect(shellDefault(script, "LOG_RETENTION_DAYS")).toMatch(/^\d+$/);
  });

  it("every --retention-days in the runbook matches the script's default", () => {
    // The contradiction this whole issue is about, in the one place CI can
    // actually see it: a runbook that tells the operator to set 7 days while
    // the check asserts 30 would report "not retained" forever, and the
    // instinct would be to relax the check rather than fix the drift.
    const declared = Number(shellDefault(script, "LOG_RETENTION_DAYS"));
    const flags = retentionDaysFlags(runbook);
    expect(flags.length).toBeGreaterThan(0);
    for (const days of flags) expect(days).toBe(declared);
  });

  it("the runbook documents both the enable step and the read-back check", () => {
    expect(runbook).toContain("gcloud services enable logging.googleapis.com");
    expect(runbook).toContain("scripts/check-log-retention.sh");
  });

  it("the runbook writes down WHY that window and not another", () => {
    // "Decide the retention window deliberately and write the reason down" —
    // a number with no reason is a default accepted silently.
    const section = runbook.split("## 16.")[1] ?? "";
    expect(section).not.toBe("");
    expect(section.toLowerCase()).toContain("ingestion");
  });

  it("the script is executable", () => {
    // `bash scripts/…` is how the digest calls it, but an operator pasting the
    // path from the runbook runs it directly, and a 0644 script fails there
    // with a message about permissions rather than about logging.
    expect(statSync(SCRIPT).mode & 0o111).not.toBe(0);
  });
});

describe("the weekly digest publishes the verdict", () => {
  const digest = readFileSync(DIGEST, "utf8");

  it("calls the check", () => {
    expect(digest).toContain("check-log-retention.sh");
  });

  it("maps all three exit codes, and never reports an unknown as an all-clear", () => {
    const stripped = stripShellComments(digest);
    const block = stripped.split("check-log-retention.sh")[1] ?? "";
    const arm = block.split("esac")[0] ?? "";
    expect(arm).toContain("✅");
    expect(arm).toContain("🔴");
    expect(arm).toContain("⚠️");
    // The default arm — anything that is not 0 or 1 — must be the warning, the
    // same shape check-prod-drift.sh's caller uses.
    expect(arm).toMatch(/\*\)\s*[a-z_]+="⚠️/);
  });

  it("no longer points the error-log gap at the closed scheduling epic", () => {
    // The digest's "Error-log scan: n/a until structured logging lands (#29)"
    // outlived its issue: #29 was closed as an epic about scheduling for
    // open-source, so the pointer sent a reader somewhere with no bearing on
    // logs at all. #157 is where that gap actually lives now.
    expect(digest).not.toContain("structured logging lands (#29)");
  });
});

describe("the ops_digest CI job", () => {
  const job = (
    readFileSync(CI_YML, "utf8").split(/^ops_digest:$/m)[1] ?? ""
  ).split(/^\S/m)[0];

  it("exists", () => {
    expect(job).not.toBe("");
  });

  it("still runs only on schedules, and on no flagged one", () => {
    // The digest's last rule is a bare `schedule` catch-all, so each new flag
    // needs an explicit guard here or the digest rides that flag's schedule.
    // #191's PROD_STATE_CHECK is HOURLY, so the missing guard would have meant 24
    // weekly digests a day. `pipeline-failure-alert.test.ts` asserts the same
    // list — both are kept because each arrived with a different digest section
    // and neither should be the only place this is pinned.
    const ifs = (job.split(/^ {2}rules:$/m)[1] ?? "")
      .split("\n")
      .filter((line) => line.includes("if:"));
    expect(ifs).toEqual([
      `    - if: '$CI_PIPELINE_SOURCE == "schedule" && $RENOVATE_RUN == "true"'`,
      `    - if: '$CI_PIPELINE_SOURCE == "schedule" && $REGISTRY_PRUNE == "true"'`,
      `    - if: '$CI_PIPELINE_SOURCE == "schedule" && $SECURITY_ASSESSMENT == "true"'`,
      `    - if: '$CI_PIPELINE_SOURCE == "schedule" && $PROD_STATE_CHECK == "true"'`,
      `    - if: '$CI_PIPELINE_SOURCE == "schedule"'`,
    ]);
  });

  it("says in-file why the log check reads undetermined there", () => {
    // The job runs on alpine with no Google Cloud credential, so this check
    // reports ⚠️ every week until one is wired. That is the honest answer and
    // it is the point — but an unexplained permanent ⚠️ trains a reader to
    // skip the line, which is how a guard stops guarding.
    expect(job).toContain("check-log-retention.sh");
  });
});

// ── the script itself, driven for real ───────────────────────────────────────

describe("scripts/check-log-retention.sh", () => {
  it("exits 0 only when a log line was actually read back", () => {
    const result = drive({ routes: healthyRoutes() });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/retained/);
    expect(result.stdout).toContain("✅");
  });

  it("treats a successful query returning nothing as NOT retained", () => {
    // The single most important assertion in this file. `gcloud logging read`
    // exiting 0 with empty output is not "fine": it is indistinguishable, to a
    // caller that only looks at the exit code, from a healthy read — and it is
    // the shape every "nothing found" false all-clear in this project has
    // taken. A zero that nobody proved is not a result.
    const result = drive({
      routes: [
        { match: "services list", body: "logging.googleapis.com" },
        { match: "logging read", body: "" },
        { match: "logging buckets describe", body: "30" },
      ],
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("🔴");
    expect(result.stdout).toMatch(/not being retained|no log entry/i);
    expect(result.stdout).not.toContain("✅ ");
  });

  it("names the disabled project-level API when that is the cause", () => {
    const result = drive({
      routes: [
        { match: "services list", body: "" },
        { match: "logging read", code: 1, body: SERVICE_DISABLED_ERR },
        {
          match: "logging buckets describe",
          code: 1,
          body: SERVICE_DISABLED_ERR,
        },
      ],
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("logging.googleapis.com");
    expect(result.stdout).toMatch(/not enabled|disabled/i);
  });

  it("reports the contradiction, not just the symptom", () => {
    // The finding was never "logging is off". It was that one surface said on
    // and another silently made it inert. A verdict that only says "no logs"
    // sends the next reader to the cluster config, which will look correct.
    const result = drive({
      routes: [
        { match: "services list", body: "" },
        {
          match: "container clusters describe",
          body: "SYSTEM_COMPONENTS;WORKLOADS",
        },
        { match: "logging read", code: 1, body: SERVICE_DISABLED_ERR },
        {
          match: "logging buckets describe",
          code: 1,
          body: SERVICE_DISABLED_ERR,
        },
      ],
      env: {
        LOG_CLUSTER: "stub-cluster",
        LOG_CLUSTER_LOCATION: "europe-west2",
      },
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/contradict/i);
  });

  it("is undetermined, not clean, when gcloud is not installed", () => {
    const result = drive({ routes: [], noGcloud: true });
    expect(result.status).toBe(2);
    expect(result.stdout).toContain("⚠️");
    expect(result.stdout).toMatch(/gcloud/);
    expect(result.stdout).not.toContain("✅");
  });

  it("is undetermined, not clean, when no project can be resolved", () => {
    const result = drive({
      routes: [{ match: "config get-value project", body: "" }],
      env: { LOG_PROJECT: undefined },
    });
    expect(result.status).toBe(2);
    expect(result.stdout).toContain("⚠️");
    expect(result.calls.some((c) => c.includes("logging read"))).toBe(false);
  });

  it("is undetermined, not broken, when the read fails for an unclassifiable reason", () => {
    // "Could not ask" and "asked and the answer was no" are different facts.
    // Collapsing them either way is a lie: reporting 1 cries wolf, reporting 0
    // is the unproven green this whole issue exists to kill.
    const result = drive({
      routes: [
        {
          match: "services list",
          code: 1,
          body: "ERROR: connection reset by peer",
        },
        {
          match: "logging read",
          code: 1,
          body: "ERROR: connection reset by peer",
        },
        {
          match: "logging buckets describe",
          code: 1,
          body: "ERROR: connection reset by peer",
        },
      ],
    });
    expect(result.status).toBe(2);
    expect(result.stdout).toContain("⚠️");
  });

  it("fails when the bucket keeps logs for less than the declared window", () => {
    const result = drive({
      routes: [
        { match: "services list", body: "logging.googleapis.com" },
        {
          match: `namespace_name="dlectroflow-prod"`,
          body: "2026-08-04T09:12:00Z",
        },
        { match: "logging read", body: "2026-08-04T09:12:04Z" },
        { match: "logging buckets describe", body: "7" },
      ],
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/7/);
    expect(result.stdout).toMatch(/30/);
  });

  it("is undetermined when ingestion is proven but the retention window is not", () => {
    const result = drive({
      routes: [
        { match: "services list", body: "logging.googleapis.com" },
        {
          match: `namespace_name="dlectroflow-prod"`,
          body: "2026-08-04T09:12:00Z",
        },
        { match: "logging read", body: "2026-08-04T09:12:04Z" },
        {
          match: "logging buckets describe",
          code: 1,
          body: "ERROR: quota exceeded",
        },
      ],
    });
    expect(result.status).toBe(2);
    // Half-proven must read as half-proven: the ingestion line stays a tick.
    expect(result.stdout).toContain("✅");
    expect(result.stdout).toContain("⚠️");
  });

  it("distinguishes 'the project ingests nothing' from 'the app namespace ingests nothing'", () => {
    const result = drive({
      routes: [
        { match: "services list", body: "logging.googleapis.com" },
        { match: `namespace_name="dlectroflow-prod"`, body: "" },
        { match: "logging read", body: "2026-08-04T09:12:04Z" },
        { match: "logging buckets describe", body: "30" },
      ],
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("dlectroflow-prod");
  });

  it("never echoes the project id or a raw provider error", () => {
    // ops-digest.sh posts this output as a note on an issue in a PUBLIC
    // project. Errors are reported as a category; identifiers are not reported
    // at all. The disabled-API message is the worst case — gcloud embeds the
    // project id in it twice, including inside a console URL.
    const result = drive({
      routes: [
        { match: "services list", code: 1, body: SERVICE_DISABLED_ERR },
        { match: "logging read", code: 1, body: SERVICE_DISABLED_ERR },
        {
          match: "logging buckets describe",
          code: 1,
          body: SERVICE_DISABLED_ERR,
        },
      ],
    });
    expect(result.stdout).not.toContain(PROJECT);
    expect(result.stdout).not.toContain("console.developers.google.com");
    expect(result.stdout).not.toContain("ERROR: (gcloud");
  });

  it("never echoes the invoking user's identity or a support token either", () => {
    // Not hypothetical, and worse than the project id. Measured against the
    // real CLI: one `gcloud services list` failure put the invoking account's
    // EMAIL ADDRESS and a support `Help Token` on stderr. Both would have gone
    // straight into a note on a public issue had the script forwarded stderr
    // instead of classifying it.
    const realErr =
      "ERROR: (gcloud.services.list) [person@example.test] does not have " +
      `permission to access projects instance [${PROJECT}] (or it may not ` +
      `exist): Project '${PROJECT}' not found or permission denied. Help ` +
      "Token: AdZh9GdH1_4C0BdH9SmXeiymikHaiVecBfbvSs3ohmofCE2qLuVDxyb74K0C7q";
    const result = drive({
      routes: [
        { match: "services list", code: 1, body: realErr },
        { match: "logging read", code: 1, body: realErr },
        { match: "logging buckets describe", code: 1, body: realErr },
      ],
    });
    expect(result.stdout).not.toContain("person@example.test");
    expect(result.stdout).not.toContain("Help Token");
    expect(result.stdout).not.toContain(PROJECT);
    expect(result.stdout).not.toMatch(/@[a-z0-9.-]+\.[a-z]{2,}/i);
    // …and the category it does print is the useful one: GCP conflates "no
    // such project" with "no access", so pointing at IAM would be a guess.
    expect(result.stdout).toContain("project_not_found_or_inaccessible");
    expect(result.status).toBe(2);
  });

  it("only ever reads — no gcloud verb it runs can change anything", () => {
    // This is pointed at production. A check that can mutate is not a check.
    const result = drive({ routes: healthyRoutes() });
    expect(result.calls.length).toBeGreaterThan(0);
    for (const call of result.calls) {
      expect(call).not.toMatch(
        /\b(enable|disable|create|update|delete|remove|set-iam-policy|add-iam-policy-binding)\b/,
      );
    }
  });

  it("honours the freshness window it advertises", () => {
    const result = drive({
      routes: healthyRoutes(),
      env: { LOG_FRESHNESS: "15m" },
    });
    expect(result.status).toBe(0);
    expect(result.calls.some((c) => c.includes("--freshness=15m"))).toBe(true);
  });

  it("prints Markdown bullets and no heading, like check-prod-drift.sh", () => {
    // Its output is spliced into the digest under a heading the caller writes.
    const result = drive({ routes: healthyRoutes() });
    const body = result.stdout.trimEnd().split("\n");
    expect(body.length).toBeGreaterThan(1);
    for (const line of body) expect(line.startsWith("- ")).toBe(true);
  });
});
