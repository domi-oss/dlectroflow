/**
 * `scripts/check-vuln-freshness.sh` — how old is the vulnerability count? (#166)
 *
 * #165 assumed `main` is only scanned on merge and proposed adding a scheduled
 * scan. That was wrong twice over: the **Weekly base-image rescan** schedule
 * (`4324812`, `0 6 * * 1` Europe/London, re-verified active 2026-08-06) already
 * re-scans `main` with no merge, and Continuous Vulnerability Scanning
 * re-evaluates the stored SBOM against new advisories with no pipeline at all.
 * `main`'s record *is* being refreshed. What no consumer of these numbers can
 * do is tell **how old they are**, and that is the whole failure:
 *
 *   * #152 recorded a snapshot of `0` active findings and `0` Critical/High.
 *     On 2026-08-04 the same surface read 12 active and 3 HIGH. The snapshot
 *     was true when it was written and carried nothing that said when it
 *     stopped being true.
 *   * `!254` and `!252` were both hard-blocked on `security_policy_violations`
 *     for twelve findings neither of them introduced, because their pipelines
 *     ran against a fresher advisory database than the baseline.
 *   * The two surfaces reporting these numbers disagreed — 12 findings from
 *     `project.pipeline(iid: 1611).securityReportFindings` against 11 from the
 *     Vulnerability Report, on the same tree — and neither labelled itself.
 *
 * So the property under test is not "are there findings". It is: **can a reader
 * of this number tell, without asking anyone, how old it is and which surface
 * produced it?**
 *
 * ── The trap that shaped the design ──────────────────────────────────────────
 * The obvious freshness anchor is the last green `main` pipeline. It is wrong
 * here, and wrong in the dangerous direction. `.gitlab-ci.yml` sets the
 * scanners `allow_failure: true` on `main` **deliberately** ("so a scanner
 * flake can't block a production deploy" — the blocking is the Scan Result
 * Policy's job). A green `main` pipeline therefore does not prove a scan ran,
 * and a red one does not prove it did not. Measured 2026-08-06: four of the
 * last six `main` pipelines were FAILED or CANCELED and every one of them ran
 * `gemnasium-dependency_scanning` to SUCCESS. The last green pipeline finished
 * 33.6h earlier than the last successful scan. Anchoring on pipeline status
 * would have called a 9-minute-old number 33 hours stale, and — the direction
 * that actually costs something — would report a confident ✅ on a day when
 * every scanner job failed inside a green pipeline.
 *
 * Hence the anchor is the **scanner job**, and hence the anchor is the OLDEST
 * of the per-scanner anchors: an aggregate count is only as fresh as its
 * stalest contributing scanner.
 *
 * ── Why the anchor is required rather than best-effort ───────────────────────
 * `detectedAt` looks like a cheaper anchor and is a real one — it moves when
 * Continuous Vulnerability Scanning writes to the report, with no pipeline
 * involved. But it only exists when there are findings, and the reading that
 * most needs a date is **zero findings**. A freshness check whose reliability
 * depends on there being something to find is the bug it is meant to catch, so
 * a missing scan anchor is `undetermined`, never a pass.
 *
 * The script is driven for real with `curl` stubbed on PATH — the
 * `registry-drain.test.ts` / `security-assessment.test.ts` idiom. A
 * re-implementation of a script inside its own test proves nothing about the
 * script.
 */
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shellDefault } from "./log-retention";

const REPO_ROOT = process.cwd();
const SCRIPT = join(REPO_ROOT, "scripts/check-vuln-freshness.sh");
const DIGEST_SCRIPT = join(REPO_ROOT, "scripts/ops-digest.sh");
const ASSESSMENT_SCRIPT = join(REPO_ROOT, "scripts/security-assessment.sh");
const SECURITY_DOC = join(REPO_ROOT, "docs/SECURITY.md");

/**
 * The script is bash and shells out to jq; Alpine (which `test_app` runs on)
 * ships neither by default. Without this guard a missing tool presents as every
 * assertion failing on an EMPTY stderr, because it was the *spawn* that failed.
 * Fail once, clearly — the guard every sibling script suite carries.
 */
