#!/usr/bin/env bash
# scripts/alert-prod-state.sh — tell a human when production is in a bad STATE,
# and be loud about it when this script itself cannot (#191).
#
# Requires bash (not POSIX sh): `set -o pipefail` below is a bash/ksh extension.
# The CI job installs bash and invokes `bash scripts/alert-prod-state.sh`.
#
# ── Why this exists ──────────────────────────────────────────────────────────
# Production served code from two days earlier on ONE replica instead of two for
# roughly 24 hours. Six consecutive Helm revisions failed, `kubectl get deploy`
# read `1/2 READY` the whole time, and two pods sat in `Init:CrashLoopBackOff`.
# It was found by accident, while investigating an unrelated pipeline.
#
# The sharpest detail is that one alert DID fire. `alert_pipeline_failure` posted
# "🔴 `main` pipeline failed — production is NOT running `main`" on the standing
# ops issue, correctly, more than once. Nobody read it. **A notification nobody
# receives is not alerting, it is logging** — so the gap this script closes is
# delivery, not detection.
#
# ── Two channels, and neither needs anything to be set up ───────────────────
# 1. **A RED PIPELINE.** GitLab notifies the owner of a pipeline schedule when
#    that pipeline fails. That path already exists, cannot be forgotten, and
#    reaches somebody who is not looking at the project. So the contract of this
#    script is deliberately blunt: **the only zero exit is "both checks verified
#    healthy"**. Drifted, degraded, undetermined, POST rejected, no token, no
#    issue — every one of them is non-zero, and therefore an email.
#
# 2. **A note that @mentions.** A mention raises a GitLab to-do as well as a
#    notification, which is the difference between "sent" and "seen". The note
#    carries the diagnosis; channel 1 is what makes somebody go and read it.
#
# A chat webhook or an SMTP sender would both be better-looking and worse: each
# needs a credential that does not exist yet, and an alert that cannot be
# finished being wired is the bug being fixed rather than the fix. Nothing here
# introduces a new secret — `GL_TOKEN` and the issue iid are the pair
# `ops_digest` has used since #33.
#
# ── The one thing this script must never do ─────────────────────────────────
# Fail quietly. A monitor that can die without saying so manufactures false
# confidence, which is worse than having no monitor at all, because the absence
# of an alert starts to read as evidence. So:
#   * an unknown is a first-class state and never renders as a tick;
#   * a rejected POST prints the ENTIRE note to the job log and still exits
#     non-zero, so the content survives a broken channel;
#   * being unconfigured is an alert, not a skip. `alert_pipeline_failure`
#     previews and exits 0 when `GL_TOKEN` is absent, which is right for a job
#     that only runs when something else already went red. It is wrong here:
#     this job's entire purpose is to be the thing that notices;
#   * de-duplication fails OPEN, on EVERY path. If the "have I already said
#     this?" read fails, it says it again — including on the healthy path, where a
#     failed read is indistinguishable from a first run and the shortcut for
#     "nothing on record, stay quiet" would otherwise swallow a recovery note.
#     Losing a recovery is worse than a duplicate, because the newest fingerprint
#     on record stays the old alert and the next recurrence of the same signature
#     is then suppressed as unchanged. A duplicate note is a nuisance; a
#     suppressed alert is an incident.
#
# ── Exit codes ───────────────────────────────────────────────────────────────
#   0  healthy — production is on `main` with every replica available
#   1  alerting — a check reported a problem
#   2  undetermined — a check could not establish its facts
#   3  the alert could not be delivered, or this job is not configured to deliver
#
# ── Env ──────────────────────────────────────────────────────────────────────
#   CI_API_V4_URL, CI_PROJECT_ID, CI_PIPELINE_ID, CI_PIPELINE_URL  — GitLab CI
#   GL_TOKEN          `api`-scoped token that can post issue notes and read them
#   ALERT_ISSUE_IID   issue to post on; defaults to OPS_DIGEST_ISSUE_IID
#   ALERT_MENTION     optional single `@handle`; what raises the to-do
#   PROD_URL          optional; defaults to the prod origin
#   DRIFT_REF         optional; defaults to `main`
#   ALERT_NOTE_LOOKBACK  how many recent notes to search for our own last word
set -euo pipefail

