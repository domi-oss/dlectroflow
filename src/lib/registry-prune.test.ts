/**
 * `scripts/prune-registry.sh` — the safety net for the only job in this repo
 * that DELETES production artefacts (#114).
 *
 * The prune job removes container-registry tags. If it gets its inputs wrong it
 * does not crash — it deletes the wrong tags and reports success, and the tag
 * production pins is a 404 away from an unrecoverable rollback. Both failure
 * modes found while doing this by hand (see #114) produce a *confident wrong
 * answer*, which is precisely what a test can catch and a code review cannot:
 *
 *   1. `git log --format=%h` abbreviates to SEVEN characters; the tags carry
 *      `$CI_COMMIT_SHORT_SHA`, which is EIGHT. Matching one against the other
 *      yields zero matches, and a job that trusts zero matches deletes every
 *      rollback target and keeps only production's tag.
 *   2. The registry tags API returns tags ALPHABETICALLY. `main-*` sorts after
 *      every bare-SHA tag beginning with a digit, so a paginator that stops
 *      early never reaches `m` and concludes there are no `main-*` tags at all.
 *
 * So these tests drive the real script — not a re-implementation of it — with
 * `curl` and `kubectl` stubbed on PATH and a REAL git repository as the history
 * fixture. Using real git is deliberate: it means test 1 keeps checking git's
 * actual abbreviation behaviour rather than our memory of it.
 *
 * The stubs record every call, so "deleted nothing" is asserted against the
 * absence of DELETE requests, not merely against the script's own summary.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GIT_ENV_PASSTHROUGH,
  GIT_LOCATION_VARIABLES,
  isolatedGitEnv,
} from "@/lib/git-env";

const SCRIPT = join(process.cwd(), "scripts/prune-registry.sh");

/**
 * The script under test is bash and shells out to jq, and Alpine (which the
 * `test_app` CI job runs on) has neither by default. Without this check a
 * missing `bash` shows up as ~30 assertions failing on an EMPTY stderr, because
 * it was the *spawn* that failed and not the script — which is how the first CI
 * run of this suite presented. Fail once, clearly, instead.
 */
for (const tool of ["bash", "jq"]) {
  const found = spawnSync("sh", ["-c", `command -v ${tool}`], {
    encoding: "utf8",
  });
  if (found.status !== 0) {
    throw new Error(
      `${tool} is not on PATH, so scripts/prune-registry.sh cannot be tested. ` +
        `Install it (CI: the apk line in test_app's before_script in .gitlab-ci.yml).`,
    );
  }
}

const API = "https://gitlab.test/api/v4";
const PROJECT_ID = "4242";
const PROJECT_PATH = "acme/apps/dlectroflow";
const PRIMARY_REPO_ID = "777";
const REGISTRY = "registry.gitlab.test";
const PRIMARY_LOCATION = `${REGISTRY}/${PROJECT_PATH}`;

/**
 * Registry repositories exactly as production returns them: THREE of them, with
 * the `…/main` repository (the one holding a stale `latest`) FIRST and the
 * Kaniko layer `…/cache` last. A prune that took `.[0]` — or matched the path
 * with a prefix instead of an equality — would work on the wrong repository.
 */
const REPOSITORIES = [
  {
    id: 111,
    name: "main",
    path: `${PROJECT_PATH}/main`,
    location: `${PRIMARY_LOCATION}/main`,
  },
  {
    id: Number(PRIMARY_REPO_ID),
    name: "",
    path: PROJECT_PATH,
    location: PRIMARY_LOCATION,
  },
  {
    id: 333,
    name: "cache",
    path: `${PROJECT_PATH}/cache`,
    location: `${PRIMARY_LOCATION}/cache`,
  },
];

// ── git history fixture ──────────────────────────────────────────────────────

/**
 * #146: an ALLOW-LIST, built by `isolatedGitEnv` from `{}` — not
 * `{ ...process.env }`. Spreading the ambient environment neutralised git's
 * config while letting `GIT_DIR` and friends through, so this fixture spent
 * months reading the repository the runner happened to be in. Only the
 * fixture's own commit identity is added here; the config pins and the
 * passthrough list live in `git-env.ts` next to the reasoning.
 */
const GIT_ENV = isolatedGitEnv({
  GIT_AUTHOR_NAME: "Prune Test",
  GIT_AUTHOR_EMAIL: "prune@example.test",
  GIT_COMMITTER_NAME: "Prune Test",
  GIT_COMMITTER_EMAIL: "prune@example.test",
});

/**
 * `-C dir` as well as `cwd`, deliberately. Belt and braces: `cwd` was the only
 * thing pinning the repository when #146 happened, and it lost.
 */
function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], {
    cwd: dir,
    encoding: "utf8",
    env: GIT_ENV,
  });
}

