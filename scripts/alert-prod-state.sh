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
#   0  healthy — production is on `main` with every replica available, OR a
#      deploy is in flight (severity `in_flight`: not an alert, and deliberately
#      not reported as a clean bill of health either — see the classifier)
#   1  alerting — a check reported a problem
#   2  undetermined — a check could not establish its facts, or exited a code
#      that is not one of its four defined outcomes
#   3  the alert could not be delivered, or this job is not configured to deliver
#
# NOTE the children use a `3` of their own, meaning "in flight, deliberately not
# concluded". It is not this 3 and does not propagate: it maps to severity
# `in_flight` and exit 0 above.
#
# ── Env ──────────────────────────────────────────────────────────────────────
#   CI_API_V4_URL, CI_PROJECT_ID, CI_PIPELINE_ID, CI_PIPELINE_URL  — GitLab CI
#   CI_JOB_NAME       how the job names itself in its own note; defaults to
#                     `alert_prod_state`
#   GL_TOKEN          `api`-scoped token that can post issue notes and read them
#   ALERT_ISSUE_IID   issue to post on; defaults to OPS_DIGEST_ISSUE_IID
#   ALERT_MENTION     optional single `@handle`; what raises the to-do
#   PROD_URL          optional; defaults to the prod origin
#   DRIFT_REF         optional; defaults to `main`
#   DRIFT_GRACE_SECONDS  how long a divergence is treated as a deploy still in
#                     flight rather than as drift; defaults to 1500 and is
#                     EXPORTED to check-prod-drift.sh, where it is off by default
#   ALERT_NOTE_LOOKBACK  how many recent notes to search for our own last word
#
# This list is asserted complete by `src/lib/prod-state-alert.test.ts` — every
# `${VAR:-…}` the script reads has to appear here, because this block is what the
# operator setting the schedule up reads instead of the code.
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
#
# `healthy` is tested for POSITIVELY — both codes exactly 0 — and never as
# "nothing alerted". That ordering is !293's review finding, caught independently
# by two reviewers, and it is the whole family's rule turned on the alerter
# itself. Both children have a fourth outcome, `3`, meaning "a deploy is in
# flight, so I deliberately did not conclude"; both refuse to print a tick for it
# and say so in their own comments; and both used to return 0 for it. A graced
# drift or a rollout mid-flight therefore rendered as
# "### ✅ production has recovered — fully replicated", five lines above evidence
# reading `1/2`, addressed to the on-call by name, with "Nothing to do." That is
# an unproven green in the one sentence somebody acts on at 3am, manufactured by
# the monitor written to abolish it.
#
# The precedence is alert > undetermined > in flight > healthy: a proven fault
# outranks everything, an unknown outranks a deliberate non-verdict (we could not
# look beats we chose not to conclude), and only two proven ticks are healthy.
if [ "$drift_code" = "1" ] || [ "$replicas_code" = "1" ]; then
  severity="alert"
  exit_code=1
elif [ "$drift_code" = "2" ] || [ "$replicas_code" = "2" ]; then
  severity="undetermined"
  exit_code=2
elif [ "$drift_code" = "3" ] || [ "$replicas_code" = "3" ]; then
  # Exit 0: a deploy in flight is genuinely not something to wake anyone for, and
  # the next run alerts if it is still true. But it is not a recovery and must
  # never be worded as one.
  severity="in_flight"
  exit_code=0
elif [ "$drift_code" = "0" ] && [ "$replicas_code" = "0" ]; then
  severity="healthy"
  exit_code=0
else
  # Anything else is a child that died rather than decided — a `set -e` abort, an
  # OOM kill, 141 from a SIGPIPE. Reported as an unknown, never as an all-clear.
  severity="undetermined"
  exit_code=2
fi

# The fingerprint is what lets this job recognise its own last word, so it can
# stay quiet about a state it has already reported. The two exit codes and
# nothing else: including the commit SHA would re-fire on every merge while
# production is stuck, and including the replica count would re-fire on every
# flap. Both are noise, and noise is what gets a channel muted.
FINGERPRINT="drift=${drift_code} replicas=${replicas_code}"

