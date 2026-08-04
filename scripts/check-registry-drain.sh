#!/usr/bin/env bash
# scripts/check-registry-drain.sh — is the container-registry cleanup policy
# actually draining? (#113)
#
# Requires bash (not POSIX sh): `set -o pipefail` below is a bash/ksh extension.
# Callers install bash and invoke `bash scripts/check-registry-drain.sh`.
#
# ── Why this exists ──────────────────────────────────────────────────────────
# #113 was diagnosed three times from three sets of numbers, and each reading
# was confidently wrong in a different way. The registry is not hard to measure;
# it is hard to measure the RIGHT thing, because several independent mechanisms
# move the same counter and the obvious signals mean something other than they
# look like they mean. This script exists so the question is settled by a
# command instead of by an argument, and so the answer carries its own date.
#
# The three traps, all of which produce a plausible answer rather than an error:
#
#   1. THE TAG COUNT IS NOT THE METRIC, IN EITHER DIRECTION. Three mechanisms
#      move it — GitLab's policy, `scripts/prune-registry.sh` (#114, which
#      deletes `main-*`, the very tags `name_regex_keep` protects) and manual
#      passes — plus CI pushing a tag per pipeline. So the total attributes
#      nothing. It was misread BOTH ways within a week: the 1,886 → 412 fall was
#      read as the policy recovering, and then a 364 → 409 rise in bare SHAs was
#      read as the policy failing to reap. Measured 2026-08-04, the rise is
#      simply inflow: CI pushes ~46 bare-SHA tags a day, and a 7-day horizon
#      reaped every ~2–3 days holds ~46 × 9.5 ≈ 436 of them at equilibrium
#      against 409 observed. A correct policy MUST hold roughly that many. So
#      this check partitions on the keep regex and asks about the AGE of the set
#      the policy owns, never its size — age is immune to push rate, immune to
#      #114, and immune to scheduler lag.
#
#   2. `next_run_at` IN THE PAST IS NOT A STALL. It was read as one, and #113
#      told the next reader to verify the fix by watching it advance. Measured
#      on gitlab.com 2026-08-04: the last completed run started
#      2026-08-02T04:02:54Z and set `next_run_at` to exactly +24h, which was
#      still ~20 hours in the past when read — while the tags themselves proved
#      the run had drained to its horizon. gitlab.com dispatches these policies
#      from a shared limited-capacity worker pool, so the cadence is an
#      earliest-start, not a schedule. A check that fails on lag alone fails
#      permanently, and an alert that always fires says nothing. Reported here,
#      never fatal.
#
#   3. A SHORT WALK OF THE TAGS API REPORTS A HEALTHY REGISTRY. GitLab's
#      `containerRepository.tags` connection caps a page at 20 but computes
#      `hasNextPage` against the number you ASKED for. Measured 2026-08-04:
#      `first: 100` returns 20 nodes per page and then stops after 5 pages with
#      99 of 421 tags and a confident `hasNextPage: false`. Tags arrive in name
#      order and bare-SHA tags are effectively random, so the truncated sample
#      looks exactly like a healthy one. Hence `first: 20`, and hence the
#      collected count is cross-checked against `tagsCount` — an incomplete walk
#      is reported as UNDETERMINED, never as a pass.
#
# ── What it actually asks ────────────────────────────────────────────────────
# Two independent questions, because either alone can be satisfied by accident:
#
#   * What does GitLab say? `expirationPolicyCleanupStatus` is documented in
#     GitLab's own schema as UNSCHEDULED / SCHEDULED / UNFINISHED / ONGOING,
#     where UNFINISHED means "Tags cleanup has been partially executed. There
#     are still remaining tags to delete" — i.e. the exact stall #113
#     hypothesised, available as one field that nobody queried for a week.
#
#   * What do the tags say? The oldest tag the policy owns should be no older
#     than `older_than` plus the worst observed gap between runs. That is an
#     outcome check, so it also covers stalls GitLab does not report.
#
# ── Contract ─────────────────────────────────────────────────────────────────
# Prints a Markdown bullet list on stdout (no heading — the caller supplies one)
# and exits:
#   0  draining — the policy owns nothing past its horizon
#   1  not draining — disabled, misconfigured, UNFINISHED, or a stale owned tag
#   2  undetermined — one of the facts could not be established
#
# Exit 2 is a distinct state on purpose, for the same reason
# `check-prod-drift.sh` carries one: "could not read the registry" must never
# collapse into "the registry is fine". An unproven green is the failure this
# issue is made of, and a caller that treats 2 as 0 has reintroduced it.
#
# Read-only by construction: it issues GraphQL queries and no mutations, and
# src/lib/registry-drain.test.ts asserts that against every request made.
#
# Env:
#   CI_API_V4_URL, CI_PROJECT_PATH  — provided by GitLab CI
#   GL_TOKEN                        — optional; falls back to CI_JOB_TOKEN.
#                                     CI_JOB_TOKEN can read the registry API
#                                     (verified 2026-07-29, #114), so the read
#                                     path needs no extra credential.
#   REGISTRY_DRAIN_GRACE_DAYS       — optional; see the derivation below
#   REGISTRY_DRAIN_MAX_PAGES        — optional; walk ceiling, default 400
#   REGISTRY_DRAIN_GRAPHQL_URL      — optional; derived from CI_API_V4_URL
#   REGISTRY_DRAIN_NOW              — test hook; an ISO-8601 instant to treat as
#                                     now, so ages are arithmetic and the suite
#                                     cannot rot into a wall-clock failure
set -euo pipefail

