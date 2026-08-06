/**
 * `scripts/security-assessment.sh` and its CI wiring (#134).
 *
 * `docs/quality-audit-prompts.md ## Cadence` has said "monthly: Duo
 * `security-assessment.md` full run" since the cadence was written, and lists
 * scheduled pipelines under "Automation gaps". Nothing ran it. That is exactly
 * how the Vulnerability Report reached 70 findings with 8 HIGH that nobody had
 * read: the scan-result policy only gates on **new** Critical/High, so anything
 * already in the baseline is invisible by construction, and the review that
 * would have caught it only happened when someone remembered to ask.
 *
 * So the job's real product is not the issue it files — it is the number this
 * repo had no way to see: **how much of the baseline is still detected on
 * `main`**. Every one of the 8 HIGH turned out to be `resolvedOnDefaultBranch`,
 * which the default Vulnerability Report view does not show. A digest that
 * printed "8 HIGH" and stopped would have reproduced the original confusion,
 * so the split is asserted here rather than left to the formatting.
 *
 * The script is driven for real, with `curl` stubbed on PATH — the
 * `registry-prune.test.ts` idiom. A re-implementation of the script in the test
 * would prove nothing about the script.
 */
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(process.cwd(), "scripts/security-assessment.sh");
const CI_YML = readFileSync(join(process.cwd(), ".gitlab-ci.yml"), "utf8");

/**
 * The script is bash and shells out to jq; Alpine (which `test_app` runs on)
 * ships neither by default. Without this, a missing tool presents as every
 * assertion failing on an EMPTY stderr, because it was the *spawn* that failed.
 * Fail once, clearly — same guard registry-prune.test.ts carries.
 */
for (const tool of ["bash", "jq"]) {
  const found = spawnSync("sh", ["-c", `command -v ${tool}`], {
    encoding: "utf8",
  });
  if (found.status !== 0) {
    throw new Error(
      `${tool} is not on PATH, so scripts/security-assessment.sh cannot be ` +
        `tested. Install it (CI: the apk line in test_app's before_script).`,
    );
  }
}

const API = "https://gitlab.test/api/v4";
const PROJECT_ID = "4242";
const PROJECT_PATH = "acme/apps/dlectroflow";

/**
 * Test stub for curl. Understands only the flags the script passes.
 *
 * Routes are `METHOD|url-substring|body-file`, matched in order, so a test can
 * serve two different GraphQL pages by ordering two routes and having the stub
 * consume the first one. Anything unmatched exits non-zero, which is what makes
 * "the script never called the issues endpoint" assertable.
 */
const CURL_STUB = `#!/usr/bin/env bash
set -u
method=GET; url=""; data=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -X) method="$2"; shift 2 ;;
    -H) shift 2 ;;
    -d) data="$2"; shift 2 ;;
    --max-time) shift 2 ;;
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
i=0
while IFS='|' read -r m sub bodyf; do
  [ -n "\${m:-}" ] || continue
  i=$((i + 1))
  [ "$m" = "$method" ] || continue
  case "$url" in *"$sub"*) ;; *) continue ;; esac
  grep -qx "$i" "$served" 2>/dev/null && continue
  printf '%s\\n' "$i" >> "$served"
  [ -n "$bodyf" ] && cat "$bodyf"
  exit 0
done < "$STUB_ROUTES"
printf 'stub: unrouted %s %s\\n' "$method" "$url" >&2
exit 22
`;

interface Vulnerability {
  title: string;
  severity: string;
  reportType: string;
  resolvedOnDefaultBranch?: boolean;
}

function page(nodes: Vulnerability[], endCursor: string | null = null) {
  return {
    data: {
      project: {
        vulnerabilities: {
          pageInfo: { hasNextPage: endCursor !== null, endCursor },
          nodes: nodes.map((n) => ({
            resolvedOnDefaultBranch: false,
            ...n,
          })),
        },
      },
    },
  };
}

interface Scenario {
  /** GraphQL responses, served one per call in order. */
  graphql?: unknown[];
  /** What `GET …/issues?labels=security-assessment` returns. */
  openAssessments?: unknown[];
  /** Drop GL_TOKEN, i.e. the "never configured" case. */
  noToken?: boolean;
  env?: Record<string, string>;
}

