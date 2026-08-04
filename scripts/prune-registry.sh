#!/usr/bin/env bash
# scripts/prune-registry.sh — bound the `main-*` container-registry tag set (#114).
#
# Run by the `prune_registry` CI job on a weekly schedule. This is the only job
# in this repo that DELETES production artefacts, so it is written to fail
# closed: every uncertainty aborts with `FATAL:` and deletes nothing.
#
# WHY THIS EXISTS (#113 → #114). GitLab's cleanup policy cannot express "keep
# the newest N tags matching a pattern": `name_regex_keep` is all-or-nothing and
# `keep_n` applies to the delete set. `main-*` is in `name_regex_keep`, so every
# production build is kept forever (1,886 tags / ~116 GiB before the first manual
# prune). Dropping `main-*` from the keep pattern would eventually delete the tag
# production pins — the chart pins `image.tag`, and a missing tag 404s the pull
# even though the digest survives. So the retention rule has to live in a job.
#
# THE RULE: keep the newest `PRUNE_KEEP_N` (10) `main-*` tags by main's git
# history, plus whatever production is running right now, plus anything not
# rankable. Delete the rest.
#
# THE TWO TRAPS, both of which produce a confident WRONG answer rather than an
# error, and both of which are covered by src/lib/registry-prune.test.ts:
#
#   1. `git log --format=%h` abbreviates to SEVEN characters. These tags carry
#      `$CI_COMMIT_SHORT_SHA`, which is EIGHT. Comparing the two matches 0 of
#      137 tags — and a job that believes "0 matched" deletes every rollback
#      target and keeps only production's. So this script matches by SHA PREFIX
#      of whatever length each tag actually carries, and then asserts the match
#      rate is plausible. That assertion matters more than the matching: a
#      near-total mismatch means the format is wrong, not that the tags are old.
#   2. The tags API returns tags ALPHABETICALLY, not chronologically. `main-*`
#      sorts after every bare-SHA tag starting with a digit, so a paginator that
#      stops early never reaches `m` and concludes there are no `main-*` tags at
#      all. So this pages to exhaustion and cross-checks the collected count
#      against the `X-Total` response header.
#
# SAFETY PROPERTIES, in the order they are enforced:
#   * Production's tag is READ from the live Deployment. If that read fails or
#     is empty, nothing is deleted and the exit status is non-zero. There is no
#     fallback and no default.
#   * Production's image repository must be the repository being pruned, and
#     production's tag must appear in the listing we are about to prune from —
#     otherwise the "keep production's tag" guard would be protecting nothing.
#   * Immediately before any DELETE is issued, an INDEPENDENT guard re-checks
#     that production's tag (and every tag a running pod uses) is absent from
#     the delete list, so a bug in the filtering above cannot bypass it.
#   * A ceiling (`PRUNE_MAX_DELETE`) bounds the blast radius of any single run.
#   * `PRUNE_DRY_RUN` defaults to `true`: only the exact string `false` deletes.
#
# Environment (job-provided):
#   CI_API_V4_URL, CI_PROJECT_ID, CI_PROJECT_PATH  — provided by GitLab CI
#   CI_JOB_TOKEN or REGISTRY_PRUNE_TOKEN           — see "Which credential" below
#   KUBECONFIG                                     — GitLab agent for Kubernetes
#
# Knobs (all optional, all with safe defaults):
#   PRUNE_DRY_RUN=true        print the plan, delete nothing (DEFAULT)
#   PRUNE_KEEP_N=10           how many recent main-* tags to keep
#   PRUNE_MAX_DELETE=400      abort if one run would delete more than this
#   PRUNE_MIN_MATCH_PCT=90    abort below this tag→commit match rate
#   PRUNE_TAG_PREFIX=main-    which tags this job is allowed to touch
#   PRUNE_GIT_REF=origin/main which history ranks the tags
#   PRUNE_NAMESPACE / PRUNE_DEPLOYMENT / PRUNE_CONTAINER / PRUNE_POD_SELECTOR
#   PRUNE_PER_PAGE=100 / PRUNE_MAX_PAGES=200
#
# WHICH CREDENTIAL — answered empirically on gitlab.com 2026-07-29 (#114):
#   * `CI_JOB_TOKEN` CAN read the registry API (`GET registry/repositories` and
#     `GET …/tags` both 200), so the dry run this ships as needs NO new
#     credential.
#   * `CI_JOB_TOKEN` CANNOT delete: `DELETE …/tags/<name>` returns 403
#     {"message":"403 Forbidden"} — and 403 rather than 404 on a tag that does
#     not exist means authorization fails before the lookup, so it is not
#     permitted rather than merely missing.
# Actually deleting therefore needs `REGISTRY_PRUNE_TOKEN`: a Maintainer token
# with `api` scope, stored as a masked+protected CI variable. That is an owner
# decision, so this script warns about it and never papers over it.
#
# Requires bash (not POSIX sh) plus curl, jq, git and kubectl — see the
# `prune_registry` job in .gitlab-ci.yml, which installs whatever the deploy
# image is missing.
set -euo pipefail

