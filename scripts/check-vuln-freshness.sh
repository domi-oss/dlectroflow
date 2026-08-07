#!/usr/bin/env bash
# scripts/check-vuln-freshness.sh — how old is the vulnerability count? (#166)
#
# Requires bash (not POSIX sh): `set -o pipefail` below is a bash/ksh extension.
# Callers install bash and invoke `bash scripts/check-vuln-freshness.sh`.
#
# ── Why this exists ──────────────────────────────────────────────────────────
# #165 assumed `main` is only scanned on merge and proposed adding a scheduled
# scan. It is wrong twice over. The **Weekly base-image rescan** schedule
# (`4324812`, cron `0 6 * * 1` Europe/London, re-verified active 2026-08-06)
# already rebuilds and re-scans `main` with no merge, and **Continuous
# Vulnerability Scanning** re-evaluates the stored SBOM against new advisories
# with no pipeline at all — proven on 2026-08-04 by eleven Vulnerability Report
# records whose `detectedAt` fell inside a window where no `main` pipeline ran.
#
# So `main`'s record IS being refreshed, and adding another scan would have
# fixed nothing. The actual failure is that **no consumer of these numbers can
# tell how old they are**:
#
#   * #152 — Security Assessment — 2026-08-01 recorded a snapshot of `0` active
#     findings and `0` Critical/High. On 2026-08-04 the same surface read 12
#     active and 3 HIGH. The snapshot was true when it was written; the artefact
#     is permanent and carries nothing that says when it stopped being true.
#   * `!254` and `!252` were both hard-blocked on `security_policy_violations`
#     for twelve findings neither of them introduced, because their pipelines
#     ran against a fresher advisory database than the baseline they were
#     compared to. A blocked MR could not distinguish "I introduced this" from
#     "the baseline is old".
#   * The two surfaces reporting these numbers disagreed on the same tree — 12
#     findings from `project.pipeline(iid: 1611).securityReportFindings` against
#     11 from the Vulnerability Report — and neither labelled itself.
#
# Hence this check emits no bare numbers. Every count it prints carries the
# query that produced it and the instant that dates it, so the block can be
# pasted into an issue and still be readable six weeks later.
#
# ── Trap 1: the pipeline's own status is the WRONG anchor ────────────────────
# The obvious anchor is the last green `main` pipeline. It is wrong here, and
# wrong in the dangerous direction. `.gitlab-ci.yml` (`.scanner_rules`) leaves
# the scanners at the template default `allow_failure: true` on `main`, on
# purpose — "so a scanner flake can't block a production deploy", because
# blocking on findings is the Scan Result Policy's job, not job exit status.
#
# A green `main` pipeline therefore does not prove a scan ran, and a red one
# does not prove it did not. Measured 2026-08-06: four of the last six `main`
# pipelines were FAILED or CANCELED and every one of them ran all five analyzer
# jobs to SUCCESS, while the last GREEN pipeline (iid 1821) had finished 33.6h
# before the last successful scan. Anchoring on pipeline status would have
# called a 9-minute-old number 33 hours stale — and, in the direction that
# actually costs something, would report a confident ✅ on a day when every
# scanner failed inside a green pipeline.
#
# So the anchor is the scanner JOB. It is read per report type, via four
# aliased `jobs(securityReportTypes: …)` selections in one request, because
# `jobs` reports a job's name but not which type it matched — recovering the
# type from job names instead would drop a whole scanner out of the calculation
# the day an analyzer job is renamed.
#
# ── Trap 2: the aggregate is only as fresh as its stalest scanner ────────────
# The Vulnerability Report count spans every analyzer, so the anchor is the
# OLDEST of the per-scanner anchors, never the newest. Reporting the newest is
# how "container scanning has not run in three weeks" hides behind an hourly
# dependency scan.
#
# ── Trap 3: a zero has no `detectedAt` to age ────────────────────────────────
# `detectedAt` is a real freshness signal and an independent one — it moves when
# Continuous Vulnerability Scanning writes to the report, with no pipeline
# involved. Both it and the scan anchor are lower bounds on how stale a surface
# can be, so the more recent of the two is the correct evidence to judge by.
#
# But it only exists when there are findings, and the reading that most needs a
# date is exactly **zero findings** — the one that means either "checked and
# clean" or "nobody looked". A freshness check whose reliability depends on
# there being something to find is the bug it exists to catch. So a missing scan
# anchor is UNDETERMINED, never a pass, even when `detectedAt` is fresh.
#
# ── Trap 4: `detectedAt` evidence does not generalise across scanners ────────
# The obvious reading — newest `detectedAt` anywhere in the report proves the
# report is fresh — is wrong, and it is what the first draft of this script did.
# Continuous Vulnerability Scanning re-evaluates the stored **SBOM**, which is
# dependency scanning's artefact; a dependency finding re-detected an hour ago
# is no evidence whatsoever that container scanning has run this month. Under
# that reading a container scanner three weeks dead reported ✅ fresh, which is
# precisely the shape of every failure in #166.
#
# So evidence is accumulated PER REPORT TYPE — each scanner is dated by the more
# recent of its own last successful run and the newest `detectedAt` among
# findings of its own type — and the aggregate takes the stalest of those.
#
# ── Contract ─────────────────────────────────────────────────────────────────
# Prints a Markdown bullet list on stdout (no heading — the caller supplies one)
# and exits:
#   0  fresh        — the newest evidence that this surface moved is inside the budget
#   1  stale        — it is not; the number may be describing a week-old tree
#   2  undetermined — the number could not be dated at all
#
# Exit 2 is a distinct state for the same reason `check-prod-drift.sh` and
# `check-registry-drain.sh` carry one: "could not establish how old this is"
# must never collapse into "this is fine". A caller that treats 2 as 0 has
# reintroduced the entire bug.
#
# Read-only by construction: it issues GraphQL queries and no mutations, and
# src/lib/vuln-freshness.test.ts asserts that against every request made.
#
# Env:
#   CI_API_V4_URL, CI_PROJECT_PATH  — provided by GitLab CI
#   CI_DEFAULT_BRANCH               — provided by GitLab CI; defaults to `main`
#   GL_TOKEN                        — optional; falls back to CI_JOB_TOKEN
#   VULN_FRESHNESS_MAX_AGE_HOURS    — optional; see the derivation below
#   VULN_FRESHNESS_PIPELINE_DEPTH   — optional; how many default-branch
#                                     pipelines to look back through, default 20
#   VULN_FRESHNESS_MAX_PAGES        — optional; vulnerability walk ceiling
#   VULN_FRESHNESS_GRAPHQL_URL      — optional; derived from CI_API_V4_URL
#   VULN_FRESHNESS_NOW              — test hook; an ISO-8601 instant to treat as
#                                     now, so ages are arithmetic and the suite
#                                     cannot rot into a wall-clock failure
set -euo pipefail