# How far past `older_than` an owned tag may legitimately be. A tag survives
# until the first run that happens more than `older_than` after it was pushed,
# so the worst legitimate age is `older_than` + the longest gap between runs.
# Measured on gitlab.com: a run started 2026-07-29T21:19:52Z (inferred from the
# `next_run_at` it set) and the next completed run started 2026-08-02T04:02:54Z
# — a gap of 3.3 days on a `1d` cadence. Four days is that, rounded up. Raise it
# if gitlab.com gets slower; do not lower it to make a red check green.
GRACE_DAYS="${REGISTRY_DRAIN_GRACE_DAYS:-4}"
MAX_PAGES="${REGISTRY_DRAIN_MAX_PAGES:-400}"

# The connection serves 20 per page whatever you ask for, and derives
# `hasNextPage` from the request. Asking for exactly what it serves is the only
# value for which that computation is correct. See trap 3 above.
PAGE_SIZE=20

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# One exit path for "we could not establish the facts", so that every unknown
# reads the same and none of them can be mistaken for an all-clear.
undetermined() {
  printf -- '- ⚠️ **could not determine whether the registry cleanup policy is draining** — %s\n' "$1"
  printf -- '- This is an unknown, not an all-clear.\n'
  exit 2
}

for tool in curl jq; do
  command -v "$tool" >/dev/null 2>&1 ||
    undetermined "\`$tool\` is not installed on this image"
done

[ -n "${CI_PROJECT_PATH:-}" ] ||
  undetermined "\`CI_PROJECT_PATH\` is unset, so there is no project to query"

# GL_TOKEN when it exists, the job token otherwise. Reading the registry API
# needs no elevated scope — deleting does, which is why the prune job and this
# check are deliberately separate jobs with separate credentials.
if [ -n "${GL_TOKEN:-}" ]; then
  AUTH="PRIVATE-TOKEN: ${GL_TOKEN}"
else
  AUTH="JOB-TOKEN: ${CI_JOB_TOKEN:-}"
fi

API_BASE="${CI_API_V4_URL:-https://gitlab.com/api/v4}"
GRAPHQL_URL="${REGISTRY_DRAIN_GRAPHQL_URL:-${API_BASE%/v4}/graphql}"

NOW_ISO="${REGISTRY_DRAIN_NOW:-}"

# ── GraphQL plumbing ─────────────────────────────────────────────────────────
# Payloads are built with `jq -n --arg`, never string-concatenated, so a project
# path or cursor can never break out of the JSON. `--data-binary @file` keeps
# the query off the process list.
post_graphql() { # payload_file response_file → prints the HTTP status code
  curl -sS --max-time 60 -o "$2" -w '%{http_code}' -X POST \
    -H "$AUTH" -H "Content-Type: application/json" \
    --data-binary @"$1" "$GRAPHQL_URL" </dev/null 2>>"$WORK/curl.err" ||
    printf '000'
}

# `.errors` present means the query was rejected or partially resolved. Either
# way the data is not trustworthy, and jq would happily read `null` out of it
# and call it an answer.
graphql_errors() { # response_file → prints a joined error string, or nothing
  jq -r 'if (.errors // empty) then
           ([.errors[]?.message] | join("; "))
         else empty end' "$1" 2>/dev/null || true
}

# ── 1. The policy and the repositories ───────────────────────────────────────
POLICY_QUERY='query($path: ID!) {
  project(fullPath: $path) {
    containerExpirationPolicy {
      enabled
      cadence
      keepN
      olderThan
      nameRegex
      nameRegexKeep
      nextRunAt
    }
    containerRepositories {
      nodes {
        id
        path
        status
        tagsCount
        expirationPolicyCleanupStatus
        expirationPolicyStartedAt
      }
    }
  }
}'

