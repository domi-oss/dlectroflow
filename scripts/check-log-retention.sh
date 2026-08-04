#!/usr/bin/env bash
# scripts/check-log-retention.sh — are production's logs actually kept? (#157)
#
# Requires bash (not POSIX sh): `set -o pipefail` below is a bash/ksh extension.
# Callers install bash and invoke `bash scripts/check-log-retention.sh`.
#
# ── Why this exists ──────────────────────────────────────────────────────────
# Two independent settings have to agree before one log line is kept, and
# neither can see the other. The CLUSTER decides what to ship (`loggingConfig`
# enabling SYSTEM_COMPONENTS and WORKLOADS, `loggingService` set to
# `logging.googleapis.com/kubernetes`). The PROJECT decides whether anything
# accepts it (the `logging.googleapis.com` service, plus a retention window on
# the bucket). With only the first in place the cluster ships logs to somewhere
# that will not take them: nothing errors, nothing warns, and an application log
# line exists only in a running pod's buffer until Autopilot recycles the pod.
#
# Each setting reads as correct on its own, so the contradiction is invisible
# from either end — a guard that has quietly stopped guarding while still
# reading as coverage. docs/deploy-runbook.md § 16 is the operator's half.
#
# So this check refuses to ask "is logging configured?". That question can
# answer yes while the answer is worthless. It asks the only one whose answer
# cannot be faked by a status field: **can a log line be read back out?** Same
# discipline as `check-prod-drift.sh` — verify the artefact, never the field
# that claims the artefact exists.
#
# ── Contract (deliberately identical to check-prod-drift.sh) ─────────────────
# Prints a Markdown bullet list on stdout (no heading — the caller supplies one)
# and exits:
#   0  retained — an entry was read back inside the window, and the bucket keeps
#      entries for at least LOG_RETENTION_DAYS
#   1  NOT retained — proven, with the cause named
#   2  undetermined — the check could not see
#
# Exit 2 is a distinct state on purpose, and the two collapses are both lies:
# reporting 1 when the check simply could not run cries wolf, and reporting 0 is
# the unproven green this issue exists to kill. A caller that treats 2 as 0 has
# reintroduced the bug.
#
# ── Read-only, and quiet about identifiers ───────────────────────────────────
# Every gcloud verb here is a read (`list`, `read`, `describe`). Nothing this
# script can do changes the project, the bucket or the cluster — enabling the
# API and setting retention are operator steps, documented in
# docs/deploy-runbook.md § 16, deliberately not automated from a check.
#
# Its stdout is spliced into the weekly digest, which posts a note on an issue in
# a **public** project. Provider errors are therefore reported as a *category*
# and never echoed: gcloud's disabled-API message embeds the project id twice,
# once inside a console URL. No identifier — project, cluster or bucket name —
# reaches stdout.
#
# Env (all optional):
#   LOG_PROJECT           project id; falls back to `gcloud config get-value project`
#   LOG_RETENTION_DAYS    the window this repo expects; see the runbook for why
#   LOG_NAMESPACE         the app's Kubernetes namespace
#   LOG_FRESHNESS         how recent an entry has to be to count as proof
#   LOG_BUCKET            log bucket to read retention from
#   LOG_BUCKET_LOCATION   that bucket's location
#   LOG_CLUSTER           optional; with LOG_CLUSTER_LOCATION, also reads the
#                         cluster's loggingConfig so the report can name the
#                         *contradiction* rather than only the symptom
set -euo pipefail

LOG_PROJECT="${LOG_PROJECT:-}"
LOG_RETENTION_DAYS="${LOG_RETENTION_DAYS:-30}"
LOG_NAMESPACE="${LOG_NAMESPACE:-dlectroflow-prod}"
LOG_FRESHNESS="${LOG_FRESHNESS:-1h}"
LOG_BUCKET="${LOG_BUCKET:-_Default}"
LOG_BUCKET_LOCATION="${LOG_BUCKET_LOCATION:-global}"
LOG_CLUSTER="${LOG_CLUSTER:-}"
LOG_CLUSTER_LOCATION="${LOG_CLUSTER_LOCATION:-}"