# The weekly rescan cadence is 168h, so anything under that would fire every
# week on a perfectly healthy project — and an alert that always fires says
# nothing, which is the lesson `check-registry-drain.sh` already paid for with
# `next_run_at`. 24h on top absorbs scheduler lag (gitlab.com dispatches
# scheduled pipelines from a shared pool, so the cron is an earliest-start).
#
# This budget exists to catch the cadence BREAKING. It is deliberately NOT an
# opinion about whether weekly is often enough — #166 raises that separately,
# and the answer is a schedule change, not a threshold change. Raise this if the
# cadence is relaxed; do not lower it to make a red check green.
# src/lib/vuln-freshness.test.ts asserts it stays at or above one full cycle.
#
# The verdict line prints where the budget came from as well as what it is. A
# line reading "past the 1h budget (168h weekly rescan + 24h grace)" states the
# same fact two ways and contradicts itself, which is the failure mode #166 is
# made of in miniature — so the derivation is only claimed when it is the one
# actually in force. Captured BEFORE the default is applied, since afterwards
# the two cases are indistinguishable.
if [ -n "${VULN_FRESHNESS_MAX_AGE_HOURS:-}" ]; then
  MAX_AGE_SOURCE="overridden via \`VULN_FRESHNESS_MAX_AGE_HOURS\`"
