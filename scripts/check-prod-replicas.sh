#!/usr/bin/env bash
# scripts/check-prod-replicas.sh — is production running as many replicas as it
# is supposed to? (#191)
#
# Requires bash (not POSIX sh): `set -o pipefail` below is a bash/ksh extension.
# Callers install bash and invoke `bash scripts/check-prod-replicas.sh`.
#
# ── Why this exists, and why check-prod-drift.sh could not answer it ──────────
# For roughly 24 hours production served code from two days earlier on ONE
# replica instead of two. `kubectl get deploy` read `1/2 READY` the whole time
# and two pods sat in `Init:CrashLoopBackOff`. Nothing looked.
#
# `check-prod-drift.sh` cannot see this, and not by oversight — by construction.
# It compares the commit `/api/health` reports against `main`'s HEAD, and
# `/api/health` is answered by whichever pod the Service happens to route to. A
# Deployment at `1/2` whose one surviving pod is on the right commit reports the
# right commit, so drift reads ✅ while half the capacity is gone. During THIS
# incident the surviving pod was the stale one and drift did fire — but that was
# luck about which pod died, not coverage.
#
# So the replica count has to come from the cluster, and it cannot come from the
# app: a container cannot read its own Deployment's `spec.replicas`. That is why
# the caller job extends `.deploy_base` — the GitLab agent context it already
# configures is the credential that exists, and no new one is introduced.
#
# It also happens to be where a failed Prisma migration becomes visible. #180's
# P3009 blocked every subsequent migration, and migrations run in the `migrate`
# initContainer (charts/dlectroflow/templates/deployment.yaml), so a wedged
# migration IS a pod that never becomes ready. The reason and message are read
# back here because `P3009` appears in no other signal — not in the deploy job's
# status, not on `/api/health`, not in the pipeline.
#
# ── Contract (deliberately identical to check-prod-drift.sh) ─────────────────
# Prints a Markdown bullet list on stdout (no heading — the caller supplies one)
# and exits:
#   0  healthy — every desired replica is available
#   1  degraded — fewer available than desired, with what the pods say about why
#   2  undetermined — the cluster could not be read, or answered without the
#      fields the question needs
#   3  in flight — degraded, but self-limiting so far, so deliberately not
#      concluded from: either a rollout progressing inside its own deadline, or a
#      shortfall younger than one monitoring cycle (see § "one hourly cycle")
#
# Exit 2 is a distinct state on purpose and both collapses are lies: reporting 1
# when the read simply failed cries wolf, and reporting 0 is the unproven green
# this issue exists to kill. A caller that treats 2 as 0 has reintroduced the bug.
#
# **Exit 3 is distinct for the same reason, and it used to be 0** — a defect found
# by review on !293. The in-flight arm's own comment says it "deliberately does
# NOT print a tick — nothing here was verified healthy, only verified
# self-limiting, and those are different claims", and then it returned the code
# meaning verified healthy. `alert-prod-state.sh` builds its headline from exit
# codes alone, so `1/2` mid-rollout could render as "✅ production has recovered,
# fully replicated". A caller that treats 3 as 0 has put that back.
#
# ── `1/2` on its own is NOT this incident, and that is measured ─────────────
# The tempting rule is "alert whenever available < desired". It was tried and it
# is wrong. On 2026-08-07, hours after the outage was fixed, `kubectl get deploy`
# read exactly `1/2` in production and it was an **ordinary mid-rollout
# transient**: the two pods were 62s and 21s old, the second still in `Init:1/3`,
# and *both were already on the new image*. `rollout status` returned
# "successfully rolled out" 90 seconds later. An hourly probe has a real chance
# of landing inside a rollout, so that rule would cry wolf several times a week —
# and a muted channel takes the real alert with it.
#
# The discriminator is **not a timer of our own**, because Kubernetes already
# runs one. `progressDeadlineSeconds` (600s by default; the chart sets none)
# flips the `Progressing` condition to `False` with reason
# `ProgressDeadlineExceeded` when a rollout stops making progress. So:
#
#   Progressing=True/ReplicaSetUpdated      a rollout is in flight and has not
#                                           yet blown its deadline → not an alert
#   Progressing=False                       stuck → alert, and name the reason
#   Progressing=True/NewReplicaSetAvailable the rollout FINISHED and a replica is
#                                           still missing → alert. No deadline
#                                           will ever flip for this shape, so
#                                           deferring to one means never alerting
#
# That is exactly the "degraded for more than N minutes" #191 asks for, expressed
# in the one clock that already exists rather than a second one built out of
# persisted state and a `date` implementation this repo has been bitten by twice.
# It also still catches the 24-hour incident: `--atomic --timeout 20m` is past
# the 600s deadline, so `Progressing` read False throughout — and after the
# atomic rollback the OLD spec's pods failed too, because a wedged migration
# blocks every image's `migrate deploy`, so it never recovered and never stopped
# being past the deadline.
#
# **The quiet arm checks the property it depends on.** It is only safe because
# Kubernetes promises to flip the condition within `progressDeadlineSeconds`; if
# that value is raised past REPLICAS_MAX_PROGRESS_DEADLINE the promise no longer
# holds, silence stops being self-limiting, and one Helm value would have turned
# this monitor off without saying so. So a too-long deadline is itself an alert.
#
# ── One hourly cycle: the OTHER discriminator, for the shape no deadline covers ─
# The table above is right that `Progressing=True/NewReplicaSetAvailable` with a
# replica missing has to alert, because no deadline will ever flip for it. What it
# did not anticipate is that the same shape covers a routine pod replacement.
#
# MEASURED, 2026-08-11 11:08 UTC — this monitor's first real run. It fired, posted
# to #45, exited 1 and emailed the schedule's owner. Every line of its evidence was
# correct: `1/2` available, the pending pod and its `seed-allowlist` init container
# named, and "every pod is on the current spec's image, so no pod is serving stale
# code". The rollout had finished four days earlier — `Progressing True
# (NewReplicaSetAvailable) since 2026-08-07T13:12:07Z` — so this arm was reached,
# correctly, and the underlying event was a pod being replaced. `Available` had
# gone False **29 seconds** before the note was posted.
#
# A 24-hour condition and a 60-second one produced the same email, and #191 exists
# because a channel that cries wolf gets filtered — which puts the 24-hour case
# back where it started. So the shortfall also has to clear one MONITORING cycle:
#
#   Available=False for < REPLICAS_MIN_UNAVAILABLE_SECONDS   → in flight (exit 3)
#   Available=False for ≥ that, or no age to be had          → alert (exit 1)
#
# **Where the state lives: nowhere.** A scheduled CI job is stateless between runs,
# and the cluster is already keeping this record — `Available`'s own
# `lastTransitionTime` is the instant availability last dropped below the minimum,
# and Kubernetes only rewrites it when the STATUS changes, so it does not reset
# while the shortfall persists. No cache, no note read-back, no second clock.
#
# **And it is a clock that actually moves.** !293 review had to remove a grace that
# could not fire, because it measured the oldest commit production was missing —
# 21 to 38 hours old on a merge workflow, so a four-minute-old deploy presented as
# 38 hours of drift. This one read 29s for the transient above and would have read
# 24 hours throughout #180. That is the property to check before trusting any
# grace: does the number change on the timescale being discriminated?
#
# **`1/2` really does flip the condition here, and that is measured too.** The
# chart sets no `strategy`, so `maxUnavailable` is 25% of 2 rounded DOWN = 0 and
# minimum availability is the full 2. The live Deployment confirms
# `maxUnavailable: 25%`, and the 11:08 note confirms the flip:
# `Available False (MinimumReplicasUnavailable)`. Raise `maxUnavailable` past 0 and
# the condition stops flipping at `1/2` — at which point there is no age to read,
# and the arm below alerts rather than staying quiet. Failing toward the alert is
# the only acceptable direction for a monitor.
#
# **Three states never get this grace**, and each for its own reason:
#   * `available = 0` — the site is down. A grace is a bet that the condition will
#     clear itself, and that bet is only acceptable while production is serving.
#   * `Progressing=False` — Kubernetes' own verdict that the rollout has stopped
#     making progress. A deadline has already expired; adding an hour of silence on
#     top is the #180 signature made quieter.
#   * an age that could not be established — same rule as the sibling's grace. A
#     grace that fires on an unknown is a monitor switched off by its own helper.
#
# Nothing here touches drift. Production running the wrong commit is never
# transient and alerts on the first observation, in the other script.
#
# ── Read-only, and careful with what the cluster says ───────────────────────
# Every kubectl verb here is `get`. Nothing this script can do changes the
# cluster. Its stdout is spliced into a note on an issue in a **PUBLIC** project,
# so EVERY string the cluster supplies — container messages, pod names and
# phases, image tags, condition text — is truncated and stripped of backticks,
# angle brackets and control characters, and pod detail is prefixed so no line
# can begin with `/`. A bare fence would break out of the code block and take
# the rest of the note's rendering with it; a bare `<tag>` breaks the whole
# surrounding document's Markdown on GitLab; a line starting with `/` would be a
# GitLab quick action executed with the alerter's token.
#
# Container messages are the attacker-influenceable ones in the general case and
# arbitrary text in every case, so they are the reason the filter exists — but it
# is applied by SOURCE, not by how dangerous a field is judged to be. !293 review
# found three fields exempted on that judgement while the comment beside them
# already claimed there were none. `clean` (in jq) and `clean_field` (in shell,
# for the values jq never sees) are the two places it is implemented; a new
# cluster-supplied field goes through one of them.
#
# Env (all optional):
#   REPLICAS_NAMESPACE   the app's namespace
#   REPLICAS_DEPLOYMENT  the Deployment to read
#   REPLICAS_CONTAINER   the app container, for the image comparison
#   REPLICAS_SELECTOR    label selector for its pods
#   REPLICAS_MAX_PODS    how many not-ready pods to describe in the report
#   REPLICAS_MAX_PROGRESS_DEADLINE  longest deadline the quiet arm will trust
#   REPLICAS_MIN_UNAVAILABLE_SECONDS  how long a replica shortfall must have lasted
#                        before it is alerted on; defaults to 3600, ONE run of the
#                        hourly schedule. Coupled to that cadence deliberately —
#                        see the § above. Set it to 0 to alert on first sight.
set -euo pipefail

