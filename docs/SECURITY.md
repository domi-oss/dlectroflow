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

**Agents may perform autonomously, with no human approving the merge:**
- Dependency **patch / minor / digest / pin** bumps (Renovate), gated behind the
  required scanners. `packageRules[0]` in `.gitlab/renovate.json` sets
  `automerge: true` for exactly those four update types, and this project sets no
  baseline approval requirement (`approvals_before_merge: 0`, no approval rules),
  so the required scanners plus the Scan Result Policy are the whole gate: a
  clean pipeline merges unattended, and a new Critical/High finding is what
  summons a human. **This bullet used to sit under the "human approves the MR"
  heading below**, which the config has never supported — see *Dependency update
  triage*.

**Agents may perform autonomously (human approves the MR):**
- Drafting false-positive dismissal rationale for human confirmation.
- Scanner-config and CI hygiene changes.
- Weekly vulnerability digests from the base-image rescan schedule.

**Human-in-the-loop (agent proposes, human decides):**
- Dependency **major** bumps, and lifting any `allowedVersions` cap. Both are
  risk acceptances in the sense used below: they change what this project is
  willing to run. No `automerge` rule matches a major, so the config enforces
  this rather than convention alone.
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
- **Weekly (Monday):** base-image rescan schedule at 06:00; the Renovate update
  window at 07:00–08:59, which is the only run permitted to open update MRs.
