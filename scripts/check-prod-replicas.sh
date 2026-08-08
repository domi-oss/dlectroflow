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
#
# Exit 2 is a distinct state on purpose and both collapses are lies: reporting 1
# when the read simply failed cries wolf, and reporting 0 is the unproven green
# this issue exists to kill. A caller that treats 2 as 0 has reintroduced the bug.
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
# ── Read-only, and careful with what the cluster says ───────────────────────
# Every kubectl verb here is `get`. Nothing this script can do changes the
# cluster. Its stdout is spliced into a note on an issue in a **PUBLIC** project,
# so container messages — which are attacker-influenceable in the general case
# and arbitrary text in every case — are truncated, stripped of backticks and
# control characters, and prefixed so no line can begin with `/`. A bare fence
# would break out of the code block and take the rest of the note's rendering
# with it; a line starting with `/` would be a GitLab quick action executed with
# the alerter's token.
#
# Env (all optional):
#   REPLICAS_NAMESPACE   the app's namespace
#   REPLICAS_DEPLOYMENT  the Deployment to read
#   REPLICAS_CONTAINER   the app container, for the image comparison
#   REPLICAS_SELECTOR    label selector for its pods
#   REPLICAS_MAX_PODS    how many not-ready pods to describe in the report
#   REPLICAS_MAX_PROGRESS_DEADLINE  longest deadline the quiet arm will trust
set -euo pipefail

NAMESPACE="${REPLICAS_NAMESPACE:-dlectroflow-prod}"
DEPLOYMENT="${REPLICAS_DEPLOYMENT:-dlectroflow}"
CONTAINER="${REPLICAS_CONTAINER:-app}"
SELECTOR="${REPLICAS_SELECTOR:-app.kubernetes.io/name=dlectroflow}"
MAX_PODS="${REPLICAS_MAX_PODS:-3}"
# 1800s = 30 minutes. The monitor runs hourly, so a deadline within this bound
# means at worst one quiet run before the condition flips and the next run
# alerts. Anything longer and staying quiet is no longer self-limiting.
MAX_DEADLINE="${REPLICAS_MAX_PROGRESS_DEADLINE:-1800}"
# 300 characters holds a Prisma P3009 message with its migration name, which is
# the longest thing worth reading here, without pasting a whole stack trace into
# somebody's inbox.
MAX_MSG=300

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
spec_tag="${spec_image##*:}"
[ -n "$spec_tag" ] || spec_tag="unknown"