interface Result {
  status: number;
  stdout: string;
  stderr: string;
  /** Every stub invocation, in order. */
  calls: string[];
  /** JSON bodies the script POSTed, parsed where possible. */
  bodies: unknown[];
  /** The issue-creation payload, if there was one. */
  created: { title?: string; description?: string; labels?: string } | null;
  /** The note payload posted to an existing assessment issue, if any. */
  note: { body?: string } | null;
}

function run(scenario: Scenario = {}): Result {
  const work = mkdtempSync(join(tmpdir(), "sec-assess-"));
  const bin = join(work, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "curl"), CURL_STUB, { mode: 0o755 });

  const routes: string[] = [];
  const write = (name: string, value: unknown): string => {
    const file = join(work, name);
    writeFileSync(file, JSON.stringify(value));
    return file;
  };

  const graphql = scenario.graphql ?? [page([])];
  graphql.forEach((body, i) => {
    routes.push(`POST|/api/graphql|${write(`gql-${i}.json`, body)}`);
  });
  routes.push(
    `GET|/issues?labels=security-assessment|${write(
      "issues.json",
      scenario.openAssessments ?? [],
    )}`,
  );
  // Creating an issue, and posting a note on an existing one.
  routes.push(`POST|/issues/|${write("note.json", { id: 1 })}`);
  routes.push(
    `POST|/issues|${write("created.json", { iid: 900, web_url: "https://gitlab.test/i/900" })}`,
  );

  const routesFile = join(work, "routes");
  writeFileSync(routesFile, routes.join("\n") + "\n");
  const log = join(work, "stub.log");
  const bodiesFile = join(work, "stub.bodies");
  writeFileSync(log, "");
  writeFileSync(bodiesFile, "");

  // Hermetic on purpose — the ambient environment is NOT spread in. A real
  // `GL_TOKEN` or `CI_*` on the machine running the suite would otherwise reach
  // a script whose whole job is to POST to a GitLab project.
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
    CI_PROJECT_PATH: PROJECT_PATH,
    CI_PIPELINE_ID: "77",
    ...(scenario.noToken ? {} : { GL_TOKEN: "stub-token" }),
    ...scenario.env,
  };

  const proc = spawnSync("bash", [SCRIPT], {
    encoding: "utf8",
    env,
    cwd: work,
  });
  // `slice(0, -1)` rather than a filter: both files end with a newline, and
  // dropping blank lines would break the call↔body index alignment that `at()`
  // below depends on (a GET has no body).
  const lines = (file: string) =>
    readFileSync(file, "utf8").split("\n").slice(0, -1);
  const calls = lines(log);
  const bodies = lines(bodiesFile).map((line) => {
    try {
      return JSON.parse(line) as unknown;
    } catch {
      return line;
    }
  });

  const isCreate = (index: number) =>
    /^POST .*\/issues$/.test(calls[index] ?? "");
  const isNote = (index: number) =>
    /^POST .*\/issues\/\d+\/notes$/.test(calls[index] ?? "");
  const at = (predicate: (i: number) => boolean) => {
    const i = calls.findIndex((_, index) => predicate(index));
    return i === -1 ? null : (bodies[i] as Record<string, string>);
  };

  return {
    status: proc.status ?? -1,
    stdout: proc.stdout ?? "",
    stderr: proc.stderr ?? "",
    calls,
    bodies,
    created: at(isCreate),
    note: at(isNote),
  };
}

// ── the script ───────────────────────────────────────────────────────────────

