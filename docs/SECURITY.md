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
  summons a human. **That gate has a known hole and has been beaten once** —
  `!245` re-introduced a High-severity range under a `patch` classification and was
  stopped only by an open review thread; see *The gate has been beaten once* below.
  **This bullet also used to sit under the "human approves the MR" heading
  below**, which the config has never supported.

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
pipeline is green.

**The pass exists to do the one thing none of that does: read the live dependency
findings.** Everything else it covers is residue the automation deliberately
leaves. The subsections below are reference material, in rough order of how
surprising they are; the pass itself runs in this order:

1. **Read the live findings** — *The zero to check, and how to earn it*. This is
   the security-relevant step and it is deliberately first, even though it is the
   last section on the page.
2. **Check the dashboard is telling you about now** — *Noticing the dashboard has
   gone stale*. Everything in steps 3–4 is read off that page, so its freshness is
   a precondition rather than a detail.
3. **Work the residue** — the *Awaiting Schedule* list, reading the update type
   before each tick, and *Repository Problems* first of all.
4. **Re-check the deferred caps** — *The deferred caps, and when each one expires*.
   A cap whose lift condition has expired is a finding.

**What a missed pass costs.** Not merely deferred residue: three facts already on
this page compose into a detection gap. The Scan Result Policy gates only *new*
Critical/High findings, so an advisory that widens against a dependency already in
the baseline blocks nothing. Renovate's `vulnerabilityAlerts` path is inert on
GitLab here, so no advisory-driven MR jumps the queue (see *Where a security fix
actually appears*). And the monthly `security_assessment` is otherwise the only
scheduled thing that reads live findings. **Between assessments this pass is the
only thing looking — so skipping it can leave an advisory unnoticed for up to
about four weeks, against the 24-hour triage and 72-hour fix targets in *Response
targets* on this same page.**

Routine updates do keep landing without the pass, which is precisely what makes
the gap easy to miss: the system looks like it is working because most of it is.
That is also why the earlier version of this section overstated — a weekly review
nobody had defined was easier to promise than to perform.

### Three schedules, one flag, and only one may open an MR

| Schedule | Cron (Europe/London) | Fires | What it may do |
|---|---|---|---|
| Weekly base-image rescan | `0 6 * * 1` | Mon 06:00 | Rebuild and re-scan `main`; carries `ops_digest`. Never deploys. |
| **Weekly Renovate** | `0 7 * * 1` | Mon 07:00 | **The only run that may open update MRs.** |
| Renovate automerge recovery | `0 1,5,9,13,17,21 * * *` | Daily 01:00, 05:00, 09:00, 13:00, 17:00, 21:00 | Finish an automerge lost at MR creation. Opens nothing. |

Both Renovate schedules carry `RENOVATE_RUN=true` and run the same job; what
separates them is the clock. `.gitlab/renovate.json` sets
`"schedule": ["* 7-8 * * 1"]` under `"timezone": "Europe/London"` — Mondays
07:00–08:59 — and **none of the recovery hours falls inside that window.** That is
the whole safety property. Out of window Renovate finishes work already in flight
and creates no branches, so **a recovery run that rewrites nothing is the design
working, not a fault** — the commonest way to misread this system is to check it on
a Saturday and conclude it is broken.

Read that property precisely: it is a claim about the **recovery hours against the
update window**, not about the project's schedules against each other. Several of
those do share a clock slot — the weekly registry prune and a recovery run both
fire Monday 05:00, and the hourly production-state check overlaps everything every
hour — which is harmless, because they are different jobs in different pipelines,
each gated on its own variable. Only the window/hours relationship is
load-bearing, and it is the one to re-check if either changes.

**The 09:00 recovery slot is the one worth noticing.** It is the first run after
the window closes at 08:59, so an automerge lost by the 07:00 run is retried the
same morning instead of waiting for the next Monday. That is the mechanism #243
was built for: a seven-day recovery became a four-hour one in general, and a
one-hour one for the case that actually produces lost automerges.

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

#### ⚠️ The gate has been beaten once — `!245`

The most important thing to carry away from this section is that "green pipeline"
is not the same as "safe change", and there is a recorded case rather than a
hypothetical.

