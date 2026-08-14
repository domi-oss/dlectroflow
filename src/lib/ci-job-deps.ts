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
 *
 * ── Comments are stripped before anything is matched (#226) ───────────────────
 * `.gitlab-ci.yml` is in `.prettierignore` *because* it "relies on hand-aligned
 * inline comments", so no formatter will ever normalise one away and annotating a
 * line here is an ordinary edit. Every matcher below used to break on one, in
 * three separate ways, and #226 reported only the third:
 *
 *     stop_review: # teardown       the job became unfindable, so the test said
 *                                   it was MISSING from the file
 *     needs: [] # load-bearing      read as `{ kind: "list", jobs: ["] # …"] }`,
 *                                   a dependency on a job that cannot exist
 *     action: stop # why            read as declaring no stop action
 *
 * All three fail loud, which is why #226 sat in Backlog — the opposite of the
 * identical hole in `guardedFlags` (#191), where the miss was silent. The cost is
 * a red pipeline accusing the file of something untrue, and the time it takes to
 * notice the `#`.
 */
import { stripYamlComment } from "./source-text";

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

/**
 * The lines of one top-level job block, excluding the `name:` line itself.
 *
 * The start line must be the job key at column 0 with nothing after the colon but
 * an optional comment — the same test `ci-docs-only`'s own extractor applies, and
 * for the same two reasons. A bare equality check rejects `stop_review: # why`
 * (#226); a `startsWith` would accept `stop_review: some-value`, which is a
 * scalar binding and not a block at all.
 *
 * **Returns the body RAW, comments included**, and that is a contract rather than
 * an oversight: `deploy-values.ts` imports this and runs `stripShellComments` over
 * the same lines, because the helm invocation inside a `script:` is shell and the
 * two languages disagree about where a comment starts. The matchers below strip
 * for themselves.
 */
export function jobBlock(gitlabCiYml: string, job: string): string[] | null {
  const lines = gitlabCiYml.split("\n");
  const start = lines.findIndex(
    (l) => /^[^\s#]/.test(l) && stripYamlComment(l).trimEnd() === `${job}:`,
  );
  if (start === -1) return null;
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    // A new top-level key ends the block. Blank lines and comments inside it
    // are kept: a comment can sit between `needs:` and its first item.
    //
    // A column-0 COMMENT also ends it, which is deliberate and was re-checked in
    // #226 rather than aligned with `topLevelBlocks`' pending-comment handling. In
    // YAML a column-0 line does end an indented block, and the shape that would
    // make this wrong — a column-0 comment sitting between a job's own keys —
    // appears nowhere in the file. Getting it wrong truncates the block, which is
    // a false negative in every caller and therefore loud; chasing it would mean
    // a second YAML parser here for no reachable defect.
    if (/^\S/.test(line)) break;
    body.push(line);
  }
  return body;
}

/**
 * A job's body with YAML inline comments removed, which is what every matcher
 * below wants and what `jobBlock` deliberately does not return.
 *
 * Line count is preserved because `stripYamlComment` only ever shortens a line —
 * a comment-only line arrives as whitespace, not as a deleted entry — so the
 * block-form scan below can still reason about indentation and ordering.
 */
function strippedJobBlock(gitlabCiYml: string, job: string): string[] | null {
  return jobBlock(gitlabCiYml, job)?.map(stripYamlComment) ?? null;
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
  const body = strippedJobBlock(gitlabCiYml, job);
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
      // A comment-only line has already been stripped to whitespace, so it
      // arrives here as blank — the same tolerance the explicit `#` check used to
      // give, now covering a comment appended to an item as well (#226). The same
      // simplification `guardedFlags` made when it started stripping first.
      if (!line.trim()) continue;
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

/**
 * Does this job's block set `environment.action: stop`?
 *
 * Anchored on the whole line rather than searched for anywhere in it, so prose
 * describing the key is not mistaken for the key. Comments are gone by the time
 * this runs, which closes the direction #226 reported — `action: stop # why` — and
 * keeps the other one shut whether or not the anchor happens to help.
 */
export function declaresStopAction(gitlabCiYml: string, job: string): boolean {
  const body = strippedJobBlock(gitlabCiYml, job);
  if (!body) return false;
  return body.some((l) => /^\s+action:\s*stop\s*$/.test(l));
}