else
  MAX_AGE_SOURCE="168h weekly rescan + 24h scheduler grace"
fi
VULN_FRESHNESS_MAX_AGE_HOURS="${VULN_FRESHNESS_MAX_AGE_HOURS:-192}"
VULN_FRESHNESS_PIPELINE_DEPTH="${VULN_FRESHNESS_PIPELINE_DEPTH:-20}"
VULN_FRESHNESS_MAX_PAGES="${VULN_FRESHNESS_MAX_PAGES:-50}"

# How far AHEAD of this check's own clock a timestamp may claim to be before it
# stops being a timestamp. Not a knob: it is the width of the one ambiguity that
# has a legitimate cause, and widening it would only buy a longer window in
# which a bogus timestamp reads as a fresh one.
#
# 300s, because gitlab.com dispatches jobs from a shared runner pool and a runner
# clock is not the API clock, so a job can honestly report finishing a couple of
# minutes "after" the instant this check reads `now`. An exact `> now` test would
# call that undetermined at random, and a check that fires at random says nothing
# — the `next_run_at` lesson check-registry-drain.sh already paid for. Five
# minutes covers ordinary NTP drift and nothing else: a 72h-ahead timestamp is
# not skew, it is data that cannot be read.
#
# Anything past it is routed to the UNREADABLE state this script already has,
# not to a new one. A time in the future is not a fresh time; it is an unknown,
# and that is the same call ops-digest.sh makes for its 1969 window — "a wrong
# number with a confident label is the exact failure class #147 is about". (#166)
VULN_FRESHNESS_CLOCK_SKEW_SECONDS=300

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# One exit path for "we could not establish the facts", so every unknown reads
# the same and none of them can be mistaken for an all-clear.
undetermined() {
  printf -- '- ⚠️ **could not determine how old the vulnerability count is** — %s\n' "$1"
  printf -- '- This is an unknown, not an all-clear. A count nobody can date is the failure #166 is about.\n'
  exit 2
}

for tool in curl jq; do
  command -v "$tool" >/dev/null 2>&1 ||
    undetermined "\`$tool\` is not installed on this image"
done

[ -n "${CI_PROJECT_PATH:-}" ] ||
  undetermined "\`CI_PROJECT_PATH\` is unset, so there is no project to query"

# GL_TOKEN when it exists, the job token otherwise. Both reads need only
# read_api; nothing here mutates.
if [ -n "${GL_TOKEN:-}" ]; then
  AUTH="PRIVATE-TOKEN: ${GL_TOKEN}"
else
  AUTH="JOB-TOKEN: ${CI_JOB_TOKEN:-}"
fi

API_BASE="${CI_API_V4_URL:-https://gitlab.com/api/v4}"
GRAPHQL_URL="${VULN_FRESHNESS_GRAPHQL_URL:-${API_BASE%/v4}/graphql}"
DEFAULT_BRANCH="${CI_DEFAULT_BRANCH:-main}"
NOW_ISO="${VULN_FRESHNESS_NOW:-}"

# ── GraphQL plumbing ─────────────────────────────────────────────────────────
# Payloads are built with `jq -n --arg`, never string-concatenated, so a project
# path or cursor can never break out of the JSON. `--data-binary @file` keeps
# the query off the process list.
post_graphql() { # payload_file response_file → prints the HTTP status code
  curl -sS --max-time 60 -o "$2" -w '%{http_code}' -X POST \
    -H "$AUTH" -H "Content-Type: application/json" \
    --data-binary @"$1" "$GRAPHQL_URL" </dev/null 2>>"$WORK/curl.err" ||
    printf '000'
}

# `.errors` present means the query was rejected or only partially resolved.
# Either way the data is not trustworthy, and jq would happily read `null` out
# of it and call that zero findings.
graphql_errors() { # response_file → prints a joined error string, or nothing
  jq -r 'if (.errors // empty) then
           ([.errors[]?.message] | join("; "))
         else empty end' "$1" 2>/dev/null || true
}

