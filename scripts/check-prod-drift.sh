#!/usr/bin/env bash
# scripts/check-prod-drift.sh — is production running `main`? (#147)
#
# Requires bash (not POSIX sh): `set -o pipefail` below is a bash/ksh extension.
# Callers install bash and invoke `bash scripts/check-prod-drift.sh`.
#
# ── Why this exists ──────────────────────────────────────────────────────────
# `main` and production can silently diverge. The known way is #147's: a
# `build`-stage failure on `main` *skips* `deploy_production` (it is in a later
# stage) rather than failing it, so the merge never deploys and the pipeline's
# own red tick is the only signal. `main` stayed red for 86 minutes and prod
# caught up by accident when the next MR merged.
#
# But the failed-pipeline case is only the cause we happen to have seen. A
# `helm rollback` (docs/deploy-runbook.md §14), an `--atomic` rollback of a
# deploy that timed out, or a manual `helm upgrade` from a laptop all leave
# production on a different commit with a **green** pipeline. So this check is
# deliberately written against the *outcome* rather than any cause: it asks the
# one question that covers all of them — is the commit production reports the
# commit `main` is on?
#
# #135 made that a two-request question by shipping the build SHA on
# /api/health. Before that there was nothing to compare: a container cannot read
# the registry tag it was pulled under.
#
# ── Contract ─────────────────────────────────────────────────────────────────
# Prints a Markdown bullet list on stdout (no heading — the caller supplies one)
# and exits:
#   0  in sync — production is running the ref's HEAD
#   1  drifted — behind, or on a commit that is not an ancestor of the ref
#   2  undetermined — one of the two facts could not be established
#
# Exit 2 is a distinct state on purpose. "Could not reach production" must never
# collapse into "in sync": an unproven green is the failure mode this whole issue
# is about, and a caller that treats 2 as 0 has reintroduced it.
#
# Env:
#   CI_API_V4_URL, CI_PROJECT_ID   — provided by GitLab CI
#   GL_TOKEN                       — optional; falls back to CI_JOB_TOKEN, and the
#                                    commits endpoint needs neither on a public project
#   PROD_URL                       — optional; defaults to the prod origin
#   DRIFT_REF                      — optional; defaults to `main`
set -euo pipefail

PROD_URL="${PROD_URL:-https://dlectroflow.dev}"
DRIFT_REF="${DRIFT_REF:-main}"
API="${CI_API_V4_URL:-https://gitlab.com/api/v4}/projects/${CI_PROJECT_ID:-}"

# GL_TOKEN when it exists, the job token otherwise. Reading a ref's HEAD needs no
# credential at all on a public project, so this check still works in a pipeline
# on an unprotected branch (where the protected GL_TOKEN is absent) — which is
# also how it can be tested by making it run.
if [ -n "${GL_TOKEN:-}" ]; then
  AUTH="PRIVATE-TOKEN: ${GL_TOKEN}"
else
  AUTH="JOB-TOKEN: ${CI_JOB_TOKEN:-}"
fi

# Same bound as src/lib/build-info.ts: a short-or-full lower-case SHA-1.
SHA_RE='^[0-9a-f]{7,40}$'

