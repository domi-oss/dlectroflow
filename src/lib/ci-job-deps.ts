/**
 * CI job-dependency hygiene — teardown jobs must declare `needs:` (#145).
 *
 * GitLab gives a job with no `needs:` an implicit dependency on **every job in
 * every earlier stage**. For a job that consumes artifacts that is a sane
 * default. For a *teardown* job it is a slow-acting trap: once those upstream
 * artifacts expire, the dependency can no longer be satisfied and the job fails
 * with `missing_dependency_failure` **before its script runs at all** — no log
 * output, `started_at: null`.
 *
 * That is what leaked review-app namespaces. `stop_review` sits in `deploy` and
 * declared no `needs`, so it implicitly depended on `build`, `build_image` and
 * `test`. After artifact expiry it became permanently unrunnable, which meant:
 *
 *   - the environment could never leave `stopping` (GitLab shows it as Active),
 *   - and `kubectl delete namespace` never ran, so an app pod + a Postgres
 *     StatefulSet kept running for merged MRs — ~$20/month each on Autopilot.
 *
 * `allow_failure: true` hid the whole thing: the pipeline stayed green and the
 * MR merged normally. Six environments were wedged this way, the oldest since
 * 11 July, before anyone noticed. The auto-stop timer was decorative.
 *
 * The invariant asserted here is deliberately narrow and mechanical: a job that
 * tears an environment down must say what it needs, and for these jobs the
 * honest answer is `needs: []` — they consume no artifacts, only `helm` and
 * `kubectl` against a live cluster.
 *
 * Kept free of `fs` so the parsing is unit-testable on synthetic YAML, matching
 * `ci-docs-only`, `dockerfile-hygiene` and `lockfile-hygiene`; the caller reads
 * the file.
 */

/**
 * Jobs whose purpose is to destroy an environment, keyed by job name.
 *
 * Identified by `environment.action: stop` in `.gitlab-ci.yml`. Listed
 * explicitly rather than discovered, so that ADDING a teardown job is a
 * deliberate act that trips this list and makes you think about `needs:` —
 * discovery would silently accept a new job with the original bug.
 */
export const TEARDOWN_JOBS = ["stop_review"] as const;

/** What a job's own block says about `needs:`. */
export type NeedsDeclaration =
  /** No `needs:` key in the job's own block — implicit dependency on all earlier stages. */
  | { kind: "absent" }
  /** `needs: []` — explicitly depends on nothing. */
  | { kind: "empty" }
  /** `needs:` with at least one entry. */
  | { kind: "list"; jobs: string[] };

/** The lines of one top-level job block, excluding the `name:` line itself. */
export function jobBlock(gitlabCiYml: string, job: string): string[] | null {
  const lines = gitlabCiYml.split("\n");
  const start = lines.findIndex((l) => l === `${job}:`);
  if (start === -1) return null;
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    // A new top-level key ends the block. Blank lines and comments inside it
    // are kept: a comment can sit between `needs:` and its first item.
    if (/^\S/.test(line)) break;
    body.push(line);
  }
  return body;
}

/**
 * Read a job's own `needs:` declaration.
 *
 * **`extends:` is deliberately NOT followed.** Inheriting "no `needs`" from a
 * shared base is precisely how #145 happened — `stop_review` extended
 * `.deploy_base`, which declares none — so a teardown job satisfying this check
 * only via a template would reproduce the bug while passing the test. Each such
 * job states its own dependencies.
 */
export function parseJobNeeds(
  gitlabCiYml: string,
  job: string,
): NeedsDeclaration | null {
  const body = jobBlock(gitlabCiYml, job);
  if (!body) return null;

  for (let i = 0; i < body.length; i++) {
    const m = /^(\s+)needs:\s*(.*)$/.exec(body[i]);
    if (!m) continue;
    const [, indent, inline] = m;
    // Only a top-level key of the job block, not a `needs:` nested inside some
    // other mapping (e.g. a `rules:` entry), which would be a different thing.
    if (indent.length !== 2) continue;

    const flow = inline.trim();
    if (flow === "[]") return { kind: "empty" };
    if (flow.startsWith("[")) {
      const inner = flow.slice(1, flow.endsWith("]") ? -1 : undefined);
      const jobs = inner
        .split(",")
        .map((s) => s.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean);
      return jobs.length ? { kind: "list", jobs } : { kind: "empty" };
    }

    // Block form: subsequent more-indented `- job: x` / `- x` entries.
    const jobs: string[] = [];
    for (const line of body.slice(i + 1)) {
      if (!line.trim() || line.trim().startsWith("#")) continue;
      const itemIndent = /^(\s*)/.exec(line)![1].length;
      if (itemIndent <= indent.length) break;
      const named = /^\s*-\s*job:\s*(\S+)/.exec(line);
      if (named) {
        jobs.push(named[1].replace(/^["']|["']$/g, ""));
        continue;
      }
      const bare = /^\s*-\s*(\S+)/.exec(line);
      if (bare) jobs.push(bare[1].replace(/^["']|["']$/g, ""));
    }
    return jobs.length ? { kind: "list", jobs } : { kind: "empty" };
  }
  return { kind: "absent" };
}

/** Does this job's block set `environment.action: stop`? */
export function declaresStopAction(gitlabCiYml: string, job: string): boolean {
  const body = jobBlock(gitlabCiYml, job);
  if (!body) return false;
  return body.some((l) => /^\s+action:\s*stop\s*$/.test(l));
}
