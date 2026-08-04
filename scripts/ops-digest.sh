#!/usr/bin/env bash
# scripts/ops-digest.sh — weekly ops digest (issue #33, automates the #16 checklist).
# Requires bash (not POSIX sh): `set -o pipefail` below is a bash/ksh extension,
# and it's load-bearing — without it a failing `curl` pipes empty output into `jq`,
# which exits 0 and yields a blank count instead of the `?` fallback. The CI job
# installs bash and invokes `bash scripts/ops-digest.sh` (see .gitlab-ci.yml).
#
# Runs from the ops_digest CI job on the "Weekly base-image rescan" schedule.
# Read-only against production; write-only to ONE tracking issue. Assembles a
# Markdown digest from prod health + GitLab-API signals and posts it as a note.
#
# Requires (job env):
#   CI_API_V4_URL, CI_PROJECT_ID, CI_PIPELINE_ID  — provided by GitLab CI
#   GL_TOKEN                                       — token with `api` scope (see .gitlab-ci.yml)
#   OPS_DIGEST_ISSUE_IID                           — iid of the standing "Weekly ops digest" issue
#   PROD_URL (optional)                            — defaults to the prod origin
#
# NOT covered here (deliberate): Anthropic/GKE spend needs billing creds, so it
# stays a manual weekly glance — see the "Spend" section below. Error logs are no
# longer in that bucket: section 2c now reports whether they are being retained at
# all (#157), which is the question that has to be answered before summarising
# them is even possible.
set -euo pipefail

PROD_URL="${PROD_URL:-https://dlectroflow.dev}"
API="${CI_API_V4_URL}/projects/${CI_PROJECT_ID}"
# `${GL_TOKEN:-}` (not `${GL_TOKEN}`) so an entirely-unset token doesn't trip
# `set -u` — that's the "no setup yet" case, where the API reads 401 and degrade
# to `?` and the IID guard below skips posting (preview mode). A *bad* token with
# the issue iid set still fails loudly at the POST (curl -f), as intended.
AUTH="PRIVATE-TOKEN: ${GL_TOKEN:-}"
DATE="$(date -u +%Y-%m-%d)"
HERE="$(cd "$(dirname "$0")" && pwd)"

# `date -d '7 days ago'` is a GNU extension. The ops_digest job installs
# `coreutils` so it has it, but this script is also driven by
# src/lib/pipeline-failure-alert.test.ts, which runs on macOS (BSD date, wants
# `-v-7d`) and in `test_app`'s node:22-alpine (busybox date, which has neither
# spelling). Under `set -e` a failing command substitution in an assignment
# aborts the script, so the un-guarded single form made the whole digest depend
# on one optional apk package. Try each spelling; if none works, drop the window
# and say so in the digest rather than sending `updated_after=` empty.
SINCE="$(date -u -d '7 days ago' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || true)"
if [ -z "$SINCE" ]; then
  SINCE="$(date -u -v-7d +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || true)"
fi
if [ -z "$SINCE" ]; then
  # The epoch is read into a variable and range-checked FIRST, rather than nested
  # as `date -d "@$(($(date +%s) - 604800))"`. Duo review on !251 flagged the
  # nested form; its stated mechanism (a `set -e` abort) is wrong — measured on
  # bash 3.2, `$(( $(true) - 604800 ))` quietly evaluates to `-604800` and exits
  # 0 — but the conclusion was right and the real failure is worse than the one
  # described. On a box where `date +%s` yields nothing usable while `date -d @…`
  # still works, that -604800 becomes a perfectly valid `1969-12-25`, and the
  # digest silently reports "failed pipelines in the last 7 days" for a window
  # starting in 1969. A wrong number with a confident label is the exact failure
  # class #147 is about, so the guard rejects anything that is not a plain epoch
  # and falls through to the honest "no window" label below.
  _now="$(date -u +%s 2>/dev/null || true)"
  case "$_now" in
    '' | *[!0-9]*) ;;
    *) SINCE="$(date -u -d "@$((_now - 604800))" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || true)" ;;
  esac
fi
if [ -n "$SINCE" ]; then
  WINDOW="&updated_after=${SINCE}"
  WINDOW_LABEL="last 7d"
else
  WINDOW=""
  WINDOW_LABEL="all time, capped at 100 — no \`date\` on this image could compute a 7-day window"
fi

