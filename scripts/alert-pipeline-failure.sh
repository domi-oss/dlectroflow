#!/usr/bin/env bash
# scripts/alert-pipeline-failure.sh — say something when `main` goes red (#147).
#
# Requires bash (not POSIX sh): `set -o pipefail` below is a bash/ksh extension
# and it is load-bearing — without it a failed `curl` pipes an empty body into
# `jq`, which exits 0, and this job would post a confident "0 failed jobs".
# The CI job installs bash and invokes `bash scripts/alert-pipeline-failure.sh`.
#
# ── Why this job exists ──────────────────────────────────────────────────────
# Pipeline 2721968532 on `main` failed in `test_app`. `deploy_production` is in a
# later stage, so it was **skipped, not failed**: the pipeline's own red tick was
# the only signal that the merge had not deployed, and nobody was looking at it.
# `main` stayed red for 86 minutes, the merge never reached production, and prod
# only caught up by accident when the next MR merged. It was noticed while
# auditing environments for an unrelated reason.
#
# So this is keyed on the *awkward* shape, not the obvious one. `when: on_failure`
# with no `needs:` means "any job in any earlier stage failed", which is what
# catches a `build`-stage failure skipping a `deploy`-stage job. A check that
# waited for `deploy_production` to FAIL would not have caught the incident that
# prompted the issue, because it never ran.
#
# It also answers the sharper half of #147: a skipped `deploy_production` is
# otherwise indistinguishable from a docs-only pipeline where skipping is
# correct (#116's fast path). On `main` it never is, and the note says so.
#
# ── The channel ──────────────────────────────────────────────────────────────
# A note on the standing ops issue — the mechanism `ops_digest` already uses to
# get a message from CI to a human on this project. Reusing it means this needs
# NO new one-time setup: `GL_TOKEN` and `OPS_DIGEST_ISSUE_IID` are already
# configured, so the alert works the first time `main` goes red rather than the
# first time somebody remembers to configure it. A new webhook would have been a
# second thing to wire up, and an unwired alert is the bug being fixed.
#
# Env:
#   CI_API_V4_URL, CI_PROJECT_ID, CI_PIPELINE_ID, CI_PIPELINE_URL,
#   CI_COMMIT_REF_NAME, CI_COMMIT_SHORT_SHA, CI_JOB_NAME  — from GitLab CI
#   GL_TOKEN             — `api`-scoped token that can post issue notes. Unset is
#                          the "not configured" case: preview to the log, exit 0.
#   ALERT_ISSUE_IID      — optional; defaults to OPS_DIGEST_ISSUE_IID
#   ALERT_MENTION        — optional single `@handle`. A note on a participated
#                          issue emails; a mention also raises a GitLab to-do,
#                          which is the difference between "sent" and "seen".
set -euo pipefail

API="${CI_API_V4_URL}/projects/${CI_PROJECT_ID}"
ISSUE_IID="${ALERT_ISSUE_IID:-${OPS_DIGEST_ISSUE_IID:-}}"
REF="${CI_COMMIT_REF_NAME:-main}"
SELF="${CI_JOB_NAME:-alert_pipeline_failure}"
# `main`, NOT the pipeline's own ref. Production only ever deploys `main`, so
# "has production caught up?" is always a question about `main` — comparing prod
# against some other branch's HEAD asks nothing. The job's rules keep this to
# `main` anyway; the default is pinned here because the verification run on this
# branch produced `HTTP 404` and an "undetermined" verdict when it was `$REF`,
# which is a latent bug the moment those rules are ever broadened.
DRIFT_REF="${DRIFT_REF:-main}"
export DRIFT_REF
HERE="$(cd "$(dirname "$0")" && pwd)"

# Reading a pipeline's jobs works with either credential, so the diagnosis still
# happens on a branch where the protected GL_TOKEN is absent — that is what makes
# this job verifiable by making it fire. POSTing a note needs GL_TOKEN, and the
# guard for that is at the bottom.
if [ -n "${GL_TOKEN:-}" ]; then
  AUTH="PRIVATE-TOKEN: ${GL_TOKEN}"
else
  AUTH="JOB-TOKEN: ${CI_JOB_TOKEN:-}"
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
JOBS="$WORK/jobs.ndjson"
: > "$JOBS"