check_response() { # response_file http_code what
  [ "$2" = "200" ] || undetermined "$3 answered HTTP ${2}"
  local errors
  errors="$(graphql_errors "$1")"
  [ -z "$errors" ] || undetermined "$3 reported a GraphQL error: ${errors}"
  jq -e '.data.project' "$1" >/dev/null 2>&1 ||
    undetermined "$3 carried no project — the token may not see \`${CI_PROJECT_PATH}\`"
}

# ── 1. The scan anchor ───────────────────────────────────────────────────────
# One request, four aliased selections. The alias IS the report type: `jobs`
# reports a job's name and status but not which `securityReportTypes` member it
# matched, and deriving that from job names would silently drop a scanner the
# day `gemnasium-dependency_scanning` or `semgrep-sast` is renamed upstream.
#
# `first: $depth` rather than "the latest pipeline": the newest default-branch
# pipeline may still be running, may have been canceled by a newer push, or may
# have skipped the scanners entirely (a docs-only tree still takes the full
# gate on `main`, but a canceled one does not finish it). Looking back through
# a window finds the most recent SUCCESSFUL run of each analyzer wherever it
# happened to be.
ANCHOR_QUERY='query($path: ID!, $ref: String!, $depth: Int!) {
  project(fullPath: $path) {
    pipelines(ref: $ref, first: $depth) {
      nodes {
        iid
        status
        finishedAt
        sast: jobs(securityReportTypes: [SAST]) {
          nodes { name status finishedAt }
        }
        dependency: jobs(securityReportTypes: [DEPENDENCY_SCANNING]) {
          nodes { name status finishedAt }
        }
        container: jobs(securityReportTypes: [CONTAINER_SCANNING]) {
          nodes { name status finishedAt }
        }
        secret: jobs(securityReportTypes: [SECRET_DETECTION]) {
          nodes { name status finishedAt }
        }
      }
    }
  }
}'

jq -n --arg q "$ANCHOR_QUERY" --arg path "$CI_PROJECT_PATH" \
  --arg ref "$DEFAULT_BRANCH" --argjson depth "$VULN_FRESHNESS_PIPELINE_DEPTH" \
  '{query: $q, variables: {path: $path, ref: $ref, depth: $depth}}' \
  >"$WORK/anchor-req.json"

code="$(post_graphql "$WORK/anchor-req.json" "$WORK/anchor.json")"
check_response "$WORK/anchor.json" "$code" "the scan-anchor query"

# ── 2. The Vulnerability Report, paginated ───────────────────────────────────
# DETECTED + CONFIRMED only: dismissed and resolved findings are answered
# questions, and the digest line this replaces already filtered that way.
#
# Paginated rather than read once. Measured 2026-08-06 this project holds 100
# records across all states on the first page alone, so a check that reads page
# one and stops would undercount silently the moment the active set grows.
VULN_QUERY='query($path: ID!, $after: String) {
  project(fullPath: $path) {
    vulnerabilities(state: [DETECTED, CONFIRMED], first: 100, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes { severity reportType detectedAt resolvedOnDefaultBranch }
    }
  }
}'

: >"$WORK/vulns.jsonl"
after=""
page=0
while :; do
  page=$((page + 1))
  [ "$page" -le "$VULN_FRESHNESS_MAX_PAGES" ] ||
    undetermined "the vulnerability walk did not terminate within ${VULN_FRESHNESS_MAX_PAGES} pages"

  jq -n --arg q "$VULN_QUERY" --arg path "$CI_PROJECT_PATH" --arg a "$after" \
    '{query: $q, variables: {path: $path,
                             after: (if $a == "" then null else $a end)}}' \
    >"$WORK/vuln-req.json"

  code="$(post_graphql "$WORK/vuln-req.json" "$WORK/vuln-page.json")"
  check_response "$WORK/vuln-page.json" "$code" "the vulnerability query"
  jq -e '.data.project.vulnerabilities' "$WORK/vuln-page.json" >/dev/null 2>&1 ||
    undetermined "the response carried no \`vulnerabilities\` connection (token scope, or Ultimate not enabled?)"

  jq -c '.data.project.vulnerabilities.nodes[]?' "$WORK/vuln-page.json" \
    >>"$WORK/vulns.jsonl"

  [ "$(jq -r '.data.project.vulnerabilities.pageInfo.hasNextPage' "$WORK/vuln-page.json")" = "true" ] || break
  after="$(jq -r '.data.project.vulnerabilities.pageInfo.endCursor // ""' "$WORK/vuln-page.json")"
  [ -n "$after" ] ||
    undetermined "the vulnerability connection said there was another page but returned no cursor"