/**
 * A repo with `commits` empty commits on `main` plus `refs/remotes/origin/main`.
 *
 * `label` exists because a commit SHA is a hash of its content, and an empty
 * commit's content is the tree, the parent, the message and the timestamps —
 * every one of which two histories built in the same second share. So
 * `makeHistory(2)` and `makeHistory(40)` produce the SAME first two SHAs, and a
 * test comparing one history against another has to make them differ on purpose
 * or it is measuring the clock. (Found writing the #146 isolation tests, where
 * that collision looked exactly like the leak they exist to detect.)
 */
function makeHistory(
  commits: number,
  label = "commit",
): { dir: string; shas: string[] } {
  const dir = mkdtempSync(join(tmpdir(), "prune-history-"));
  git(dir, "init", "--quiet", "--initial-branch=main");
  for (let i = 0; i < commits; i++) {
    git(dir, "commit", "--quiet", "--allow-empty", "-m", `${label} ${i}`);
  }
  git(dir, "update-ref", "refs/remotes/origin/main", "HEAD");
  const shas = git(dir, "log", "--format=%H").trim().split("\n");
  return { dir, shas };
}

// One shared history for every test that does not need its own (all of them are
// read-only against it). 40 commits is enough to rank 20 tags with room over.
const HISTORY = makeHistory(40);

/** `main-<8 chars>` for the Nth-newest commit — the real tag shape. */
const mainTag = (n: number): string => `main-${HISTORY.shas[n].slice(0, 8)}`;

/**
 * 237 bare-SHA tags, all beginning with a hex digit, so that `main-*` sorts to
 * the very end of the alphabetical listing — the shape of the real registry.
 */
const BARE_TAGS = HISTORY.shas
  .flatMap((sha) => ["0", "1", "2", "3", "4", "5"].map((d) => d + sha.slice(1)))
  .slice(0, 237);

/** The 11 `main-*` tags the real registry holds today, newest first. */
const ELEVEN_MAIN_TAGS = Array.from({ length: 11 }, (_, i) => mainTag(i));

// ── the harness ──────────────────────────────────────────────────────────────

const CURL_STUB = `#!/usr/bin/env bash
# Test stub for curl. Understands only the flags prune-registry.sh passes.
set -u
method=GET; out=""; hdr=""; url=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    -D) hdr="$2"; shift 2 ;;
    -w) shift 2 ;;
    -X) method="$2"; shift 2 ;;
    -H) shift 2 ;;
    --max-time) shift 2 ;;
    -*) shift ;;
    *) url="$1"; shift ;;
  esac
done
printf '%s %s\\n' "$method" "$url" >> "$STUB_LOG"
while IFS='|' read -r m sub status bodyf hdrf; do
  [ -n "\${m:-}" ] || continue
  [ "$m" = "$method" ] || continue
  case "$url" in *"$sub"*) ;; *) continue ;; esac
  if [ -n "$hdr" ]; then
    if [ -n "$hdrf" ]; then cat "$hdrf" > "$hdr"; else : > "$hdr"; fi
  fi
  body=""
  [ -n "$bodyf" ] && body="$(cat "$bodyf")"
  if [ -n "$out" ]; then printf '%s' "$body" > "$out"; else printf '%s' "$body"; fi
  printf '%s' "$status"
  exit 0
done < "$STUB_ROUTES"
printf '000'
exit 7
`;

const KUBECTL_STUB = `#!/usr/bin/env bash
# Test stub for kubectl. Driven entirely by STUB_* environment variables.
set -u
printf 'kubectl %s\\n' "$*" >> "$STUB_LOG"
case "$*" in
  *"config use-context"*) exit 0 ;;
  *"get deployment"*)
    if [ "\${STUB_DEPLOY_EXIT:-0}" != "0" ]; then
      printf 'Error from server (NotFound)\\n' >&2
      exit "\$STUB_DEPLOY_EXIT"
    fi
    printf '%s' "\${STUB_DEPLOY_IMAGE-}"
    ;;
  *"get pod"*)
    if [ "\${STUB_PODS_EXIT:-0}" != "0" ]; then
      printf 'Error from server\\n' >&2
      exit "\$STUB_PODS_EXIT"
    fi
    printf '%s' "\${STUB_POD_IMAGES-}"
    ;;
  *) printf 'unexpected kubectl call: %s\\n' "$*" >&2; exit 64 ;;
esac
`;