for (const tool of ["bash", "jq"]) {
  const found = spawnSync("sh", ["-c", `command -v ${tool}`], {
    encoding: "utf8",
  });
  if (found.status !== 0) {
    throw new Error(
      `${tool} is not on PATH, so scripts/check-vuln-freshness.sh cannot be ` +
        `tested. Install it (CI: the apk line in test_app's before_script).`,
    );
  }
}

const API = "https://gitlab.test/api/v4";
const PROJECT_PATH = "acme/apps/dlectroflow";

/**
 * "Now" for every scenario, so ages are arithmetic rather than wall-clock and
 * the suite cannot rot into a wall-clock failure six months from now. The
 * script reads it from `VULN_FRESHNESS_NOW`.
 */
const NOW = "2026-08-06T20:00:00Z";
const nowMs = Date.parse(NOW);
const hoursAgo = (hours: number) =>
  new Date(nowMs - hours * 3_600_000).toISOString().replace(".000Z", "Z");

/**
 * Test stub for curl. Understands only the flags this script passes. Every
 * request is a POST to the same GraphQL URL, so routes are served in
 * declaration order and the sequence *is* the fixture.
 *
 * Routes are `body-file|http-code`. Running out of routes exits non-zero, so
 * "the script stopped paginating early" is assertable rather than silently
 * served a repeat.
 */
const CURL_STUB = `#!/usr/bin/env bash
set -u
url=""; out=""; wfmt=""; data=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -X) shift 2 ;;
    -H) shift 2 ;;
    -d|--data|--data-binary) data="$2"; shift 2 ;;
    -o) out="$2"; shift 2 ;;
    -w) wfmt="$2"; shift 2 ;;
    --max-time) shift 2 ;;
    -*) shift ;;
    *) url="$1"; shift ;;
  esac
done
case "$data" in
  @*) data="$(cat "\${data#@}")" ;;
esac
printf '%s\\n' "$url" >> "$STUB_LOG"
printf '%s\\n' "$(printf '%s' "$data" | tr '\\n' ' ')" >> "$STUB_BODIES"
n="$(cat "$STUB_DIR/cursor" 2>/dev/null || echo 0)"
n=$((n + 1))
printf '%s' "$n" > "$STUB_DIR/cursor"
line="$(sed -n "\${n}p" "$STUB_ROUTES")"
if [ -z "$line" ]; then
  printf 'stub: no route left for request %s to %s\\n' "$n" "$url" >&2
  exit 22
fi
bodyf="\${line%%|*}"; code="\${line##*|}"
if [ -n "$bodyf" ]; then
  if [ -n "$out" ]; then cat "$bodyf" > "$out"; else cat "$bodyf"; fi
elif [ -n "$out" ]; then
  : > "$out"
fi
[ -n "$wfmt" ] && printf '%s' "$code"
exit 0
`;

interface Route {
  body?: unknown;
  code?: number;
}

interface Vuln {
  severity: string;
  reportType?: string;
  detectedAt?: string | null;
  resolvedOnDefaultBranch?: boolean;
}

/**
 * The four aliases the script asks for, in one request. `jobs(…)` reports a
 * job's name and status but NOT which report type it was matched on, so the
 * type has to come from the alias — otherwise the script would be guessing it
 * back out of job names, and a renamed analyzer job would silently drop a
 * whole scanner out of the freshness calculation.
 */
const ALIASES = {
  sast: "SAST",
  dependency: "DEPENDENCY_SCANNING",
  container: "CONTAINER_SCANNING",
  secret: "SECRET_DETECTION",
} as const;
type Alias = keyof typeof ALIASES;

interface ScanJob {
  name: string;
  type: Alias;
  status?: string;
  finishedAt?: string | null;
}

interface PipelineSpec {
  iid: number;
  status?: string;
  finishedAt?: string | null;
  jobs: ScanJob[];
}

/** The five analyzer jobs this project actually runs, all green, `hours` ago. */
function freshJobs(hours = 1): ScanJob[] {
  return [
    {
      name: "gemnasium-dependency_scanning",
      type: "dependency",
      finishedAt: hoursAgo(hours),
    },
    { name: "semgrep-sast", type: "sast", finishedAt: hoursAgo(hours) },
    { name: "gitlab-advanced-sast", type: "sast", finishedAt: hoursAgo(hours) },
    {
      name: "container_scanning",
      type: "container",
      finishedAt: hoursAgo(hours),
    },
    { name: "secret_detection", type: "secret", finishedAt: hoursAgo(hours) },
  ];
}

