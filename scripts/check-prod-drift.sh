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
#   3  in flight — drifted, but inside the caller's grace, so deliberately not
#      concluded from (only reachable when DRIFT_GRACE_SECONDS > 0)
#
# Exit 2 is a distinct state on purpose. "Could not reach production" must never
# collapse into "in sync": an unproven green is the failure mode this whole issue
# is about, and a caller that treats 2 as 0 has reintroduced it.
#
# **Exit 3 is distinct for exactly the same reason, and it used to be 0.** That
# was a defect, found by review on !293: this script's own comment beside the
# grace says "nothing was verified in sync, only verified too young to conclude
# from, and those are different claims" — and then it returned the code that
# means the first one. `alert-prod-state.sh` composes its headline from exit
# codes alone, so a graced drift during a rollout rendered as
# "✅ production has recovered", which is the unproven green #191 exists to
# abolish, emitted by the alerter itself. A caller that treats 3 as 0 has
# reintroduced it a third time.
#
# Env:
#   CI_API_V4_URL, CI_PROJECT_ID   — provided by GitLab CI
#   GL_TOKEN                       — optional; falls back to CI_JOB_TOKEN, and the
#                                    commits endpoint needs neither on a public project
#   PROD_URL                       — optional; defaults to the prod origin
#   DRIFT_REF                      — optional; defaults to `main`
#   DRIFT_GRACE_SECONDS            — optional, DEFAULT 0 (see below)
#
# ── DRIFT_GRACE_SECONDS: opt-in, and off by default on purpose (#191) ────────
# A normal deploy leaves production legitimately a commit or two behind for a few
# minutes. An HOURLY caller will land inside that window every few days, and an
# alert that cries wolf gets muted — which is how the real alert went unread in
# the first place. So a caller on a clock can ask for divergence younger than N
# seconds to be reported as "a deploy may still be in flight" (exit 3) instead.
#
# It defaults to 0 — no grace — because the two existing callers want the opposite.
# `alert_pipeline_failure` runs immediately after a pipeline failed, where "the
# deploy may still be in flight" is precisely the wrong reading, and `ops_digest`
# is weekly, where anything it sees has been true for a long time. Only
# `alert_prod_state` sets it, to just over deploy_production's `--timeout 20m`,
# so a deploy that blows its own timeout is reported by the pipeline-failure alert
# while a deploy that is merely slow is not reported twice.
#
# The grace applies ONLY to an age that could be established. With no usable
# `date` there is no age, and the safe direction is to alert — a grace that
# silently swallowed every divergence on an image whose `date` cannot parse
# ISO-8601 would be a monitor switched off by its own helper.
set -euo pipefail

PROD_URL="${PROD_URL:-https://dlectroflow.dev}"
DRIFT_REF="${DRIFT_REF:-main}"
GRACE="${DRIFT_GRACE_SECONDS:-0}"
case "$GRACE" in
  '' | *[!0-9]*) GRACE=0 ;;