jq -n --arg q "$POLICY_QUERY" --arg path "$CI_PROJECT_PATH" \
  '{query: $q, variables: {path: $path}}' >"$WORK/policy-req.json"

code="$(post_graphql "$WORK/policy-req.json" "$WORK/policy.json")"
[ "$code" = "200" ] ||
  undetermined "the GraphQL endpoint answered HTTP ${code}"
errors="$(graphql_errors "$WORK/policy.json")"
[ -z "$errors" ] ||
  undetermined "GraphQL reported an error: ${errors}"

jq -e '.data.project' "$WORK/policy.json" >/dev/null 2>&1 ||
  undetermined "the response carried no project — the token may not see \`${CI_PROJECT_PATH}\`"
jq -e '.data.project.containerExpirationPolicy' "$WORK/policy.json" >/dev/null 2>&1 ||
  undetermined "\`${CI_PROJECT_PATH}\` has no container cleanup policy at all"

# ── 2. Walk every repository's tags ──────────────────────────────────────────
# Every repository, not just the primary one: the Kaniko `…/cache` repository is
# subject to the same policy and has its own way of going wrong.
TAGS_QUERY_TEMPLATE='query($after: String) {
  containerRepository(id: "REPO_GID") {
    tags(first: 20, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes { name createdAt }
    }
  }
}'

repo_count="$(jq -r '(.data.project.containerRepositories.nodes // []) | length' "$WORK/policy.json")"
: >"$WORK/walks.jsonl"

i=0
while [ "$i" -lt "$repo_count" ]; do
  gid="$(jq -r --argjson i "$i" \
    '.data.project.containerRepositories.nodes[$i].id // ""' "$WORK/policy.json")"

  # The id is interpolated into the query text rather than passed as a variable,
  # so it is validated against the exact shape GitLab returns first. Anything
  # else is a bug or a hostile response, not something to send back.
  case "$gid" in
  gid://gitlab/ContainerRepository/[0-9]*) ;;
  *) undetermined "repository ${i} reported an unrecognised id" ;;
  esac
  case "${gid##*/}" in
  '' | *[!0-9]*) undetermined "repository ${i} reported an unrecognised id" ;;
  esac

  query="${TAGS_QUERY_TEMPLATE/REPO_GID/$gid}"
  : >"$WORK/tags-${i}.jsonl"
  cursor=""
  pages=0
  while :; do
    if [ -z "$cursor" ]; then
      jq -n --arg q "$query" '{query: $q, variables: {after: null}}' \
        >"$WORK/tags-req.json"
    else
      jq -n --arg q "$query" --arg after "$cursor" \
        '{query: $q, variables: {after: $after}}' >"$WORK/tags-req.json"
    fi

    code="$(post_graphql "$WORK/tags-req.json" "$WORK/tags-page.json")"
    [ "$code" = "200" ] ||
      undetermined "listing tags answered HTTP ${code} on page $((pages + 1))"
    errors="$(graphql_errors "$WORK/tags-page.json")"
    [ -z "$errors" ] ||
      undetermined "listing tags reported a GraphQL error: ${errors}"
    jq -e '.data.containerRepository.tags' "$WORK/tags-page.json" >/dev/null 2>&1 ||
      undetermined "a tag page carried no \`tags\` connection"

    jq -c '.data.containerRepository.tags.nodes[]?' "$WORK/tags-page.json" \
      >>"$WORK/tags-${i}.jsonl"
    pages=$((pages + 1))

    has_next="$(jq -r '.data.containerRepository.tags.pageInfo.hasNextPage' "$WORK/tags-page.json")"
    [ "$has_next" = "true" ] || break
    cursor="$(jq -r '.data.containerRepository.tags.pageInfo.endCursor // ""' "$WORK/tags-page.json")"
    [ -n "$cursor" ] ||
      undetermined "the tag connection said there was another page but returned no cursor"
    [ "$pages" -lt "$MAX_PAGES" ] ||
      undetermined "the tag walk did not terminate within ${MAX_PAGES} pages"
  done

  jq -c -n --argjson i "$i" --slurpfile tags "$WORK/tags-${i}.jsonl" \
    --slurpfile policy "$WORK/policy.json" \
    '$policy[0].data.project.containerRepositories.nodes[$i]
     | {path, tagsCount, status,
        cleanupStatus: .expirationPolicyCleanupStatus,
        startedAt: .expirationPolicyStartedAt,
        tags: $tags}' >>"$WORK/walks.jsonl"

  i=$((i + 1))
