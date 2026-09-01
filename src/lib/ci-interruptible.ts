/**
 * CI cancellation-policy hygiene — every deploy job must have the right opinion
 * about being killed (`!382`).
 *
 * `.gitlab-ci.yml` sets `workflow:auto_cancel:on_new_commit: interruptible`. That
 * one line changes what every OTHER job's `interruptible` value means, which is
 * why it needs a guard rather than a comment.
 *
 * ── What the mode changes ────────────────────────────────────────────────────
 * Under the default `conservative`, GitLab's own reference says "a job that has
 * not started yet is always considered `interruptible: true`, **regardless of the
 * job's configuration**". `deploy_production` is stage-scheduled behind
 * build+test and additionally queues on `resource_group: production`, so at the
 * moment a second merge lands it has not started — and is cancelled however it is
 * configured. Measured on this project: pipeline 2762854030 (main, 2026-08-15)
 * built and pushed the image, five jobs succeeded, and `deploy_production` was
 * `canceled` without ever starting. Pipeline 2758021582 is the same shape.
 * `alert_pipeline_failure` was cancelled in the same sweep, which is why the
 * missing deploy was quiet instead of loud.
 *
 * Under `interruptible` the decision is each job's declared value whether or not
 * it has started. So the mode and the per-job values are **one mechanism**, and
 * either half alone is worthless:
 *
 *   - lose the mode, and `deploy_production` goes back to being cancelled while
 *     unstarted no matter what its block says;
 *   - lose the per-job value, and the mode has nothing to read.
 *
 * That is the whole reason `interruptiblePolicyGaps` checks the mode *and* the
 * jobs, and reports a missing mode as a gap rather than skipping the job checks.
 *
 * ── Why a template is checked too ────────────────────────────────────────────
 * `deploy_production` and `stop_review` both `extends: .deploy_base`, and GitLab
 * merges an extended template's keys into the job. So `interruptible: true` on
 * `.deploy_base` unprotects both jobs while each job's own block still reads
 * `absent`. That is the #145 shape exactly — inheriting the wrong default from a
 * shared base — and it is the one direction a per-job check cannot see, so it
 * would be a **silent** false pass rather than a loud one. `DEPLOY_TEMPLATES`
 * closes it.
 *
 * ── Why the two directions are not symmetric ─────────────────────────────────
 * `MUST_FINISH_JOBS` may be `absent` or `false` — both mean "not interruptible"
 * to GitLab, and the file uses both spellings on purpose (`deploy_production`
 * documents the absence; four alert jobs say `false` out loud). Only `true` is a
 * defect.
 *
 * `MUST_ABANDON_JOBS` must be `true` **explicitly**, because for these jobs the
 * default is the defect: an absent key means every superseded review deploy runs
 * a full `helm upgrade` to completion. Measured over the 16 days to 2026-09-01,
 * 37 `deploy_review` jobs were cancelled having never started — 37 stale
 * upgrades that would otherwise have run on billable Autopilot capacity, and
 * `resource_group`'s unordered queue means the review app could settle on an
 * older commit than the newest push.
 *
 * ── The exposure this key accepts, and why it is not guarded here ────────────
 * `interruptible: true` on `deploy_review` means the job can be killed mid-`helm
 * upgrade`, leaving the release pending and the next upgrade failing with
 * "another operation (install/upgrade/rollback) is in progress". That is real —
 * `helm upgrade` refuses on `Info.Status.IsPending()` — but it needs a push to
 * land inside the job's own 76–261s run, and the job starts a median 675s after
 * its pipeline. Measured over the same 16 days: **0 of 78** completed
 * `deploy_review` windows had a new pipeline created inside them, and the three
 * closest push pairs (547–683s apart) all cancelled `deploy_review` *before* it
 * started. The recovery is `stop_review`, plus `auto_stop_in: 12 hours` as a
 * backstop; a failed `deploy_review` is a red MR pipeline, not a silent one. See
 * `docs/deploy-runbook.md` §20. Guarding a path measured at zero would be the
 * kind of unmeasured guard-building this repo has paid for before.
 *
 * Kept free of `fs` so the parsing is unit-testable on synthetic YAML, matching
 * `ci-job-deps`, `ci-docs-only` and `ci-schedule-guards`; the caller reads the
 * file.
 */
import { jobBlock } from "./ci-job-deps";
import { stripYamlComment } from "./source-text";

/**
 * The only `on_new_commit` mode under which the per-job values below are
 * honoured. Named rather than inlined so the test and the parser cannot drift.
 */
export const AUTO_CANCEL_MODE = "interruptible";

/**
 * Jobs that must run to completion once started, and must never be cancelled.
 *
 * Listed explicitly rather than discovered — the same choice `TEARDOWN_JOBS`
 * makes, for the same reason. Adding a deploy job should trip this list and make
 * you decide which side it is on; discovery would silently accept a new one
 * carrying whichever default it happened to inherit.
 */
export const MUST_FINISH_JOBS = ["deploy_production", "stop_review"] as const;

/** Jobs whose superseded runs are worthless and must be abandoned. */
export const MUST_ABANDON_JOBS = ["deploy_review"] as const;

/** Shared templates the deploy jobs extend, which must not smuggle in a `true`. */
export const DEPLOY_TEMPLATES = [".deploy_base"] as const;

/** What a job's own block says about `interruptible:`. */
export type InterruptibleDeclaration =
  /** No `interruptible` key — GitLab's default, false. */
  | { kind: "absent" }
  /** `interruptible: true` — safe to cancel. */
  | { kind: "true" }
  /** `interruptible: false` — the default, said out loud. */
  | { kind: "false" }
  /**
   * The key is there with a value this module will not interpret.
   *
   * Not folded into `absent`, because YAML 1.1 — which is what GitLab's Ruby
   * parser reads — treats `yes`, `on` and `y` as **true**. Reporting
   * `interruptible: yes` on `deploy_production` as `absent` would be a guard
   * passing a job that GitLab considers cancellable: the precise silent false
   * pass this module exists to prevent. `interruptiblePolicyGaps` flags it in
   * both directions rather than guessing which way it resolves.
   */
  | { kind: "unknown"; value: string };