NAMESPACE="${REPLICAS_NAMESPACE:-dlectroflow-prod}"
DEPLOYMENT="${REPLICAS_DEPLOYMENT:-dlectroflow}"
CONTAINER="${REPLICAS_CONTAINER:-app}"
SELECTOR="${REPLICAS_SELECTOR:-app.kubernetes.io/name=dlectroflow}"
MAX_PODS="${REPLICAS_MAX_PODS:-3}"
# Validated for the same reason as MAX_DEADLINE below, and !293 review caught
# that the comment there claimed EVERY operator-settable number was — this was
# the one that wasn't. It reaches `jq --argjson`, which rejects a non-number, and
# that `jq` is guarded by `2>/dev/null || :` so the failure is silent: the pod
# report comes back empty and the note then says "no pod is failing readiness, so
# the missing replica has no pod at all — check scheduling, quota". A wedged
# migration in `Init:CrashLoopBackOff` is invisible and the reader is actively
# sent to the wrong place. A typo must degrade to the default, not to a confident
# wrong answer.
case "$MAX_PODS" in
  '' | *[!0-9]*)
    echo "check-prod-replicas: REPLICAS_MAX_PODS is not a whole number ('${MAX_PODS}') — using 3." >&2
    MAX_PODS=3
    ;;
esac
# 1800s = 30 minutes. The monitor runs hourly, so a deadline within this bound
# means at worst one quiet run before the condition flips and the next run
# alerts. Anything longer and staying quiet is no longer self-limiting.
#
# Validated like every other operator-settable number in these scripts (the k8s
# `deadline` below, `LOOKBACK` and `GRACE` in the siblings). Duo review on !293
# caught this one skipping it: left unvalidated, `[ "$deadline" -le "$MAX_DEADLINE" ]`
# is a bash error rather than a comparison, so the quiet arm is skipped and an
# ordinary rolling deploy reads as an alert. A typo in a variable must not turn a
# monitor into a false-alarm generator — that is how a channel gets muted.
MAX_DEADLINE="${REPLICAS_MAX_PROGRESS_DEADLINE:-1800}"
case "$MAX_DEADLINE" in
  '' | *[!0-9]*)
    echo "check-prod-replicas: REPLICAS_MAX_PROGRESS_DEADLINE is not a number of seconds ('${MAX_DEADLINE}') — using 1800." >&2
    MAX_DEADLINE=1800
    ;;