done

# ── 3. Verdict ───────────────────────────────────────────────────────────────
# All of the reasoning is in jq rather than bash, deliberately: it needs date
# arithmetic, and portable `date` is a trap this repo has already paid for once
# (see the window handling in ops-digest.sh — GNU `-d`, BSD `-v` and busybox all
# disagree, and the failure mode was a confident 1969). jq's
# `fromdateiso8601` is the same everywhere.
jq -r -n \
  --slurpfile policy "$WORK/policy.json" \
  --slurpfile walks "$WORK/walks.jsonl" \
  --arg nowIso "$NOW_ISO" \
  --argjson grace "$GRACE_DAYS" \
  --argjson pageSize "$PAGE_SIZE" '
def parse_ts:
  if . == null or . == "" then null
  else
    (sub("\\.[0-9]+"; "") | sub("\\+00:00$"; "Z"))
    | if test("Z$") then (try fromdateiso8601 catch null) else null end
  end;

# GitLab returns these as enums over GraphQL and as plain values over REST. An
# unrecognised member is answered with "undetermined", never with a guess: the
# whole point of this check is that a wrong number under a confident label is
# worse than no number.
def keep_n:
  {"ONE_TAG":1,"FIVE_TAGS":5,"TEN_TAGS":10,"TWENTY_FIVE_TAGS":25,
   "FIFTY_TAGS":50,"ONE_HUNDRED_TAGS":100}[.] // null;
def older_than_days:
  {"SEVEN_DAYS":7,"FOURTEEN_DAYS":14,"THIRTY_DAYS":30,"SIXTY_DAYS":60,
   "NINETY_DAYS":90}[.] // null;

def days(seconds): ((seconds / 86400) * 10 | round) / 10;
def code(s): "`" + s + "`";

# Anchored at both ends, which is how GitLab applies these patterns
# (`Gitlab::UntrustedRegexp` wraps them in \A…\z). An unanchored match would
# quietly treat every tag merely CONTAINING "v" as a release and keep it.
def owned($tags; $del; $keep):
  [ $tags[]
    | select(($del != "") and (.name | test("\\A(?:" + $del + ")\\z")))
    | select(($keep == "") or ((.name | test("\\A(?:" + $keep + ")\\z")) | not)) ];

($nowIso | if . == "" then now else parse_ts end) as $now
| if $now == null then
    {lines: ["- ⚠️ **could not determine whether the registry cleanup policy is draining** — the supplied instant could not be parsed", "- This is an unknown, not an all-clear."], status: 2}
  else