done

# ── 3. Verdict ───────────────────────────────────────────────────────────────
# All of the reasoning is in jq rather than bash, deliberately: it needs date
# arithmetic, and portable `date` is a trap this repo has already paid for once
# (see the window handling in ops-digest.sh — GNU `-d`, BSD `-v` and busybox all
# disagree, and the failure mode was a confident 1969). jq's `fromdateiso8601`
# behaves the same everywhere.
#
# NOTE: no apostrophes anywhere in the jq program below, including in comments.
# It is a single-quoted bash string, so one apostrophe ends the string and the
# whole program fails to compile.
set +e
jq -r -n \
  --slurpfile anchor "$WORK/anchor.json" \
  --slurpfile vulns "$WORK/vulns.jsonl" \
  --arg nowIso "$NOW_ISO" \
  --arg branch "$DEFAULT_BRANCH" \
  --argjson maxAge "$VULN_FRESHNESS_MAX_AGE_HOURS" \
  --arg maxAgeSource "$MAX_AGE_SOURCE" \
  --argjson skew "$VULN_FRESHNESS_CLOCK_SKEW_SECONDS" \
  --argjson depth "$VULN_FRESHNESS_PIPELINE_DEPTH" '
def parse_ts:
  if . == null or . == "" then null
  else
    (sub("\\.[0-9]+"; "") | sub("\\+00:00$"; "Z"))
    | if test("Z$") then (try fromdateiso8601 catch null) else null end
  end;

# One rendering for every age in the block, so two numbers in the same bullet
# can never be in different units without saying so. Hours below two days,
# days above: an "8.3d" reads as a problem where "199.2h" reads as noise.
def age(seconds):
  if seconds < 172800
  then "\(((seconds / 3600) * 10 | round) / 10)h"
  else "\(((seconds / 86400) * 10 | round) / 10)d"
  end;
def code(s): "`" + s + "`";

($nowIso | if . == "" then now else parse_ts end) as $now
| if $now == null then
    {lines: ["- ⚠️ **could not determine how old the vulnerability count is** — the supplied instant could not be parsed",
             "- This is an unknown, not an all-clear. A count nobody can date is the failure #166 is about."],
     status: 2}
  else

# Nothing may claim to have happened later than this. A timestamp AHEAD of the
# instant this check ran is not a fresh one — it is one that cannot be read, and
# it is routed to the same UNREADABLE state below rather than to a third state.
# `$skew` is the allowance and its reasoning lives with the constant in the shell
# above; the bound has to sit on BOTH lower bounds, because the evidence is the
# more recent of them and clamping only one leaves the other able to lift a dead
# scanner to fresh. (#166)
  ( $now + $skew ) as $horizon

# An age is never negative. Skew inside the allowance can put the evidence a few
# minutes ahead of `now`, and "-0.1h old" is a wrong number with a confident
# label — the thing this whole check exists to stop printing. Floor it at zero:
# the honest reading is "no older than nothing".
| def since($t): [($now - $t), 0] | max;