# ── The same verdict, in words, for the JOB LOG ──────────────────────────────
# The pipeline notification says only that `alert_prod_state` failed, so the line
# this script leaves in its log is the first sentence a human reads. On 2026-08-11
# 11:08 that line was, in full:
#
#     alert-prod-state: posted a alert note to issue #45 (`drift=0 replicas=1`)
#
# `severity` is a four-value word that says a check fired without saying WHICH, and
# the fingerprint is two raw exit codes the reader has to decode against two script
# headers. The note has a headline that says it in words; the log line did not. So
# each check contributes its own fragment, chosen from its OWN exit code and tested
# for one value at a time — the same rule as the note's fragments below, because a
# default arm catching "everything but 1" is what renders an unknown as a pass.
case "$drift_code" in
  1) drift_word="production is not on \`${DRIFT_REF}\`" ;;
  2) drift_word="undetermined" ;;
  3) drift_word="behind, but inside the grace" ;;
  0) drift_word="in sync" ;;
  *) drift_word="undefined exit ${drift_code}" ;;
esac
case "$replicas_code" in
  1) replicas_word="short of desired" ;;
  2) replicas_word="undetermined" ;;
  3) replicas_word="short, but self-limiting so far" ;;
  0) replicas_word="every desired replica available" ;;
  *) replicas_word="undefined exit ${replicas_code}" ;;
esac
CONDITION="drift: ${drift_word}; replicas: ${replicas_word}"
# The trailing sentence is per-severity because the note IS the product: on the
# healthy path "the exit code keeps failing until this clears" is simply false,
# and a line that is wrong on the good days is a line nobody reads on the bad
# ones. The `<job> fingerprint: <value>` prefix is fixed, because that is what the
# next run greps for.
if [ "$severity" = "healthy" ] || [ "$severity" = "in_flight" ]; then
  # `in_flight` shares this wording because it also exits 0 — "the job keeps
  # failing every run until this clears" would be false, and a line that is wrong
  # on the quiet days is a line nobody reads on the loud ones.
  FINGERPRINT_LINE="_\`${SELF}\` fingerprint: \`${FINGERPRINT}\`. Recorded so a later recurrence is not mistaken for this one and suppressed._"
else
  FINGERPRINT_LINE="_\`${SELF}\` fingerprint: \`${FINGERPRINT}\`. Silent while unchanged; the job keeps failing every run until this clears._"
fi