`!245`, titled *"update dependency brace-expansion to v2.1.4"*, rewrote the
top-level `brace-expansion` override from `^5.0.8` back to `^2.1.3` — **inside
CVE-2026-14257's affected range**. It was classified `patch`, so `packageRules[0]`
applied to it and it was eligible to merge itself. The Scan Result Policy did not
object, because the head pipeline's security summary was **identical to `main`'s**:
the policy gates on *new* Critical/High findings, and re-introducing a
vulnerability that is already in the baseline produces nothing new to gate on.
**Only an unresolved review discussion stopped it merging unattended.** It was
closed rather than merged.

Two things follow. First, the phrase used earlier on this page — that the required
scanners plus the Scan Result Policy are the whole gate — describes what the
configuration provides, **not a guarantee that a bad patch cannot land**; the
baseline exemption is the hole, and it is the same hole the ⚠️ note under *Security
program cadence* describes. Second, this was not a one-off: `.gitlab/renovate.json`
records that the underlying mis-resolution recurs on **every future 2.x release**,
because Renovate reads that entry's current version from the hoisted copy of the
package, which a *different* override pins to 2.x. The `>=5.0.8` floor is what
makes those proposals ineligible, and `override-hygiene` asserts the override still
matches the rule that pins it.

Practical rule: **a patch or digest bump touching a package that appears in
`package.json`'s `overrides` gets read, whatever its update type says.** Those
entries exist because a resolved version was deliberately overridden, and an
update type is computed against the resolution, not against the intent.

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

**Worked example, since "read Repository Problems first" is only worth anything
applied.** `#17` currently carries `⚠️ WARN: No docker auth found - returning`, and
the job log names what it gave up on: this project's own
`gl-demo-ultimate-dtop/domi-oss/dlectroflow`. Every other image the config tracks
sits on a public registry and resolves without credentials; the exception is the
one image in this project's private registry, and Renovate is configured with no
container-registry credentials, so it does not look. **This is expected and not
worth chasing** — that image's tag is set by CI at deploy time
(`charts/dlectroflow/values.yaml` carries `tag: ""`), so there is no version for a
dependency bot to propose in the first place. The same empty tag is why the
dashboard lists that image under helm-values as `unknown version`; it is one cause
showing up twice, not two faults.

The general lesson outlives the specific warning: a permanent benign entry here is
exactly what trains a reader to skip the section the table above tells them to read
first. **Read what the warning names, not merely whether one is present** — the
same warning text against a *public* image, or against a manifest rather than a
registry, would mean Renovate had stopped resolving something it is supposed to
resolve.

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

⚠️ **`allowedVersions` is not bypassed for a security fix**, so a cap can hold one
back. All six are accounted for below rather than only the ones with a comfortable
answer — a reader checking these for production exposure needs the complete list:

- **Two are floors, not ceilings, and cannot block anything.** `tsx >=4.22.0` and
  the top-level `brace-expansion >=5.0.8` exclude *lower* versions, so an advisory
  fix — which is always a higher version — stays eligible. The `brace-expansion`
  floor exists precisely to keep a patched version from being walked backwards.
- **Three ceilings cover the lint and type toolchain.** `eslint <10` and
  `typescript <6.1` are `devDependencies`; the nested `brace-expansion <3` reaches
  only the ESLint plugin chain. All three are recorded accepted trade-offs, and in
  each case a fix that cleared the cap would break the toolchain it constrains, so
  the real remediation is lifting the cap rather than routing around it.
- **One ceiling governs production: `postgres <17`.** It applies to three pins that
  must move together — `charts/dlectroflow/values.yaml` and
  `docker/docker-compose.prod.yml` twice — and to the backup path with them, since
  `backup.dumpImage` defaults to `postgres.image` to keep `pg_dump` matched to the
  server major. What makes it safe is not that it is unimportant but that it is a
  **major ceiling only**: Postgres 16 remains upstream-supported, and 16.x patch
  and digest releases — which is how a Postgres security fix actually arrives — are
  unaffected. **If 16 leaves upstream support this cap stops being a scheduling
  decision and becomes a security one**, so that is the condition to watch, not
  just the migration it is waiting on.

Do not add a ceiling to a production-reachable package without recording that same
reasoning beside it.

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
it is usually the wrong target.** One of this project's own records reads
`fast-uri` at `3.1.4` with *"Upgrade to versions 2.4.4, 3.1.5, 4.1.2 or above."*
The fix for our line is **3.1.5**, a patch. Reading only `4.1.2` converts a patch
bump into a major one and invents a migration the advisory never asked for. (That
record's own state is `RESOLVED` — it is quoted for the version arithmetic, which
is what the next two paragraphs are about, and calling it "live" would beg the
question they answer.)

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