/** The healthy shape: one red pipeline whose scanners all went green. */
function freshPipelines(hours = 1): PipelineSpec[] {
  return [
    {
      iid: 1928,
      status: "FAILED",
      finishedAt: hoursAgo(hours),
      jobs: freshJobs(hours),
    },
  ];
}

/** The scan-anchor response, which the script asks for first. */
function anchorRoute(pipelines: PipelineSpec[]): Route {
  const node = (p: PipelineSpec) => {
    const out: Record<string, unknown> = {
      iid: String(p.iid),
      status: p.status ?? "SUCCESS",
      finishedAt: p.finishedAt === undefined ? NOW : p.finishedAt,
    };
    for (const alias of Object.keys(ALIASES) as Alias[]) {
      out[alias] = {
        nodes: p.jobs
          .filter((j) => j.type === alias)
          .map((j) => ({
            name: j.name,
            status: j.status ?? "SUCCESS",
            finishedAt: j.finishedAt === undefined ? NOW : j.finishedAt,
          })),
      };
    }
    return out;
  };
  return {
    body: { data: { project: { pipelines: { nodes: pipelines.map(node) } } } },
  };
}

/** One page of the paginated vulnerability walk. */
function vulnRoute(vulns: Vuln[], endCursor: string | null = null): Route {
  return {
    body: {
      data: {
        project: {
          vulnerabilities: {
            pageInfo: { hasNextPage: endCursor !== null, endCursor },
            nodes: vulns.map((v) => ({
              reportType: "DEPENDENCY_SCANNING",
              detectedAt: hoursAgo(3),
              resolvedOnDefaultBranch: false,
              ...v,
            })),
          },
        },
      },
    },
  };
}

interface Result {
  status: number;
  stdout: string;
  stderr: string;
  urls: string[];
  queries: string[];
}

function drive(
  routes: Route[],
  env: Record<string, string | undefined> = {},
  script: string = SCRIPT,
): Result {
  const work = mkdtempSync(join(tmpdir(), "vuln-freshness-"));
  const bin = join(work, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "curl"), CURL_STUB, { mode: 0o755 });

  const lines = routes.map((route, i) => {
    let bodyFile = "";
    if (route.body !== undefined) {
      bodyFile = join(work, `body-${i}.json`);
      writeFileSync(bodyFile, JSON.stringify(route.body));
    }
    return `${bodyFile}|${route.code ?? 200}`;
  });
  const routesFile = join(work, "routes");
  writeFileSync(routesFile, lines.join("\n") + "\n");

  const log = join(work, "stub.log");
  const bodiesFile = join(work, "stub.bodies");
  writeFileSync(log, "");
  writeFileSync(bodiesFile, "");

  // Hermetic on purpose — the ambient environment is NOT spread in. A real
  // GL_TOKEN or CI_* on the machine running the suite would otherwise reach a
  // script that talks to a GitLab project.
  const processEnv: NodeJS.ProcessEnv = {
    PATH: `${bin}:${process.env.PATH}`,
    HOME: work,
    NODE_ENV: "test",
    STUB_ROUTES: routesFile,
    STUB_LOG: log,
    STUB_BODIES: bodiesFile,
    STUB_DIR: work,
    CI_API_V4_URL: API,
    CI_PROJECT_PATH: PROJECT_PATH,
    CI_DEFAULT_BRANCH: "main",
    GL_TOKEN: "stub-token",
    VULN_FRESHNESS_NOW: NOW,
    ...env,
  };
  for (const [key, value] of Object.entries(processEnv)) {
    if (value === undefined) delete processEnv[key];
  }

  const proc = spawnSync("bash", [script], {
    encoding: "utf8",
    env: processEnv,
    cwd: work,
  });
  const readLines = (file: string) =>
    readFileSync(file, "utf8").split("\n").slice(0, -1);

  return {
    status: proc.status ?? -1,
    stdout: proc.stdout ?? "",
    stderr: proc.stderr ?? "",
    urls: readLines(log),
    queries: readLines(bodiesFile),
  };
}