# ── 1. Production health (public endpoints — no auth needed) ──────────────────
health_code="$(curl -s -o /tmp/health.json -w '%{http_code}' --max-time 15 "${PROD_URL}/api/health" || echo 000)"
health_body="$(cat /tmp/health.json 2>/dev/null || echo '{}')"
site_code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "${PROD_URL}/" || echo 000)"
if [ "$health_code" = "200" ]; then
  health_line="✅ \`/api/health\` ${health_code} — ${health_body}"
else
  health_line="🔴 \`/api/health\` ${health_code} — ${health_body}"
fi
case "$site_code" in
  200|301|302|307|308) site_line="✅ site \`/\` ${site_code}" ;;
  *)                   site_line="🔴 site \`/\` ${site_code}" ;;
esac

# ── 2. CI health — failed main pipelines, last 7d ────────────────────────────
failed_pipes="$(curl -s -H "$AUTH" "${API}/pipelines?ref=main&status=failed${WINDOW}&per_page=100" \
  | jq -r 'length | if . == 100 then "100+" else . end' 2>/dev/null || echo '?')"

# ── 2b. Is production actually running `main`? (#147) ─────────────────────────
# The on-failure alert (alert_pipeline_failure) covers divergence caused by a red
# pipeline. This covers everything else: a `helm rollback`, an `--atomic` rollback
# of a deploy that timed out, a manual `helm upgrade` — all of which leave prod on
# a different commit with a GREEN pipeline and no event to hook onto. Comparing
# the outcome rather than the cause is what makes it catch failure modes nobody
# has thought of yet, which is why it is here as well as on the failure path.
#
# WEEKLY is the honest latency of this backstop, and it is not an incident
# response: #147's divergence lasted 86 minutes. Tightening it is a
# settings-only change once this exists — a schedule running the same script
# hourly and posting only when it reads drift.
set +e
drift_block="$(bash "${HERE}/check-prod-drift.sh")"
drift_status=$?
set -e
case "$drift_status" in
  0) drift_headline="✅ production is running \`main\`" ;;
  1) drift_headline="🔴 **production is not running \`main\`** — see below" ;;
  *) drift_headline="⚠️ **undetermined** — this is an unknown, not an all-clear" ;;
esac

# ── 2c. Are production's logs actually being kept? (#157) ─────────────────────
# Two settings have to agree before a log line is kept — the cluster's, which
# decides what to ship, and the project's, which decides whether anything accepts
# it — and neither can see the other. With only the first in place every
# application log line lives in a pod's buffer and dies with the pod, while both
# configs still read correct in isolation. Same shape as 2b: ask the outcome, not
# the cause, because that is what catches the causes nobody has thought of.
#
# THIS JOB CANNOT ANSWER IT TODAY, and publishing that is the point. The digest
# runs on alpine and reaches the cluster through the GitLab Kubernetes agent, so
# it holds no Google Cloud credential and the check reports "undetermined". An
# unknown nobody can see is indistinguishable from a pass, which is precisely the
# failure being fixed — so it goes in the digest as ⚠️ rather than being omitted
# until someone wires a credential. Exit 2 must never render as ✅.
set +e
logret_block="$(bash "${HERE}/check-log-retention.sh")"
logret_status=$?
set -e
case "$logret_status" in
  0) logret_headline="✅ production logs are retained, proven by reading one back" ;;
  1) logret_headline="🔴 **production logs are not being retained** — see below" ;;
  *) logret_headline="⚠️ **undetermined** — this is an unknown, not an all-clear" ;;
esac

# ── 2d. Is the container registry actually draining? (#113, the check #16 asked
# for) ────────────────────────────────────────────────────────────────────────
# A registry-growth check belongs on the ops cadence because nothing else
# surfaces it: the cleanup policy fails silently, and the one number a human
# would glance at — the tag count — is ALSO moved by the weekly prune job
# (#114), so a broken policy and a working one look identical from outside. #113
# was re-diagnosed three times on that ambiguity. check-registry-drain.sh
# resolves it by partitioning the tags on the policy's own keep regex and
# reporting only on the set the policy owns, which is exactly the set #114 is
# forbidden to touch.
#
# Read-only, and deliberately NOT part of prune_registry: that job deletes and
# wants a Maintainer credential, this one reads and runs on the digest's token.
set +e
registry_block="$(bash "${HERE}/check-registry-drain.sh")"
registry_status=$?
set -e
case "$registry_status" in
  0) registry_headline="✅ the registry cleanup policy is draining" ;;
  1) registry_headline="🔴 **the registry cleanup policy is not draining** — see below" ;;
  *) registry_headline="⚠️ **undetermined** — this is an unknown, not an all-clear" ;;
esac