# ── How long has it been drifted? (#191) ─────────────────────────────────────
# A failed deploy is an EVENT and is easy to miss. "Production has been behind
# `main` for 24 hours" is a STATE: it stays true until somebody fixes it, and it
# is the sentence that actually describes #180. The commit count alone cannot
# tell a deploy that is still running from one that stopped running yesterday.
#
# The instant comes from the oldest commit production is missing, which is a
# LOWER bound on the drift — production may have fallen behind later than that
# commit was authored, never earlier.
#
# `date` is the hazard, not the arithmetic. Three implementations reach this
# script: GNU (the digest job installs coreutils), BSD (macOS, where `npm test`
# drives it) and busybox (alpine). Only GNU accepts `-d <iso8601>`, so each
# spelling is tried and **failure prints no age at all** rather than a confident
# wrong number — the same discipline as the digest's 7-day window, which already
# degrades to an honest "no window" label. A negative age is treated as
# unparseable too: a commit in the future is clock skew, not a duration.
iso_to_epoch() {
  local iso="$1" out=""
  # Fractional seconds and the zone suffix are stripped once, up front: BSD's
  # `-f` needs the format to match the input exactly, and GitLab sends
  # `2026-08-06T13:12:00.000Z`.
  local plain="${iso%%.*}"
  plain="${plain%Z}"
  out="$(date -u -d "${plain}Z" +%s 2> /dev/null || true)"        # GNU
  if [ -z "$out" ]; then
    out="$(date -u -j -f '%Y-%m-%dT%H:%M:%S' "$plain" +%s 2> /dev/null || true)" # BSD
  fi
  if [ -z "$out" ]; then
    out="$(date -u -d "${plain/T/ }" +%s 2> /dev/null || true)"   # busybox
  fi
  case "$out" in
    '' | *[!0-9]*) return 1 ;;
  esac
  printf '%s' "$out"
}

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# ── 1. What the ref is ───────────────────────────────────────────────────────
# The ref's CURRENT head, from the API — not `$CI_COMMIT_SHA`. In a pipeline
# that is the commit the pipeline was created for, which may already be behind
# `main`; the question is what `main` is now.
ref_code="$(curl -s -o "$WORK/ref.json" -w '%{http_code}' --max-time 30 \
  -H "$AUTH" "${API}/repository/commits/${DRIFT_REF}" || echo 000)"
head_sha=""
if [ "$ref_code" = "200" ]; then
  head_sha="$(jq -r '.id // empty' "$WORK/ref.json" 2>/dev/null || true)"
fi
if ! printf '%s' "$head_sha" | grep -Eq "$SHA_RE"; then
  head_sha=""
fi

# ── 2. What production is ────────────────────────────────────────────────────
# NO GitLab credential on this request. It leaves for a different origin, and a
# token on an outbound request to the app host would be a credential leak for
# the sake of an endpoint that is unauthenticated by design.
health_code="$(curl -s -o "$WORK/health.json" -w '%{http_code}' --max-time 15 \
  "${PROD_URL}/api/health" || echo 000)"
prod_raw=""
if [ "$health_code" = "200" ]; then
  prod_raw="$(jq -r '.sha // empty' "$WORK/health.json" 2>/dev/null || true)"
fi
prod_sha=""
prod_bad_shape=""
if [ -n "$prod_raw" ]; then
  if printf '%s' "$prod_raw" | grep -Eq "$SHA_RE"; then
    prod_sha="$prod_raw"
  else
    # /api/health is unauthenticated and its body is reflected straight into a
    # GitLab note by the callers. src/lib/build-info.ts validates on the way out;
    # this validates on the way IN, because the consumer is the one embedding
    # somebody else's string in Markdown. Report the shape, never the value.
    prod_bad_shape="${#prod_raw} characters"
  fi
fi

