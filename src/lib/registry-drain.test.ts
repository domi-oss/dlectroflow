/**
 * `scripts/check-registry-drain.sh` — is the container-registry cleanup policy
 * actually draining? (#113)
 *
 * #113 was filed and then re-diagnosed three times on the strength of numbers
 * that did not mean what they were read to mean, so this suite exists to make
 * the question answerable by a command instead of by an argument. Three
 * specific misreadings are pinned here as tests, because each produced a
 * confident wrong answer that a code review would not have caught:
 *
 *   1. **The tag count is the wrong metric, in either direction.** Three
 *      mechanisms move it — GitLab's policy, `scripts/prune-registry.sh` (#114,
 *      which deletes `main-*`, the very tags `name_regex_keep` protects) and
 *      manual passes — while CI pushes a tag per pipeline. So it attributes
 *      nothing, and it was misread both ways inside a week: 1,886 → 412 read as
 *      the policy recovering, then 364 → 409 bare SHAs read as the policy
 *      failing to reap. Measured 2026-08-04 the rise is just inflow — ~46
 *      bare-SHA pushes a day against a 7-day horizon reaped every ~2–3 days
 *      sits at ~436 by arithmetic, versus 409 observed. A *correct* policy has
 *      to hold roughly that many. So the check asks about the AGE of the owned
 *      set, never its size.
 *
 *   2. **`next_run_at` in the past is not a stall.** It was read as one on
 *      2026-08-01, and #113 told the next reader to verify by watching it
 *      advance. Measured on gitlab.com 2026-08-04, it chronically lags the
 *      cadence — the last completed run started 2026-08-02T04:02:54Z and set
 *      `next_run_at` to exactly +24h, which was still ~20 hours in the past
 *      when read. A check that fails on that alone fails permanently, and an
 *      alert that always fires says nothing.
 *
 *   3. **A short walk of the tags API reports a healthy registry.** GitLab's
 *      `containerRepository.tags` connection caps a page at 20 but computes
 *      `hasNextPage` against the number you asked for: measured 2026-08-04,
 *      `first: 100` stops after 5 pages with 99 of 421 tags and
 *      `hasNextPage: false`. Since the tags arrive in name order and bare-SHA
 *      tags are effectively random, a truncated walk yields a plausible-looking
 *      oldest tag and a pass. So an incomplete walk must report *undetermined*,
 *      never a pass — the same rule `check-prod-drift.sh` applies to an
 *      unreachable production.
 *
 * The script is driven for real with `curl` stubbed on PATH — the
 * `registry-prune.test.ts` / `pipeline-failure-alert.test.ts` idiom. A
 * re-implementation of a script inside its own test proves nothing about the
 * script.
 */
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO_ROOT = process.cwd();
const SCRIPT = join(REPO_ROOT, "scripts/check-registry-drain.sh");
const DIGEST_SCRIPT = join(REPO_ROOT, "scripts/ops-digest.sh");
const CI_YML = readFileSync(join(REPO_ROOT, ".gitlab-ci.yml"), "utf8");

/**
 * The script is bash and shells out to jq; Alpine (which `test_app` runs on)
 * ships neither by default. Without this guard a missing tool presents as every
 * assertion failing on an EMPTY stderr, because it was the *spawn* that failed.
 * Fail once, clearly — the guard the sibling script suites carry.
 */
for (const tool of ["bash", "jq"]) {
  const found = spawnSync("sh", ["-c", `command -v ${tool}`], {
    encoding: "utf8",
  });
  if (found.status !== 0) {
    throw new Error(
      `${tool} is not on PATH, so scripts/check-registry-drain.sh cannot be ` +
        `tested. Install it (CI: the apk line in test_app's before_script).`,
    );
  }
}

const API = "https://gitlab.test/api/v4";

const PROJECT_PATH = "acme/apps/dlectroflow";
const PRIMARY = `${PROJECT_PATH}`;
const CACHE = `${PROJECT_PATH}/cache`;

/**
 * "Now" for every scenario, so ages are arithmetic rather than wall-clock and
 * the suite cannot go red six months from now. The script reads it from
 * `REGISTRY_DRAIN_NOW` when set.
 */
const NOW = "2026-08-04T00:00:00Z";
const nowMs = Date.parse(NOW);
const daysAgo = (days: number) =>
  new Date(nowMs - days * 86_400_000).toISOString().replace(".000Z", "Z");