interface Scenario {
  /** Tag names in the registry (the stub sorts + paginates them like the API). */
  tags?: string[];
  /** Raw tag objects, when a test needs a payload the array form can't express. */
  rawTags?: unknown[];
  /** `X-Total` to advertise. Defaults to the true count. */
  xTotal?: number | null;
  /** Serve only the first N pages, claiming there is no next page. */
  servePages?: number;
  perPage?: number;
  /** `kubectl get deployment` output. */
  prodImage?: string;
  deployExit?: number;
  /** `kubectl get pods` output (space-separated image refs). */
  podImages?: string;
  podsExit?: number;
  /** HTTP status the DELETE route returns. */
  deleteStatus?: number;
  repositories?: unknown[];
  cwd?: string;
  env?: Record<string, string>;
}

interface Result {
  status: number;
  stdout: string;
  stderr: string;
  /** Every stub invocation, in order. */
  calls: string[];
  /** Tag names the script actually issued a DELETE for. */
  deleted: string[];
  keeps: { tag: string; reason: string }[];
  plannedDeletes: string[];
  summary: string;
}

function run(scenario: Scenario = {}): Result {
  const work = mkdtempSync(join(tmpdir(), "prune-run-"));
  const bin = join(work, "bin");
  mkdirSync(bin);
  for (const [name, body] of [
    ["curl", CURL_STUB],
    ["kubectl", KUBECTL_STUB],
  ]) {
    writeFileSync(join(bin, name), body, { mode: 0o755 });
  }

  const perPage = scenario.perPage ?? 100;
  const tagNames = scenario.tags ?? [...BARE_TAGS, ...ELEVEN_MAIN_TAGS];
  const tagObjects =
    scenario.rawTags ??
    [...tagNames].sort().map((name) => ({ name, path: `x:${name}` }));
  const total =
    scenario.xTotal === undefined ? tagObjects.length : scenario.xTotal;

  const pages: unknown[][] = [];
  for (let i = 0; i < tagObjects.length; i += perPage) {
    pages.push(tagObjects.slice(i, i + perPage));
  }
  if (pages.length === 0) pages.push([]);
  const servePages = scenario.servePages ?? pages.length;

  const fixture = (name: string, body: string): string => {
    const path = join(work, name);
    writeFileSync(path, body);
    return path;
  };

  const routes: string[] = [];
  const addRoute = (
    method: string,
    match: string,
    status: number,
    body: string,
    headers: Record<string, string | number | null>,
  ): void => {
    const key = match.replace(/[^A-Za-z0-9]/g, "_");
    const bodyFile = fixture(`body-${method}-${key}`, body);
    const headerLines = Object.entries(headers)
      .filter(([, v]) => v !== null)
      .map(([k, v]) => `${k}: ${v}\r\n`)
      .join("");
    const headerFile = fixture(
      `hdr-${method}-${key}`,
      `HTTP/2 ${status}\r\n${headerLines}\r\n`,
    );
    routes.push(`${method}|${match}|${status}|${bodyFile}|${headerFile}`);
  };

  // DELETE first: its URL contains the tags path, so it must win the match.
  addRoute(
    "DELETE",
    `/registry/repositories/${PRIMARY_REPO_ID}/tags/`,
    scenario.deleteStatus ?? 200,
    "",
    {},
  );
  for (let page = 1; page <= servePages; page++) {
    const isLast = page === servePages;
    addRoute(
      "GET",
      `/registry/repositories/${PRIMARY_REPO_ID}/tags?per_page=${perPage}&page=${page}`,
      200,
      JSON.stringify(pages[page - 1] ?? []),
      {
        "X-Page": page,
        "X-Per-Page": perPage,
        "X-Next-Page": isLast ? "" : page + 1,
        "X-Total": total,
        "X-Total-Pages": total === null ? null : Math.ceil(total / perPage),
      },
    );
  }
  addRoute(
    "GET",
    "/registry/repositories?per_page=",
    200,
    JSON.stringify(scenario.repositories ?? REPOSITORIES),
    { "X-Page": 1, "X-Next-Page": "", "X-Total": 3, "X-Total-Pages": 1 },
  );

  const log = fixture("stub.log", "");
  const routesFile = fixture("routes", routes.join("\n") + "\n");

  const prodImage =
    scenario.prodImage === undefined
      ? `${PRIMARY_LOCATION}:${ELEVEN_MAIN_TAGS[0]}`
      : scenario.prodImage;

  // The script decides what to do from its environment, so anything ambient
  // that it reads has to be stripped rather than merely overridden — a real
  // value inherited from the runner would silently satisfy the condition a
  // scenario exists to prove is ABSENT, and the test would pass by luck or fail
  // for a reason that has nothing to do with the code. This is not theoretical:
  // `REGISTRY_PRUNE_TOKEN` is a protected CI variable, so it is present on
  // `main` and absent on MR branches, which is exactly the shape that turns a
  // green MR pipeline into a red default branch after the merge (#120).
  // Scenarios opt a value back in explicitly via `scenario.env`.
  //
  // #146 made that an allow-list rather than a list of exclusions: the script's
  // ranking step runs `git log` itself, and it was reading the runner's own
  // clone whenever a `GIT_DIR` was exported — which no amount of removing
  // `REGISTRY_PRUNE_TOKEN` would have caught. Starting from `{}` covers the
  // variables this comment predates as well as the ones it names.
  const proc = spawnSync("bash", [SCRIPT], {
    cwd: scenario.cwd ?? HISTORY.dir,
    encoding: "utf8",
    env: isolatedGitEnv({
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      // Its own HOME, so nothing the script or git writes can land in the
      // developer's — and so `~` resolves to a directory that exists.
      HOME: work,
      STUB_LOG: log,
      STUB_ROUTES: routesFile,
      STUB_DEPLOY_IMAGE: prodImage,
      STUB_DEPLOY_EXIT: String(scenario.deployExit ?? 0),
      STUB_POD_IMAGES: scenario.podImages ?? prodImage,
      STUB_PODS_EXIT: String(scenario.podsExit ?? 0),
      CI_API_V4_URL: API,
      CI_PROJECT_ID: PROJECT_ID,
      CI_PROJECT_PATH: PROJECT_PATH,
      CI_JOB_TOKEN: "stub-job-token",
      PRUNE_PER_PAGE: String(perPage),
      ...scenario.env,
    }),
  });

  const calls = readFileSync(log, "utf8").split("\n").filter(Boolean);
  const stdout = proc.stdout ?? "";
  const line = (prefix: string): string[] =>
    stdout
      .split("\n")
      .filter((l) => l.startsWith(prefix))
      .map((l) => l.slice(prefix.length).trim());

  return {
    status: proc.status ?? -1,
    stdout,
    stderr: proc.stderr ?? "",
    calls,
    deleted: calls
      .filter((c) => c.startsWith("DELETE "))
      .map((c) => c.replace(/^.*\/tags\//, "")),
    keeps: line("PLAN KEEP ").map((rest) => {
      const [tag, ...reason] = rest.split(/\s+/);
      return { tag, reason: reason.join(" ") };
    }),
    plannedDeletes: line("PLAN DELETE "),
    summary: line("SUMMARY ")[0] ?? "",
  };
}

// ── the fixture itself: isolation from the ambient git environment ───────────

/**
 * Every variable git reads to decide WHICH repository it is looking at, mapped
 * onto a decoy repo. Set together they are the shape that reddened `main` in
 * #146 — a `GIT_DIR` inherited from the runner, pointing at a shallow clone.
 */
function ambientGitEnvPointingAt(dir: string): Record<string, string> {
  const gitDir = join(dir, ".git");
  return {
    GIT_DIR: gitDir,
    GIT_COMMON_DIR: gitDir,
    GIT_WORK_TREE: dir,
    GIT_INDEX_FILE: join(gitDir, "index"),
    GIT_OBJECT_DIRECTORY: join(gitDir, "objects"),
    GIT_ALTERNATE_OBJECT_DIRECTORIES: join(gitDir, "objects"),
    GIT_CEILING_DIRECTORIES: dir,
    GIT_DISCOVERY_ACROSS_FILESYSTEM: "1",
    GIT_NAMESPACE: "refs/namespaces/decoy",
  };
}

/** A decoy repo, labelled so its commits cannot hash-collide with a fixture's. */
function makeDecoy(): { dir: string; shas: string[] } {
  return makeHistory(2, "decoy");
}

/** Point the live environment at `dir`, for the duration of one test. */
function pollute(dir: string): void {
  for (const [name, value] of Object.entries(ambientGitEnvPointingAt(dir))) {
    vi.stubEnv(name, value);
  }
}

/**
 * #146 — `main` was red for 86 minutes and `deploy_production` was SKIPPED, so
 * the !220 merge never reached production, because the fixture above spread
 * `process.env` into its git calls. That neutralised git's *config* while
 * letting `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE` and the object-directory
 * variables straight through — so `git log`, run with `cwd` set to a freshly
 * `git init`ed temp directory, read the runner's own shallow clone instead and
 * died traversing parents that were outside the clone depth.
 *
 * The fixture was never isolated. It only looked isolated because a developer's
 * shell does not export those variables, which is why the tests below export
 * them on purpose: a suite that only ever runs in a clean environment cannot
 * tell real isolation from the appearance of it.
 *
 * Two different regressions are covered, deliberately:
 *
 *   * The environment handed to a git child is an ALLOW-LIST — asserted on
 *     `GIT_ENV` itself, because that object is built once at module load, so no
 *     amount of stubbing `process.env` inside a test can observe it leaking.
 *     This is the assertion that fails against the code #146 was filed about.
 *   * A child git ignores the ambient environment END TO END — asserted by
 *     polluting `process.env` and running the real thing, which is what catches
 *     an `env` that is rebuilt per call, or omitted altogether (the shape
 *     `ci-docs-only.test.ts` had).
 */
describe("the git history fixture is isolated from the ambient environment", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("points every repository-locating variable at the decoy", () => {
    // When `git-env.ts` learns about another variable, this fixture has to
    // exercise it too — otherwise the allow-list grows a name that nothing
    // below ever proves is being ignored, which is the state this issue found
    // the suite in.
    expect(Object.keys(ambientGitEnvPointingAt("/tmp/decoy")).sort()).toEqual(
      [...GIT_LOCATION_VARIABLES].sort(),
    );
  });

  it("hands git an allow-list, not a copy of the ambient environment", () => {
    // Before the fix this object held every variable the shell exported —
    // hundreds of them on a developer machine, and on a runner the `GIT_DIR`
    // that broke the job. Asserting on the KEYS rather than on git's behaviour
    // is what makes this independent of whether the machine running the suite
    // happens to export anything interesting.
    const unexpected = Object.keys(GIT_ENV).filter(
      (name) =>
        !(GIT_ENV_PASSTHROUGH as readonly string[]).includes(name) &&
        !name.startsWith("GIT_"),
    );
    expect(
      unexpected,
      "GIT_ENV carries variables git was never given on purpose",
    ).toEqual([]);
    for (const name of GIT_LOCATION_VARIABLES) {
      expect(GIT_ENV, `GIT_ENV must not name a repository`).not.toHaveProperty(
        name,
      );
    }
  });

  it("builds its own history when the environment points at another repo", () => {
    // Built BEFORE the pollution, so it is a real repository with a history of
    // its own that the fixture must neither read nor write.
    const decoy = makeDecoy();
    pollute(decoy.dir);

    const own = makeHistory(40);

    // Reading the decoy would return 2 SHAs, or 42 once the fixture's own
    // commits had been written into it.
    expect(own.shas).toHaveLength(40);
    for (const sha of decoy.shas) {
      expect(own.shas, "the fixture read the decoy repository").not.toContain(
        sha,
      );
    }
    // …and writing into the decoy must not have happened either.
    vi.unstubAllEnvs();
    expect(
      git(decoy.dir, "log", "--format=%H").trim().split("\n"),
      "the fixture committed into the decoy repository",
    ).toEqual(decoy.shas);
  });

  it("drives the script against the fixture, not the ambient repo", () => {
    // The script runs `git log` itself, so the environment `run()` hands it has
    // to be isolated too — a leaked GIT_DIR sends the ranking step at whatever
    // repository the runner happens to be sitting in. This one DID fail against
    // the old code: `run()` reads `process.env` on every call.
    pollute(makeDecoy().dir);

    const r = run();
    expect(r.stderr).not.toMatch(/FATAL/);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/matched=11\/11/);
  });
});