# Every arm below tests a check's exit code for ONE value. Matching on "not 1"
# and letting 0 and 2 share an arm is the collapse this whole family of scripts
# exists to prevent — it renders "we could not look" as "we looked and it was
# fine" — and the headline is the line that actually gets read, so a proven fault
# standing next to an unreadable check must not present as a clean single-fault
# diagnosis. Duo review on !293 caught the same collapse in the recovery text
# below; this is its sibling, found by sweeping for the shape rather than the
# instance.
case "$severity" in
  alert)
    if [ "$drift_code" = "1" ] && [ "$replicas_code" = "1" ]; then
      HEADLINE="### 🔴 production is behind \`${DRIFT_REF}\` **and** short of replicas"
    elif [ "$drift_code" = "1" ] && [ "$replicas_code" = "2" ]; then
      HEADLINE="### 🔴 production is not running \`${DRIFT_REF}\` — and its replica count is **undetermined**"
    elif [ "$drift_code" = "1" ]; then
      HEADLINE="### 🔴 production is not running \`${DRIFT_REF}\`"
    elif [ "$drift_code" = "2" ]; then
      HEADLINE="### 🔴 production is short of replicas — and whether it runs \`${DRIFT_REF}\` is **undetermined**"
    else
      HEADLINE="### 🔴 production is short of replicas"
    fi
    ;;
  healthy)
    HEADLINE="### ✅ production has recovered — on \`${DRIFT_REF}\`, fully replicated"
    ;;
  in_flight)
    # `in_flight` used to mean one thing — a deploy still running — and now means
    # two: that, or a replica shortfall too young to conclude from. Branched on WHICH
    # child returned 3 rather than widened to a sentence true of either, because a
    # headline vague enough to cover both says nothing about this one, and the
    # headline is the line that actually gets read.
    #
    # THREE arms for three states, and the two-arm version was a Duo finding on !328.
    # Branching on `drift_code` alone put the both-graced case — a merge minutes old
    # landing while an unrelated pod is replaced — into the deploy arm, so the note
    # never said the replica count was also being held. Every other composed string
    # here is built from each check's own exit code, and the `alert` headline below
    # already enumerates its combinations; this one was one arm short of doing the
    # same.
    if [ "$drift_code" = "3" ] && [ "$replicas_code" = "3" ]; then
      HEADLINE="### 🔄 a deploy is in flight **and** production is briefly short of replicas — neither is an alert yet, and **not** a clean bill of health"
    elif [ "$drift_code" = "3" ]; then
      HEADLINE="### 🔄 a deploy is in flight — not an alert, and **not** a clean bill of health"
    else
      HEADLINE="### 🔄 production is short of replicas, but only just — not an alert yet, and **not** a clean bill of health"
    fi
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
    elif [ "$severity" = "in_flight" ]; then
      # "cleared" is the word this severity must never reach — it is the line
      # addressed to the on-call BY NAME, so it is the one sentence most likely
      # to be read on its own and acted on (!293 review). Neutral as to WHICH
      # self-limiting state it is: the headline above already says, and a mention
      # line that named the wrong one would be worse than one that names neither.
      MENTION_LINE="${ALERT_MENTION} — nothing to do yet, and not an all-clear."
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
#
# A second Duo round on !293 found the two bugs left in the shape of that fix,
# and they are the same bug from either side — the text was PICKED from one check
# instead of COMPOSED from both:
#
#   * the last arm was reached whenever `replicas_code` was not 1, so it opened
#     with "every replica is available" on the strength of a check that had
#     exited **2** — a `kubectl` read that was refused. That is the unproven
#     green #191 exists to abolish, reintroduced in the one sentence somebody
#     acts on at 3am, by the alerter itself;
#   * a simultaneous drift AND replica alert only ever printed the replica half,
#     so nobody was told the deploy had not landed either.
#
# So each check now contributes a fragment chosen from its OWN exit code, tested
# for one value at a time. A check that returned 2 contributes a fragment saying
# so — "could not determine" is a third answer, and rendering it as either of the
# other two is the collapse, whichever direction it collapses in.
case "$drift_code" in
  1) DRIFT_STEP="**Production is not running \`${DRIFT_REF}\`.** Check \`deploy_production\` on the most recent \`${DRIFT_REF}\` pipeline: a failure in an earlier stage *skips* it rather than failing it (#147), so a merge can go green without deploying. Rolling forward on \`${DRIFT_REF}\` deploys with the next green pipeline." ;;
  2) DRIFT_STEP="**Whether production is running \`${DRIFT_REF}\` could not be determined** — an unknown, and neither a fault nor an all-clear. The \`curl\` error is in this job's log; stdout withholds it deliberately." ;;
  3) DRIFT_STEP="**Production is behind \`${DRIFT_REF}\`, but recently enough that a deploy is most likely still running.** Not concluded from either way — the next run alerts if it is still behind." ;;
  0) DRIFT_STEP="Production **is** running \`${DRIFT_REF}\`, so stale code is not part of this." ;;
  # `0)` is explicit and this arm is the unknown, not the all-clear (!293 review).
  # A default that catches everything-but-1-and-2 is the same collapse `55d2833`
  # fixed one level up: a child that dies rather than decides — a `set -e` abort,
  # 141 from a SIGPIPE, an OOM kill — was asserting that production is on `main`.
  *) DRIFT_STEP="**The drift check exited \`${drift_code}\`**, which is not one of its four defined outcomes. Treat it as an unknown and read this job's log; nothing about production's commit was established." ;;