API="${CI_API_V4_URL:-https://gitlab.com/api/v4}/projects/${CI_PROJECT_ID:-}"
ISSUE_IID="${ALERT_ISSUE_IID:-${OPS_DIGEST_ISSUE_IID:-}}"
LOOKBACK="${ALERT_NOTE_LOOKBACK:-20}"
# Validated because it is interpolated into a URL. A non-numeric value would make
# a malformed request whose failure the de-duplication read treats as "post
# anyway" — safe, but silently unpaginated, so it is corrected loudly instead.
case "$LOOKBACK" in
  '' | *[!0-9]*)
    echo "alert-prod-state: ALERT_NOTE_LOOKBACK is not a number — using 20." >&2
    LOOKBACK=20
    ;;
esac
SELF="${CI_JOB_NAME:-alert_prod_state}"
# `main`, never the pipeline's own ref: production only ever deploys `main`, so
# "has production caught up?" is always a question about `main`. Same pin, and
# same reason, as alert-pipeline-failure.sh.
DRIFT_REF="${DRIFT_REF:-main}"
export DRIFT_REF
# Just over deploy_production's `--timeout 20m`. On an hourly clock this job
# would otherwise land inside a normal deploy every few days and post that
# production is behind — true for four minutes, and the sort of noise that gets a
# channel muted. A deploy that blows its own timeout fails its pipeline, and
# `alert_pipeline_failure` reports that immediately without any grace, so nothing
# is lost in the window. Off by default in the check itself; see its header.
DRIFT_GRACE_SECONDS="${DRIFT_GRACE_SECONDS:-1500}"
export DRIFT_GRACE_SECONDS
HERE="$(cd "$(dirname "$0")" && pwd)"

if [ -n "${GL_TOKEN:-}" ]; then
  AUTH="PRIVATE-TOKEN: ${GL_TOKEN}"
else
  AUTH="PRIVATE-TOKEN: "
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# ── 1. The two state checks ──────────────────────────────────────────────────
# Both are run unconditionally and neither short-circuits the other. They answer
# different questions and the incident needed both: the SHA comparison cannot see
# a half-empty Deployment, and the replica count cannot see stale code. stderr is
# inherited on purpose so a broken check is visible in this job's log rather than
# swallowed into the note.
set +e
DRIFT="$(bash "${HERE}/check-prod-drift.sh")"
drift_code=$?
REPLICAS="$(bash "${HERE}/check-prod-replicas.sh")"
replicas_code=$?
set -e

# ── 2. One verdict from two ──────────────────────────────────────────────────
# A problem outranks an unknown: if one check proves something is broken, that is
# the headline even when the other could not read anything. An unknown still
# outranks healthy — which is the rule the whole `check-*.sh` family exists to
# enforce, and the one a caller is tempted to break.
if [ "$drift_code" = "1" ] || [ "$replicas_code" = "1" ]; then
  severity="alert"
  exit_code=1
elif [ "$drift_code" = "0" ] && [ "$replicas_code" = "0" ]; then
  severity="healthy"
  exit_code=0
else
  severity="undetermined"
  exit_code=2
fi

# The fingerprint is what lets this job recognise its own last word, so it can
# stay quiet about a state it has already reported. The two exit codes and
# nothing else: including the commit SHA would re-fire on every merge while
# production is stuck, and including the replica count would re-fire on every
# flap. Both are noise, and noise is what gets a channel muted.
FINGERPRINT="drift=${drift_code} replicas=${replicas_code}"
# The trailing sentence is per-severity because the note IS the product: on the
# healthy path "the exit code keeps failing until this clears" is simply false,
# and a line that is wrong on the good days is a line nobody reads on the bad
# ones. The `<job> fingerprint: <value>` prefix is fixed, because that is what the
# next run greps for.
if [ "$severity" = "healthy" ]; then
  FINGERPRINT_LINE="_\`${SELF}\` fingerprint: \`${FINGERPRINT}\`. Recorded so a later recurrence is not mistaken for this one and suppressed._"