// ── the non-negotiable safety property ───────────────────────────────────────

describe("production's tag cannot be confirmed", () => {
  const cases: [string, Scenario][] = [
    ["kubectl fails", { deployExit: 1 }],
    ["kubectl returns nothing", { prodImage: "" }],
    ["kubectl returns whitespace", { prodImage: "   " }],
    ["the image carries no tag", { prodImage: PRIMARY_LOCATION }],
    [
      "the image is digest-pinned",
      { prodImage: `${PRIMARY_LOCATION}@sha256:${"a".repeat(64)}` },
    ],
    [
      "the image comes from another repository",
      { prodImage: `${PRIMARY_LOCATION}/cache:${ELEVEN_MAIN_TAGS[0]}` },
    ],
  ];

  for (const [name, scenario] of cases) {
    it(`deletes nothing and exits non-zero when ${name}`, () => {
      const r = run({ ...scenario, env: { PRUNE_DRY_RUN: "false" } });
      expect(r.deleted).toEqual([]);
      expect(r.calls.filter((c) => c.startsWith("DELETE"))).toEqual([]);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/FATAL/);
    });
  }

  it("names the deployment it could not read", () => {
    const r = run({ deployExit: 1 });
    expect(r.stderr).toMatch(/deployment\/dlectroflow/);
    expect(r.stderr).toMatch(/dlectroflow-prod/);
  });
});