- **Every four hours:** the Renovate automerge-recovery run, whose job is to
  finish an automerge lost at MR creation (#243) and which, as a side effect, is
  what keeps the Dependency Dashboard current.
- **Weekly (Monday, after the update window):** a dependency triage pass over
  the Dependency Dashboard — scope, steps and failure modes under *Dependency
  update triage*. This is the only item on this list a person performs, so it is
  the only one that can silently not happen; what that costs is bounded, and
  stated there rather than left to be assumed.
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

## Dependency update triage

Most dependency work here happens without a person. Renovate opens the MRs, the
required scanners gate them, and patch/minor/digest/pin merge themselves once the
pipeline is green. What is left for a person is a weekly pass over the
**Dependency Dashboard** (#17): the residue the automation deliberately does not
touch, the deferred caps, and one failure the dashboard cannot report about
itself.

**What a missed pass costs, stated plainly, because it is the reason this cadence
can be published honestly:** routine updates keep landing without it, and an
outstanding security fix does not wait on it either (see *Where a security fix
actually appears*). What accumulates is the deferred residue — majors, capped
packages, abandoned packages — and a dashboard whose claims nobody has checked.
That is a slow cost, not an incident. It is also the entire reason the previous
version of this section overstated: a weekly review nobody had defined was easier
to promise than to do.

### Three schedules, one flag, and only one may open an MR

| Schedule | Cron (Europe/London) | What it may do |
|---|---|---|
| Weekly base-image rescan | `0 6 * * 1` | Rebuild and re-scan `main`; carries `ops_digest`. Never deploys. |
| **Weekly Renovate** | `0 7 * * 1` | **The only run that may open update MRs.** |
| Renovate automerge recovery | `0 1,5,9,13,17,21 * * *` | Finish an automerge lost at MR creation. Opens nothing. |

Both Renovate schedules carry `RENOVATE_RUN=true` and run the same job; what
separates them is the clock. `.gitlab/renovate.json` sets
`"schedule": ["* 7-8 * * 1"]` under `"timezone": "Europe/London"`, and none of
the six recovery hours falls inside that window. Out of window Renovate finishes
work already in flight and creates no branches, so **a recovery run that rewrites
nothing is the design working, not a fault** — the commonest way to misread this
system is to check it on a Saturday and conclude it is broken.

Delete the window and all six daily runs start opening MRs of their own, up to
`prConcurrentLimit: 5`. `src/lib/renovate-hygiene.test.ts` asserts the window
exists and that its cron minute is `*` (Renovate has no minute granularity and
rejects anything else), because nothing in this project's CI runs
`renovate-config-validator`.

### ⚠️ Ticking a dashboard checkbox can be a merge, not a review request

A checkbox under **Awaiting Schedule** does not queue an update for review. It
tells Renovate to create the branch and MR immediately, ignoring the window —
and what happens next depends entirely on the update type:

- **patch, minor, digest, pin** — `packageRules[0]` sets `automerge: true`, and
  nothing further is asked of a person unless a scanner objects, so **the tick is
  the last human action before that change is on `main`.**
- **major** — no `automerge` rule matches, so it stops as an open MR and waits.

The list mixes both freely and is long: **32 entries on 2026-08-15**, spanning
digest refreshes and `typescript` v6, `prisma` v7 and `node` v24. So "tick a few
to catch up" is not a safe motion, and the 🔐 **Create all awaiting schedule
MRs at once** 🔐 box even less so. Read the update type before each tick.

Note for completeness, because it changes how much to trust that rule today:
`automerge: true` describes what the config asks for, not a path that has yet
carried this project's traffic. Renovate arms GitLab's native auto-merge once, at
MR creation, and swallows the failure if it does not take — so **all 34 Renovate
MRs merged between 2026-07-15 and 2026-08-11 were merged by hand**, every one of
them. That is what #243 is, and what the recovery schedule addresses. Expect the
automerge path to start firing, and treat the checkbox warning above as the
standing rule rather than a future one.

### What each dashboard section means

| Section | What it is | What to do with it |
|---|---|---|
| **Repository Problems** | Warnings Renovate raised about the run itself, reprinted from its `warn` stream. | **Read first** — a problem here can mean the rest of the page is incomplete. The `logLevelRemap` entry promotes `Automerge on PR creation failed` to `warn` so a lost automerge surfaces here instead of only in a job log nobody opens (#243). |
| **Abandoned Dependencies** | Packages with no release since `abandonmentThreshold`. Inferred from inactivity — not an upstream notice, and not a vulnerability. | Note it. Act only if the package is production-reachable *and* a maintained equivalent exists; a small stable package with no releases is often just finished. |
| **Awaiting Schedule** | Updates computed but not opened, because it is outside the Monday window. | The main body of the pass. Read the warning above before ticking. |
| **Rate-Limited** | Updates held back by `prConcurrentLimit: 5`. Appears only while five Renovate MRs are already open. | Clear the open MRs rather than ticking through this list — the limit is doing its job. |
| **Pending Status Checks** | The branch exists; Renovate is waiting on its pipeline before opening the MR. | Usually resolves itself. Ticking forces MR creation *before* the branch is green, which is the opposite of what the wait is for. |
| **Open** | Renovate MRs open as of the last run. | ⚠️ **A claim about the last run, not about now.** Confirm against real MR state — see below. |
| **Detected Dependencies** | The full inventory Renovate parsed, by manager. | Reference, not a task list. Its real use is confirming that a newly added manifest or image field is actually being tracked. |

A section that is empty is omitted entirely rather than shown empty, so its
absence carries no information.

### Noticing the dashboard has gone stale

This is the failure that actually occurred, and it is the one the dashboard
cannot report: **every section is written by the last Renovate run, so a page
five days old looks exactly like a page written a minute ago.**

**The recorded instance, with its resolution, because the two dates are the
point.** Read on the morning of 2026-08-15, `#17` carried an `updated_at` of
`2026-08-10T06:14Z` — the finish time of the previous Monday's Renovate run — and
its **Open** section still listed `!312`–`!316` as awaiting action, all five of
which had merged on 2026-08-11. Nothing on the page said so. The cause was not a
failed run: before the recovery schedule existed, the Monday run was the only
thing that rewrote the page, so between Mondays a merged MR stayed on the list
**by construction**. That schedule was created at `2026-08-15T00:28Z`, and its
first run rewrote the page at `2026-08-15T12:11Z` — which is why the same page
read current a few hours later, and why the numbers in the check below agree.

So the failure is fixed at the mechanism, and the check below stays worth running
anyway: it is what distinguishes "Renovate has not run" from "Renovate ran and
found nothing", and no section of the page distinguishes those on its own.

The check is to compare the issue's `updated_at` against the last successful
`renovate` job, because Renovate rewrites the issue at the end of its run:

```
glab api "projects/84020916/issues/17" | jq -r .updated_at
glab api "projects/84020916/jobs?scope[]=success&per_page=100" \
  | jq -r 'map(select(.name=="renovate"))[0].finished_at'
```

The two should agree to within about a minute — run on 2026-08-15 they returned
`2026-08-15T12:11:11Z` and `2026-08-15T12:11:13Z`. **If `updated_at` is older
than the last successful `renovate` job, the page was not rewritten and every
section on it is a claim about an earlier tree.** With the 4-hourly recovery
cadence the expected gap is under four hours rather than under seven days, so
this check is now sharp enough to be worth running.

Confirm the **Open** list against real MR state regardless, since it is the one
section whose entries can be finished work:

```
glab api "projects/84020916/merge_requests?state=opened&per_page=100" \
  | jq -r '.[]|select(.source_branch|startswith("renovate/"))|"!\(.iid) \(.title)"'
```

Empty output means no Renovate MR is open. That is what it printed on 2026-08-15
after the page had been rewritten — and it is the answer the stale page had been
contradicting for four days.

### The deferred caps, and when each one expires

`.gitlab/renovate.json` carries **six** `allowedVersions` rules. Each states its
own lift condition in its `description`, and a triage pass re-checks whether that
condition still holds. **A cap whose condition has expired is a finding** — at
that point it is blocking an update for a reason that no longer exists, and
silently, because a cap produces no MR to notice.

| Scope | Cap | What lifts it |
|---|---|---|
| `tsx` | `>=4.22.0` | A floor, not a ceiling: keeps tsx's esbuild range overlapping vite's so the lockfile resolves a single esbuild (#67). Guarded by `lockfile-hygiene`. |
| `eslint` | `<10` | An `eslint-plugin-react` release peering ESLint 10, reachable through `eslint-config-next` (#21). |
| `typescript` | `<6.1` | `@typescript-eslint` shipping TS 7 support. TS 6.0.x is still proposed today. |
| `brace-expansion`, top-level override | `>=5.0.8` | The top-level override no longer being needed (#82, #161). Guarded by `override-hygiene`. |
| `brace-expansion`, nested `minimatch@^3` override | `<3` | `minimatch@3` leaving the ESLint plugin chain; the override and this rule are then deleted together (#82, #161). |
| `postgres` (docker) | `<17` | A planned dump/restore migration moving all three pins in one commit. Digest refreshes and 16.x minors are unaffected. |

⚠️ **`allowedVersions` is not bypassed for a security fix.** Two of these caps —
`typescript` and the nested `brace-expansion` — would therefore also hold back an
advisory fix. Both are recorded accepted trade-offs and both cover dev-only
dependencies whose real remediation is lifting the cap rather than routing around
it. Do not add a cap to a production-reachable package without recording that
same reasoning next to it.

### Reasoning about an advisory

**Decide from the affected range and the patched version. Never from dates.**
Under coordinated disclosure the advisory is published *after* the fix exists, so
"the advisory is newer than the release we are on" is true of nearly every
responsibly disclosed CVE and distinguishes nothing. Both facts you need are on
the same record:

```
project.vulnerabilities(
  reportType: [DEPENDENCY_SCANNING]
  state: [DETECTED, CONFIRMED, DISMISSED, RESOLVED]
) { nodes { title state solution
            location { ... on VulnerabilityLocationDependencyScanning {
              dependency { version package { name } } } } } }
```

`location.dependency.version` is the version the scanner actually read;
`solution` is the patched set.

**`solution` usually names more than one patched line, and the highest number in
it is usually the wrong target.** A live record here reads `fast-uri` at `3.1.4`
with *"Upgrade to versions 2.4.4, 3.1.5, 4.1.2 or above."* The fix for our line
is **3.1.5**, a patch. Reading only `4.1.2` converts a patch bump into a major
one and invents a migration that the advisory never asked for.

**The worked example, from this repo.** #55 bumped `brace-expansion`
1.1.16 → 2.1.2 for CVE-2026-14257 and closed. The advisory later widened to cover
2.x. The first reading of the re-detected finding was that it "appears to be
stale scan state", because the issue was closed and the lockfile said 2.1.2. That
was wrong — **2.1.2 was the old fix, not immunity.** What settled it was the
reported version against the solution field (*"Upgrade to version 5.0.8 or
above"*); #82 records the correction. So: **a closed issue is not evidence that a
package is patched, and neither is the version number by itself.** A version
means something only against the range that is affected *today*.

The same error runs in the other direction and did. All eight HIGH findings
triaged under #134 were `resolvedOnDefaultBranch: true` — already fixed by
`next@16.2.11` and `sharp@0.35.3` bumps sitting in the lockfile — and were marked
**resolved rather than dismissed** for exactly that reason, because dismissing a
real finding a version bump had fixed would misrecord why it went away.
**A finding's state is not its liveness, in either direction.**

### Where a security fix actually appears

**Not on any held-back list.** `vulnerabilityAlerts` in `.gitlab/renovate.json`
carries labels only, deliberately. Renovate guards every limit gate on its
security path with `&& !config.isVulnerabilityAlert`, so `prConcurrentLimit`,
`branchConcurrentLimit`, `prHourlyLimit`, `commitHourlyLimit` and `schedule` are
all ignored for a security bump — the docs put it as "vulnerability alerts skip
the line". An outstanding one is therefore **an open MR at the front of the
queue**, never a line under *Awaiting Schedule* or *Rate-Limited*.
`renovate-hygiene` fails if one of those keys is added back, because
`renovate-config-validator` accepts them and so cannot tell you they do nothing
(#243).

**One honesty note, or the paragraph above overstates.** That block is inert on
GitLab today: Renovate implements `platform.getVulnerabilityAlerts` on its GitHub
platform only, and `osvVulnerabilityAlerts` is deliberately off, so no advisory
source currently reaches Renovate here. What actually surfaces an advisory on
this project is **GitLab Dependency Scanning plus the Scan Result Policy**, per
the per-commit line in the cadence above. The `vulnerabilityAlerts` guarantee is
what would apply once a source is wired, and the hygiene test is what keeps it
from being quietly turned into a no-op before then.

### The zero to check, and how to earn it

A pass should end by confirming nothing is outstanding — and on this project that
number is worth exactly as much as the control run beside it. Measured
2026-08-15:

| Query | Result |
|---|---|
| `vulnerabilities(reportType: [DEPENDENCY_SCANNING], state: [DETECTED, CONFIRMED])` | **0** |
| Same, `state: [DISMISSED, RESOLVED]` | **31** (29 resolved, 2 dismissed) |

The second is not trivia; it is what makes the first believable. **`state:` is
not optional** — the same trap the vulnerability-surface section above documents
for `securityReportFindings` applies here, and a well-triaged project is
precisely where an unfiltered query returns a reassuring zero. Report the zero
only alongside a query that came back non-zero.

Two mechanics worth knowing before running it: `VulnerabilityConnection` has **no
`count` field**, so count `nodes` and check `pageInfo { hasNextPage }`; and per
*Every count must carry its age* above, this count is only as fresh as the
stalest scanner contributing to it.