DRY_RUN="${PRUNE_DRY_RUN:-true}"
KEEP_N="${PRUNE_KEEP_N:-10}"
MAX_DELETE="${PRUNE_MAX_DELETE:-400}"
MIN_MATCH_PCT="${PRUNE_MIN_MATCH_PCT:-90}"
PREFIX="${PRUNE_TAG_PREFIX:-main-}"
GIT_REF="${PRUNE_GIT_REF:-origin/main}"
NAMESPACE="${PRUNE_NAMESPACE:-dlectroflow-prod}"
DEPLOYMENT="${PRUNE_DEPLOYMENT:-dlectroflow}"
CONTAINER="${PRUNE_CONTAINER:-app}"
POD_SELECTOR="${PRUNE_POD_SELECTOR:-app.kubernetes.io/name=dlectroflow}"
PER_PAGE="${PRUNE_PER_PAGE:-100}"
MAX_PAGES="${PRUNE_MAX_PAGES:-200}"

log() { printf '%s\n' "$*"; }
warn() { printf 'WARN: %s\n' "$*" >&2; }

# Every abort path goes through fatal(): one exit code, one wording, and an
# explicit statement that nothing was removed, so a red schedule is unambiguous.
fatal() {
  printf 'FATAL: %s\n' "$*" >&2
  printf 'ABORTED — no tags have been deleted.\n' >&2
  exit 1
}

# Only for failures DURING the delete loop, where "nothing was deleted" would be
# a lie.
fatal_mid_delete() {
  printf 'FATAL: %s\n' "$*" >&2
  exit 4
}

require_uint() {
  case "$2" in
  '' | *[!0-9]*) fatal "$1 must be a non-negative integer (got '$2')" ;;
  esac
}

lc() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }

for tool in curl jq git kubectl; do
  command -v "$tool" >/dev/null 2>&1 ||
    fatal "$tool is not installed — see the prune_registry job in .gitlab-ci.yml"
done

require_uint PRUNE_KEEP_N "$KEEP_N"
require_uint PRUNE_MAX_DELETE "$MAX_DELETE"
require_uint PRUNE_MIN_MATCH_PCT "$MIN_MATCH_PCT"
require_uint PRUNE_PER_PAGE "$PER_PAGE"
require_uint PRUNE_MAX_PAGES "$MAX_PAGES"
[ "$KEEP_N" -ge 1 ] || fatal "PRUNE_KEEP_N must be at least 1 (got $KEEP_N)"
[ -n "$PREFIX" ] || fatal "PRUNE_TAG_PREFIX must not be empty"

[ -n "${CI_API_V4_URL:-}" ] || fatal "CI_API_V4_URL is unset"
[ -n "${CI_PROJECT_ID:-}" ] || fatal "CI_PROJECT_ID is unset"
[ -n "${CI_PROJECT_PATH:-}" ] || fatal "CI_PROJECT_PATH is unset"
API="${CI_API_V4_URL%/}/projects/${CI_PROJECT_ID}"

# A stored token wins if present; otherwise the job token, which may or may not
# be permitted to delete tags (the delete loop reports which).
if [ -n "${REGISTRY_PRUNE_TOKEN:-}" ]; then
  AUTH_HEADER="PRIVATE-TOKEN: ${REGISTRY_PRUNE_TOKEN}"
  AUTH_KIND="REGISTRY_PRUNE_TOKEN (PRIVATE-TOKEN header)"
elif [ -n "${CI_JOB_TOKEN:-}" ]; then
  AUTH_HEADER="JOB-TOKEN: ${CI_JOB_TOKEN}"
  AUTH_KIND="CI_JOB_TOKEN (JOB-TOKEN header)"