/**
 * Test stub for curl. Understands only the flags this script passes. Every
 * request it makes is a POST to the same GraphQL URL, so routes are served in
 * declaration order and the sequence *is* the fixture: policy query first, then
 * one route per page of the tag walk.
 *
 * Routes are `body-file|http-code`. Running out of routes exits non-zero, which
 * is what makes "the script stopped walking early" assertable rather than
 * silently served a repeat.
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

interface Tag {
  name: string;
  createdAt: string;
}

interface RepoSpec {
  path: string;
  tagsCount?: number;
  cleanupStatus?: string;
  /** `ContainerRepository.status` — DELETE_SCHEDULED / DELETE_FAILED / …. */
  repoStatus?: string | null;
  startedAt?: string | null;
  /** Pages exactly as the connection would return them. */
  pages?: Tag[][];
}

interface PolicySpec {
  enabled?: boolean;
  keepN?: string;
  olderThan?: string;
  nameRegex?: string;
  nameRegexKeep?: string | null;
  nextRunAt?: string | null;
}

/** Build the policy+repositories response and the tag-walk pages behind it. */
function scenario(repos: RepoSpec[], policy: PolicySpec = {}): Route[] {
  const routes: Route[] = [
    {
      body: {
        data: {
          project: {
            containerExpirationPolicy: {
              enabled: policy.enabled ?? true,
              cadence: "EVERY_DAY",
              keepN: policy.keepN ?? "TEN_TAGS",
              olderThan: policy.olderThan ?? "SEVEN_DAYS",
              nameRegex: policy.nameRegex ?? ".*",
              nameRegexKeep:
                policy.nameRegexKeep === undefined
                  ? "(latest|main-.*|prod|v.*)"
                  : policy.nameRegexKeep,
              nextRunAt:
                policy.nextRunAt === undefined
                  ? daysAgo(0.8)
                  : policy.nextRunAt,
            },
            containerRepositories: {
              nodes: repos.map((repo, i) => ({
                id: `gid://gitlab/ContainerRepository/${100 + i}`,
                path: repo.path,
                status: repo.repoStatus ?? null,
                tagsCount:
                  repo.tagsCount ??
                  (repo.pages ?? []).reduce((n, page) => n + page.length, 0),
                expirationPolicyCleanupStatus:
                  repo.cleanupStatus ?? "UNSCHEDULED",
                expirationPolicyStartedAt:
                  repo.startedAt === undefined ? daysAgo(2) : repo.startedAt,
              })),
            },
          },
        },
      },
    },
  ];
  for (const repo of repos) {
    const pages = repo.pages ?? [];
    pages.forEach((page, i) => {
      routes.push({
        body: {
          data: {
            containerRepository: {
              tags: {
                pageInfo: {
                  hasNextPage: i < pages.length - 1,
                  endCursor: `cursor-${repo.path}-${i}`,
                },
                nodes: page,
              },
            },
          },
        },
      });
    });
  }
  return routes;
}

interface Result {
  status: number;
  stdout: string;
  stderr: string;
  requests: number;
  queries: string[];
}

function drive(
  routes: Route[],
  env: Record<string, string | undefined> = {},
  script: string = SCRIPT,
): Result {
  const work = mkdtempSync(join(tmpdir(), "registry-drain-"));
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
    CI_PROJECT_ID: "4242",
    CI_PROJECT_PATH: PROJECT_PATH,
    CI_PIPELINE_ID: "2721968532",
    GL_TOKEN: "stub-token",
    REGISTRY_DRAIN_NOW: NOW,
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
    requests: readLines(log).length,
    queries: readLines(bodiesFile),
  };
}

/** 20 bare-SHA tags, all recent — the shape of a healthy primary repository. */
function freshShaTags(count: number, oldestDays = 6): Tag[] {
  return Array.from({ length: count }, (_, i) => ({
    name: `${i.toString(16).padStart(40, "a")}`,
    createdAt: daysAgo((oldestDays * i) / Math.max(count - 1, 1)),
  }));
}

