# CI speed review — 2026-07-24

> Raw Duo CI-expert review of the pipeline critical paths. The actionable plan
> and decisions (owner leans **#1 + #3**; #2 deferred; plus the release-gate and
> secret-scan guards) are tracked in **#53** (milestone v0.4.0).

## Context

CI speed review (2026-07-24) based on measured critical paths:

- **MR pipeline** (~6m 50s): `test_app`/`e2e_test` (~142s) → `build_image` (152s) → `deploy_review` (111s)
- **main pipeline** (~14m 30s): `test_app` (212s) → `build_image` (171s) → `container_scanning` (138s) → `deploy_production` (332s)

Reference pipelines: https://gitlab.com/gl-demo-ultimate-dtop/domi-oss/dlectroflow/-/pipelines/2703739654 (MR),
https://gitlab.com/gl-demo-ultimate-dtop/domi-oss/dlectroflow/-/pipelines/2703702535 (main)

## Proposed changes

### 1. Start `build_image` right after `build_app` (~1 min saved on MRs, ~2 min on main)

`build_app` finishes at ~90s but `build_image` idles 50–120s waiting on the `test_app` + `e2e_test` gates.
Move the "no deploy from a red suite" gate downstream instead:

- `build_image` → `needs: [build_app]` only
- `deploy_review` → `needs: [build_image, test_app, e2e_test]`
- `deploy_production` unchanged (stage-scheduled behind the build stage, gate preserved)

Trade-offs:
- Image pushed even on red suites (MR SHA tags are reaped by cleanup; `main-<sha>` kept but never deployed).
- Tag pipelines: release image could publish from a red suite — softens the documented `#12 §5` invariant
  (low risk since tags are cut from green main). Decide before implementing.

Validated with the CI Linter — config passes.

### 2. Larger runners for heavy jobs (~1–1.5 min more)

`build_app`, `test_app`, `e2e_test` are CPU-bound on `saas-linux-small` (2 vCPU).
Moving to `saas-linux-medium-amd64` typically cuts 30–40% off those jobs.
Trade-off: 2× compute-minute cost for those jobs.

### 3. Minor / no action

- `test_app` variance (142–212s) is vitest + sequential static checks; splitting jobs not worth the extra `npm ci` per job.
- Duplicate secret detection: policy-driven `secret-detection-0` runs alongside the template `secret_detection` —
  check whether the `Jobs/Secret-Detection.gitlab-ci.yml` include is redundant.
- `deploy_production` (332s) is dominated by `helm --atomic` rollout wait — not addressable in CI config.
- `e2e_test`'s repeated `npm run build` is required (musl vs glibc Prisma engines).

## Follow-up: what the docs-only fast path cost (#116)

Recorded here because the review above proposed the fast path without noticing this.

Skipping a scanner is not free even when there is nothing to scan. The approval
policy compares the set of security report **types** in a merge request's
pipeline against the set in `main`'s, and treats a type `main` has and the merge
request lacks as unresolved rather than as inapplicable. So the fast path made
every docs-only merge request unmergeable until one specific human approved it —
a slow path for the safest class of change, on an OSS repo where a drive-by
documentation fix should be easy. It took months to spot because the failure
message blames security, not CI configuration.

Fixed by `docs_only_scan_stub` in `.gitlab-ci.yml`, which emits an empty,
schema-valid report for each of the three types the fast path skips
(`secret_detection` is ungated and still runs for real). Its rule is the exact
inverse of the one that runs the real scanners, so it can only fire on a diff
containing no code path at all.

**The general lesson for any future `changes:`-gated job: check what consumes
its output.** A gate that silently stops producing an artifact something else
compares against fails somewhere unrelated, and the error points at the consumer.