# ── 1. This pipeline's jobs ──────────────────────────────────────────────────
# `include_retried=false` so a job that failed and was retried green is not
# reported as a failure.
page=0
while :; do
  page=$((page + 1))
  # 5 pages = 500 jobs, ~30x this pipeline's size. A `page` parameter that stops
  # advancing would otherwise loop forever inside a job nobody is watching.
  if [ "$page" -gt 5 ]; then
    echo "alert-pipeline-failure: refusing to page past 5 requests of pipeline jobs" >&2
    exit 1
  fi
  resp="$WORK/jobs-${page}.json"
  code="$(curl -s -o "$resp" -w '%{http_code}' --max-time 30 -H "$AUTH" \
    "${API}/pipelines/${CI_PIPELINE_ID}/jobs?per_page=100&page=${page}&include_retried=false" \
    || echo 000)"
  # Failing loudly here rather than degrading: "no failed jobs" because the API
  # answered 403 is a false all-clear, and posting one would be worse than
  # posting nothing. The pipeline is already red, so a red job here costs
  # nothing and a silent one recreates the bug.
  if [ "$code" != "200" ]; then
    echo "alert-pipeline-failure: could not read pipeline ${CI_PIPELINE_ID}'s jobs — HTTP ${code}" >&2
    exit 1
  fi
  if ! jq -e 'type == "array"' "$resp" > /dev/null 2>&1; then
    echo "alert-pipeline-failure: could not read pipeline ${CI_PIPELINE_ID}'s jobs — the response was not a job array" >&2
    exit 1
  fi
  count="$(jq 'length' "$resp")"
  jq -c '.[]' "$resp" >> "$JOBS"
  [ "$count" -eq 100 ] || break
done

# ── 2. What actually failed ──────────────────────────────────────────────────
# `allow_failure: true` jobs are excluded. On `main` the scanners run that way on
# purpose, so a scanner flake cannot block a production deploy — and an alert
# that shouted about those would be filtered within a week, taking the real one
# with it. `$SELF` is excluded so a retry of this job never reports the previous
# attempt as the cause of the pipeline's failure.
# shellcheck disable=SC2016  # `$self` is a JQ variable and must not be expanded.
BLOCKING='[ .[] | select(.status == "failed" and (.allow_failure // false) == false and .name != $self) ]'

failed_count="$(jq -s -r --arg self "$SELF" "${BLOCKING} | length" "$JOBS")"

if [ "$failed_count" -eq 0 ]; then
  echo "alert-pipeline-failure: pipeline ${CI_PIPELINE_ID} has no blocking job failures — nothing to report."
  echo "Job statuses were:"
  jq -s -r 'map("  \(.name): \(.status)\(if (.allow_failure // false) then " (allow_failure)" else "" end)") | join("\n")' "$JOBS"
  exit 0
fi

# shellcheck disable=SC2016  # jq variables, not shell — see above.
FAILED_TABLE="$(jq -s -r --arg self "$SELF" "${BLOCKING}"'
  | map("| "
        + (if (.web_url // "") == "" then "`\(.name)`" else "[`\(.name)`](\(.web_url))" end)
        + " | `\(.stage // "?")` | `\(.failure_reason // "unknown")` |")
  | join("\n")' "$JOBS")"

NON_BLOCKING="$(jq -s -r --arg self "$SELF" '
  [ .[] | select(.status == "failed" and (.allow_failure // false) == true and .name != $self) ]
  | map("`\(.name)`") | join(", ")' "$JOBS")"

deploy_status="$(jq -s -r '[ .[] | select(.name == "deploy_production") ] | .[0].status // "absent"' "$JOBS")"

case "$deploy_status" in
  skipped)
    DEPLOY_LINE="**\`deploy_production\`: \`skipped\` — this commit never reached production.** It sits in a later stage than the failure above, so an earlier failure *skips* it rather than failing it, and the pipeline's own red tick is the only trace. On \`${DRIFT_REF}\` a skipped \`deploy_production\` always means \"should have deployed, did not\"; on a docs-only merge-request pipeline the same status is correct and expected, which is exactly what made the two indistinguishable (#147, #116)."
    ;;
  failed)
    DEPLOY_LINE="**\`deploy_production\`: \`failed\` — the deploy itself failed.** \`helm upgrade --atomic\` rolls a failed release back, so production is still on the previous commit. \`docs/deploy-runbook.md\` §14 covers going further back."
    ;;
  success)
    DEPLOY_LINE="**\`deploy_production\`: \`success\`** — production deployed this commit despite the failure above, so the comparison below should read in sync. A green deploy on a red pipeline means the failing job is not gating the deploy; that is worth a look on its own."
    ;;
  absent)
    DEPLOY_LINE="**\`deploy_production\`: not present in this pipeline.** On \`${DRIFT_REF}\` it should always be created — check the job's \`rules:\`."
    ;;
  *)
    DEPLOY_LINE="**\`deploy_production\`: \`${deploy_status}\`** — not a terminal state when this alert ran, so treat it as undecided rather than as a deploy."
    ;;
esac

# ── 3. Has production actually diverged? ─────────────────────────────────────
# The deploy's status says what the pipeline did; this says what production IS.
# They can disagree (a rollback, a later pipeline that deployed a newer commit),
# and the second question is the one that decides whether anyone must act now.
# stderr is inherited on purpose: a broken drift check must be visible in this
# job's log rather than swallowed into the note.
set +e
DRIFT="$(bash "${HERE}/check-prod-drift.sh")"
drift_status=$?
set -e
case "$drift_status" in
  0) DRIFT_HEADLINE="production is currently in sync with \`${DRIFT_REF}\` anyway" ;;
  1) DRIFT_HEADLINE="**production is NOT running \`${DRIFT_REF}\`**" ;;
  *) DRIFT_HEADLINE="production's commit could not be established — unknown, not an all-clear" ;;