describe("scripts/check-registry-drain.sh", () => {
  it("reports draining and exits 0 when the policy owns nothing past its horizon", () => {
    const result = drive(
      scenario([{ path: PRIMARY, pages: [freshShaTags(20, 6)] }]),
    );
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("✅");
    expect(result.stdout).toMatch(/draining/i);
    expect(result.status).toBe(0);
  });

  /**
   * The signal #113 spent a week arguing about and never queried. GitLab's own
   * schema documents `UNFINISHED` as "Tags cleanup has been partially executed.
   * There are still remaining tags to delete" — which is the stall the issue
   * hypothesised. It is one field, and it is authoritative.
   */
  it("fails when GitLab itself reports the last cleanup UNFINISHED", () => {
    const result = drive(
      scenario([
        {
          path: PRIMARY,
          cleanupStatus: "UNFINISHED",
          pages: [freshShaTags(20, 6)],
        },
      ]),
    );
    expect(result.stdout).toContain("UNFINISHED");
    expect(result.stdout).toContain("🔴");
    expect(result.status).toBe(1);
  });

  /**
   * A repository stuck mid-removal is invisible in every count — its tags are
   * still listed and still billed — and no cleanup policy will ever touch it,
   * because GitLab believes it is on its way out.
   */
  it("fails when a repository is stuck in DELETE_FAILED", () => {
    const result = drive(
      scenario([
        {
          path: PRIMARY,
          repoStatus: "DELETE_FAILED",
          pages: [freshShaTags(20, 6)],
        },
      ]),
    );
    expect(result.stdout).toContain("DELETE_FAILED");
    expect(result.stdout).toContain("🔴");
    expect(result.status).toBe(1);
  });

  it("fails when a tag the policy owns is past older_than plus the grace window", () => {
    const stale = [
      ...freshShaTags(19, 5),
      { name: "f".repeat(40), createdAt: daysAgo(21) },
    ];
    const result = drive(scenario([{ path: PRIMARY, pages: [stale] }]));
    expect(result.stdout).toContain("🔴");
    expect(result.stdout).toMatch(/21(\.\d)?d/);
    expect(result.status).toBe(1);
  });

  /**
   * Misreading 3. A walk that ends early must never be reported as a pass: the
   * tags it did not see are exactly the ones that would have failed it.
   */
  it("reports undetermined, not a pass, when the tag walk is short of tagsCount", () => {
    const result = drive(
      scenario([
        { path: PRIMARY, tagsCount: 421, pages: [freshShaTags(20, 6)] },
      ]),
    );
    expect(result.status).toBe(2);
    expect(result.stdout).toContain("⚠️");
    expect(result.stdout).toMatch(/20 of 421|incomplete/i);
    expect(result.stdout).not.toContain("✅");
  });

  /**
   * Misreading 1. #114's job owns `main-*`; the policy's keep regex protects
   * them. An unbounded `main-*` set is #114's business and must not colour this
   * check either way — otherwise the two mechanisms report on each other and
   * neither is measuring what it claims to.
   */
  it("ignores main-* accumulation, which the keep regex protects and #114 bounds", () => {
    const mains = Array.from({ length: 400 }, (_, i) => ({
      name: `main-${i.toString(16).padStart(8, "0")}`,
      createdAt: daysAgo(300 - i * 0.1),
    }));
    const result = drive(
      scenario([
        { path: PRIMARY, pages: [[...mains, ...freshShaTags(20, 6)]] },
      ]),
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("✅");
    // …but the size of that set is still worth reporting, since it is the thing
    // the keep regex retains forever.
    expect(result.stdout).toMatch(/400/);
  });

  /**
   * Misreading 2. Read on gitlab.com 2026-08-04: the policy had completed a run
   * and `next_run_at` was still ~20 hours in the past. Reported, never fatal.
   */
  it("reports a next_run_at in the past without failing on it alone", () => {
    const result = drive(
      scenario([{ path: PRIMARY, pages: [freshShaTags(20, 6)] }], {
        nextRunAt: daysAgo(2.3),
      }),
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/next run/i);
    expect(result.stdout).toMatch(/overdue|past/i);
    expect(result.stdout).toContain("✅");
  });

  it("fails when the cleanup policy is disabled outright", () => {
    const result = drive(
      scenario([{ path: PRIMARY, pages: [freshShaTags(20, 6)] }], {
        enabled: false,
      }),
    );
    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/disabled/i);
  });

  /**
   * `keep_n` spares the newest N of the delete set, so a repository holding
   * fewer than `keep_n` owned tags is behaving correctly however old they are.
   * Without this the check would fail every quiet repository — including the
   * Kaniko `…/cache` one, which is why it is not hypothetical.
   */
  it("does not fail a repository whose owned tags all fall inside keep_n", () => {
    const few = [
      { name: "a".repeat(40), createdAt: daysAgo(90) },
      { name: "b".repeat(40), createdAt: daysAgo(80) },
    ];
    const result = drive(scenario([{ path: CACHE, pages: [few] }]));
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/keep_n/);
  });

  it("walks every page of the connection rather than trusting the first", () => {
    const result = drive(
      scenario([
        {
          path: PRIMARY,
          pages: [freshShaTags(20, 3), freshShaTags(20, 6).slice(0, 20)],
          tagsCount: 40,
        },
      ]),
    );
    // 1 policy query + 2 tag pages.
    expect(result.requests).toBe(3);
    expect(result.status).toBe(0);
  });

  /**
   * The page size is load-bearing, not a style choice: the connection caps at
   * 20 and derives `hasNextPage` from what was requested, so asking for more
   * ends the walk early with a subset and a confident `hasNextPage: false`.
   */
  it("requests 20 tags per page, the size the connection actually serves", () => {
    const result = drive(
      scenario([{ path: PRIMARY, pages: [freshShaTags(20, 6)] }]),
    );
    const walk = result.queries.filter((q) => q.includes("tags("));
    expect(walk.length).toBeGreaterThan(0);
    for (const query of walk) {
      expect(query).toContain("first: 20");
      expect(query).not.toContain("first: 100");
    }
  });

  it("reports undetermined when GraphQL answers with errors", () => {
    const result = drive([
      { body: { errors: [{ message: "something went wrong" }] } },
    ]);
    expect(result.status).toBe(2);
    expect(result.stdout).toContain("⚠️");
    expect(result.stdout).not.toContain("✅");
  });

  it("reports undetermined on a non-200 from the GraphQL endpoint", () => {
    const result = drive([{ body: {}, code: 502 }]);
    expect(result.status).toBe(2);
    expect(result.stdout).toContain("502");
    expect(result.stdout).not.toContain("✅");
  });

  /**
   * An empty read where a non-empty one is expected is the single highest-risk
   * shape in this whole issue: it is indistinguishable from "healthy" unless
   * something insists on the discrepancy.
   */
  it("reports undetermined when a repository returns no tags but claims some", () => {
    const result = drive(
      scenario([{ path: PRIMARY, tagsCount: 419, pages: [[]] }]),
    );
    expect(result.status).toBe(2);
    expect(result.stdout).not.toContain("✅");
  });

  /**
   * The same shape as the short walk, one level down. An unreadable timestamp
   * removes a tag from the owned set, and an owned set shrunk toward empty
   * reads as a clean registry. `parse_ts` returns null for anything that is not
   * UTC, so a single API change would be enough to trigger it silently.
   */
  it("reports undetermined when a tag's creation date cannot be read", () => {
    const tags = freshShaTags(20, 6);
    tags[7] = { name: "e".repeat(40), createdAt: "2026-07-01 12:00:00 +0100" };
    const result = drive(scenario([{ path: PRIMARY, pages: [tags] }]));
    expect(result.status).toBe(2);
    expect(result.stdout).not.toContain("✅");
    expect(result.stdout).toMatch(/cannot read|unreadable/i);
  });

  it("does not call an empty project a clean registry", () => {
    const result = drive(scenario([]));
    expect(result.status).toBe(2);
    expect(result.stdout).not.toContain("✅");
    expect(result.stdout).toMatch(/no container repositories/i);
  });

  it("never issues a request that is not a read", () => {
    const result = drive(
      scenario([{ path: PRIMARY, pages: [freshShaTags(20, 6)] }]),
    );
    for (const query of result.queries) {
      expect(query).not.toMatch(/mutation/i);
      expect(query).not.toMatch(/destroy|delete/i);
    }
    expect(result.status).toBe(0);
  });

  it("covers every repository the project has, not just the first", () => {
    const result = drive(
      scenario([
        { path: PRIMARY, pages: [freshShaTags(20, 6)] },
        { path: CACHE, pages: [freshShaTags(5, 2)] },
      ]),
    );
    expect(result.stdout).toContain(PRIMARY);
    expect(result.stdout).toContain(CACHE);
    expect(result.status).toBe(0);
  });
});

describe("scripts/ops-digest.sh wiring (#16 asked for a registry check)", () => {
  it("invokes the drain check by path relative to itself", () => {
    const digest = readFileSync(DIGEST_SCRIPT, "utf8");
    expect(digest).toContain('"${HERE}/check-registry-drain.sh"');
  });

  it("renders an undetermined drain check as an unknown, never an all-clear", () => {
    const digest = readFileSync(DIGEST_SCRIPT, "utf8");
    const block = digest.slice(digest.indexOf("check-registry-drain.sh"));
    expect(block).toMatch(/⚠️/);
    expect(block).toMatch(/registry/i);
  });
});

describe("the drain check ships with the ops digest job", () => {
  it("is not wired into the prune job, whose credential and blast radius differ", () => {
    // The prune job deletes; this check reads. Keeping them apart is what lets
    // the check run weekly on the digest's read-only token.
    const pruneJob = CI_YML.slice(CI_YML.indexOf("prune_registry:"));
    const nextJob = pruneJob.slice(1).search(/\n[a-z_]+:\n/);
    const body = nextJob === -1 ? pruneJob : pruneJob.slice(0, nextJob);
    expect(body).not.toContain("check-registry-drain.sh");
  });
});