esac
# 3600s = one run of the `0 * * * *` schedule, so a shortfall is alerted on by the
# SECOND consecutive run at the latest and a self-healing pod replacement is never
# alerted on at all. Validated like every other operator-settable number here, and
# for the same measured reason: unvalidated, the `-lt` in the arm below is a bash
# error rather than a comparison, the quiet path is skipped, and every routine pod
# swap alerts again.
MIN_UNAVAILABLE="${REPLICAS_MIN_UNAVAILABLE_SECONDS:-3600}"
case "$MIN_UNAVAILABLE" in
  '' | *[!0-9]*)
    echo "check-prod-replicas: REPLICAS_MIN_UNAVAILABLE_SECONDS is not a number of seconds ('${MIN_UNAVAILABLE}') — using 3600." >&2
    MIN_UNAVAILABLE=3600
    ;;
esac
# 300 characters holds a Prisma P3009 message with its migration name, which is
# the longest thing worth reading here, without pasting a whole stack trace into
# somebody's inbox.
MAX_MSG=300

# The shell-side twin of the `clean` defined in the jq programs below, character
# class for character class — see the long comment on the pod report for why each
# class is removed. It exists because not every cluster-supplied string is read
# by jq: the image tag is taken with a parameter expansion, and !293 review found
# that was exactly the one reaching stdout raw. A Deployment whose image tag held
# `<img src=x>` and a fence published both, whole, into a note on a PUBLIC issue.
#
# Replaces rather than deletes, like its jq twin, so the surrounding text is
# neutralised instead of lost and the line still answers its question.
clean_field() {
  local value="${1//[\`<>]/ }"
  value="${value//[[:cntrl:]]/ }"
  if [ "${#value}" -gt "$MAX_MSG" ]; then
    value="${value:0:$MAX_MSG}…"
  fi
  printf '%s' "$value"
}