BROKEN=0
UNKNOWN=0
LINES=""

say() { LINES="${LINES}- ${1}"$'\n'; }

# Report, then map the two counters onto the three exit codes. `broken` wins
# over `unknown`: a proven failure alongside an unreadable surface is still a
# proven failure, and downgrading it to "don't know" would bury it.
finish() {
  printf '%s' "$LINES"
  if [ "$BROKEN" -gt 0 ]; then exit 1; fi
  if [ "$UNKNOWN" -gt 0 ]; then exit 2; fi
  exit 0
}

# ── 0. Is there a tool to ask with? ──────────────────────────────────────────
# The weekly digest runs on alpine with a Kubernetes-agent context and no Google
# Cloud credential, so this branch is the one it takes today. That is the honest
# answer and it is published rather than hidden: an unknown that nobody can see
# is indistinguishable from a pass, which is the whole shape of this issue.
if ! command -v gcloud > /dev/null 2>&1; then
  say "⚠️ \`gcloud\` is not available here, so log retention **could not be checked** — this is an unknown, not an all-clear"
  say "run it where a Google Cloud credential exists: \`bash scripts/check-log-retention.sh\` (docs/deploy-runbook.md § 16)"
  UNKNOWN=1
  finish
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

GC_OUT=""
GC_ERR=""
GC_STATUS=0

# Run gcloud, capturing stdout, stderr and status separately. stderr is captured
# rather than inherited so that a provider message can be classified without
# ever being printed.
gc() {
  set +e
  gcloud "$@" > "$WORK/out" 2> "$WORK/err"
  GC_STATUS=$?
  set -e
  GC_OUT="$(cat "$WORK/out" 2> /dev/null || true)"
  GC_ERR="$(cat "$WORK/err" 2> /dev/null || true)"
}

# A provider error reduced to one of five words. The full text is discarded:
# it carries identifiers, and a category is all a reader needs to know which of
# "it is broken" and "I could not look" they are being told.
#
# SERVICE_DISABLED is matched FIRST and that ordering is load-bearing — the real
# message is `PERMISSION_DENIED: … has not been used in this project … reason:
# SERVICE_DISABLED`, so a permission-first arm would misfile the one cause this
# script was written to catch as a credential problem.
classify() {
  case "$1" in
    *SERVICE_DISABLED* | *"has not been used in project"* | *"API has not been used"*)
      printf 'service_disabled'
      ;;
    *"Reauthentication"* | *"gcloud auth login"* | *"credentials"* | *"not logged in"*)
      printf 'no_credential'
      ;;
    *PERMISSION_DENIED* | *"does not have permission"* | *"Permission denied"*)
      printf 'permission_denied'
      ;;
    *NOT_FOUND* | *"was not found"*)
      printf 'not_found'
      ;;
    *)
      printf 'unclassified'
      ;;
  esac
}

# ── 1. Which project? ────────────────────────────────────────────────────────
if [ -z "$LOG_PROJECT" ]; then
  gc config get-value project
  if [ "$GC_STATUS" -eq 0 ]; then LOG_PROJECT="$GC_OUT"; fi
fi
case "$LOG_PROJECT" in
  "" | "(unset)")
    say "⚠️ no Google Cloud project could be resolved (\`LOG_PROJECT\` unset and \`gcloud config get-value project\` gave nothing) — **undetermined**, not an all-clear"
    UNKNOWN=1
    finish
    ;;
esac
say "project: resolved, id withheld — this output is posted to a public issue"

# ── 2. The status field, recorded as a status field ──────────────────────────
# No tick on this line, ever. "The API shows as enabled" is exactly the kind of
# claim that read fine while nothing was being kept; it is context for the
# verdict, not evidence for it.
api_state="unknown"
api_reason=""
gc services list --enabled \
  --filter="config.name=logging.googleapis.com" \
  --format="value(config.name)" \
  --project="$LOG_PROJECT"