else
  fatal "no API token available: set REGISTRY_PRUNE_TOKEN, or run inside CI"
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# `</dev/null` on every curl: these run inside `while read` loops, and a child
# that inherits the loop's stdin can swallow the list being iterated.
http_get() { # url body_file header_file → prints the HTTP status code
  curl -sS --max-time 60 -o "$2" -D "$3" -w '%{http_code}' \
    -H "$AUTH_HEADER" "$1" </dev/null 2>>"$WORK/curl.err" || printf '000'
}

http_delete() { # url → prints the HTTP status code
  curl -sS --max-time 60 -o /dev/null -w '%{http_code}' -X DELETE \
    -H "$AUTH_HEADER" "$1" </dev/null 2>>"$WORK/curl.err" || printf '000'
}

header_value() { # header_file name → prints the value (case-insensitive)
  tr -d '\r' <"$1" | awk -v want="$2" '
    BEGIN { want = tolower(want) }
    {
      p = index($0, ":")
      if (p > 1) {
        k = tolower(substr($0, 1, p - 1))
        v = substr($0, p + 1)
        sub(/^[ \t]+/, "", v)
        sub(/[ \t]+$/, "", v)
        if (k == want) print v
      }
    }'
}

log "prune-registry: authenticating with ${AUTH_KIND}"

# Measured on gitlab.com 2026-07-29 (#114, pipeline 2715681240): with
# CI_JOB_TOKEN, `GET registry/repositories` and `GET …/tags` both return 200 —
# so a DRY RUN needs no extra credential at all — but `DELETE …/tags/<name>`
# returns 403 {"message":"403 Forbidden"}. It is 403 rather than 404 on a tag
# that does not exist, i.e. authorization fails before the lookup: not
# permitted, full stop. Say so BEFORE doing several minutes of work.
# Deliberately a warning, not an abort: GitLab may permit this in a later
# version, and the delete loop's own 401/403 handler is the backstop.
if [ "$DRY_RUN" = "false" ] && [ -z "${REGISTRY_PRUNE_TOKEN:-}" ]; then
  warn "PRUNE_DRY_RUN=false but the only credential is CI_JOB_TOKEN, which cannot delete registry tags (verified 2026-07-29: HTTP 403 on the tag-delete endpoint). Expect the delete loop to stop on its first call. Set REGISTRY_PRUNE_TOKEN to a Maintainer token with 'api' scope."
fi

# ── 1. Which registry repository? Never `.[0]` ───────────────────────────────
# TWO of them as measured 2026-08-04: `…/dlectroflow` (SHA + main-* builds) and
# `…/dlectroflow/cache` (Kaniko layer cache). There were THREE when this was
# written — `…/dlectroflow/main`, a hand-pushed orphan holding a stale `latest`,
# deleted 2026-07-29 (#113) — and the API listed it FIRST, so `.[0]` picked the
# wrong repository and pruned a listing that did not contain production's tag.
#
# The count is not the point and is not worth re-checking here: a repository
# appears the moment anything is pushed under a new path, so `.[0]` can start
# being wrong again without warning. Match the path EXACTLY and assert there is
# exactly one match. src/lib/registry-prune.test.ts keeps the three-repository
# shape as its fixture on purpose — it is the harder case, and dropping it when
# production dropped it would retire the test for the bug that caused it.
: >"$WORK/repos.tsv"
page=1
while :; do
  url="${API}/registry/repositories?per_page=${PER_PAGE}&page=${page}"
  code="$(http_get "$url" "$WORK/repos.json" "$WORK/repos.hdr")"
  [ "$code" = "200" ] ||
    fatal "GET registry/repositories page ${page} returned HTTP ${code}"
  jq -r '.[] | [(.id|tostring), (.path // ""), (.location // "")] | @tsv' \
    "$WORK/repos.json" >>"$WORK/repos.tsv" ||
    fatal "could not parse the registry repositories response"
  next="$(header_value "$WORK/repos.hdr" X-Next-Page)"
  [ -n "$next" ] || break
  page=$((page + 1))
  [ "$page" -le "$MAX_PAGES" ] ||
    fatal "registry repository listing did not terminate in ${MAX_PAGES} pages"
done