/** The default scenario: one recent full scan, three active findings. */
function healthy(overrides: { vulns?: Vuln[]; scanHours?: number } = {}) {
  return [
    anchorRoute(freshPipelines(overrides.scanHours ?? 1)),
    vulnRoute(
      overrides.vulns ?? [
        { severity: "HIGH" },
        { severity: "MEDIUM" },
        { severity: "LOW", resolvedOnDefaultBranch: true },
      ],
    ),
  ];
}

// ── the check ────────────────────────────────────────────────────────────────

describe("scripts/check-vuln-freshness.sh", () => {
  it("reports the count, the surface that produced it, and when it was read", () => {
    const result = drive(healthy());
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    // The count.
    expect(result.stdout).toMatch(/\*\*3 active\*\*/);
    // The surface, named as a query rather than as a place. #166's gap 1 is two
    // surfaces reporting different numbers while neither says which it is.
    expect(result.stdout).toContain(
      "project.vulnerabilities(state: [DETECTED, CONFIRMED])",
    );
    // The instant of the read, so the line can be quoted into an issue and
    // still carry its own date — #152's snapshot could not.
    expect(result.stdout).toContain(NOW);
  });

  it("dates a count of ZERO, and does not let it read as an unqualified clean", () => {
    // THE test. A clean count is exactly the reading that means either "checked
    // and clean" or "nobody looked", and the data cannot tell them apart:
    // with no findings there is no `detectedAt` to age. #152 recorded 0 active
    // and 0 Critical/High with nothing saying when it stopped being true.
    const result = drive(healthy({ vulns: [] }));
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/\*\*0 active\*\*/);
    // Still dated, from the scan anchor rather than from the (absent) findings.
    expect(result.stdout).toMatch(/last succeeded 2026-08-06T19:00:00Z/);
    expect(result.stdout).toMatch(/\b1\.0h\b/);
  });

  it("goes stale, not clean, when nothing has scanned inside the budget", () => {
    const result = drive(healthy({ vulns: [], scanHours: 400 }));
    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/stale/i);
    expect(result.stdout).toMatch(/16\.7d/);
  });

  it("anchors on the scanner job, not the pipeline's own status", () => {
    // `.gitlab-ci.yml` leaves the scanners allow_failure: true on `main`, so a
    // green pipeline does not prove a scan ran and a red one does not prove it
    // did not. Measured 2026-08-06, four of the last six `main` pipelines were
    // red with every scanner green, and the last GREEN pipeline was 33.6h older
    // than the last successful scan.
    const result = drive([
      anchorRoute([
        {
          iid: 1928,
          status: "FAILED",
          finishedAt: hoursAgo(1),
          jobs: freshPipelines(1)[0].jobs,
        },
        {
          iid: 1821,
          status: "SUCCESS",
          finishedAt: hoursAgo(33.6),
          jobs: freshPipelines(33.6)[0].jobs,
        },
      ]),
      vulnRoute([{ severity: "HIGH" }]),
    ]);
    expect(result.status).toBe(0);
    // The red pipeline's successful scan is the anchor; the green pipeline's
    // older one is not.
    expect(result.stdout).toContain("1928");
    expect(result.stdout).not.toMatch(/33\.6h/);
  });

  it("refuses to call a scanner fresh because a DIFFERENT scanner ran", () => {
    // An aggregate count is only as fresh as its stalest contributing scanner.
    // Reporting the newest of them is how "container scanning has not run in
    // three weeks" hides behind an hourly dependency scan.
    const result = drive([
      anchorRoute([
        {
          iid: 1928,
          finishedAt: hoursAgo(1),
          jobs: [
            ...freshJobs(1).filter((j) => j.type !== "container"),
            {
              name: "container_scanning",
              type: "container",
              finishedAt: hoursAgo(500),
            },
          ],
        },
      ]),
      vulnRoute([{ severity: "HIGH" }]),
    ]);
    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/CONTAINER_SCANNING/);
    expect(result.stdout).toMatch(/20\.8d/);
  });

  it("counts a fresh detectedAt as independent evidence the surface moved", () => {
    // Continuous Vulnerability Scanning re-evaluates the stored SBOM against
    // new advisories with NO pipeline at all — proven on 2026-08-04 by eleven
    // records whose detectedAt fell in a window where no `main` pipeline ran.
    // So a recent detectedAt is a genuine, independent lower bound on how stale
    // the surface can be, and ignoring it would report a fresh report as stale.
    const result = drive([
      anchorRoute(freshPipelines(200)),
      vulnRoute([{ severity: "HIGH", detectedAt: hoursAgo(2) }]),
    ]);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/Continuous Vulnerability Scanning/);
    // Both anchors are shown; the check does not silently pick one.
    expect(result.stdout).toMatch(/8\.3d/); // the scan
    expect(result.stdout).toMatch(/2\.0h/); // the detection
  });

  it("splits still-detected on main from already-fixed-but-not-resolved", () => {
    // The Vulnerability Report's default view does not distinguish them, which
    // is how #134's baseline grew to 8 unread HIGH that were all already fixed.
    const result = drive(healthy());
    expect(result.stdout).toMatch(/2 still detected on `main`/);
    expect(result.stdout).toMatch(/1 already fixed/);
  });

  it("reports undetermined, not a pass, when no scan can be found at all", () => {
    // The count would still be printable — and completely undateable. A
    // freshness check that degrades to "looks fine" when it cannot find the
    // scan has reproduced the bug it exists to catch.
    const result = drive([
      anchorRoute([{ iid: 1928, jobs: [] }]),
      vulnRoute([]),
    ]);
    expect(result.status).toBe(2);
    expect(result.stdout).toContain("⚠️");
    expect(result.stdout).toContain("This is an unknown, not an all-clear.");
  });

  it("reports undetermined when a scanner has no SUCCESSFUL run in the window", () => {
    const result = drive([
      anchorRoute([
        {
          iid: 1928,
          jobs: [
            ...freshJobs(1).filter((j) => j.type !== "container"),
            {
              name: "container_scanning",
              type: "container",
              status: "FAILED",
              finishedAt: NOW,
            },
          ],
        },
      ]),
      vulnRoute([]),
    ]);
    expect(result.status).toBe(2);
    expect(result.stdout).toMatch(/CONTAINER_SCANNING/);
  });

  it("reports undetermined when a timestamp cannot be read, never dropping it", () => {
    // A dropped timestamp shrinks the evidence set toward "nothing recent",
    // or — worse, depending on which side it falls — toward a confident pass.
    const result = drive([
      anchorRoute([
        {
          iid: 1928,
          jobs: [
            ...freshJobs(1).filter((j) => j.type !== "dependency"),
            {
              name: "gemnasium-dependency_scanning",
              type: "dependency",
              finishedAt: "06/08/2026 19:00",
            },
          ],
        },
      ]),
      vulnRoute([]),
    ]);
    expect(result.status).toBe(2);
  });

  it("reports undetermined on a GraphQL error rather than an empty count", () => {
    // A GraphQL error arrives as HTTP 200 with an `errors` array, so status
    // alone proves nothing and jq would read `null` out of it and call it zero.
    const result = drive([
      anchorRoute(freshPipelines()),
      { body: { errors: [{ message: "insufficient scope" }] } },
    ]);
    expect(result.status).toBe(2);
    expect(result.stdout).toMatch(/insufficient scope/);
  });

  it("reports undetermined on a non-200 from the GraphQL endpoint", () => {
    const result = drive([{ body: {}, code: 502 }]);
    expect(result.status).toBe(2);
    expect(result.stdout).toMatch(/502/);
  });

  it("reports undetermined when the token cannot see the project", () => {
    const result = drive([{ body: { data: { project: null } } }]);
    expect(result.status).toBe(2);
    expect(result.stdout).toContain(PROJECT_PATH);
  });

  it("walks every page of the vulnerability connection", () => {
    // The Vulnerability Report is already past one page at 100/page in this
    // project's own history — 100 rows across all states, measured 2026-08-06.
    // A check that reads page 1 undercounts silently.
    const result = drive([
      anchorRoute(freshPipelines()),
      vulnRoute([{ severity: "HIGH" }], "cursor-1"),
      vulnRoute([{ severity: "CRITICAL" }]),
    ]);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/\*\*2 active\*\*/);
    expect(result.urls).toHaveLength(3);
  });

  it("never issues a request that is not a read", () => {
    const result = drive(healthy());
    for (const url of result.urls) expect(url).toContain("/api/graphql");
    for (const query of result.queries) {
      expect(query).not.toMatch(/"query"\s*:\s*"\s*mutation/);
    }
  });

  it("names the surface that answers 0 by design, so nobody queries it for main", () => {
    // Getting this backwards produced a false "main has zero untriaged
    // findings" once already. Re-verified 2026-08-06: `main` pipeline iid 1606
    // reads 0 dependency findings on the exact tree (`cca6fdd`) that MR
    // pipeline iid 1611 reads 12 on.
    const result = drive(healthy());
    expect(result.stdout).toContain("securityReportFindings");
    expect(result.stdout).toMatch(/merge request/i);
  });

  it("states the budget it is judging against, not just the verdict", () => {
    // "Stale" with no threshold is another unlabelled number.
    const result = drive(healthy());
    expect(result.stdout).toMatch(/192h/);
  });
});