describe("scripts/security-assessment.sh", () => {
  const BASELINE: Vulnerability[] = [
    {
      title: "Server-side request forgery (SSRF)",
      severity: "HIGH",
      reportType: "SAST",
      resolvedOnDefaultBranch: true,
    },
    {
      title: "sharp inherited vulnerabilities in libvips",
      severity: "HIGH",
      reportType: "DEPENDENCY_SCANNING",
      resolvedOnDefaultBranch: true,
    },
    {
      title: "Regular expression with non-literal value",
      severity: "MEDIUM",
      reportType: "SAST",
    },
    {
      title: "Use of cryptographically weak PRNG",
      severity: "MEDIUM",
      reportType: "SAST",
    },
    {
      title: "A genuinely live one",
      severity: "CRITICAL",
      reportType: "CONTAINER_SCANNING",
    },
  ];

  it("files a dated, labelled assessment issue", () => {
    const result = run({ graphql: [page(BASELINE)] });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.created).not.toBeNull();
    // The prompt file mandates this exact title shape so the record is findable.
    expect(result.created?.title).toMatch(
      /^Security Assessment — \d{4}-\d{2}-\d{2}: /,
    );
    // Both labels, because the prompt's work-item requirement names both.
    expect(result.created?.labels).toBe("security,security-assessment");
  });

  it("counts active findings by severity", () => {
    const body = run({ graphql: [page(BASELINE)] }).created?.description ?? "";
    expect(body).toMatch(/\|\s*CRITICAL\s*\|\s*1\s*\|/);
    expect(body).toMatch(/\|\s*HIGH\s*\|\s*2\s*\|/);
    expect(body).toMatch(/\|\s*MEDIUM\s*\|\s*2\s*\|/);
  });

  it("splits still-detected from no-longer-detected on main", () => {
    // THE point of the job. A count of 5 that does not say 2 of them are gone
    // from `main` is the reading that let the baseline rot in the first place —
    // the Vulnerability Report's default view hides exactly this.
    const body = run({ graphql: [page(BASELINE)] }).created?.description ?? "";
    expect(body).toMatch(/still detected on `main`\*{0,2}:?\s*\*{0,2}3\b/i);
    expect(body).toMatch(/no longer detected on `main`\*{0,2}:?\s*\*{0,2}2\b/i);
  });

  it("names every Critical and High finding, with its scanner and liveness", () => {
    // A count alone cannot be triaged. #134 exists because eight findings were
    // a number rather than a list.
    const body = run({ graphql: [page(BASELINE)] }).created?.description ?? "";
    expect(body).toContain("Server-side request forgery (SSRF)");
    expect(body).toContain("sharp inherited vulnerabilities in libvips");
    expect(body).toContain("A genuinely live one");
    expect(body).toContain("CONTAINER_SCANNING");
    expect(body).not.toContain("Regular expression with non-literal value");
  });

  it("points at the prompt that does the actual assessment", () => {
    const body = run({ graphql: [page(BASELINE)] }).created?.description ?? "";
    expect(body).toContain(".gitlab/duo/prompts/security-assessment.md");
  });

  it("follows GraphQL pagination instead of stopping at the first page", () => {
    // The Vulnerability Report is already past one page at 100/page in this
    // project's own history; a digest that reads page 1 undercounts silently.
    const result = run({
      graphql: [
        page(
          [{ title: "p1", severity: "HIGH", reportType: "SAST" }],
          "cursor-1",
        ),
        page([{ title: "p2", severity: "HIGH", reportType: "SAST" }]),
      ],
    });
    // Counted on THIS script's own query, not on every GraphQL call that
    // passes through the stub: since #166 the script also shells out to
    // `check-vuln-freshness.sh`, which queries the same endpoint. Only the
    // assessment's query selects `title`, so that is the discriminator — a
    // plain call count would silently start measuring two scripts at once.
    const ownPages = result.bodies.filter(
      (body) =>
        typeof body === "object" &&
        body !== null &&
        typeof (body as { query?: unknown }).query === "string" &&
        (body as { query: string }).query.includes("nodes { title severity"),
    );
    expect(ownPages).toHaveLength(2);
    expect(result.created?.description).toContain("p2");
  });

  it("does not file a second issue in the same month", () => {
    // A schedule that double-files after a manual re-run trains people to
    // ignore it.
    const today = new Date().toISOString().slice(0, 10);
    const result = run({
      graphql: [page(BASELINE)],
      openAssessments: [
        { iid: 42, title: `Security Assessment — ${today}: earlier run` },
      ],
    });
    expect(result.status).toBe(0);
    expect(result.created).toBeNull();
    expect(result.calls.some((c) => /\/issues\/42\/notes$/.test(c))).toBe(true);
    expect(result.note?.body).toContain("Security Assessment");
  });

  it("fails loudly when the vulnerability query errors", () => {
    // Filing "0 findings, all clear" because the API returned an error is worse
    // than filing nothing — it is a false all-clear with a date on it.
    const result = run({
      graphql: [{ errors: [{ message: "insufficient scope" }] }],
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/insufficient scope|query failed/i);
    expect(result.created).toBeNull();
  });

  it("previews instead of posting when GL_TOKEN is unset", () => {
    // The ops_digest precedent: an unconfigured token is the "not set up yet"
    // case and must not fail the maintenance pipeline.
    const result = run({ graphql: [page(BASELINE)], noToken: true });
    expect(result.status).toBe(0);
    expect(result.created).toBeNull();
    expect(result.stdout).toContain("Security Assessment");
    expect(result.stdout).toMatch(/GL_TOKEN/);
  });
});