esac

# ── 4. Optional mention ──────────────────────────────────────────────────────
# Validated rather than interpolated: a value that is not a bare handle would be
# arbitrary Markdown — and GitLab quick actions — in a note this job posts
# with an `api`-scoped token.
MENTION_LINE=""
if [ -n "${ALERT_MENTION:-}" ]; then
  if printf '%s' "$ALERT_MENTION" | grep -Eq '^@[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$'; then
    MENTION_LINE="${ALERT_MENTION} — \`${REF}\` needs a look."
  else
    echo "alert-pipeline-failure: ALERT_MENTION is not a single @handle — ignoring it." >&2
  fi
fi

if [ -n "$NON_BLOCKING" ]; then
  NON_BLOCKING_LINE="Also failed but non-blocking (\`allow_failure: true\`, so they did not cause this): ${NON_BLOCKING}."
else
  NON_BLOCKING_LINE=""
fi

# ── 5. The note ──────────────────────────────────────────────────────────────
# Heredoc into a file, then read it back — NOT `$(cat <<EOF …)`. bash 3.2 (the
# system bash on macOS, where `npm test` runs this script) mis-parses a heredoc
# inside a command substitution and dies with "unexpected EOF"; alpine's bash 5
# does not, so the naive form is green in CI and broken on every laptop.
cat > "$WORK/body.md" <<EOF
### 🔴 \`${REF}\` pipeline failed — ${DRIFT_HEADLINE}

Pipeline [${CI_PIPELINE_ID}](${CI_PIPELINE_URL:-}) on \`${REF}\` at \`${CI_COMMIT_SHORT_SHA:-unknown}\`.

| Failed job | Stage | Reason |
|---|---|---|
${FAILED_TABLE}

${NON_BLOCKING_LINE}

${DEPLOY_LINE}

**Production vs \`${DRIFT_REF}\`**

${DRIFT}

**Recovery** — roll forward on \`${DRIFT_REF}\` (the next green pipeline deploys), or re-run \`deploy_production\` on this pipeline if the failure is unrelated to the image it would ship. Going backwards instead: \`docs/deploy-runbook.md\` §14.

${MENTION_LINE}

_Posted by the \`alert_pipeline_failure\` CI job (pipeline ${CI_PIPELINE_ID}). Mechanism: #147._
EOF
# `${NON_BLOCKING_LINE}` and `${MENTION_LINE}` are empty in the common case, and
# a heredoc keeps their blank line, so the note rendered with three consecutive
# blanks in the verification run. Collapse any run of blank lines to one and drop
# trailing ones — presentation only, and the note IS the product here.
awk 'BEGIN { blank = 0 }
     /^[[:space:]]*$/ { blank++; next }
     { if (blank > 0 && NR > blank) print ""; blank = 0; print }' \
  "$WORK/body.md" > "$WORK/body.squeezed.md"
BODY="$(cat "$WORK/body.squeezed.md")"

# ── 6. Post, or preview ──────────────────────────────────────────────────────
if [ -z "${GL_TOKEN:-}" ]; then
  echo "GL_TOKEN unset — not posting. Preview:"
  printf '%s\n' "$BODY"
  exit 0
fi
if [ -z "$ISSUE_IID" ]; then
  echo "Neither ALERT_ISSUE_IID nor OPS_DIGEST_ISSUE_IID is set — not posting. Preview:"
  printf '%s\n' "$BODY"
  exit 0
fi

# JSON body, never form-encoded: the note carries a Markdown table and backticks,
# and URL-encoding these POSTs is how they come back 400/415.
jq -n --arg b "$BODY" '{body: $b}' > "$WORK/note.json"

# Status captured rather than `curl -f`, which aborts with nothing but "The
# requested URL returned error: 422" (Duo review on !251). This is the one write
# this job performs and it is the whole point of it, so a rejection has to name
# the endpoint, the status and the response body — otherwise the alert about a
# silent failure fails silently, which would be its own punchline. `-o` also
# keeps the created note's JSON out of the job log, which `> /dev/null` did.
post_code="$(curl -sS -o "$WORK/post.json" -w '%{http_code}' \
  -X POST -H "$AUTH" -H "Content-Type: application/json" \
  --max-time 30 -d "@$WORK/note.json" "${API}/issues/${ISSUE_IID}/notes" \
  || echo 000)"
# 201 is what the notes endpoint returns; 200 is accepted so a future API change
# to the success code cannot turn a posted alert into a red job.
case "$post_code" in
  200 | 201) ;;
  *)
    echo "alert-pipeline-failure: POST ${API}/issues/${ISSUE_IID}/notes failed — HTTP ${post_code}" >&2
    # The body, not the token: this is a response, and it is where GitLab says
    # which field it rejected. 401/403 means GL_TOKEN's scope or role; 404 means
    # the issue iid; 422 means the payload.
    head -c 2000 "$WORK/post.json" >&2 || true
    echo >&2
    exit 1
    ;;
esac
echo "Posted failure alert to issue #${ISSUE_IID}"