# ── the per-scanner anchors ──────────────────────────────────────────────────
# Only SUCCESS counts. A scanner that errored produced no report, so its
# contribution to the aggregate count is whatever the last good run left behind
# — which is exactly the staleness being measured.
  ( ($anchor[0].data.project.pipelines.nodes // []) ) as $pipes

# ── the count ────────────────────────────────────────────────────────────────
# Bound before the scanners, because each scanner is dated partly by the
# findings OF ITS OWN TYPE and those timestamps go through the same horizon.
| ( $vulns ) as $all
| ( $all | map(select(.resolvedOnDefaultBranch != true)) ) as $live

| ( [ {alias: "dependency", type: "DEPENDENCY_SCANNING"},
      {alias: "sast",       type: "SAST"},
      {alias: "container",  type: "CONTAINER_SCANNING"},
      {alias: "secret",     type: "SECRET_DETECTION"} ]
    | map(. as $s
          | ( [ $pipes[]
                | . as $p
                | (.[$s.alias].nodes // [])[]
                | select(.status == "SUCCESS")
                | {type: $s.type, name: .name, iid: $p.iid,
                   raw: .finishedAt, ts: (.finishedAt | parse_ts)} ] ) as $runs
          | ( [ $all[] | select(.reportType == $s.type)
                | {raw: .detectedAt, ts: (.detectedAt | parse_ts)}
                | select(.ts != null) ] ) as $dets
          | $s + {runs: $runs,
                  # A run whose timestamp cannot be read is NOT dropped. Dropping
                  # it would quietly shrink the evidence toward whichever verdict
                  # the remaining rows happen to support, and this check exists
                  # because a number that lost its provenance still looked fine.
                  unreadable: ($runs | map(select(.ts == null)) | length),
                  # Same treatment, other direction: a row claiming to be later
                  # than `now` is held out of the evidence AND reported, rather
                  # than being allowed to date anything.
                  futureRuns: ($runs | map(select(.ts != null and .ts > $horizon))),
                  futureDets: ($dets | map(select(.ts > $horizon))),
                  detected: ($dets | map(select(.ts <= $horizon)) | map(.ts) | max),
                  newest: ($runs | map(select(.ts != null and .ts <= $horizon))
                                 | sort_by(-.ts) | first)}) ) as $scanners

| ( [ $scanners[] | select(.unreadable > 0)
      | "\(.type) reports a run whose finish time cannot be read, and an unreadable timestamp is not an old one — it is an unknown" ]
    + [ $scanners[] | select((.futureRuns | length) > 0)
      | "\(.type) reports a successful run finishing \(.futureRuns[0].raw), which is in the FUTURE relative to \($now | todateiso8601) by more than the \($skew)s clock-skew allowance — a timestamp ahead of the clock is not a fresh one, it is one that cannot be read" ]
    + [ $scanners[] | select((.futureDets | length) > 0)
      | "\(.type) carries a finding detected \(.futureDets[0].raw), which is in the FUTURE relative to \($now | todateiso8601) by more than the \($skew)s clock-skew allowance — same reading, and it dates nothing" ] ) as $unreadable

| ( [ $scanners[] | select(.newest == null)
      | "\(.type) has no successful run in the last \($depth) `\($branch)` pipelines whose finish time can be read, so the part of the count it contributes cannot be dated at all" ] ) as $missing

| if (($unreadable + $missing) | length) > 0 then
    {lines: ([ "- ⚠️ **could not determine how old the vulnerability count is**:" ]
             + (($unreadable + $missing) | map("  - " + .))
             + [ "- This is an unknown, not an all-clear. A count nobody can date is the failure #166 is about." ]),
     status: 2}
  else

# Displayed only, and bounded by the same horizon: a future detection on a report
# type this check does not track cannot lift any scanner to fresh, so it is held
# out of the display rather than escalated to undetermined.
  ( $all | map(.detectedAt | parse_ts)
         | map(select(. != null and . <= $horizon)) | max ) as $newestDetected

# Evidence is accumulated PER REPORT TYPE, and this is the correction that
# matters most. Two independent lower bounds date each scanner:
#
#   * its own last successful run — proof a scanner looked;
#   * the newest `detectedAt` among findings OF ITS OWN TYPE — proof the report
#     was written to, which Continuous Vulnerability Scanning does with no
#     pipeline at all.
#
# The more recent of the two dates that scanner. What it must NOT do is date
# any OTHER scanner: CVS re-evaluates the stored SBOM, which is dependency
# scanning`s artefact, so a dependency finding re-detected an hour ago is no
# evidence whatsoever that container scanning has run this month. Taking the
# newest detection anywhere in the report — the obvious reading, and the one
# this script did first — reported a container scanner three weeks dead as
# fresh, which is exactly the shape of every failure in #166.
| ( $scanners
    | map(. as $s
          | $s + {evidence: ([$s.newest.ts, $s.detected]
                             | map(select(. != null)) | max)}) ) as $dated

# The aggregate is only as fresh as its STALEST contributor. Taking the newest
# is how a scanner that stopped running three weeks ago hides behind an hourly
# one.
| ( $dated | sort_by(.evidence) | first ) as $oldest
| ( $oldest.evidence ) as $evidence
| ( since($evidence) ) as $evidenceAge
| ( $evidenceAge <= ($maxAge * 3600) ) as $fresh

| ( ["CRITICAL","HIGH","MEDIUM","LOW","INFO","UNKNOWN"]
    | map(. as $s | ($live | map(select(.severity == $s)) | length) as $n
          | select($n > 0) | "\($s) \($n)")
    | if length == 0 then "none" else join(" · ") end ) as $sevs

| {status: (if $fresh then 0 else 1 end),
   lines: [
    "- **\($all | length) active** findings on the **Vulnerability Report** — "
      + code("project.vulnerabilities(state: [DETECTED, CONFIRMED])")
      + ", read \($now | todateiso8601). "
      + "\($live | length) still detected on `\($branch)`, "
      + "\(($all | length) - ($live | length)) already fixed but not resolved.",
    "- Severity of the \($live | length) still detected: \($sevs).",
    "- **Oldest evidence: \($oldest.type)**, **\(age($evidenceAge)) old** — "
      + code($oldest.newest.name)
      + " last succeeded \($oldest.newest.ts | todateiso8601) in pipeline \($oldest.newest.iid)"
      + (if ($oldest.detected != null) and ($oldest.detected > $oldest.newest.ts)
         then ", and a finding of that type was re-detected \($oldest.detected | todateiso8601)"
         else "" end)
      + ". A count of zero has no `detectedAt` of its own, so a scan is the only thing that can date it.",
    "- Every scanner, oldest evidence first: "
      + ($dated | sort_by(.evidence)
         | map("\(.type) \(age(since(.evidence)))"
               + (if (.detected != null) and (.detected > .newest.ts)
                  then " (scan \(age(since(.newest.ts))), re-detected \(age(since(.detected))))"
                  else "" end))
         | join(" · "))
      + ". Anchored on the JOB, not the pipeline: the scanners are "
      + code("allow_failure: true")
      + " on `\($branch)` by design, so a green pipeline does not prove a scan ran.",
    (if $newestDetected == null then
       "- No active finding carries a `detectedAt`, so Continuous Vulnerability Scanning offers no second opinion on freshness here — the scan anchor above is the only evidence."
     else
       "- Newest `detectedAt` in the active set: \($newestDetected | todateiso8601), **\(age(since($newestDetected))) ago**. Continuous Vulnerability Scanning re-evaluates the stored SBOM with no pipeline at all, so this is an independent second lower bound."
     end),
    (if $fresh then
       "- ✅ **Fresh**: the newest evidence this surface moved is \(age($evidenceAge)) old, inside the \($maxAge)h budget (\($maxAgeSource))."
     else
       "- 🔴 **Stale**: the newest evidence this surface moved is \(age($evidenceAge)) old, past the \($maxAge)h budget (\($maxAgeSource)). Every number above may be describing an older tree than the one on `\($branch)`."
     end),
    "- Surface note: "
      + code("project.pipeline(iid:).securityReportFindings")
      + " reads **0** for a `\($branch)` pipeline once findings are ingested into the report. "
      + "It is the right query for a merge request pipeline and the wrong one for `\($branch)` — "
      + "re-verified 2026-08-06, `\($branch)` pipeline 1606 reads 0 dependency findings on the exact tree MR pipeline 1611 reads 12 on. (#166)"
   ]}
  end
  end
| (.lines[] | .), "EXIT:\(.status)"
' >"$WORK/verdict.txt"
jq_status=$?
set -e

[ "$jq_status" -eq 0 ] ||
  undetermined "the verdict could not be computed from the responses"

# The exit code rides out on the last line rather than in jq's own status, which
# is reserved for "the program itself failed" above.
sed '$d' "$WORK/verdict.txt"
exit "$(sed -n '$s/^EXIT://p' "$WORK/verdict.txt")"
