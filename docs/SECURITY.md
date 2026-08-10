# Security Policy

dlectroflow is a single-maintainer, agent-augmented project that runs live at
https://dlectroflow.dev. This document defines how security issues
are reported and handled, and where the line sits between automated and
human-only remediation.

## Reporting a vulnerability

**Do not open a public issue for a suspected vulnerability.**

- Preferred: open a [confidential issue](https://gitlab.com/gl-demo-ultimate-dtop/domi-oss/dlectroflow/-/issues/new)
  (check **This issue is confidential**) with steps to reproduce and impact.
- Alternatively, email the maintainer at the address on the GitLab profile.

Please include: affected URL/endpoint or file, a reproduction, and the impact
you believe it has. We do not run a paid bug-bounty program, but credible
reports are acknowledged and credited (with your consent).

## Supported versions

Only the currently deployed `main` (production) is supported. There are no
back-ported release branches.

| Version | Supported |
|---------|-----------|
| `main` (production) | ✅ |
| Any tag / older commit | ❌ |

## Response targets

| Severity | Triage | Fix or documented mitigation |
|----------|--------|------------------------------|
| Critical (exploitable in production) | 24 hours | 72 hours |
| High | 3 business days | 2 weeks |
| Medium / Low | Next assessment cycle | As capacity allows |

"Triage" means acknowledged, reproduced (or refuted), and severity confirmed.

## Automated vs. human-only remediation

This project delegates routine security work to agents, with a human retaining
authority over anything that changes trust boundaries or production state.

**Agents may perform autonomously (human approves the MR):**
- Dependency patch/minor/digest bumps (Renovate), gated behind required scanners.
- Drafting false-positive dismissal rationale for human confirmation.
- Scanner-config and CI hygiene changes.
- Weekly vulnerability digests from the base-image rescan schedule.

**Human-in-the-loop (agent proposes, human decides):**
- Vulnerability dismissals, severity changes, and risk acceptances.
- Any production configuration change.

**Human-only:**
- Cryptographic key or secret rotation.
- Production rollback / incident command.
- Repository visibility changes and security-policy edits.

## Handling a Critical-in-production discovery

1. **Contain** — if actively exploited, take the affected path offline
   (scale down, disable the route, or roll back to the last-known-good image tag).
2. **Rotate** — if any secret may be exposed, rotate it (see below) before
   restoring service.
3. **Fix** — land the patch through the normal MR + required-scanner pipeline.
4. **Verify** — confirm `/api/health` is 200 and the finding is resolved on the
   default-branch scan.
5. **Record** — note the timeline and root cause on the security assessment issue.

### Secret rotation note

Application secrets are injected via a Kubernetes Secret consumed with
`envFrom: secretRef`. Rotating a secret in CI/CD variables and re-deploying now
automatically rolls the pods (a `checksum/secret` annotation on the Deployment
pod template forces a rollout when the Secret changes), so rotated values take
effect without a manual `kubectl rollout restart`.

## Security program cadence

- **Per-commit (agent-gated):** SAST, Advanced SAST, Dependency Scanning,
  Secret Detection, and Container Scanning run as **required** MR jobs; a Scan
  Result Policy requires approval for any new Critical/High finding.
- **Weekly:** base-image rescan schedule; Renovate review.
- **Monthly:** security assessment re-run (per `.gitlab/duo/prompts/security-assessment.md`).
  Kicked off by the **Monthly security assessment** pipeline schedule
  (`SECURITY_ASSESSMENT=true` → the `security_assessment` job), which files the
  dated work item pre-filled with the active-vulnerability snapshot. Before #134
  this cadence had no mechanism, and the Vulnerability Report reached 70
  findings — 8 of them High — that nobody had read.
- **Quarterly:** threat-model refresh and policy review.

> ⚠️ **The Scan Result Policy only gates on *new* Critical/High findings.**
> Anything already in the baseline is never "new", so it never blocks anything.
> The monthly assessment is the only thing that reads the baseline — and it
> reports "still detected on `main`" separately from "already fixed but never
> resolved", because the Vulnerability Report's default view does not
> distinguish them.

### Which surface is authoritative, and how old is its answer (#166)

Two surfaces report vulnerability counts for this project and they **disagree
without saying so**. On 2026-08-04, against the same tree, the pipeline query
read 12 dependency findings where the Vulnerability Report read 11.
Reconciling them cost an afternoon, twice, before the answer was written down:

| Question | Query | Notes |
|---|---|---|
| What is on `main` right now? | `project.vulnerabilities(state: [DETECTED, CONFIRMED])` | **Authoritative.** Paginate it — this project already holds 100 records on page one. |
| What did *this merge request* introduce? | `project.pipeline(iid:).securityReportFindings` | Merge-request pipelines **only**. |

**A pipeline-level query looks empty against `main`, and the cause is a default
argument — not the surface.** `securityReportFindings` with **no `state:`
argument returns `DETECTED` only**. A well-triaged `main` has a tiny `DETECTED`
set, so the query reads 0 or 1 and looks like a surface that reports nothing by
design. It is not one.

Measured 2026-08-07: it returned **1** on `main` pipeline iid 2005 (`fe5321a`)
and **1** on iid 2009 (`0d47b2f`). On MR pipeline iid 1981 — unfiltered **1**,
`state: [DISMISSED]` **29**, all four states **30**. Pass the filter and the
records are there:

```
securityReportFindings(first: 200, state: [DETECTED, CONFIRMED, DISMISSED, RESOLVED])
```

The 2026-08-06 observation this paragraph used to rest on — `main` pipeline iid
1606 reading 0 dependency findings on the exact tree (`cca6fdd`) that MR
pipeline iid 1611 reads 12 on — is a real measurement, but the explanation
attached to it was wrong. Those 12 were triaged records an unfiltered query
cannot see, not findings that had stopped being reported.

**This paragraph previously said the opposite**, and asserting that a zero was
expected is worse than saying nothing: it taught the reader not to question one.
The same claim sat uncorrected in a maintainer's own notes for five days. **Never
accept a zero from this query without a control** — run it with the state filter,
or against a pipeline known to hold findings, and watch it come back non-zero
before believing the zero.

**Every count must carry its age.** `scripts/check-vuln-freshness.sh` emits the
count together with the query that produced it and the instant that dates it;
the weekly `ops_digest` and the monthly `security_assessment` both embed it, so
neither files a number a reader cannot date. Its freshness budget is **192h** —
the 168h weekly rescan cycle plus 24h of scheduler grace.

Two things date the answer, and they are **not** interchangeable:

- **The scanner job**, not the pipeline. The scanners are `allow_failure: true`
  on `main` on purpose (a scanner flake must not block a production deploy), so
  a green `main` pipeline does not prove a scan ran and a red one does not
  prove it did not. Measured 2026-08-06, four of the last six `main` pipelines
  were red with all five analyzers green, and the last green pipeline finished
  33.6h before the last successful scan.
- **`detectedAt`**, which moves when Continuous Vulnerability Scanning
  re-evaluates the stored SBOM with no pipeline at all. It dates only the
  scanner whose findings it belongs to — the SBOM is dependency scanning's
  artefact, so a dependency finding re-detected an hour ago says nothing about
  whether container scanning has run this month.

An aggregate count is only as fresh as its **stalest** contributing scanner,
and a count of zero has no `detectedAt` of its own — so when the scan cannot be
found, the honest answer is *undetermined*, never *clean*.

**Neither is a timestamp ahead of the clock.** A finish time or a `detectedAt`
later than the instant the check ran is not a fresh one, it is one that cannot
be read, and it is reported as *undetermined* like any other unknown. Five
minutes of runner clock skew is allowed for, because gitlab.com dispatches jobs
from a shared pool and a runner clock is not the API clock; anything past that
is data, not drift. Without the bound a container scanner three weeks dead read
`✅ Fresh, 1h old` as soon as one row carried a future stamp.