# ── 3. Verdict ───────────────────────────────────────────────────────────────
verdict="undetermined"
behind=""
since=""
age_line=""
cmp_code=""
if [ -n "$head_sha" ] && [ -n "$prod_sha" ]; then
  # Prefix comparison, not equality: /api/health reports 7 characters, GitLab's
  # `short_id` is 8 and its `id` is 40. String equality would report permanent
  # drift — an alert that fires always says nothing.
  if [ "$(printf '%s' "$head_sha" | cut -c1-"${#prod_sha}")" = "$prod_sha" ]; then
    verdict="in_sync"
  else
    verdict="drifted"
    cmp_code="$(curl -s -o "$WORK/cmp.json" -w '%{http_code}' --max-time 30 \
      -H "$AUTH" "${API}/repository/compare?from=${prod_sha}&to=${DRIFT_REF}" \
      || echo 000)"
    if [ "$cmp_code" = "200" ]; then
      behind="$(jq -r '(.commits // []) | length' "$WORK/cmp.json" 2>/dev/null || true)"
      # `min`, not `.[0]`: the endpoint's ordering is not part of its contract,
      # and picking the wrong end of the list would understate the drift — the
      # direction that makes an alert reassuring.
      since="$(jq -r '[(.commits // [])[] | (.committed_date // .created_at // empty)] | min // empty' \
        "$WORK/cmp.json" 2>/dev/null || true)"
    fi
  fi
fi

# ── 4. Report ────────────────────────────────────────────────────────────────
if [ -n "$head_sha" ]; then
  head_line="- \`${DRIFT_REF}\` HEAD: \`${head_sha}\`"
else
  head_line="- \`${DRIFT_REF}\` HEAD: _could not read_ (\`GET /repository/commits/${DRIFT_REF}\` → HTTP ${ref_code})"
fi

if [ -n "$prod_sha" ]; then
  prod_line="- production \`/api/health\`: \`${prod_sha}\` (HTTP ${health_code})"
elif [ -n "$prod_bad_shape" ]; then
  prod_line="- production \`/api/health\`: HTTP ${health_code}, but its \`sha\` is **not a valid short SHA** (${prod_bad_shape}) — withheld rather than echoed into this note"
elif [ "$health_code" = "200" ]; then
  prod_line="- production \`/api/health\`: HTTP 200 with \`sha: null\` — the running image was built without the \`BUILD_SHA\` build arg (see \`src/lib/build-info.ts\`), so which commit it is cannot be established"
else
  prod_line="- production \`/api/health\`: _unreachable_ (HTTP ${health_code})"
fi

case "$verdict" in
  in_sync)
    verdict_line="- ✅ production is running \`${DRIFT_REF}\`"
    status=0
    ;;
  drifted)
    if [ -z "${behind:-}" ]; then
      verdict_line="- 🔴 **production is not running \`${DRIFT_REF}\`** — it is behind or has diverged; the commit count is unavailable (\`GET /repository/compare\` → HTTP ${cmp_code})"
    elif [ "$behind" = "0" ]; then
      verdict_line="- 🔴 **production has diverged from \`${DRIFT_REF}\`** — the commit it reports is not an ancestor of \`${DRIFT_REF}\` (a rollback, or history that was rewritten)"
    elif [ "$behind" = "1" ]; then
      verdict_line="- 🔴 **production is 1 commit behind \`${DRIFT_REF}\`** — merged but not deployed"
    else
      verdict_line="- 🔴 **production is ${behind} commits behind \`${DRIFT_REF}\`** — merged but not deployed"
    fi
    # The duration (#191). Reported as a separate bullet rather than folded into
    # the verdict so the instant survives even when no `date` on the image can
    # turn it into an age — the timestamp alone still answers "is this minutes
    # old or a day old", which is the whole question.
    if [ -n "$since" ]; then
      age_line="- behind since at least \`${since}\` (the oldest commit production is missing)"
      now_epoch="$(date -u +%s 2>/dev/null || true)"
      then_epoch="$(iso_to_epoch "$since" || true)"
      case "${now_epoch}${then_epoch}" in
        '' | *[!0-9]*) ;;
        *)
          if [ -n "$now_epoch" ] && [ -n "$then_epoch" ] && [ "$now_epoch" -ge "$then_epoch" ]; then
            hours=$(( (now_epoch - then_epoch) / 3600 ))
            if [ "$hours" -lt 1 ]; then
              age_line="${age_line} — under an hour"
            elif [ "$hours" -eq 1 ]; then
              age_line="${age_line} — **1 hour** ago"
            else
              age_line="${age_line} — **${hours} hours** ago"
            fi
          fi
          ;;
      esac
    fi
    status=1
    ;;
  *)
    verdict_line="- ⚠️ **could not determine whether production is running \`${DRIFT_REF}\`** — this is an unknown, not an all-clear"
    status=2
    ;;
esac

if [ -n "$age_line" ]; then
  printf '%s\n%s\n%s\n%s\n' "$head_line" "$prod_line" "$age_line" "$verdict_line"
else
  printf '%s\n%s\n%s\n' "$head_line" "$prod_line" "$verdict_line"
fi
exit "$status"