# A Kubernetes condition timestamp to a Unix epoch, or failure.
#
# **Deliberately NOT check-prod-drift.sh's `iso_to_epoch`, and the difference is a
# guard rather than a shortcut.** That function exists to handle a NUMERIC OFFSET,
# because GitLab's API returns `2026-08-07T09:27:36.000+01:00` and reading the
# remainder as UTC made every age wrong by an hour. This input cannot carry an
# offset: `metav1.Time` marshals through `time.Time.UTC().Format(time.RFC3339)`, so
# a condition's `lastTransitionTime` is always UTC with a `Z` — measured on the live
# Deployment and in the 11:08 note (`since 2026-08-11T11:07:56Z`). So the `Z` is
# REQUIRED and anything else is refused, which is what makes carrying the offset
# arithmetic unnecessary instead of merely omitted. A refusal costs an alert that
# might have been graced; guessing costs an age that is silently wrong, and this
# grace's whole job is to be trusted with silence.
#
# All three `date` implementations are tried for the same reason the sibling tries
# them, and the third is the one that matters: `alert_prod_state` runs on
# `dtzar/helm-kubectl`, whose `date` is **busybox**. Measured in that exact image —
# GNU `-d <iso>` and BSD `-j -f` both fail, `date -u -d "2026-08-11 11:07:56" +%s`
# returns 1786446476, and the offset from a `date -u +%s` taken alongside it matched
# the wall clock to the second. `+%s` for "now" works everywhere, which is why only
# the PARSING side needs a fallback chain.
k8s_condition_epoch() {
  local iso="$1" naive epoch=""
  # The exact RFC3339-with-seconds shape, matched whole rather than sniffed: the
  # value is interpolated into a `date` argument, and validating on the way IN is
  # the same discipline check-prod-drift.sh applies to `/api/health`'s `sha`.
  case "$iso" in
    [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]Z)
      naive="${iso%Z}"
      ;;
    *) return 1 ;;
  esac
  epoch="$(date -u -d "${naive}Z" +%s 2> /dev/null || true)" # GNU
  if [ -z "$epoch" ]; then # BSD (macOS, where `npm test` drives this)
    epoch="$(date -u -j -f '%Y-%m-%dT%H:%M:%S' "$naive" +%s 2> /dev/null || true)"
  fi
  if [ -z "$epoch" ]; then # busybox (alpine, and the real CI image)
    epoch="$(date -u -d "${naive/T/ }" +%s 2> /dev/null || true)"
  fi
  case "$epoch" in
    '' | *[!0-9]*) return 1 ;;
  esac
  printf '%s' "$epoch"
}

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# Every early return goes through here so the "undetermined" wording, the
# never-a-tick rule and the exit code can never drift apart between arms.
undetermined() {
  printf -- '- ⚠️ **undetermined** — %s. This is an unknown, not an all-clear.\n' "$1"
  exit 2
}

for tool in kubectl jq; do
  command -v "$tool" > /dev/null 2>&1 ||
    undetermined "\`${tool}\` is not on PATH in this job, so the cluster could not be read"
done