// ── trap 1: seven characters versus eight ────────────────────────────────────

describe("short-SHA length", () => {
  it("git really does abbreviate %h to seven characters", () => {
    // If this ever fails, git's default changed and the trap's shape changed
    // with it — read the new value before touching the script.
    const abbreviated = git(HISTORY.dir, "log", "--format=%h", "-1").trim();
    expect(abbreviated).toHaveLength(7);
    expect(HISTORY.shas[0].slice(0, 8)).not.toBe(abbreviated);
  });

  it("matches every 8-character tag against main's history", () => {
    const r = run();
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/matched=11\/11/);
    expect(r.summary).toMatch(/candidates=11/);
  });

  it("matches 7-character tags too (the length is not hardcoded)", () => {
    const sevens = HISTORY.shas
      .slice(0, 11)
      .map((sha) => `main-${sha.slice(0, 7)}`);
    const r = run({
      tags: [...BARE_TAGS, ...sevens],
      prodImage: `${PRIMARY_LOCATION}:${sevens[0]}`,
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/matched=11\/11/);
  });

  it("refuses to delete when the match rate is implausible", () => {
    // What the %h bug looks like from the inside: SHA-shaped tags that match no
    // commit at all. The wrong conclusion is "these tags are stale, delete
    // them"; the right one is "the comparison is broken".
    const strangers = Array.from(
      { length: 11 },
      (_, i) => `main-ffff${String(i).padStart(4, "0")}`,
    );
    const r = run({
      tags: [...BARE_TAGS, ...strangers],
      prodImage: `${PRIMARY_LOCATION}:${strangers[0]}`,
      env: { PRUNE_DRY_RUN: "false" },
    });
    expect(r.deleted).toEqual([]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/match/i);
    expect(r.stderr).toMatch(/format/i);
  });

  it("aborts on a shallow clone instead of ranking half the history", () => {
    const shallow = mkdtempSync(join(tmpdir(), "prune-shallow-"));
    git(
      shallow,
      "clone",
      "--quiet",
      "--depth",
      "3",
      `file://${HISTORY.dir}`,
      "repo",
    );
    const r = run({
      cwd: join(shallow, "repo"),
      env: { PRUNE_DRY_RUN: "false" },
    });
    expect(r.deleted).toEqual([]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/shallow/i);
    expect(r.stderr).toMatch(/GIT_DEPTH/);
  });
});