cond() {
  jq -r --arg t "$1" --arg f "$2" \
    '(.status.conditions // []) | map(select(.type == $t)) | .[0]
     | if . == null then (if $f == "full" then "absent" else "" end)
       elif $f == "status" then (.status // "")
       elif $f == "reason" then (.reason // "")
       else "\(.status) (\(.reason // "no reason")) since \(.lastTransitionTime // "an unknown time")" end' \
    "$WORK/deploy.json" 2> /dev/null || echo ""
}
progressing="$(cond Progressing full)"
progressing_status="$(cond Progressing status)"
progressing_reason="$(cond Progressing reason)"
available_cond="$(cond Available full)"

count_line="- \`deployment/${DEPLOYMENT}\`: **${available}/${desired}** replicas available (${ready} ready, ${updated} on the current spec, image \`${spec_tag}\`)"
cond_line="- conditions: \`Progressing\` ${progressing}; \`Available\` ${available_cond}"

if [ "$available" -ge "$desired" ]; then
  printf -- '%s\n%s\n- ✅ production is running every replica it is meant to\n' \
    "$count_line" "$cond_line"
  exit 0
fi

# ── 1b. Degraded, but is it a rollout in flight? ─────────────────────────────
# See the header: this arm exists because `1/2` was MEASURED to be an ordinary
# transient, and it defers to Kubernetes' own progress deadline rather than a
# second clock. It deliberately does NOT print a tick — nothing here was verified
# healthy, only verified self-limiting, and those are different claims.
if [ "$progressing_status" = "True" ] && [ "$progressing_reason" = "ReplicaSetUpdated" ]; then
  if [ "$deadline" -le "$MAX_DEADLINE" ]; then
    printf -- '%s\n%s\n- 🔄 a rollout is in progress and has **not** yet exceeded its progress deadline (`progressDeadlineSeconds: %s`), so this is not an alert yet. Kubernetes flips `Progressing` to False within that window if it stops making progress, and the next run of this check alerts on it.\n' \
      "$count_line" "$cond_line" "$deadline"
    exit 0
  fi
  printf -- '%s\n%s\n- 🔴 **a rollout has been in progress and its progress deadline is too long to wait for** — `progressDeadlineSeconds: %s` exceeds the %ss this check will stay quiet for. Staying silent would depend on a flip that may not come for hours, which is how a monitor gets switched off without saying so.\n' \
    "$count_line" "$cond_line" "$deadline" "$MAX_DEADLINE"
  exit 1
fi

# ── 2. Degraded — say which pods, and what they say about why ────────────────
# Best-effort by design: the Deployment read above already established the
# verdict, and a pod list that cannot be fetched must not downgrade a proven
# `1/2` into an unknown. It only ever adds detail.
pod_block=""
if kubectl get pods -n "$NAMESPACE" -l "$SELECTOR" -o json \
  > "$WORK/pods.json" 2> "$WORK/pods.err"; then
  # `sanitise` is applied to every cluster-supplied string that reaches stdout:
  #   tr -d  strips backticks (a fence would break out of the code block) and
  #          control characters including newlines (a message spanning lines
  #          could otherwise start one with `/`, which GitLab would run as a
  #          quick action with this job's token);
  #   cut    bounds the length.
  # Done in jq rather than shell so a pod name and a 3-line Prisma error survive
  # as single fields — the loop below reads one record per line.
  jq -r --argjson max "$MAX_PODS" --argjson maxmsg "$MAX_MSG" '
    def clean: (. // "") | tostring
      | gsub("[`[:cntrl:]]"; " ")
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
  pod_tags="$(jq -r --arg c "$CONTAINER" '
    [ (.items // [])[] | (.spec.containers // []) | map(select(.name == $c)) | .[0].image // empty ]
    | map(sub("^.*:"; "")) | unique | join("`, `")' "$WORK/pods.json" 2> /dev/null || true)"
  if [ -n "$pod_tags" ]; then
    if [ "$pod_tags" = "$spec_tag" ]; then
      image_line="- every pod is on the current spec's image (\`${spec_tag}\`), so no pod is serving stale code"
    else
      image_line="- ⚠️ pods are running \`${pod_tags}\` while the current spec is \`${spec_tag}\` — at least one pod is on a **different image**, so production may be serving stale code as well as being short of capacity"
    fi
  fi

  if [ -s "$WORK/pods.md" ]; then
    pod_block="$(printf -- '%s- pods that are not ready:\n%s\n' \
      "${image_line:+${image_line}
}" "$(cat "$WORK/pods.md")")"
  else
    # Degraded with every listed pod Ready is a real and confusing state — the
    # missing replica has no pod object at all (unschedulable, quota, a
    # ReplicaSet that cannot create). Say that rather than printing nothing.
    pod_block="- no pod is failing readiness, so the missing replica has no pod at all — check scheduling, quota and the ReplicaSet's events"
  fi
else
  sed 's/^/  kubectl: /' "$WORK/pods.err" >&2 || true
  pod_block="- the pod list could not be read (see this job's log), so the cause is not in this report — the replica shortfall above is still established"
fi

shortfall=$((desired - available))
if [ "$available" -eq 0 ]; then
  verdict="- 🔴 **production has no available replica at all** — the site is down"
elif [ "$shortfall" -eq 1 ]; then
  verdict="- 🔴 **production is 1 replica short of ${desired}** — it is serving, with no redundancy left: one node event takes the site down"
else
  verdict="- 🔴 **production is ${shortfall} replicas short of ${desired}** — it is serving with no redundancy left"
fi

printf -- '%s\n%s\n%s\n%s\n' "$count_line" "$cond_line" "$pod_block" "$verdict"
exit 1