want_path="$(lc "$CI_PROJECT_PATH")"
repo_matches="$(awk -F'\t' -v w="$want_path" 'tolower($2) == w' \
  "$WORK/repos.tsv" | wc -l | tr -d ' ')"
[ "$repo_matches" = "1" ] || fatal \
  "expected exactly one registry repository whose path is '${want_path}', found ${repo_matches}"
REPO_ID="$(awk -F'\t' -v w="$want_path" 'tolower($2) == w { print $1 }' "$WORK/repos.tsv")"
REPO_LOCATION="$(awk -F'\t' -v w="$want_path" 'tolower($2) == w { print $3 }' "$WORK/repos.tsv")"
log "prune-registry: repository=${REPO_LOCATION} id=${REPO_ID}"

# ── 2. What is production running? Read it; never assume ─────────────────────
# The single most important step in this script. If it cannot be answered, the
# job deletes nothing and exits non-zero so the schedule surfaces it.
if kubectl get deployment "$DEPLOYMENT" -n "$NAMESPACE" \
  -o "jsonpath={.spec.template.spec.containers[?(@.name==\"${CONTAINER}\")].image}" \
  >"$WORK/prod.img" 2>"$WORK/prod.err"; then
  prod_image="$(tr -d '[:space:]' <"$WORK/prod.img")"
else
  sed 's/^/  kubectl: /' "$WORK/prod.err" >&2 || true
  fatal "could not read deployment/${DEPLOYMENT} in namespace ${NAMESPACE}"
fi
[ -n "$prod_image" ] ||
  fatal "deployment/${DEPLOYMENT} in namespace ${NAMESPACE} reported an empty image for container '${CONTAINER}'"

case "$prod_image" in
*@*) fatal "production's image ${prod_image} is digest-pinned, so no tag can be confirmed" ;;
*:*) ;;
*) fatal "production's image ${prod_image} carries no tag, so nothing can be confirmed" ;;
esac
prod_repo="${prod_image%:*}"
prod_tag="${prod_image##*:}"
[ "$(lc "$prod_repo")" = "$(lc "$REPO_LOCATION")" ] || fatal \
  "production pulls from ${prod_repo} but this job prunes ${REPO_LOCATION} — the 'keep production's tag' guard would protect nothing"
case "$prod_tag" in
'' | *[!A-Za-z0-9._-]*) fatal "production's tag '${prod_tag}' is not a valid tag name" ;;
esac
log "prune-registry: production tag=${prod_tag} (deployment/${DEPLOYMENT} in ${NAMESPACE})"

# Additionally keep whatever the RUNNING pods pull, which can differ from the
# Deployment's spec mid-rollout or after a failed one. Best-effort by design:
# the Deployment read above is the hard requirement, this is extra cover.
KEEP_EXTRA="$WORK/keep-extra.tsv"
: >"$KEEP_EXTRA"
if kubectl get pods -n "$NAMESPACE" -l "$POD_SELECTOR" \
  -o "jsonpath={.items[*].spec.containers[?(@.name==\"${CONTAINER}\")].image}" \
  >"$WORK/pods.img" 2>"$WORK/pods.err"; then
  # Word-splitting is intended: kubectl's jsonpath output is space-separated.
  # shellcheck disable=SC2013
  for image in $(cat "$WORK/pods.img"); do
    # Skip anything digest-pinned or carrying no tag: neither names a tag we
    # could protect, and neither is something this job would delete.
    case "$image" in
    *@*) continue ;;
    esac
    case "$image" in
    *:*) ;;
    *) continue ;;
    esac
    pod_repo="${image%:*}"
    pod_tag="${image##*:}"
    [ "$(lc "$pod_repo")" = "$(lc "$REPO_LOCATION")" ] || continue
    case "$pod_tag" in
    '' | *[!A-Za-z0-9._-]*) continue ;;
    esac
    printf '%s\trunning-pod\n' "$pod_tag" >>"$KEEP_EXTRA"
  done
  log "prune-registry: running-pod tags=$(cut -f1 "$KEEP_EXTRA" | sort -u | tr '\n' ' ')"
else
  warn "could not list pods in ${NAMESPACE} (-l ${POD_SELECTOR}) — continuing with the Deployment's tag only"
fi