else
  FINGERPRINT_LINE="_\`${SELF}\` fingerprint: \`${FINGERPRINT}\`. Silent while unchanged; the job keeps failing every run until this clears._"
fi

case "$severity" in
  alert)
    if [ "$drift_code" = "1" ] && [ "$replicas_code" = "1" ]; then
      HEADLINE="### 🔴 production is behind \`${DRIFT_REF}\` **and** short of replicas"
    elif [ "$drift_code" = "1" ]; then
      HEADLINE="### 🔴 production is not running \`${DRIFT_REF}\`"
    else
      HEADLINE="### 🔴 production is short of replicas"
    fi
    ;;
  healthy)
    HEADLINE="### ✅ production has recovered — on \`${DRIFT_REF}\`, fully replicated"
    ;;
  *)
    HEADLINE="### ⚠️ production's state is **undetermined** — an unknown, not an all-clear"
    ;;
esac

# ── 3. Optional mention ──────────────────────────────────────────────────────
# Validated rather than interpolated: a value that is not a bare handle would be
# arbitrary Markdown — and GitLab quick actions — in a note this job posts with
# an `api`-scoped token.
#
# `[[ =~ ]]` and NOT `grep -Eq`, which is what alert-pipeline-failure.sh used
# until #191. **grep anchors per LINE, so `^@handle$` matches the first line of a
# multi-line value and the guard passes.** `@someone\n/close` was therefore
# accepted and interpolated whole, putting `/close` at the start of its own line
# in the note — which is exactly how GitLab recognises a quick action, executed
# with this job's token. Bash's `=~` anchors the whole string (no REG_NEWLINE),
# measured on bash 3.2.57 and 5.x. The existing test missed it because its
# malformed case was single-line.
MENTION_LINE=""
if [ -n "${ALERT_MENTION:-}" ]; then
  if [[ "$ALERT_MENTION" =~ ^@[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$ ]]; then
    if [ "$severity" = "healthy" ]; then
      MENTION_LINE="${ALERT_MENTION} — cleared, no action needed."
    else
      MENTION_LINE="${ALERT_MENTION} — production needs a look."
    fi
  else
    echo "alert-prod-state: ALERT_MENTION is not a single @handle — ignoring it." >&2
  fi
fi

# The first instruction has to match the evidence, and it did not. Duo review on
# !293 caught that this text was identical for EVERY non-healthy severity and
# opened by blaming a failed migration — including when the state is undetermined
# because the cluster could not be read, and when the only problem is that a
# deploy did not happen. Sending somebody to the migrations at 2am because the
# check has no credentials is a wrong first step, and the note is the product.
if [ "$severity" = "healthy" ]; then
  NEXT_STEPS="Nothing to do. This note exists so the channel closes its own loops — an alerting path that only ever reports bad news gives you no way to tell \"fixed\" from \"stopped running\"."
elif [ "$severity" = "undetermined" ]; then
  NEXT_STEPS="**Establish the facts first — nothing above is a diagnosis.** One of the two checks could not read what it needed, so this is an unknown rather than a fault, and an unknown is reported because a check nobody can see is indistinguishable from a passing one. Start with this job's log: it carries the \`kubectl\` or \`curl\` error that stdout deliberately withholds. \`docs/deploy-runbook.md\` § 18 covers reading this alert."
elif [ "$replicas_code" = "1" ]; then
  NEXT_STEPS="**Recovery** — a wedged migration is the likeliest cause of a replica shortfall here, and it is the one that compounds: it blocks every LATER migration, so each merge from now makes it worse. \`docs/deploy-runbook.md\` § 19 for that path, § 14 to go back a revision, § 18 to read this alert."
else
  NEXT_STEPS="**Recovery** — every replica is available, so this is a deploy that did not land rather than a broken one. Check \`deploy_production\` on the most recent \`${DRIFT_REF}\` pipeline: a failure in an earlier stage *skips* it rather than failing it (#147). Rolling forward on \`${DRIFT_REF}\` deploys with the next green pipeline; \`docs/deploy-runbook.md\` § 14 to go back a revision instead, § 18 to read this alert."
fi

# ── 4. The note ──────────────────────────────────────────────────────────────
# Heredoc into a file, then read it back — NOT `$(cat <<EOF …)`. bash 3.2 (the
# system bash on macOS, where `npm test` drives this script) mis-parses a heredoc
# inside a command substitution and dies with "unexpected EOF"; alpine's bash 5
# does not, so the naive form is green in CI and broken on every laptop. Three
# scripts in this directory carry the same note for the same reason.
cat > "$WORK/body.md" <<EOF
${HEADLINE}

**Is production running \`${DRIFT_REF}\`?** (#147)

${DRIFT}

**Is production running every replica it should?** (#191)

${REPLICAS}

${NEXT_STEPS}

${MENTION_LINE}

${FINGERPRINT_LINE}

_Posted by the \`${SELF}\` CI job (pipeline ${CI_PIPELINE_ID:-unknown}${CI_PIPELINE_URL:+ — ${CI_PIPELINE_URL}}). Mechanism: #191._
EOF
# `${MENTION_LINE}` is empty in the common case and a heredoc keeps its blank
# line. Collapse runs of blanks to one and drop trailing ones — presentation
# only, and the note IS the product here.
awk 'BEGIN { blank = 0 }
     /^[[:space:]]*$/ { blank++; next }
     { if (blank > 0 && NR > blank) print ""; blank = 0; print }' \
  "$WORK/body.md" > "$WORK/body.squeezed.md"
BODY="$(cat "$WORK/body.squeezed.md")"

# ── 5. Can this job deliver at all? ──────────────────────────────────────────
# Checked AFTER composing, so the state still reaches the job log when it cannot
# reach the issue. Exits 3 rather than 0: an alerting job that silently cannot
# alert is the failure this whole issue is about, one level up.
undeliverable() {
  echo "alert-prod-state: $1" >&2
  echo "The state below was NOT delivered to anybody. This job is red so that the"
  echo "pipeline notification is at least reaching you; fix the setting and it"
  echo "will post next run."
  printf '%s\n' "$BODY"
  exit 3
}
if [ -z "${GL_TOKEN:-}" ]; then
  undeliverable "GL_TOKEN is unset, so no note can be posted (Settings → CI/CD → Variables, protected)"
fi
if [ -z "$ISSUE_IID" ]; then
  undeliverable "neither ALERT_ISSUE_IID nor OPS_DIGEST_ISSUE_IID is set, so there is nowhere to post"
fi

# ── 6. Have we already said this? ────────────────────────────────────────────
# Only the most recent fingerprint counts, and a recovery writes one too. That
# pairing is what keeps the chain honest: without a "recovered" note the last
# thing this job ever said would stay the old failure, and the NEXT identical
# incident would be suppressed as a duplicate of one that was fixed weeks ago.
#
# Fails OPEN in every direction — a non-200, an unparseable body, no match. The
# only outcome of a broken de-duplication read is a repeated note.
last_fp=""
notes_code="$(curl -s -o "$WORK/notes.json" -w '%{http_code}' --max-time 30 \
  -H "$AUTH" "${API}/issues/${ISSUE_IID}/notes?order_by=created_at&sort=desc&per_page=${LOOKBACK}" \
  || echo 000)"
if [ "$notes_code" = "200" ]; then
  # `.[]?` and `// ""` throughout: a system note has no body, and one malformed
  # entry must not cost the whole read.
  # The job name is part of the marker, so an unrelated comment that happens to
  # contain the word "fingerprint" cannot suppress a real alert. `$self` is passed
  # in rather than interpolated into the program text.
  last_fp="$(jq -r --arg self "$SELF" '
    ($self + "` fingerprint: `([^`]*)`") as $re
    | [ .[]? | (.body // "")
        | select(test($re))
        | (match($re).captures[0].string) ]
    | .[0] // empty' "$WORK/notes.json" 2> /dev/null || true)"
else
  echo "alert-prod-state: could not read recent notes (HTTP ${notes_code}) — posting without de-duplication rather than risking a suppressed alert." >&2
  # Said in the NOTE as well as the log, so a reader is not told production
  # "recovered" from something that may never have been broken. The log is not
  # where the person who gets the to-do is looking.
  BODY="${BODY}

_De-duplication was unavailable this run (\`GET …/notes\` → HTTP ${notes_code}), so this note may repeat one you have already seen, and \"recovered\" may mean \"was never broken\". A duplicate is the deliberate trade against a suppressed alert._"
fi

if [ "$last_fp" = "$FINGERPRINT" ]; then
  if [ "$severity" = "healthy" ]; then
    echo "alert-prod-state: production is healthy and was healthy at the last check — nothing to post."
  else
    echo "alert-prod-state: state unchanged since the last note (\`${FINGERPRINT}\`) — not repeating it. This job still exits ${exit_code}, so the pipeline notification keeps firing."
  fi
  exit "$exit_code"
fi
# `notes_code = 200` is load-bearing, and its absence was a real bug caught in Duo
# review on !293. A FAILED read also leaves `last_fp` empty, which is
# indistinguishable from a genuine first run — so this shortcut used to drop a
# recovery note on a transient HTTP error.
#
# That is worse than the duplicate the design accepts: with no recovery marker
# written, the newest fingerprint on the issue stays the OLD alert, and the next
# recurrence of the same signature reads as "unchanged since the last note". A
# real, new incident would be silently suppressed — the exact failure this whole
# MR exists to remove, reintroduced one level down.
if [ "$severity" = "healthy" ] && [ "$notes_code" = "200" ] && [ -z "$last_fp" ]; then
  # Healthy, and the read SUCCEEDED and found nothing: the first run, or an issue
  # whose notes have rolled past the lookback. Posting "all is well" unprompted is
  # how an alert channel trains its reader to ignore it.
  echo "alert-prod-state: production is healthy and this job has said nothing before — staying quiet."
  exit 0
fi

# ── 7. Post ──────────────────────────────────────────────────────────────────
# JSON body, never form-encoded: the note carries Markdown and backticks, and
# URL-encoding these POSTs is how they come back 400/415.
jq -n --arg b "$BODY" '{body: $b}' > "$WORK/note.json"
post_code="$(curl -sS -o "$WORK/post.json" -w '%{http_code}' \
  -X POST -H "$AUTH" -H "Content-Type: application/json" \
  --max-time 30 -d "@$WORK/note.json" "${API}/issues/${ISSUE_IID}/notes" \
  || echo 000)"
case "$post_code" in
  200 | 201) ;;
  *)
    # The alert about a silent failure failing silently would be its own
    # punchline, so the whole note goes to the job log and the job goes red.
    # The response body names the field GitLab rejected: 401/403 is GL_TOKEN's
    # scope or role, 404 the issue iid, 422 the payload.
    echo "alert-prod-state: POST ${API}/issues/${ISSUE_IID}/notes failed — HTTP ${post_code}" >&2
    head -c 2000 "$WORK/post.json" >&2 || true
    echo >&2
    echo "The note below was NOT delivered. It is here so the diagnosis survives a broken channel:"
    printf '%s\n' "$BODY"
    exit 3
    ;;
esac

echo "alert-prod-state: posted a ${severity} note to issue #${ISSUE_IID} (\`${FINGERPRINT}\`)"
exit "$exit_code"