if [ "$GC_STATUS" -eq 0 ]; then
  case "$GC_OUT" in
    *logging.googleapis.com*) api_state="enabled" ;;
    *) api_state="disabled" ;;
  esac
else
  api_reason="$(classify "$GC_ERR")"
  # Only conclude "disabled" when the message is about *this* service. A
  # SERVICE_DISABLED on serviceusage itself says nothing about logging, and
  # reporting it as a logging outage would send the reader to the wrong console.
  case "$GC_ERR" in
    *logging.googleapis.com*)
      if [ "$api_reason" = "service_disabled" ]; then api_state="disabled"; fi
      ;;
  esac
fi
case "$api_state" in
  enabled) say "\`logging.googleapis.com\` (project-level API): enabled — a status field, not proof that anything is kept" ;;
  disabled) say "\`logging.googleapis.com\` (project-level API): **not enabled**" ;;
  *) say "\`logging.googleapis.com\` (project-level API): could not be read (${api_reason})" ;;
esac

# ── 3. The artefact: read one back ───────────────────────────────────────────
# Project-wide first: any entry at all proves ingestion is live, which separates
# "nothing is being kept" from "the app in particular is not being kept" — two
# different problems with two different fixes.
#
# `LOG_FILTER` is positional and optional, so it is OMITTED rather than passed
# as "". An empty positional is the kind of argument a CLI is free to reject in
# a later release, and the failure would present as `unclassified` — a check
# reporting "undetermined" because of its own argument list, indistinguishable
# from the provider being unreachable.
ingest="unknown"
read_reason=""
gc logging read \
  --limit=1 \
  --freshness="$LOG_FRESHNESS" \
  --order=desc \
  --format="value(timestamp)" \
  --project="$LOG_PROJECT"
if [ "$GC_STATUS" -eq 0 ]; then
  if [ -n "$GC_OUT" ]; then ingest="proven"; else ingest="empty"; fi
else
  read_reason="$(classify "$GC_ERR")"
  if [ "$read_reason" = "service_disabled" ]; then ingest="disabled"; fi
fi

case "$ingest" in
  proven)
    say "✅ an entry from the last ${LOG_FRESHNESS} was **read back** through the Logging API — ingestion is real, not merely configured"
    ;;
  empty)
    say "🔴 **no log entry at all** in the last ${LOG_FRESHNESS}: the query ran and returned nothing, so logs are **not being retained**"
    BROKEN=1
    ;;
  disabled)
    say "🔴 **the project-level \`logging.googleapis.com\` API is not enabled** — the cluster is shipping logs to a project that will not accept them, so nothing is retained"
    BROKEN=1
    ;;
  *)
    say "⚠️ the Logging API could not be read (${read_reason}) — **undetermined**, not an all-clear"
    UNKNOWN=1
    ;;
esac

# ── 4. The app's own logs, once ingestion is known to work ───────────────────
# Skipped when the project-wide read already failed: it would fail the same way
# and add a second bullet saying the same thing.
if [ "$ingest" = "proven" ]; then
  gc logging read "resource.type=\"k8s_container\" AND resource.labels.namespace_name=\"${LOG_NAMESPACE}\"" \
    --limit=1 \
    --freshness="$LOG_FRESHNESS" \
    --order=desc \
    --format="value(timestamp)" \
    --project="$LOG_PROJECT"
  if [ "$GC_STATUS" -ne 0 ]; then
    say "⚠️ could not read the \`${LOG_NAMESPACE}\` namespace's own logs ($(classify "$GC_ERR")) — **undetermined**"
    UNKNOWN=1
  elif [ -z "$GC_OUT" ]; then
    say "🔴 the project is ingesting logs, but **nothing from \`${LOG_NAMESPACE}\`** in the last ${LOG_FRESHNESS} — the app's own lines are the ones an incident needs"
    BROKEN=1
  else
    say "✅ an entry from \`${LOG_NAMESPACE}\` was read back — the app's structured lines (\`tag:\"llm_failure\"\`, !52) survive a pod recycle"
  fi