# ── 1. What the Deployment wants, and what it has ────────────────────────────
# One read, as JSON rather than a jsonpath per field: the conditions are needed
# too, and four kubectl invocations to answer one question is four chances for a
# partial answer that looks whole.
if ! kubectl get deployment "$DEPLOYMENT" -n "$NAMESPACE" -o json \
  > "$WORK/deploy.json" 2> "$WORK/deploy.err"; then
  # The error goes to stderr (the job log), never into stdout: stdout is the
  # Markdown that gets published, and kubectl's messages embed cluster and
  # project identifiers.
  sed 's/^/  kubectl: /' "$WORK/deploy.err" >&2 || true
  undetermined "\`kubectl get deployment/${DEPLOYMENT}\` failed — see this job's log"
fi

desired="$(jq -r '.spec.replicas // empty' "$WORK/deploy.json" 2> /dev/null || true)"
case "$desired" in
  '' | *[!0-9]*)
    # `0 of 0 available` is arithmetically satisfied and operationally
    # meaningless. A spec with no replica count means the read did not return
    # what was asked for, which is an unknown rather than a pass.
    undetermined "the Deployment reported no \`spec.replicas\`, so \"enough\" has no value to compare against"
    ;;
esac

# `// 0`, and this is the one that matters: Kubernetes OMITS availableReplicas
# and readyReplicas rather than writing 0. Read as "missing means fine", a
# Deployment with nothing running at all reports healthy.
available="$(jq -r '.status.availableReplicas // 0' "$WORK/deploy.json")"
ready="$(jq -r '.status.readyReplicas // 0' "$WORK/deploy.json")"
updated="$(jq -r '.status.updatedReplicas // 0' "$WORK/deploy.json")"

# `progressDeadlineSeconds` is absent in the common case: the chart sets none, so
# Kubernetes' documented 600s default applies and nothing writes the field. That
# default is what the quiet arm below relies on, so it is spelled out here rather
# than left implicit.
deadline="$(jq -r '.spec.progressDeadlineSeconds // 600' "$WORK/deploy.json" 2> /dev/null || true)"
case "$deadline" in
  '' | *[!0-9]*) deadline=600 ;;
esac

spec_image="$(jq -r --arg c "$CONTAINER" \
  '((.spec.template.spec.containers // []) | map(select(.name == $c)) | .[0].image) // ""' \
  "$WORK/deploy.json" 2> /dev/null || true)"
# Tag only. The registry path is already public in .gitlab-ci.yml, but the tag is
# the whole of the question and a full ref makes the note harder to scan.
#
# Cleaned because it is published: Kubernetes does not validate `image` against
# the reference grammar, so a Deployment can legally carry any string here. Both
# sides of the pod/spec comparison below are cleaned, so it stays an equality
# between like and like — two tags that differ ONLY in the characters this strips
# would compare equal, which needs two references that are both already illegal
# and costs one wrong sentence in an alert that has already fired.
spec_tag="${spec_image##*:}"
[ -n "$spec_tag" ] || spec_tag="unknown"
spec_tag="$(clean_field "$spec_tag")"