esac
case "$replicas_code" in
  1) REPLICAS_STEP="**Production is short of replicas.** A wedged migration is the likeliest cause, and it is the one that compounds: it blocks every LATER migration, so each merge from now makes it worse — § 19 for that path." ;;
  2) REPLICAS_STEP="**The replica count could not be determined** — an unknown, and neither a fault nor an all-clear. The \`kubectl\` error is in this job's log; stdout withholds it deliberately." ;;
  3) REPLICAS_STEP="**Fewer replicas than desired, but self-limiting so far**, so this is not concluded from either way — either a rollout progressing inside its own deadline, or a shortfall younger than one run of this schedule. The bullet in the evidence above says which. Kubernetes flips \`Progressing\` to False if a rollout stops making progress, and a shortfall that is still there next run has outlived the wait and alerts." ;;
  0) REPLICAS_STEP="Every replica **is** available, so nothing here is a shortfall in capacity." ;;
  *) REPLICAS_STEP="**The replica check exited \`${replicas_code}\`**, which is not one of its four defined outcomes. Treat it as an unknown and read this job's log; nothing about capacity was established." ;;
esac

if [ "$severity" = "healthy" ]; then
  NEXT_STEPS="Nothing to do. This note exists so the channel closes its own loops — an alerting path that only ever reports bad news gives you no way to tell \"fixed\" from \"stopped running\"."
elif [ "$severity" = "in_flight" ]; then
  # Deliberately NOT "nothing to do": nothing was verified healthy, and the
  # difference between "no action needed" and "no action needed yet" is the
  # difference this severity exists to preserve.
  NEXT_STEPS="**Nothing to do yet, and nothing here is an all-clear.** The state below is expected to be temporary — it has not been confirmed good, only confirmed self-limiting. The next run alerts if it is still true.

${DRIFT_STEP}

${REPLICAS_STEP}"
else
  if [ "$severity" = "undetermined" ]; then
    LEAD="**Establish the facts first — nothing above is a diagnosis.** An unknown is reported because a check nobody can see is indistinguishable from a passing one."
  else
    LEAD="**Recovery.**"
  fi
  # Blank-separated so each fragment is its own paragraph; the awk squeeze below
  # tidies the run of blanks either fragment would leave if it were ever empty.
  NEXT_STEPS="${LEAD}

${DRIFT_STEP}

${REPLICAS_STEP}

\`docs/deploy-runbook.md\` § 14 goes back a revision, § 18 covers reading this alert."
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
  if [ "$severity" = "healthy" ] || [ "$severity" = "in_flight" ]; then
    echo "alert-prod-state: state unchanged since the last check (${severity} — ${CONDITION}) — nothing to post."
  else
    echo "alert-prod-state: state unchanged since the last note (${severity} — ${CONDITION}) — not repeating it. This job still exits ${exit_code}, so the pipeline notification keeps firing."
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
if { [ "$severity" = "healthy" ] || [ "$severity" = "in_flight" ]; } &&
  [ "$notes_code" = "200" ] && [ -z "$last_fp" ]; then
  # Healthy, and the read SUCCEEDED and found nothing: the first run, or an issue
  # whose notes have rolled past the lookback. Posting "all is well" unprompted is
  # how an alert channel trains its reader to ignore it. `in_flight` joins it for
  # the same reason — announcing an ordinary deploy to a channel that has said
  # nothing before is noise, and noise is what gets a channel muted.
  # The condition is named here too, and this is now the load-bearing case rather
  # than a nicety: with a replica shortfall graced for a cycle, a run that posts
  # nothing and exits 0 is the ONLY record that a shortfall was seen at all. A log
  # line reading just "in_flight" would make a held shortfall indistinguishable
  # from a run where nothing happened.
  echo "alert-prod-state: ${severity} — ${CONDITION} — and this job has said nothing before, so it is staying quiet."
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

# The severity leads, the condition names itself, and the article is gone rather
# than computed: "a alert" was the bug, and "an alert"/"a healthy" would need a
# vowel test to stay correct across all four severities. Restructuring costs
# nothing and cannot regress.
echo "alert-prod-state: ${severity} — ${CONDITION} — posted a note to issue #${ISSUE_IID} (\`${FINGERPRINT}\`)"
exit "$exit_code"