($policy[0].data.project.containerExpirationPolicy) as $p
| ($p.keepN | keep_n) as $keepN
| ($p.olderThan | older_than_days) as $olderDays
| ($p.nameRegexKeep // "") as $keepRe
| ($p.nameRegex // "") as $deleteRe
| ($p.nextRunAt | parse_ts) as $nextRun

| ( [ $walks[]
      | . as $r
      | (owned($r.tags; $deleteRe; $keepRe)) as $own
      | { path: $r.path,
          collected: ($r.tags | length),
          claimed: ($r.tagsCount // 0),
          complete: (($r.tags | length) >= ($r.tagsCount // 0)),
          status: $r.status,
          cleanupStatus: $r.cleanupStatus,
          startedAt: ($r.startedAt | parse_ts),
          kept: (($r.tags | length) - ($own | length)),
          # Tags whose timestamp could not be read are counted, not silently
          # dropped. Dropping them is the failure this whole issue is made of:
          # an unreadable date would shrink the owned set toward empty and turn
          # a stale registry into a confident ✅. `parse_ts` returns null for
          # anything that is not UTC, so one API change is all it would take.
          unparsed: ($own | map(select((.createdAt | parse_ts) == null)) | length),
          owned: ($own
                  | map(. + {ts: (.createdAt | parse_ts)})
                  | map(select(.ts != null))
                  | sort_by(-.ts)) }
      | . + { beyondKeepN: (.owned[($keepN // 0):]) }
      | . + { oldest: (.beyondKeepN | last) } ] ) as $repos

| ($olderDays + $grace) as $limit

# Everything that can make this red or amber, gathered before anything is
# printed, so the report always states every reason rather than the first one.
| ( [ if ($keepN == null) then "the `keep_n` value \(($p.keepN|tostring)) is not one this check recognises" else empty end,
      if ($olderDays == null) then "the `older_than` value \(($p.olderThan|tostring)) is not one this check recognises" else empty end,
      ( $repos[] | select(.complete | not)
        | "the tag walk for \(.path) collected \(.collected) of \(.claimed) tags, so the tags it did not see are exactly the ones that would have failed it" ),
      ( $repos[] | select(.unparsed > 0)
        | "\(.unparsed) tag(s) in \(.path) carry a creation date this check cannot read, and an unreadable date shrinks the owned set toward empty, which would read as a clean registry" ),
      ( if ($repos | length) == 0 then
          "the project reports no container repositories at all, so there is nothing to assess — that is a different statement from a clean registry"
        else empty end ) ] ) as $unknowns

| ( [ if ($p.enabled | not) then "the cleanup policy is **disabled**, so nothing is ever reaped" else empty end,
      if ($deleteRe == "") then "`name_regex` is empty, so the policy can never select anything to reap" else empty end,
      ( $repos[] | select(.cleanupStatus == "UNFINISHED")
        | "GitLab reports \(.path) as **UNFINISHED** — its own wording is \"Tags cleanup has been partially executed. There are still remaining tags to delete\"" ),
      # A repository stuck mid-removal cannot be reaped by anything, and it is
      # invisible in every count: the tags are still billed and still listed.
      ( $repos[] | select(.status == "DELETE_FAILED")
        | "\(.path) is stuck in `DELETE_FAILED` — its removal did not complete, so nothing will reap it" ),
      ( if ($olderDays == null) then empty else
          $repos[] | select(.oldest != null)
          | select(days($now - .oldest.ts) > $limit)
          | "\(.path) still holds `\(.oldest.name[0:12])…` at **\(days($now - .oldest.ts))d**, past `older_than` \($olderDays)d + \($grace)d grace = \($limit)d"
        end ) ] ) as $failures

| ( [ "- policy: \(if $p.enabled then "enabled" else "**disabled**" end), cadence \(code($p.cadence|tostring)), `keep_n`=\($p.keepN|tostring), `older_than`=\($p.olderThan|tostring)",
      "- `name_regex`=\(code($deleteRe)) · `name_regex_keep`=\(code($keepRe)) — tags matching the latter are kept **forever**, which is why #114 bounds `main-*` in a job instead",
      ( if $nextRun == null then "- next run: _not scheduled_"
        elif $nextRun < $now then "- next run was due \(days($now - $nextRun))d ago (**overdue**) — on gitlab.com the cadence is an earliest-start, not a schedule, so this alone is not a stall and is not counted as one here"
        else "- next run due in \(days($nextRun - $now))d"
        end ),
      # One repository at a time, both of its lines together. Emitted as two
      # separate loops, the sub-bullets all landed after the last parent, which
      # attributes the numbers to the wrong repository.
      ( $repos[]
        | ( "- \(code(.path)): \(.collected) tags walked (`tagsCount` \(.claimed)), cleanup status \(code(.cleanupStatus // "unknown"))\(if .startedAt == null then "" else ", last run \(days($now - .startedAt))d ago" end)\(if .status == null then "" else ", repository status \(code(.status))" end)",
            ( "  - \(.kept) kept by `name_regex_keep`, \(.owned | length) owned by the policy" +
              ( if ($keepN != null) and ((.owned | length) <= $keepN) then
                  " — all of them inside `keep_n` (\($keepN)), which spares the newest \($keepN) of the delete set whatever their age"
                elif .oldest == null then " — none of them carry a readable creation date"
                else " — oldest past `keep_n`: `\(.oldest.name[0:12])…` at \(days($now - .oldest.ts))d"
                end ) ) ) ) ] ) as $facts

| if ($failures | length) > 0 then
    {lines: ($facts + [ $failures[] | "- 🔴 " + . ]
             + ["- 🔴 **the registry cleanup policy is not draining.**"]),
     status: 1}
  elif ($unknowns | length) > 0 then
    {lines: ($facts + [ $unknowns[] | "- ⚠️ " + . ]
             + ["- ⚠️ **could not determine whether the registry cleanup policy is draining.** This is an unknown, not an all-clear."]),
     status: 2}
  else
    {lines: ($facts + ["- ✅ the registry cleanup policy is draining — nothing it owns is past `older_than` + grace"]),
     status: 0}
  end
end
| (.lines[], "VERDICT \(.status)")
' >"$WORK/report.txt"

verdict="$(sed -n 's/^VERDICT //p' "$WORK/report.txt" | tail -n 1)"
sed '/^VERDICT /d' "$WORK/report.txt"

case "$verdict" in
0 | 1 | 2) exit "$verdict" ;;
*)
  printf -- '- ⚠️ **the drain check produced no verdict** — treat as an unknown, not an all-clear.\n'
  exit 2
  ;;
esac