// ── the CI wiring ────────────────────────────────────────────────────────────

describe("the security_assessment CI job", () => {
  const job = (CI_YML.split(/^security_assessment:$/m)[1] ?? "").split(
    /^\S/m,
  )[0];

  it("exists", () => {
    expect(job).not.toBe("");
  });

  it("runs only on its own schedule", () => {
    // Never on an MR, never on main, never on a tag: it writes an issue, and a
    // per-MR run would file one per merge request.
    const rules = (job.split(/^ {2}rules:$/m)[1] ?? "")
      .split("\n")
      .filter((line) => line.includes("if:"));
    expect(rules).toEqual([
      `    - if: '$CI_PIPELINE_SOURCE == "schedule" && $SECURITY_ASSESSMENT == "true"'`,
    ]);
  });

  it("needs nothing, so a red build cannot suppress the assessment", () => {
    // ops_digest's reasoning: the whole point is that it always runs.
    expect(job).toMatch(/^\s+needs: \[\]\s*(#.*)?$/m);
  });

  it("is not interruptible", () => {
    // A maintenance run should finish, not be cancelled by a newer pipeline
    // half way through filing an issue.
    expect(job).toMatch(/^\s+interruptible: false\s*(#.*)?$/m);
  });
});

describe("the schedule-flag guards", () => {
  /**
   * `.gitlab-ci.yml` states the rule itself: "Each flag variable gets a
   * `when: never` guard on every OTHER scheduled job… Add a flag, add its
   * guards." Without it, adding `SECURITY_ASSESSMENT` would make the monthly
   * schedule ALSO rebuild the image and re-run every scanner.
   *
   * Asserted structurally rather than by counting: every rules list that
   * already guards `REGISTRY_PRUNE` must guard `SECURITY_ASSESSMENT` too, so a
   * future flag added to only some of them fails here.
   */
  const lines = CI_YML.split("\n");
  const guardIndexes = (flag: string) =>
    lines
      .map((line, i) => (line.includes(`$${flag} == "true"'`) ? i : -1))
      .filter((i) => i !== -1);

  it("guards the same rule blocks REGISTRY_PRUNE guards", () => {
    // Both flags' own jobs contribute one non-guard entry each (the rule that
    // RUNS them), so compare the guard positions, not the raw counts.
    const isGuard = (i: number) => lines[i + 1]?.trim() === "when: never";
    const prune = guardIndexes("REGISTRY_PRUNE").filter(isGuard);
    const assessment = guardIndexes("SECURITY_ASSESSMENT").filter(isGuard);
    expect(prune.length).toBeGreaterThan(4);
    expect(assessment).toHaveLength(prune.length);
    // Each new guard sits directly beneath the REGISTRY_PRUNE one it mirrors.
    for (const [n, index] of prune.entries()) {
      expect(assessment[n], `guard missing near line ${index + 1}`).toBe(
        index + 2,
      );
    }
  });

  it("documents the fourth schedule where the other three are listed", () => {
    // The comment block at the top of the file is the only place the schedules
    // are written down; a schedule that exists only in project settings is a
    // schedule nobody can review.
    const header = CI_YML.split("variables:")[0];
    expect(header).toMatch(/SECURITY_ASSESSMENT=true/);
    expect(header).toMatch(/security[- ]assessment/i);
  });
});