# ── 3. List every tag — alphabetically, so page to exhaustion ────────────────
: >"$WORK/tags.txt"
page=1
total=""
pages_seen=0
while :; do
  url="${API}/registry/repositories/${REPO_ID}/tags?per_page=${PER_PAGE}&page=${page}"
  code="$(http_get "$url" "$WORK/tags.json" "$WORK/tags.hdr")"
  [ "$code" = "200" ] || fatal "GET registry tags page ${page} returned HTTP ${code}"
  jq -r '.[].name' "$WORK/tags.json" >>"$WORK/tags.txt" ||
    fatal "could not parse the registry tags response (page ${page})"
  pages_seen=$((pages_seen + 1))
  if [ "$page" -eq 1 ]; then
    total="$(header_value "$WORK/tags.hdr" X-Total)"
  fi
  next="$(header_value "$WORK/tags.hdr" X-Next-Page)"
  [ -n "$next" ] || break
  page=$((page + 1))
  [ "$page" -le "$MAX_PAGES" ] ||
    fatal "tag listing did not terminate in ${MAX_PAGES} pages"
done
collected="$(wc -l <"$WORK/tags.txt" | tr -d ' ')"

[ -n "$total" ] || fatal \
  "the tags API returned no X-Total header, so the listing cannot be verified complete"
case "$total" in
'' | *[!0-9]*) fatal "the X-Total header is not a number ('${total}')" ;;
esac
[ "$collected" -ge "$total" ] || fatal \
  "tag listing is incomplete: collected ${collected} of X-Total ${total} in ${pages_seen} page(s). Tags come back ALPHABETICALLY, so a truncated listing hides every ${PREFIX}* tag rather than erroring"
[ "$collected" -le "$total" ] ||
  warn "collected ${collected} tags but X-Total says ${total} — the registry changed mid-listing"

# Cross-check that we are pruning the listing production actually pulls from.
# If production's tag is missing here, either the image it pins is already gone
# (a broken rollback, worth shouting about) or this listing is not the right one.
if ! grep -qxF "$prod_tag" "$WORK/tags.txt"; then
  fatal "production's tag ${prod_tag} is not in ${REPO_LOCATION}'s tag listing (${collected} tags) — refusing to prune a listing that does not contain the running image"
fi

sort -u "$WORK/tags.txt" | awk -v p="$PREFIX" 'index($0, p) == 1' \
  >"$WORK/candidates.txt" || true
cand_count="$(wc -l <"$WORK/candidates.txt" | tr -d ' ')"
log "prune-registry: tags=${collected} (X-Total=${total}, pages=${pages_seen}) ${PREFIX}* candidates=${cand_count}"

if [ "$cand_count" -eq 0 ]; then
  log "SUMMARY candidates=0 keep=0 delete=0 dry_run=${DRY_RUN}"
  log "prune-registry: no ${PREFIX}* tags — nothing to do."
  exit 0
fi

# ── 4. Rank the candidates by main's git history ─────────────────────────────
if [ "$(git rev-parse --is-shallow-repository 2>/dev/null || echo unknown)" = "true" ]; then
  fatal "this clone is SHALLOW, so most main-* tags would look unmatched. Set GIT_DEPTH: 0 on the prune_registry job (see .gitlab-ci.yml)"
fi

resolved_ref=""
for candidate in "$GIT_REF" "refs/remotes/${GIT_REF}" main; do
  if git rev-parse --verify --quiet "${candidate}^{commit}" >/dev/null 2>&1; then
    resolved_ref="$candidate"
    break
  fi
done
if [ -z "$resolved_ref" ]; then
  git for-each-ref --format='  ref: %(refname)' | head -n 50 >&2 || true
  fatal "could not resolve main's history (tried ${GIT_REF}, refs/remotes/${GIT_REF}, main)"
fi
git log "$resolved_ref" --format=%H >"$WORK/commits.txt" ||
  fatal "git log ${resolved_ref} failed"
commit_count="$(wc -l <"$WORK/commits.txt" | tr -d ' ')"
[ "$commit_count" -gt 0 ] || fatal "git log ${resolved_ref} produced no commits"