// ── trap 2: alphabetical pagination ──────────────────────────────────────────

describe("alphabetical pagination", () => {
  it("pages to exhaustion to reach tags that sort last", () => {
    const r = run();
    // Every main-* tag lives on the third page, after 237 bare-SHA tags.
    expect(r.calls).toContain(
      `GET ${API}/projects/${PROJECT_ID}/registry/repositories/${PRIMARY_REPO_ID}/tags?per_page=100&page=3`,
    );
    expect(r.summary).toMatch(/candidates=11/);
    expect(r.stdout).toMatch(/pages=3/);
  });

  it("refuses to act on a listing shorter than X-Total", () => {
    const r = run({ servePages: 1, env: { PRUNE_DRY_RUN: "false" } });
    expect(r.deleted).toEqual([]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/248/);
    expect(r.stderr).toMatch(/incomplete|truncat/i);
  });

  it("refuses to act when X-Total is missing entirely", () => {
    const r = run({ xTotal: null, env: { PRUNE_DRY_RUN: "false" } });
    expect(r.deleted).toEqual([]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/X-Total/);
  });
});

// ── production's tag is never in the delete list ─────────────────────────────

describe("production's tag", () => {
  const twenty = Array.from({ length: 20 }, (_, i) => mainTag(i));

  it("is kept even when it ranks far outside the newest N", () => {
    const prodTag = twenty[14]; // 15th newest — a pinned rollback
    const r = run({
      tags: [...BARE_TAGS, ...twenty],
      prodImage: `${PRIMARY_LOCATION}:${prodTag}`,
      podImages: `${PRIMARY_LOCATION}:${prodTag}`,
      env: { PRUNE_DRY_RUN: "false" },
    });
    expect(r.status).toBe(0);
    expect(r.plannedDeletes).not.toContain(prodTag);
    expect(r.deleted).not.toContain(prodTag);
    expect(r.keeps).toContainEqual({ tag: prodTag, reason: "production" });
    // …and it still pruned the rest: 20 candidates, keep 10 newest + prod.
    expect(r.deleted).toHaveLength(9);
  });

  it("is caught by an independent guard if the filtering lets it through", () => {
    // Fault injection (PRUNE_TEST_INJECT_PROD_TAG) puts production's tag into
    // the delete list *after* filtering, which is the one thing no amount of
    // review can rule out. The second guard must catch it on its own.
    const r = run({
      env: { PRUNE_DRY_RUN: "false", PRUNE_TEST_INJECT_PROD_TAG: "1" },
    });
    expect(r.deleted).toEqual([]);
    expect(r.status).not.toBe(0);
    // Assert on THAT guard's wording. Several later guards would also trip on
    // this input, and an assertion on a bare /FATAL/ passes even with the
    // production-tag guard deleted — verified by removing it.
    expect(r.stderr).toMatch(
      new RegExp(
        `production's tag ${ELEVEN_MAIN_TAGS[0]} is in the delete list`,
      ),
    );
    expect(r.stderr).not.toMatch(/running-pod tag/);
  });

  it("keeps a tag a running pod still uses", () => {
    const twentyTags = [...BARE_TAGS, ...twenty];
    const stalePod = twenty[15];
    const r = run({
      tags: twentyTags,
      prodImage: `${PRIMARY_LOCATION}:${twenty[0]}`,
      podImages: `${PRIMARY_LOCATION}:${twenty[0]} ${PRIMARY_LOCATION}:${stalePod}`,
      env: { PRUNE_DRY_RUN: "false" },
    });
    expect(r.status).toBe(0);
    expect(r.deleted).not.toContain(stalePod);
    expect(r.keeps).toContainEqual({ tag: stalePod, reason: "running-pod" });
  });

  it("warns but continues when the pod list cannot be read", () => {
    const r = run({ podsExit: 1 });
    expect(r.status).toBe(0);
    expect(r.stdout + r.stderr).toMatch(/WARN/);
  });
});