# `full` is the only mode that reaches stdout, so it is the only one cleaned:
# `status`, `reason` and `since` are compared against literals or parsed below and
# must stay exact. `since` never reaches stdout raw either — the arm that reads it
# publishes the DURATION it computed, a number this script owns, and the instant
# itself is already in the `full` rendering, cleaned.
cond() {
  jq -r --arg t "$1" --arg f "$2" --argjson maxmsg "$MAX_MSG" \
    'def clean: (. // "") | tostring
       | gsub("[`<>[:cntrl:]]"; " ")
       | if (. | length) > $maxmsg then (.[:$maxmsg] + "…") else . end;
     (.status.conditions // []) | map(select(.type == $t)) | .[0]
     | if . == null then (if $f == "full" then "absent" else "" end)
       elif $f == "status" then (.status // "")
       elif $f == "reason" then (.reason // "")
       elif $f == "since" then (.lastTransitionTime // "")
       else "\(.status | clean) (\((.reason // "no reason") | clean)) since \((.lastTransitionTime // "an unknown time") | clean)" end' \
    "$WORK/deploy.json" 2> /dev/null || echo ""
}
progressing="$(cond Progressing full)"
progressing_status="$(cond Progressing status)"
progressing_reason="$(cond Progressing reason)"
available_cond="$(cond Available full)"
available_status="$(cond Available status)"
available_since="$(cond Available since)"

count_line="- \`deployment/${DEPLOYMENT}\`: **${available}/${desired}** replicas available (${ready} ready, ${updated} on the current spec, image \`${spec_tag}\`)"
cond_line="- conditions: \`Progressing\` ${progressing}; \`Available\` ${available_cond}"

# ── 1b. A stalled rollout outranks the replica count ─────────────────────────
# **Checked BEFORE availability, and that ordering is the whole point.** `maxSurge`
# is 25% of 2 = 1, so a new rollout adds ONE pod while the two old ones keep
# serving. If the new pod's `migrate` initContainer is wedged, `availableReplicas`
# stays at 2 and a check that returns ✅ on `available >= desired` calls a failed
# deploy healthy — never even reading the condition that says otherwise.
#
# That is the shape of the incident's first hours, before the atomic rollback took
# the old pods down as well, and it is the shape that repeats on every merge
# afterwards, because P3009 blocks each later migration in turn. **Full
# availability and a healthy Deployment are different claims.**
#
# `Progressing: False` is Kubernetes' own verdict that the rollout has stopped
# making progress within `progressDeadlineSeconds`, so this needs no threshold of
# its own — it is read, not computed.
stalled=0
if [ "$progressing_status" = "False" ]; then
  stalled=1
fi

if [ "$stalled" = "0" ] && [ "$available" -ge "$desired" ]; then
  printf -- '%s\n%s\n- ✅ production is running every replica it is meant to\n' \
    "$count_line" "$cond_line"
  exit 0
fi

# ── 1c. Degraded or stalled — but is it a rollout still in flight? ───────────
# See the header: this arm exists because `1/2` was MEASURED to be an ordinary
# transient, and it defers to Kubernetes' own progress deadline rather than a
# second clock. It deliberately does NOT print a tick — nothing here was verified
# healthy, only verified self-limiting, and those are different claims.
#
# Unreachable when `stalled` is 1: `Progressing` cannot be False and True at once,
# so a stalled rollout can never take this quiet path.
if [ "$progressing_status" = "True" ] && [ "$progressing_reason" = "ReplicaSetUpdated" ]; then
  if [ "$deadline" -le "$MAX_DEADLINE" ]; then
    printf -- '%s\n%s\n- 🔄 a rollout is in progress and has **not** yet exceeded its progress deadline (`progressDeadlineSeconds: %s`), so this is not an alert yet. Kubernetes flips `Progressing` to False within that window if it stops making progress, and the next run of this check alerts on it.\n' \
      "$count_line" "$cond_line" "$deadline"
    # 3, not 0 — see the contract. The header has documented this since !293 and the
    # code kept returning 0 anyway, which is the whole of the bug: the caller builds
    # its headline from exit codes alone, so `drift=0 replicas=0` composed
    # "### ✅ production has recovered — on `main`, fully replicated" five lines
    # above a count line reading `1/2`, and exited 0 so no pipeline mail
    # contradicted it. The sibling's grace was fixed to `status=3` in the same
    # review; this arm was missed, and the bullet above already refuses the tick it
    # was handing over anyway.
    exit 3
  fi
  printf -- '%s\n%s\n- 🔴 **a rollout has been in progress and its progress deadline is too long to wait for** — `progressDeadlineSeconds: %s` exceeds the %ss this check will stay quiet for. Staying silent would depend on a flip that may not come for hours, which is how a monitor gets switched off without saying so.\n' \
    "$count_line" "$cond_line" "$deadline" "$MAX_DEADLINE"
  exit 1
fi

# ── 1d. Degraded — but has it lasted longer than one monitoring cycle? ───────
# The arm the 11:08 false positive needed, and the header § "one hourly cycle" is
# its reasoning. `Progressing=True/NewReplicaSetAvailable` with a replica missing is
# both the 24 hours of #180 and a pod being replaced; no deadline distinguishes
# them, and the cluster's own `Available` transition does.
#
# The age is computed first and separately from the decision, so an unreadable or
# skewed timestamp leaves `unavailable_secs` empty and every guard below simply
# fails to grace. There is no arm in which an unknown buys silence.
unavailable_secs=""
if [ "$available_status" = "False" ] && [ -n "$available_since" ]; then
  since_epoch="$(k8s_condition_epoch "$available_since" 2> /dev/null || true)"
  now_epoch="$(date -u +%s 2> /dev/null || true)"
  case "$since_epoch" in '' | *[!0-9]*) since_epoch="" ;; esac
  case "$now_epoch" in '' | *[!0-9]*) now_epoch="" ;; esac
  # `-ge`, so a transition in the FUTURE leaves the age empty rather than negative.
  # A negative number would compare as younger than any threshold and grace a
  # shortfall of any duration on nothing but clock skew — the same guard, and the
  # same reasoning, as the sibling's.
  if [ -n "$since_epoch" ] && [ -n "$now_epoch" ] &&
    [ "$now_epoch" -ge "$since_epoch" ]; then
    unavailable_secs=$((now_epoch - since_epoch))
  fi
fi

# `available -gt 0` and `stalled = 0` are the two states that never get the grace:
# the site being down is not a bet worth taking, and `Progressing=False` is a
# verdict Kubernetes has already reached. Both are spelled out rather than left to
# the arms above, because this arm is reached by fall-through and a future edit
# above it must not be able to widen what stays quiet.
if [ "$MIN_UNAVAILABLE" -gt 0 ] && [ "$stalled" = "0" ] &&
  [ "$available" -gt 0 ] && [ -n "$unavailable_secs" ] &&
  [ "$unavailable_secs" -lt "$MIN_UNAVAILABLE" ]; then
  # No tick, for the reason the arm above gives: verified self-limiting is not
  # verified healthy. The duration is this script's own arithmetic, so nothing
  # cluster-supplied reaches stdout uncleaned here.
  printf -- '%s\n%s\n- 🔄 production has been short of replicas for **%ss**, less than the %ss this check waits before alerting — a pod being replaced looks exactly like this and clears itself in about a minute (measured: the 2026-08-11 11:08 false alarm was 29s old). Not an alert yet, and **not** a clean bill of health: still short on the next hourly run and it will have outlived the wait, and that run alerts.\n' \
    "$count_line" "$cond_line" "$unavailable_secs" "$MIN_UNAVAILABLE"
  exit 3
fi

# ── 2. Degraded — say which pods, and what they say about why ────────────────
# Best-effort by design: the Deployment read above already established the
# verdict, and a pod list that cannot be fetched must not downgrade a proven
# `1/2` into an unknown. It only ever adds detail.
pod_block=""
if kubectl get pods -n "$NAMESPACE" -l "$SELECTOR" -o json \
  > "$WORK/pods.json" 2> "$WORK/pods.err"; then
  # `clean` is applied to EVERY cluster-supplied string that reaches stdout,
  # because stdout is spliced into a note on an issue in a PUBLIC project. That
  # is the whole rule and it holds across the file, not just here: the same four
  # classes are stripped from the pod tags below, from the condition text in
  # `cond` and from the spec's image tag by `clean_field`, which is this
  # definition rewritten in shell for the one value jq never sees. !293 review
  # found those three raw while this comment already claimed otherwise, so if a
  # new cluster-supplied field ever reaches stdout, it goes through one of the
  # two — or this sentence has to stop saying "EVERY". It removes four classes of
  # character, each for its own reason:
  #   `      a fence would break out of the code block and take the rest of the
  #          note's rendering with it;
  #   <>     a BARE `<tag>` breaks the whole surrounding document's Markdown on
  #          GitLab — this project has already lost an MR description to it, and
  #          one `<img …>` inside a Prisma error would make the alert unreadable
  #          at precisely the wrong moment;
  #   ctrl   newlines included: a message spanning lines could otherwise start one
  #          with `/`, which GitLab runs as a quick action with this job's token;
  #   length bounded, so a stack trace is not pasted into somebody's inbox.
  # Characters are replaced with a space rather than deleted, so the surrounding
  # words survive and the message is neutralised rather than lost.
  #
  # Done in jq rather than shell so a pod name and a 3-line Prisma error survive
  # as single fields — the loop below reads one record per line.
  jq -r --argjson max "$MAX_PODS" --argjson maxmsg "$MAX_MSG" '
    def clean: (. // "") | tostring
      | gsub("[`<>[:cntrl:]]"; " ")
      | if (. | length) > $maxmsg then (.[:$maxmsg] + "…") else . end;
    [ (.items // [])[]
      | select(
          ((.status.conditions // []) | map(select(.type == "Ready")) | .[0].status // "False") != "True"
        )
      | { name: (.metadata.name | clean),
          phase: (.status.phase | clean),
          bad: [ ((.status.initContainerStatuses // [])[] | . + {kind: "init"}),
                 ((.status.containerStatuses // [])[] | . + {kind: "app"}) ]
               | map(select((.ready // false) == false))
               | map("\(.kind) container `\(.name | clean)`: \(
                   (.state.waiting.reason // .state.terminated.reason // .lastState.terminated.reason // "no reason") | clean
                 ) after \(.restartCount // 0) restart(s) — \(
                   (.state.waiting.message // .state.terminated.message // .lastState.terminated.message // "no message") | clean
                 )")
        }
    ] | .[:$max]
      | map("  - pod `\(.name)` (\(.phase))" + (if (.bad | length) == 0 then "" else "\n" + (.bad | map("    - " + .) | join("\n")) end))
      | join("\n")
  ' "$WORK/pods.json" > "$WORK/pods.md" 2> /dev/null || : > "$WORK/pods.md"
  # The other half of the measured discriminator. During the 2026-08-07
  # transient BOTH pods were on the new image; during the outage the surviving
  # pod was the STALE one, and that difference is what a human uses to tell
  # "still rolling" from "wedged". One line, from two documents already fetched.
  image_line=""
  # Each tag is cleaned BEFORE the join, because the backticks in the separator
  # are ours and must survive: cleaning the joined string would strip the very
  # code-span markers that keep the list readable.
  pod_tags="$(jq -r --arg c "$CONTAINER" --argjson maxmsg "$MAX_MSG" '
    def clean: (. // "") | tostring
      | gsub("[`<>[:cntrl:]]"; " ")
      | if (. | length) > $maxmsg then (.[:$maxmsg] + "…") else . end;
    [ (.items // [])[] | (.spec.containers // []) | map(select(.name == $c)) | .[0].image // empty ]
    | map(sub("^.*:"; "") | clean) | unique | join("`, `")' "$WORK/pods.json" 2> /dev/null || true)"
  if [ -n "$pod_tags" ] && [ "$spec_tag" = "unknown" ]; then
    # The comparison needs BOTH sides. Without the spec's image, "unknown" would
    # differ from every real tag and the check would report stale code purely
    # because it could not read the field it was comparing against.
    image_line="- pods are running \`${pod_tags}\`; the current spec's image could not be read, so no comparison is made"
  elif [ -n "$pod_tags" ]; then
    if [ "$pod_tags" = "$spec_tag" ]; then
      image_line="- every pod is on the current spec's image (\`${spec_tag}\`), so no pod is serving stale code"
    else
      image_line="- ⚠️ pods are running \`${pod_tags}\` while the current spec is \`${spec_tag}\` — at least one pod is on a **different image**, so production may be serving stale code as well as being short of capacity"
    fi
  fi

  # NOT `[ -s ]`, and the difference is a whole branch. `jq -r … | join("\n")`
  # writes a single NEWLINE for an empty list, so the file is 1 byte and `-s` is
  # true whenever the pod read merely succeeded. The else arm below — the one
  # that explains the confusing state where the missing replica has no pod
  # OBJECT at all — was therefore unreachable, and the note rendered a bare
  # "pods that are not ready:" heading with nothing beneath it: a reader sent to
  # look at pods at precisely the moment the pods are not where the answer is.
  # Found sweeping for the sibling of the `!= 1` collapse Duo caught on !293.
  if grep -q '[^[:space:]]' "$WORK/pods.md"; then
    pod_block="$(printf -- '%s- pods that are not ready:\n%s\n' \
      "${image_line:+${image_line}
}" "$(cat "$WORK/pods.md")")"
  else
    # Degraded with every listed pod Ready is a real and confusing state — the
    # missing replica has no pod object at all (unschedulable, quota, a
    # ReplicaSet that cannot create). Say that rather than printing nothing.
    pod_block="${image_line:+${image_line}
}- no pod is failing readiness, so the missing replica has no pod at all — check scheduling, quota and the ReplicaSet's events"
  fi
else
  sed 's/^/  kubectl: /' "$WORK/pods.err" >&2 || true
  pod_block="- the pod list could not be read (see this job's log), so the cause is not in this report — the replica shortfall above is still established"
fi

shortfall=$((desired - available))
if [ "$available" -ge "$desired" ]; then
  # Stalled at full availability. Saying "N replicas short" here would be simply
  # untrue, and an alert whose headline is wrong is one the reader learns to skim.
  verdict="- 🔴 **production is fully available but its rollout has stopped making progress** — the old pods are still serving, so the site is up and the DEPLOY HAS NOT LANDED. \`${updated}\` of \`${desired}\` pods are on the current spec. A wedged migration looks exactly like this, and it blocks every later migration too, so each merge from here makes it worse."
elif [ "$available" -eq 0 ]; then
  verdict="- 🔴 **production has no available replica at all** — the site is down"
elif [ "$shortfall" -eq 1 ]; then
  verdict="- 🔴 **production is 1 replica short of ${desired}** — it is serving, with no redundancy left: one node event takes the site down"
else
  verdict="- 🔴 **production is ${shortfall} replicas short of ${desired}** — it is serving with no redundancy left"
fi

printf -- '%s\n%s\n%s\n%s\n' "$count_line" "$cond_line" "$pod_block" "$verdict"
exit 1