/**
 * Read a job's own `interruptible:` declaration, or `null` if the job is not in
 * the file at all.
 *
 * `null` is deliberately distinct from `absent`: a renamed or deleted job must
 * not read as a safely-configured one, which is how a guard ends up asserting
 * nothing. Callers that treat the two the same reintroduce that hole.
 *
 * **`extends:` is not followed**, matching `parseJobNeeds`. This function answers
 * "what does this block say", and the inherited direction is covered by naming
 * the templates in `DEPLOY_TEMPLATES` and checking them as blocks in their own
 * right — cheaper than a template resolver, and it fails on the template rather
 * than on each of its consumers.
 */
export function parseJobInterruptible(
  gitlabCiYml: string,
  job: string,
): InterruptibleDeclaration | null {
  const body = jobBlock(gitlabCiYml, job)?.map(stripYamlComment);
  if (!body) return null;

  for (const line of body) {
    // Anchored on the whole line, and only at the job block's own indent level.
    // A deeper `interruptible:` belongs to some other mapping (a `rules:` entry),
    // and a searched-for match would read the block's own sentence "Do not add
    // `interruptible: true` to this job." as the setting — passing while the job
    // is unprotected. Comments are already gone, which shuts that door twice.
    const m = /^(\s+)interruptible:\s*(\S+)\s*$/.exec(line);
    if (!m) continue;
    const [, indent, value] = m;
    if (indent.length !== 2) continue;
    if (value === "true") return { kind: "true" };
    if (value === "false") return { kind: "false" };
    // Deliberately NOT `absent`. See `InterruptibleDeclaration`: YAML 1.1 reads
    // `yes`/`on`/`y` as true, so treating an uninterpreted value as "no key"
    // would report an interruptible `deploy_production` as safe.
    return { kind: "unknown", value };
  }
  return { kind: "absent" };
}

/**
 * Read `workflow:auto_cancel:on_new_commit`, or `null` if it is not declared.
 *
 * Indentation is what distinguishes this from any other `on_new_commit:` in the
 * file: 4 spaces, inside `auto_cancel:` at 2, inside the `workflow:` block.
 */
export function parseAutoCancelOnNewCommit(gitlabCiYml: string): string | null {
  const body = jobBlock(gitlabCiYml, "workflow")?.map(stripYamlComment);
  if (!body) return null;

  let inAutoCancel = false;
  for (const line of body) {
    if (!line.trim()) continue;
    const indent = /^(\s*)/.exec(line)![1].length;
    if (indent === 2) inAutoCancel = /^\s+auto_cancel:\s*$/.test(line);
    if (!inAutoCancel) continue;
    const m = /^(\s+)on_new_commit:\s*(\S+)\s*$/.exec(line);
    if (m && m[1].length === 4) return m[2];
  }
  return null;
}

/**
 * Every way the file currently disagrees with the policy above, as sentences.
 *
 * Empty means compliant. A caller must also show the derivation was non-empty —
 * "no gaps" is equally true of a file with no deploy jobs and of a parser that
 * matched nothing — which is why the jobs are a named list the test can assert
 * resolves. Same floor `ci-schedule-guards` keeps under `guardParityGaps`.
 */
export function interruptiblePolicyGaps(gitlabCiYml: string): string[] {
  const gaps: string[] = [];

  const mode = parseAutoCancelOnNewCommit(gitlabCiYml);
  if (mode !== AUTO_CANCEL_MODE) {
    gaps.push(
      `workflow:auto_cancel:on_new_commit is ${mode ?? "not declared"}, expected ${AUTO_CANCEL_MODE} — ` +
        `under any other mode an unstarted job is cancelled regardless of its own interruptible value, ` +
        `which is how pipeline 2762854030 lost a built-and-pushed production deploy`,
    );
  }

  for (const job of [...MUST_FINISH_JOBS, ...DEPLOY_TEMPLATES]) {
    const declared = parseJobInterruptible(gitlabCiYml, job);
    if (declared === null) {
      gaps.push(
        `${job} is missing from .gitlab-ci.yml — is this module's policy list stale?`,
      );
      continue;
    }
    // `absent` and `false` are both fine here and mean the same thing to GitLab.
    // `unknown` is not: YAML 1.1 reads `yes`/`on`/`y` as true, so an
    // uninterpreted value has to be reported rather than assumed harmless.
    if (declared.kind === "true" || declared.kind === "unknown") {
      const why = job.startsWith(".")
        ? `it is extended by ${MUST_FINISH_JOBS.join(" and ")}, so this unprotects them while their own blocks still read absent`
        : `a second merge or push would cancel it`;
      const value =
        declared.kind === "true" ? "true" : `${declared.value} (uninterpreted)`;
      gaps.push(`${job} is interruptible: ${value} but must finish — ${why}`);
    }
  }

  for (const job of MUST_ABANDON_JOBS) {
    const declared = parseJobInterruptible(gitlabCiYml, job);
    if (declared === null) {
      gaps.push(
        `${job} is missing from .gitlab-ci.yml — is this module's policy list stale?`,
      );
      continue;
    }
    if (declared.kind !== "true") {
      gaps.push(
        `${job} is interruptible: ${declared.kind} but must be abandoned when superseded — ` +
          `under ${AUTO_CANCEL_MODE} anything but an explicit true runs every stale deploy to completion`,
      );
    }
  }

  return gaps;
}