// ── the wiring ───────────────────────────────────────────────────────────────

describe("scripts/ops-digest.sh wiring (#166 — the digest was the count's first home)", () => {
  const digest = readFileSync(DIGEST_SCRIPT, "utf8");

  it("invokes the freshness check by path relative to itself", () => {
    expect(digest).toContain('"${HERE}/check-vuln-freshness.sh"');
  });

  it("renders an undetermined check as an unknown, never an all-clear", () => {
    // The 2b/2c/2d contract: exit 2 must never render as ✅.
    const block = digest.split("check-vuln-freshness.sh")[1] ?? "";
    expect(block).toMatch(/⚠️ \*\*undetermined\*\*/);
    expect(block).toMatch(/not an all-clear/);
  });

  it("no longer prints a vulnerability count with no date on it", () => {
    // The line this issue is about: "Active Vulnerability Report findings
    // (detected+confirmed): **12**" is true, useful, and undateable.
    expect(digest).not.toMatch(
      /Active Vulnerability Report findings \(detected\+confirmed\): \*\*\$\{vulns\}\*\*/,
    );
  });
});

describe("scripts/security-assessment.sh wiring (#166 — #152's snapshot had no expiry)", () => {
  const assessment = readFileSync(ASSESSMENT_SCRIPT, "utf8");

  it("stamps the monthly snapshot with the freshness block", () => {
    // #152 — Security Assessment — 2026-08-01 recorded `0` active findings and
    // `0` Critical/High. On 2026-08-04 the same surface read 12 and 3. The
    // snapshot was true when written; the artefact is permanent and said
    // nothing about when it stopped being true.
    expect(assessment).toContain("check-vuln-freshness.sh");
    expect(assessment).toMatch(/FRESHNESS_BLOCK/);
  });

  it("does not fail the monthly assessment on an undetermined freshness read", () => {
    // The assessment's own query already exits non-zero when it cannot read the
    // report. Freshness is context on that number, not a second gate — an
    // unknown belongs in the issue, not in a red maintenance pipeline.
    const block = assessment.split("check-vuln-freshness.sh")[1] ?? "";
    expect(block).toMatch(/set \+e/);
  });
});

describe("the freshness budget agrees with the cadence it is derived from", () => {
  const script = readFileSync(SCRIPT, "utf8");
  const doc = readFileSync(SECURITY_DOC, "utf8");

  it("allows at least one full rescan cycle before calling anything stale", () => {
    // The budget exists to catch the cadence BREAKING, not to re-litigate it.
    // A budget under the 168h weekly cycle would fire every week on a healthy
    // project, and an alert that always fires says nothing — the lesson
    // check-registry-drain.sh paid for with `next_run_at`.
    const budget = shellDefault(script, "VULN_FRESHNESS_MAX_AGE_HOURS");
    expect(budget).not.toBeNull();
    expect(Number(budget)).toBeGreaterThanOrEqual(168);
  });

  it("writes down which surface is authoritative for `main`", () => {
    // #166's last checkbox. Reconciling the two surfaces cost an afternoon and
    // it had been paid twice before anyone wrote the answer down.
    expect(doc).toMatch(/authoritative/i);
    expect(doc).toContain("project.vulnerabilities");
    expect(doc).toContain("securityReportFindings");
  });

  it("documents the weekly rescan the budget is derived from", () => {
    expect(doc).toMatch(/168h|weekly/i);
  });
});