esac
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
# **The offset is honoured, not stripped.** Measured against the live API: GitLab
# returns `committed_date` as `2026-08-07T09:27:36.000+01:00` — a numeric offset,
# NOT a `Z`. The first cut here removed everything from the first `.` onward,
# which took the fractional seconds and the offset together and then read the
# remainder as UTC, making every age wrong by the offset (one hour in BST). So the
# zone is split off explicitly and applied as arithmetic, rather than handed to a
# `date` that may or may not understand it — only GNU does.
iso_to_epoch() {
  local iso="$1" naive off="" sign hh mm off_secs=0 utc=""
  # Fractional seconds ONLY. `${iso%%.*}` is what got this wrong.
  naive="$(printf '%s' "$iso" | sed 's/\.[0-9]*//')"
  case "$naive" in
    *Z) naive="${naive%Z}" ;;
    *[+-][0-9][0-9]:[0-9][0-9]) off="${naive: -6}"; naive="${naive%??????}" ;;
    *[+-][0-9][0-9][0-9][0-9]) off="${naive: -5}"; naive="${naive%?????}" ;;
  esac
  # The naive datetime is converted AS UTC by all three spellings, and the offset
  # is subtracted afterwards — `09:27:36+01:00` is `08:27:36Z`.
  utc="$(date -u -d "${naive}Z" +%s 2> /dev/null || true)"                        # GNU
  if [ -z "$utc" ]; then
    utc="$(date -u -j -f '%Y-%m-%dT%H:%M:%S' "$naive" +%s 2> /dev/null || true)"  # BSD
  fi
  if [ -z "$utc" ]; then
    utc="$(date -u -d "${naive/T/ }" +%s 2> /dev/null || true)"                   # busybox
  fi
  case "$utc" in
    '' | *[!0-9]*) return 1 ;;
  esac
  if [ -n "$off" ]; then
    sign="${off:0:1}"
    hh="${off:1:2}"
    mm="${off#???}"
    mm="${mm#:}"
    # `10#` is load-bearing: without it bash reads `08` and `09` as octal and
    # aborts under `set -e` on exactly two offsets a year.
    case "${hh}${mm}" in
      '' | *[!0-9]*) return 1 ;;
    esac
    off_secs=$(( 10#$hh * 3600 + 10#$mm * 60 ))
    [ "$sign" = "-" ] && off_secs=$(( 0 - off_secs ))
  fi
  printf '%s' "$(( utc - off_secs ))"
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
head_date=""
if [ "$ref_code" = "200" ]; then
  head_sha="$(jq -r '.id // empty' "$WORK/ref.json" 2>/dev/null || true)"
  # WHEN THE REF LAST MOVED, which is a different question from how old the
  # oldest missing commit is — and it is the one the grace below actually needs.
  # Free: already in this response.
  head_date="$(jq -r '.committed_date // .created_at // empty' "$WORK/ref.json" 2>/dev/null || true)"
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
since_epoch=""
# What `since` is a claim ABOUT — see the selection below. It changes with how
# many of the timestamps could be converted, so it is chosen where that is known
# rather than reconstructed in the report.
since_note="the oldest commit production is missing"
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
      # The oldest commit production is missing, chosen by INSTANT rather than by
      # string order, and not by `.[0]` — the endpoint's ordering is not part of
      # its contract, and picking the wrong end understates the drift, which is
      # the direction that makes an alert reassuring.
      #
      # It was `jq … | min`, which is LEXICOGRAPHIC on the raw strings. Duo review
      # on !293 caught that this re-introduces, in the selection step, exactly the
      # offset bug `iso_to_epoch` above exists to avoid in the arithmetic step:
      # the timestamps carry their own offsets, so string order is not
      # chronological order. `2026-08-07T05:00:00-04:00` sorts first and is an
      # hour LATER than `2026-08-07T09:27:36+01:00`.
      jq -r '(.commits // [])[] | (.committed_date // .created_at // empty)' \
        "$WORK/cmp.json" > "$WORK/dates.txt" 2>/dev/null || : > "$WORK/dates.txt"
      lex_min="$(sort < "$WORK/dates.txt" | head -1)"
      unparseable=0
      while IFS= read -r cand; do
        [ -n "$cand" ] || continue
        cand_epoch="$(iso_to_epoch "$cand" || true)"
        if [ -z "$cand_epoch" ]; then
          unparseable=1
          continue
        fi
        if [ -z "$since_epoch" ] || [ "$cand_epoch" -lt "$since_epoch" ]; then
          since_epoch="$cand_epoch"
          since="$cand"
        fi
      done < "$WORK/dates.txt"
      # If ANY timestamp could not be converted, the minimum above is not provably
      # the oldest, so the instant is reported without an age rather than with a
      # number that might understate the drift. Same rule as everywhere else here:
      # no confident number over an unproven input.
      #
      # The two arms differ, and conflating them was a Duo finding on !293. Both
      # drop the age; only one has to drop the INSTANT.
      if [ -z "$since" ]; then
        # NOTHING converted. There is no ordering to be had, so `lex_min` is shown
        # because it is the only thing left — not because it is the oldest. With a
        # single missing commit it is; with several it is whichever string sorted
        # first, and the note says so rather than implying a chronology.
        since="$lex_min"
        since_epoch=""
        since_note="one of the commits production is missing — no timestamp here could be read as an instant, so this is not provably the oldest and the drift may be older"
      elif [ "$unparseable" = "1" ]; then
        # MIXED: some converted, some did not. The loop above already holds the
        # chronologically oldest of the ones that DID, which is a real instant
        # picked by comparison. Falling back to `lex_min` here threw that away for
        # the plain string minimum of the raw dates — reintroducing, in the very
        # branch meant to be careful, the ordering bug `iso_to_epoch` exists to
        # remove: `2026-08-07T05:00:00-04:00` sorts first and is half an hour LATER
        # than `2026-08-07T09:27:36+01:00`, so the drift would be reported as
        # younger than it provably is. Understating is the worst direction for this
        # monitor to be wrong in — #191 exists because a real drift read as fine.
        #
        # So the parsed minimum stays and only the age goes: a timestamp that could
        # not be read may be older still, which is what the caveat tells the reader.
        since_epoch=""
        since_note="the oldest commit production is missing **whose timestamp could be read** — at least one could not, so the drift may be older"
      fi
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
    # How long ago the ref last moved — the grace's input, computed separately
    # from the age below and reported separately, because they answer different
    # questions and conflating them is !293's second blocking review finding.
    moved_secs=""
    if [ -n "$head_date" ]; then
      moved_epoch="$(iso_to_epoch "$head_date" || true)"
      if [ -n "$moved_epoch" ]; then
        moved_secs=$(( $(date -u +%s) - moved_epoch ))
        # A clock skew between the runner and the API would give a negative age;
        # a negative number here would be graced as "very recent" no matter how
        # stale production is, so it is treated as unusable rather than as zero.
        [ "$moved_secs" -lt 0 ] && moved_secs=""
      fi
    fi
    age_secs=""
    if [ -n "$since" ]; then
      age_line="- behind since no earlier than \`${since}\` (${since_note})"
      now_epoch="$(date -u +%s 2>/dev/null || true)"
      # Reused from the selection above rather than recomputed: when a timestamp
      # could not be converted, `since_epoch` is deliberately empty and there must
      # be no age at all.
      then_epoch="$since_epoch"
      case "${now_epoch}${then_epoch}" in
        '' | *[!0-9]*) ;;
        *)
          if [ -n "$now_epoch" ] && [ -n "$then_epoch" ] && [ "$now_epoch" -ge "$then_epoch" ]; then
            age_secs=$(( now_epoch - then_epoch ))
            hours=$(( age_secs / 3600 ))
            # An UPPER bound, and it used to be worded as a lower one ("behind
            # since at least … — 38 hours ago"). !293 review: drift begins when
            # the ref first moved past production's commit, and every missing
            # commit was authored at or before that instant — so `now - min` can
            # only overstate. On a merge workflow it overstates enormously,
            # because the merged branch's own commits predate the merge by days:
            # measured over this repo's last six merges, the gap between the
            # merge and the oldest commit it brought in ran 21 to 38 hours. A
            # deploy four minutes old therefore read "38 hours ago" — which is
            # the exact signature of the #180 outage this monitor exists to
            # catch, printed for an ordinary deploy.
            if [ "$hours" -lt 1 ]; then
              age_line="${age_line} — under an hour"
            elif [ "$hours" -eq 1 ]; then
              age_line="${age_line} — no more than **1 hour** ago"
            else
              age_line="${age_line} — no more than **${hours} hours** ago"
            fi
          fi
          ;;
      esac
    fi
    if [ -n "$moved_secs" ]; then
      age_line="${age_line}