// ── the rest of the guard rail ───────────────────────────────────────────────

describe("dry run", () => {
  it("is the default and issues no DELETE at all", () => {
    const r = run({ tags: [...BARE_TAGS, ...ELEVEN_MAIN_TAGS] });
    expect(r.status).toBe(0);
    expect(r.summary).toMatch(/dry_run=true/);
    expect(r.calls.filter((c) => c.startsWith("DELETE"))).toEqual([]);
    expect(r.plannedDeletes).toEqual([ELEVEN_MAIN_TAGS[10]]);
  });

  it("deletes exactly the planned tags when switched off", () => {
    const r = run({ env: { PRUNE_DRY_RUN: "false" } });
    expect(r.status).toBe(0);
    expect(r.deleted).toEqual([ELEVEN_MAIN_TAGS[10]]);
    expect(r.summary).toMatch(/dry_run=false/);
  });
});

describe("repository selection", () => {
  it("targets the repository whose path equals the project path", () => {
    const r = run();
    expect(
      r.calls.some((c) => c.includes(`/repositories/${PRIMARY_REPO_ID}/`)),
    ).toBe(true);
    expect(r.calls.some((c) => c.includes("/repositories/111/"))).toBe(false);
    expect(r.calls.some((c) => c.includes("/repositories/333/"))).toBe(false);
  });

  it("aborts when the project's own repository is absent", () => {
    const r = run({
      repositories: REPOSITORIES.filter((repo) => repo.path !== PROJECT_PATH),
      env: { PRUNE_DRY_RUN: "false" },
    });
    expect(r.deleted).toEqual([]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/registry repository/i);
  });
});