# ── 3. Dependency upgrades — open Renovate MRs awaiting triage ────────────────
# The API has no source-branch filter, so we fetch open MRs and filter for
# `renovate/` client-side. If the fetched page is full (100 open MRs), Renovate
# MRs could sit beyond page 1 → suffix the count with `+` to flag the undercount
# rather than silently understating it.
renovate_mrs="$(curl -s -H "$AUTH" "${API}/merge_requests?state=opened&per_page=100" \
  | jq -r '([.[] | select(.source_branch | startswith("renovate/"))] | length) as $r
           | if length == 100 then "\($r)+" else "\($r)" end' 2>/dev/null || echo '?')"

# ── 4. Security signal ───────────────────────────────────────────────────────
# Vulnerability Report count (Ultimate). The REST vuln endpoint may be
# unavailable → shows '?'; the authoritative source is the Vulnerability Report
# UI + the Scan Result Policy. Open security-labelled issues is the reliable
# secondary signal (Duo's security-assessment files those).
# Filter by state SERVER-SIDE (`state[]=detected&state[]=confirmed`) so the 100
# page cap bounds ACTIVE vulns only — otherwise a project with >100 total vulns
# (mostly dismissed) could push the active ones off page 1 and silently
# undercount. The client-side select stays as a belt-and-suspenders in case the
# param is ignored; `100+` then honestly means ≥100 active.
vulns="$(curl -s -H "$AUTH" "${API}/vulnerabilities?state[]=detected&state[]=confirmed&per_page=100" \
  | jq -r '[.[] | select(.state=="detected" or .state=="confirmed")] | length | if . == 100 then "100+" else . end' 2>/dev/null || echo '?')"
sec_issues="$(curl -s -H "$AUTH" "${API}/issues?state=opened&labels=security&per_page=100" \
  | jq -r 'length | if . == 100 then "100+" else . end' 2>/dev/null || echo '?')"

# ── 5. Digest body ───────────────────────────────────────────────────────────
# Heredoc into a file, then read it back — NOT `$(cat <<EOF …)`. bash 3.2 (the
# system bash on macOS, where `npm test` drives this script) mis-parses a heredoc
# inside a command substitution and dies with `bad substitution: no closing ')'`;
# alpine's bash 5 does not, so the naive form is green in the ops_digest job and
# broken on every contributor's laptop. It was written that way and never run
# locally, because until #147 nothing drove this script from the suite.
# `security-assessment.sh` carries the same note for the same reason.
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
cat > "$WORK/body.md" <<EOF
### 🗓️ Weekly ops digest — ${DATE}

**Health**
- ${health_line}
- ${site_line}

**Deploy** — is production running \`main\`? (#147)
- ${drift_headline}
${drift_block}

**Logs** — could an incident be diagnosed after the fact? (#157)
- ${logret_headline}
${logret_block}
**Registry** — is the cleanup policy draining? (#113)
- ${registry_headline}
${registry_block}

**CI**
- Failed \`main\` pipelines (${WINDOW_LABEL}): **${failed_pipes}**

**Security**
- Active Vulnerability Report findings (detected+confirmed): **${vulns}**
- Open \`security\`-labelled issues: **${sec_issues}**
- Deep monthly assessment → run \`.gitlab/duo/prompts/security-assessment.md\` via Duo (#33 item 2).

**Dependencies**
- Open Renovate MRs awaiting triage: **${renovate_mrs}**

**Spend — _manual this week_ ⚠️** (needs billing creds):
- Anthropic + GKE/GCP spend: review in the respective consoles.
- Error-log scan: covered by the **Logs** section above, not by this line. The
  old wording deferred it to #29, which was closed as an epic about scheduling
  for open-source and never had anything to do with logs; #157 is where the gap
  actually lives.

_Automated by the \`ops_digest\` CI job (pipeline ${CI_PIPELINE_ID}). Cadence: docs/quality-audit-prompts.md ## Cadence + #16._
EOF
BODY="$(cat "$WORK/body.md")"

# ── 6. Post as a note on the standing digest issue ───────────────────────────
if [ -n "${OPS_DIGEST_ISSUE_IID:-}" ]; then
  curl -sS -f -X POST -H "$AUTH" --data-urlencode "body=${BODY}" \
    "${API}/issues/${OPS_DIGEST_ISSUE_IID}/notes" > /dev/null
  echo "Posted digest to issue #${OPS_DIGEST_ISSUE_IID}"
else
  echo "OPS_DIGEST_ISSUE_IID unset — not posting. Preview:"
  printf '%s\n' "$BODY"
fi