- \`${DRIFT_REF}\` last moved **${moved_secs}s** ago (\`${head_date}\`)"
    fi
    status=1
    # The grace, applied last so it can only ever downgrade a fully-computed
    # verdict — and only when the input is KNOWN. See the header for why this is
    # off by default. No tick: nothing was verified in sync, only verified too
    # young to conclude from, and those are different claims.
    #
    # ── It is `moved_secs`, NOT `age_secs`, and that is !293's second blocking
    # review finding. ────────────────────────────────────────────────────────
    # `age_secs` is the age of the OLDEST COMMIT production is missing. On a
    # merge workflow that includes the merged branch's own commits, which predate
    # the merge by days — measured over this repo's last six merges, 21 to 38
    # hours. So the grace could never fire here: a merge four minutes old
    # presented as 38 hours of drift and alerted immediately. The mechanism added
    # to stop this monitor crying wolf was inert on the only history this project
    # produces, and the header three screens up predicts exactly what that costs.
    #
    # `moved_secs` is how long ago the ref itself last moved, which is the
    # question the grace is actually asking: could the deploy for that movement
    # still be running? It comes free from the ref lookup and it is immune to the
    # shape of the branch that was merged.
    #
    # Bounded under-alerting, deliberately accepted: if several merges land in a
    # burst, the newest resets this clock while production is behind by the
    # oldest. The grace can then hold one cycle longer than it should. It is
    # self-correcting — once the burst stops, nothing resets the clock and the
    # next hourly run alerts — and the alternative is walking the first-parent
    # chain, an extra paged API call to shave at most one cycle off a case that
    # only arises while someone is actively merging.
    if [ "$GRACE" -gt 0 ] && [ -n "$moved_secs" ] && [ "$moved_secs" -lt "$GRACE" ]; then
      verdict_line="- 🔄 production is behind \`${DRIFT_REF}\`, but \`${DRIFT_REF}\` itself only moved ${moved_secs}s ago, which is inside the ${GRACE}s grace this caller allows — **a deploy is most likely still in flight**, so this is not an alert yet. A deploy that blows its own \`--timeout\` fails its pipeline, and \`alert_pipeline_failure\` reports that immediately; anything still behind after the grace is alerted on by the next run."
      # 3, not 0 — see the contract. The bullet above already refuses to print a
      # tick; returning 0 handed the caller the tick anyway.
      status=3
    fi
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