describe("blast-radius ceilings", () => {
  it("aborts when the plan exceeds PRUNE_MAX_DELETE", () => {
    const twenty = Array.from({ length: 20 }, (_, i) => mainTag(i));
    const r = run({
      tags: [...BARE_TAGS, ...twenty],
      env: { PRUNE_DRY_RUN: "false", PRUNE_MAX_DELETE: "2" },
    });
    expect(r.deleted).toEqual([]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/PRUNE_MAX_DELETE/);
  });

  it("never deletes a tag whose SHA part is unusable", () => {
    // A blank name and a bare `main-` must not become a DELETE against
    // `…/tags/` (which would be a request for something else entirely).
    const r = run({
      rawTags: [
        { name: "" },
        { name: "main-" },
        { name: "main-latest" },
        ...ELEVEN_MAIN_TAGS.map((name) => ({ name })),
      ],
      env: { PRUNE_DRY_RUN: "false" },
    });
    expect(r.status).toBe(0);
    expect(r.deleted).toEqual([ELEVEN_MAIN_TAGS[10]]);
    for (const call of r.calls) expect(call).not.toMatch(/\/tags\/$/);
    expect(r.keeps.map((k) => k.tag)).toContain("main-latest");
  });

  it("does nothing when there are no main-* tags at all", () => {
    // Production on a release tag, no main-* builds left to prune.
    const r = run({
      tags: [...BARE_TAGS, "v0.5.0"],
      prodImage: `${PRIMARY_LOCATION}:v0.5.0`,
      env: { PRUNE_DRY_RUN: "false" },
    });
    expect(r.status).toBe(0);
    expect(r.deleted).toEqual([]);
  });

  it("aborts when production's tag is missing from the listing", () => {
    // Either the image production pins has already been deleted, or this is not
    // the repository production pulls from. Both mean: do not prune this list.
    const r = run({
      tags: [...BARE_TAGS, ...ELEVEN_MAIN_TAGS.slice(1)],
      prodImage: `${PRIMARY_LOCATION}:${ELEVEN_MAIN_TAGS[0]}`,
      env: { PRUNE_DRY_RUN: "false" },
    });
    expect(r.deleted).toEqual([]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(new RegExp(ELEVEN_MAIN_TAGS[0]));
  });
});

// ── how the job is wired, which is half of the safety story ──────────────────

describe("the prune_registry CI job", () => {
  const ci = readFileSync(join(process.cwd(), ".gitlab-ci.yml"), "utf8");
  // The job block: from `prune_registry:` to the next top-level key.
  const job = (ci.split(/^prune_registry:$/m)[1] ?? "").split(/^\S/m)[0];

  it("exists", () => {
    expect(job).not.toBe("");
  });

  it("ships as a dry run, so merging it cannot delete anything", () => {
    // #114 hard requirement: the job lands printing its plan. Flipping this is
    // a separate, deliberate change made after reading a real dry-run log.
    expect(job).toMatch(/^\s+PRUNE_DRY_RUN: "true"$/m);
  });

  it("clones the full history, which the ranking needs", () => {
    // At the runner's default depth of 50, most main-* tags look unmatched and
    // the script's match-rate assertion aborts every run.
    expect(job).toMatch(/^\s+GIT_DEPTH: 0$/m);
  });

  it("runs only on its own schedule", () => {
    const rules = (job.split(/^ {2}rules:$/m)[1] ?? "")
      .split("\n")
      .filter((l) => l.includes("if:"));
    expect(rules).toEqual([
      `    - if: '$CI_PIPELINE_SOURCE == "schedule" && $REGISTRY_PRUNE == "true"'`,
    ]);
  });

  it("keeps its schedule from dragging every other scheduled job along", () => {
    // The RENOVATE_RUN flag has a `when: never` guard on every other scheduled
    // job. REGISTRY_PRUNE needs the same guards or the prune schedule rebuilds
    // the image, re-runs the scanners and posts a second weekly ops digest.
    const neverGuards = (flag: string): number =>
      (
        ci.match(
          new RegExp(
            `- if: '\\$CI_PIPELINE_SOURCE == "schedule" && \\$${flag} == "true"'\\n\\s+when: never`,
            "g",
          ),
        ) ?? []
      ).length;
    expect(neverGuards("REGISTRY_PRUNE")).toBe(neverGuards("RENOVATE_RUN"));
    expect(neverGuards("REGISTRY_PRUNE")).toBeGreaterThanOrEqual(7);
  });
});

describe("which credential", () => {
  // Measured on gitlab.com 2026-07-29 (#114, pipeline 2715681240): with
  // CI_JOB_TOKEN, GET registry/repositories and GET …/tags both return 200, but
  // DELETE …/tags/<anything> returns 403 {"message":"403 Forbidden"} — and 403
  // rather than 404 on a tag that does not exist means the authorization check
  // fails before the lookup, so it is not permitted, full stop.
  it("warns up front when asked to delete with only the job token", () => {
    const r = run({ env: { PRUNE_DRY_RUN: "false" } });
    expect(r.stderr).toMatch(/CI_JOB_TOKEN/);
    expect(r.stderr).toMatch(/403/);
    // A warning, not a hard failure: GitLab could permit this in a later
    // version, and the delete loop's own 401/403 handler is the backstop.
    expect(r.status).toBe(0);
  });

  it("stays quiet about it in a dry run, which needs no delete rights", () => {
    const r = run();
    expect(r.stderr).not.toMatch(/cannot delete registry tags/);
  });

  it("stays quiet when a stored token is supplied", () => {
    const r = run({
      env: { PRUNE_DRY_RUN: "false", REGISTRY_PRUNE_TOKEN: "stored-token" },
    });
    expect(r.stdout).toMatch(/REGISTRY_PRUNE_TOKEN/);
    expect(r.stderr).not.toMatch(/cannot delete registry tags/);
  });
});

describe("delete failures", () => {
  it("exits non-zero when a delete is rejected", () => {
    const r = run({ deleteStatus: 500, env: { PRUNE_DRY_RUN: "false" } });
    expect(r.status).not.toBe(0);
    expect(r.stdout + r.stderr).toMatch(/DELETE-FAILED/);
  });

  it("stops at the first authorization failure instead of hammering", () => {
    const twenty = Array.from({ length: 20 }, (_, i) => mainTag(i));
    const r = run({
      tags: [...BARE_TAGS, ...twenty],
      deleteStatus: 403,
      env: { PRUNE_DRY_RUN: "false" },
    });
    expect(r.status).not.toBe(0);
    expect(r.deleted).toHaveLength(1);
    expect(r.stderr).toMatch(/token/i);
  });
});