# Match each tag's SHA part against a FULL 40-character commit SHA by prefix, at
# whatever length the tag itself carries. That is what makes the 7-vs-8 trap
# impossible to reintroduce: nothing here abbreviates anything. `first[]` keeps
# the newest index for each prefix, so ties resolve toward "newer" (= kept).
#   ranked      → SHA-shaped and present in the history (index = 0 is newest)
#   unmatched   → SHA-shaped but in no commit; counts against the match rate
#   unrankable  → not SHA-shaped at all (`main-latest`, a bare `main-`)
awk -v prefix="$PREFIX" '
  NR == FNR {
    if ($0 == "") next
    n++
    tags[n] = $0
    suffix = substr($0, length(prefix) + 1)
    sufs[n] = suffix
    if (suffix ~ /^[0-9a-f]+$/ && length(suffix) >= 7 && length(suffix) <= 40) {
      shaped[n] = 1
      lens[length(suffix)] = 1
    }
    next
  }
  {
    idx = FNR - 1
    for (l in lens) {
      p = substr($0, 1, l + 0)
      if (!(p in first)) first[p] = idx
    }
  }
  END {
    for (i = 1; i <= n; i++) {
      if (!shaped[i]) { print tags[i] "\tunrankable\t-1"; continue }
      if (sufs[i] in first) print tags[i] "\tranked\t" first[sufs[i]]
      else print tags[i] "\tunmatched\t-1"
    }
  }
' "$WORK/candidates.txt" "$WORK/commits.txt" >"$WORK/classified.tsv"

shaped_count="$(awk -F'\t' '$2 != "unrankable"' "$WORK/classified.tsv" | wc -l | tr -d ' ')"
ranked_count="$(awk -F'\t' '$2 == "ranked"' "$WORK/classified.tsv" | wc -l | tr -d ' ')"

if [ "$shaped_count" -eq 0 ]; then
  log "SUMMARY candidates=${cand_count} keep=${cand_count} delete=0 dry_run=${DRY_RUN}"
  log "prune-registry: no SHA-shaped ${PREFIX}* tags to rank — nothing to do."
  exit 0
fi

match_pct=$((ranked_count * 100 / shaped_count))
log "prune-registry: history ref=${resolved_ref} commits=${commit_count} matched=${ranked_count}/${shaped_count} (${match_pct}%)"

# THE assertion. A near-total mismatch is a broken comparison, not stale tags.
[ "$match_pct" -ge "$MIN_MATCH_PCT" ] || fatal \
  "only ${ranked_count}/${shaped_count} (${match_pct}%) of ${PREFIX}* tags match a commit on ${resolved_ref}, below PRUNE_MIN_MATCH_PCT=${MIN_MATCH_PCT}. A near-total mismatch means the SHA FORMAT is wrong, not that the tags are stale: 'git log --format=%h' abbreviates to 7 characters while these tags carry \$CI_COMMIT_SHORT_SHA (8)"

# ── 5. Keep / delete ─────────────────────────────────────────────────────────
awk -F'\t' '$2 == "ranked" { print $3 "\t" $1 }' "$WORK/classified.tsv" |
  sort -n -k1,1 | cut -f2 >"$WORK/ranked.txt"
head -n "$KEEP_N" "$WORK/ranked.txt" >"$WORK/keep-newest.txt"
tail -n "+$((KEEP_N + 1))" "$WORK/ranked.txt" >"$WORK/beyond.txt"

# Reasons are listed in priority order; the dedupe below keeps the first.
{
  printf '%s\tproduction\n' "$prod_tag"
  cat "$KEEP_EXTRA"
  awk '{ print $0 "\tnewest-N" }' "$WORK/keep-newest.txt"
  awk -F'\t' '$2 != "ranked" { print $1 "\tunranked" }' "$WORK/classified.tsv"
} | awk -F'\t' '!seen[$1]++' >"$WORK/keep.tsv"

awk -F'\t' 'NR == FNR { keep[$1] = 1; next } !($0 in keep)' \
  "$WORK/keep.tsv" "$WORK/beyond.txt" >"$WORK/delete.txt"

# TEST-ONLY fault injection, deliberately placed BETWEEN the filtering and the
# guards below: it is the only way to prove the belt-and-braces guard is live
# rather than decorative (see src/lib/registry-prune.test.ts). It can only ever
# ADD production's tag to the delete list, which the next guard turns into an
# abort — so setting it in production disables the job, it cannot destroy
# anything.
if [ "${PRUNE_TEST_INJECT_PROD_TAG:-}" = "1" ]; then
  warn "PRUNE_TEST_INJECT_PROD_TAG=1 — injecting production's tag into the delete list to exercise the guard"
  printf '%s\n' "$prod_tag" >>"$WORK/delete.txt"
fi