fi

# ── 5. For how long ──────────────────────────────────────────────────────────
# Only a tick when ingestion is proven: a retention window on a bucket that
# receives nothing retains nothing, and a green line here over a dead pipe is
# the same false coverage in a smaller box.
gc logging buckets describe "$LOG_BUCKET" \
  --location="$LOG_BUCKET_LOCATION" \
  --format="value(retentionDays)" \
  --project="$LOG_PROJECT"
retention=""
if [ "$GC_STATUS" -eq 0 ]; then
  case "$GC_OUT" in
    "" | *[!0-9]*) retention="" ;;
    *) retention="$GC_OUT" ;;
  esac
fi

if [ -z "$retention" ]; then
  if [ "$GC_STATUS" -eq 0 ]; then
    say "⚠️ the \`${LOG_BUCKET}\` bucket's \`retentionDays\` came back in a shape that is not a number — **undetermined**"
  else
    say "⚠️ the \`${LOG_BUCKET}\` bucket's retention could not be read ($(classify "$GC_ERR")) — **undetermined**"
  fi
  UNKNOWN=1
elif [ "$retention" -lt "$LOG_RETENTION_DAYS" ]; then
  say "🔴 the \`${LOG_BUCKET}\` bucket keeps entries for **${retention} days**, short of the ${LOG_RETENTION_DAYS} this repo expects (docs/deploy-runbook.md § 16)"
  BROKEN=1
elif [ "$ingest" = "proven" ]; then
  say "✅ the \`${LOG_BUCKET}\` bucket keeps entries for ${retention} days, at or above the ${LOG_RETENTION_DAYS} this repo expects"
else
  say "the \`${LOG_BUCKET}\` bucket is configured for ${retention} days — but a bucket receiving nothing keeps nothing"
fi

# ── 6. The other half of the contradiction ───────────────────────────────────
# Opt-in, and deliberately NEVER changes the verdict: what the cluster believes
# is diagnosis, not evidence about retention. Its whole value is that a report
# saying only "no logs" sends the next reader to the cluster config — where they
# will find it correct, conclude the report is wrong, and stop.
if [ -n "$LOG_CLUSTER" ] && [ -n "$LOG_CLUSTER_LOCATION" ]; then
  gc container clusters describe "$LOG_CLUSTER" \
    --location="$LOG_CLUSTER_LOCATION" \
    --format="value(loggingConfig.componentConfig.enableComponents)" \
    --project="$LOG_PROJECT"
  if [ "$GC_STATUS" -eq 0 ] && [ -n "$GC_OUT" ]; then
    say "cluster \`loggingConfig\` enables: ${GC_OUT}"
    if [ "$BROKEN" -gt 0 ]; then
      say "🔴 **the two surfaces contradict each other** — the cluster is shipping those components' logs while the project is not keeping them. Each config reads correct on its own, which is why this went unnoticed"
    fi
  else
    say "cluster \`loggingConfig\`: could not be read ($(classify "$GC_ERR")) — diagnosis only, so the verdict below stands either way"
  fi
else
  say "cluster \`loggingConfig\`: not checked (set \`LOG_CLUSTER\` and \`LOG_CLUSTER_LOCATION\` to have the report name the contradiction, not just the symptom)"
fi

# ── 7. Verdict ───────────────────────────────────────────────────────────────
if [ "$BROKEN" -gt 0 ]; then
  say "🔴 **production logs are not being retained** — any question about a past production event is unanswerable, because the lines that would answer it no longer exist"
elif [ "$UNKNOWN" -gt 0 ]; then
  say "⚠️ **could not determine whether production logs are retained** — this is an unknown, not an all-clear"
else
  say "✅ production logs are **retained** for ${LOG_RETENTION_DAYS} days, proven by reading one back rather than by a status field"
fi

finish