keep_count="$(wc -l <"$WORK/keep.tsv" | tr -d ' ')"
delete_count="$(wc -l <"$WORK/delete.txt" | tr -d ' ')"

# ── 6. Guards — all of them run before the first DELETE is issued ────────────

# (a) Every entry is a well-formed tag carrying the prefix. Without this an
#     empty line would become a request against `…/tags/`, which is a different
#     endpoint entirely.
while IFS= read -r tag; do
  [ -n "$tag" ] || fatal "the delete list contains an empty tag name"
  case "$tag" in
  *[!A-Za-z0-9._-]*) fatal "the delete list contains an invalid tag name '${tag}'" ;;
  esac
  case "$tag" in
  "$PREFIX"?*) ;;
  *) fatal "the delete list contains '${tag}', which is not a ${PREFIX}* tag" ;;
  esac
done <"$WORK/delete.txt"

# (b) Belt and braces: production's tag is absent. Deliberately an independent
#     re-check of the finished list, not a re-run of the filtering logic, so a
#     bug up there cannot bypass this.
if grep -qxF "$prod_tag" "$WORK/delete.txt"; then
  fatal "production's tag ${prod_tag} is in the delete list — the filtering is wrong"
fi

# (c) …and so is every tag a running pod is using.
for pod_tag in $(cut -f1 "$KEEP_EXTRA" | sort -u); do
  if grep -qxF "$pod_tag" "$WORK/delete.txt"; then
    fatal "running-pod tag ${pod_tag} is in the delete list — the filtering is wrong"
  fi
done

# (d) Blast-radius ceiling for a single run.
[ "$delete_count" -le "$MAX_DELETE" ] || fatal \
  "the plan would delete ${delete_count} tags, above PRUNE_MAX_DELETE=${MAX_DELETE}. Raise it deliberately after reading the plan"

# (e) …and we are not about to empty the set.
min_keep="$KEEP_N"
if [ "$ranked_count" -lt "$KEEP_N" ]; then
  min_keep="$ranked_count"
fi
[ "$keep_count" -ge "$min_keep" ] || fatal \
  "the plan keeps only ${keep_count} tags, fewer than the ${min_keep} it must"

# ── 7. Report the plan ───────────────────────────────────────────────────────
while IFS=$'\t' read -r tag reason; do
  printf 'PLAN KEEP %s %s\n' "$tag" "$reason"
done <"$WORK/keep.tsv"
while IFS= read -r tag; do
  printf 'PLAN DELETE %s\n' "$tag"
done <"$WORK/delete.txt"
log "SUMMARY candidates=${cand_count} keep=${keep_count} delete=${delete_count} dry_run=${DRY_RUN}"

# Only the exact string `false` deletes anything: a typo'd, empty or unset value
# stays a dry run.
if [ "$DRY_RUN" != "false" ]; then
  log "DRY-RUN (PRUNE_DRY_RUN=${DRY_RUN}): nothing was deleted. Read the plan above, then set PRUNE_DRY_RUN=false to act on it."
  exit 0
fi

# ── 8. Delete ────────────────────────────────────────────────────────────────
deleted=0
failed=0
while IFS= read -r tag; do
  code="$(http_delete "${API}/registry/repositories/${REPO_ID}/tags/${tag}")"
  case "$code" in
  200 | 202 | 204)
    deleted=$((deleted + 1))
    log "DELETED ${tag} ${code}"
    ;;
  404)
    log "ALREADY-GONE ${tag} 404"
    ;;
  401 | 403)
    log "DELETE-FAILED ${tag} ${code}"
    fatal_mid_delete "the API token is not permitted to delete registry tags (HTTP ${code} on ${tag}). That endpoint needs Maintainer + api scope; CI_JOB_TOKEN may not qualify — supplying REGISTRY_PRUNE_TOKEN is an owner decision. Stopped after ${deleted} deletion(s)"
    ;;
  *)
    failed=$((failed + 1))
    log "DELETE-FAILED ${tag} ${code}"
    ;;
  esac
done <"$WORK/delete.txt"

log "APPLIED deleted=${deleted} already-gone=$((delete_count - deleted - failed)) failed=${failed}"
if [ "$failed" -gt 0 ]; then
  printf 'FATAL: %s tag deletion(s) failed — see DELETE-FAILED above.\n' "$failed" >&2
  exit 4
fi
