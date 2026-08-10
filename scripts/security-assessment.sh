#!/usr/bin/env bash
# scripts/security-assessment.sh — monthly security-assessment kickoff (#134).
#
# Requires bash (not POSIX sh): `set -o pipefail` below is a bash/ksh extension
# and is load-bearing — without it a failed `curl` pipes an empty body into `jq`,
# which exits 0, and the job would file a confident "0 findings" all-clear. The
# CI job installs bash and invokes `bash scripts/security-assessment.sh`.
#
# ── Why this job exists ──────────────────────────────────────────────────────
# `docs/quality-audit-prompts.md ## Cadence` has said "monthly: Duo
# security-assessment.md full run" since the cadence was written, and lists
# scheduled pipelines under "Automation gaps". Nothing ran it, and the
# Vulnerability Report grew to 70 findings with 8 HIGH that nobody had read: the
# Scan Result Policy gates on *new* Critical/High, so the standing baseline is
# never "new" and is invisible by construction.
#
# So the digest below leads with the number the Vulnerability Report's default
# view does NOT show: how many active findings are **still detected on `main`**.
# All 8 of the HIGH findings in #134 turned out to be `resolvedOnDefaultBranch`
# — already fixed by Renovate, still sitting in the report. A digest that
# printed "8 HIGH" and stopped would reproduce exactly that confusion.
#
# The assessment itself is a human/agent run of `.gitlab/duo/prompts/…`; this
# job files the dated work item that prompt requires, pre-filled with the data
# the run needs, so the cadence has a mechanism instead of a memory.
#
# Requires (job env):
#   CI_API_V4_URL, CI_PROJECT_ID, CI_PROJECT_PATH, CI_PIPELINE_ID — from GitLab CI
#   GL_TOKEN — token with `api` scope (the same one ops_digest uses). Unset =
#              "not configured yet": preview to the log, post nothing, exit 0.
#
# Deliberately files the issue with NO milestone. It is a recurring cadence item
# rather than release scope, and the person triaging it is the one who knows
# which milestone the follow-up work belongs in.
set -euo pipefail

API="${CI_API_V4_URL}/projects/${CI_PROJECT_ID}"
# GraphQL is a sibling of /api/v4, and it is the only surface that exposes
# `resolvedOnDefaultBranch` — the whole point of this digest.
GRAPHQL="${CI_API_V4_URL%/api/v4}/api/graphql"
AUTH="PRIVATE-TOKEN: ${GL_TOKEN:-}"
DATE="$(date -u +%Y-%m-%d)"
MONTH="${DATE%-*}"
PROMPT=".gitlab/duo/prompts/security-assessment.md"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
NODES="$WORK/nodes.ndjson"
: > "$NODES"

# ── 1. Every active finding, paginated ───────────────────────────────────────
# DETECTED + CONFIRMED only — dismissed and resolved ones are answered
# questions, and including them is how a report becomes unreadable.
# shellcheck disable=SC2016  # `$p` and `$after` are GRAPHQL variables — they
# must reach the server unexpanded, so single quotes are the correct quoting.
QUERY='query($p: ID!, $after: String) {
  project(fullPath: $p) {
    vulnerabilities(state: [DETECTED, CONFIRMED], first: 100, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes { title severity reportType resolvedOnDefaultBranch }
    }
  }
}'

after=""
page=0
while :; do
  page=$((page + 1))
  # 50 pages = 5,000 findings. A cursor that stops advancing would otherwise
  # loop forever inside a scheduled job nobody is watching.
  if [ "$page" -gt 50 ]; then
    echo "security-assessment: vulnerability query failed — refusing to page past 50 requests" >&2
    exit 1
  fi

  jq -n --arg q "$QUERY" --arg p "$CI_PROJECT_PATH" --arg a "$after" \
    '{query: $q, variables: {p: $p, after: (if $a == "" then null else $a end)}}' \
    > "$WORK/query.json"

  resp="$WORK/resp-${page}.json"
  if ! curl -sS -X POST -H "$AUTH" -H "Content-Type: application/json" \
    --max-time 60 -d "@$WORK/query.json" "$GRAPHQL" > "$resp"; then
    echo "security-assessment: vulnerability query failed — transport error" >&2
    exit 1
  fi

  # A GraphQL error arrives as HTTP 200 with an `errors` array, so status alone
  # proves nothing. Naming the error matters: `insufficient scope` means the
  # token is wrong, not that the project is clean.
  if jq -e 'has("errors")' "$resp" > /dev/null 2>&1; then
    echo "security-assessment: vulnerability query failed — $(jq -c '.errors' "$resp")" >&2
    exit 1
  fi
  if ! jq -e '.data.project.vulnerabilities' "$resp" > /dev/null 2>&1; then
    echo "security-assessment: vulnerability query failed — no vulnerabilities in response (token scope, or Ultimate not enabled?)" >&2
    exit 1
  fi

  jq -c '.data.project.vulnerabilities.nodes[]' "$resp" >> "$NODES"

  [ "$(jq -r '.data.project.vulnerabilities.pageInfo.hasNextPage' "$resp")" = "true" ] || break
  after="$(jq -r '.data.project.vulnerabilities.pageInfo.endCursor' "$resp")"
done

# ── 2. The numbers ───────────────────────────────────────────────────────────
# `resolvedOnDefaultBranch != true` rather than `== false`: a null (an older
# finding, or a scanner that does not report it) counts as still live. Failing
# towards "someone should look at this" is the correct direction.
# Every `count '...'` program below is single-quoted for the same reason
# (shellcheck SC2016): `$order`, `$all`, `$s` and `$g` are JQ variables, and
# letting the shell expand them would silently blank the whole aggregation.
count() { jq -s -r "$1" "$NODES"; }

TOTAL="$(count 'length')"
STILL="$(count '[.[] | select(.resolvedOnDefaultBranch != true)] | length')"
GONE=$((TOTAL - STILL))
CH_STILL="$(count '[.[] | select((.severity == "CRITICAL" or .severity == "HIGH") and .resolvedOnDefaultBranch != true)] | length')"

# shellcheck disable=SC2016  # jq variables, not shell — see count() above.
SEV_TABLE="$(count '
  ["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO", "UNKNOWN"] as $order
  | . as $all
  | [ $order[]
      | . as $s
      | ($all | map(select(.severity == $s))) as $g
      | select(($g | length) > 0)
      | "| \($s) | \($g | length) | \($g | map(select(.resolvedOnDefaultBranch != true)) | length) |"
    ]
  | if length == 0 then "| _none_ | 0 | 0 |" else join("\n") end')"

# Every Critical and High by name. A count cannot be triaged — #134 exists
# because eight findings were a number rather than a list.
# shellcheck disable=SC2016  # jq variables, not shell — see count() above.
CH_TABLE="$(count '
  [ .[] | select(.severity == "CRITICAL" or .severity == "HIGH") ]
  | if length == 0 then "| _none_ | | | |"
    else
      map("| \(.severity) | \(.reportType) | \(.title) | "
          + (if .resolvedOnDefaultBranch == true
             then "no longer detected"
             else "**still detected**" end)
          + " |")
      | join("\n")
    end')"

# shellcheck disable=SC2016  # jq variables, not shell — see count() above.
BY_SCANNER="$(count '
  [ .[] | select(.resolvedOnDefaultBranch != true) ]
  | group_by(.reportType)
  | if length == 0 then "| _none_ | 0 |"
    else map("| \(.[0].reportType) | \(length) |") | join("\n") end')"

TITLE="Security Assessment — ${DATE}: ${STILL} active on main, ${CH_STILL} critical/high"

# ── 2b. How old are those numbers? (#166) ────────────────────────────────────
# This job files a PERMANENT artefact stating a count. #152 — Security
# Assessment — 2026-08-01 recorded `0` active findings and `0` Critical/High;
# the same surface read 12 active and 3 HIGH three days later. The snapshot was
# true when it was written and carried nothing that said when it stopped being
# true, so the next reader had no way to know it had expired.
#
# Freshness is CONTEXT on the numbers above, not a second gate: the assessment
# query has already exited non-zero if it could not read the report, and an
# unknown belongs in the issue where a human will see it rather than in a red
# maintenance pipeline nobody is watching. Hence `set +e` and no status check —
# the block carries its own ⚠️ when it cannot establish the age.
HERE="$(cd "$(dirname "$0")" && pwd)"
set +e
FRESHNESS_BLOCK="$(bash "${HERE}/check-vuln-freshness.sh")"
set -e

# Heredoc into a file, then read it back — NOT `$(cat <<EOF …)`. bash 3.2 (the
# system bash on macOS, where `npm test` runs this script) mis-parses a heredoc
# inside a command substitution and dies with "unexpected EOF"; alpine's bash 5
# does not, so the naive form is green in CI and broken on every contributor's
# laptop.
cat > "$WORK/body.md" <<EOF
> Filed automatically by the \`security_assessment\` CI job (pipeline ${CI_PIPELINE_ID}) on the **Monthly security assessment** schedule. Cadence: \`docs/quality-audit-prompts.md ## Cadence\` + \`docs/SECURITY.md\`. Opened by #134.

## Snapshot

> **How old are these numbers?** (#166) — a snapshot with no expiry reads as
> current forever. #152 recorded \`0\` active and \`0\` Critical/High; the same
> surface read 12 and 3 three days later.
${FRESHNESS_BLOCK}

Active findings (\`DETECTED\` + \`CONFIRMED\`): **${TOTAL}**

- Still detected on \`main\`: **${STILL}**
- No longer detected on \`main\`: **${GONE}** — already fixed in the tree, still sitting in the report. These are safe to resolve; they are counted separately because the Vulnerability Report's default view does not distinguish them, which is how the #134 baseline grew unread.

| Severity | Active | Still detected on \`main\` |
|---|---|---|
${SEV_TABLE}

| Scanner (still detected) | Count |
|---|---|
${BY_SCANNER}

## Every Critical and High

| Severity | Scanner | Finding | On \`main\` |
|---|---|---|---|
${CH_TABLE}

## The assessment

Run the full prompt — this issue is the record it requires, not a substitute for it:

\`\`\`
Run the security assessment prompt from ${PROMPT}
\`\`\`

- [ ] 1. Vulnerability report analysis — triage every finding above; fix the real ones, dismiss false positives **with written evidence** and a reason
- [ ] 2. Risk prioritisation — CVSS, EPSS, KEV, reachability
- [ ] 3. Secrets and credential hygiene
- [ ] 4. Principle of least privilege
- [ ] 5. Supply chain and dependency security
- [ ] 6. Container and runtime security
- [ ] 7. Frontend security (CSP, headers, token storage)
- [ ] 8. Authentication and session security
- [ ] 9. GitLab platform security configuration
- [ ] 10. Compliance posture
- [ ] 11. Open-source licence review
- [ ] 12. Scanner coverage
- [ ] 13. Incident-response readiness
- [ ] 14. Security-program cadence
- [ ] Resolve the "no longer detected" findings, or say why they are being kept
- [ ] Record accepted risks in the security debt register

_No milestone on purpose: this is a recurring cadence item, and whoever triages it picks the milestone for the follow-up work._
EOF
BODY="$(cat "$WORK/body.md")"

# ── 3. Post, or preview ──────────────────────────────────────────────────────
if [ -z "${GL_TOKEN:-}" ]; then
  echo "GL_TOKEN unset — not posting. Preview:"
  printf '%s\n\n%s\n' "$TITLE" "$BODY"
  exit 0
fi

# One issue per month. A schedule that double-files after a manual re-run trains
# people to ignore it, so a re-run appends a note to the month's issue instead.
EXISTING="$(curl -sS -H "$AUTH" --max-time 30 \
  "${API}/issues?labels=security-assessment&state=opened&per_page=100" \
  | jq -r --arg m "Security Assessment — ${MONTH}" \
      'map(select(.title | startswith($m))) | .[0].iid // empty')"

if [ -n "$EXISTING" ]; then
  jq -n --arg b "### ${TITLE}

Re-run of the monthly assessment kickoff; the month's issue already exists, so this is a note rather than a duplicate.

${BODY}" '{body: $b}' > "$WORK/note.json"
  curl -sS -f -X POST -H "$AUTH" -H "Content-Type: application/json" \
    --max-time 30 -d "@$WORK/note.json" "${API}/issues/${EXISTING}/notes" > /dev/null
  echo "Assessment issue for ${MONTH} already open as #${EXISTING} — appended a note."
  exit 0
fi

# JSON body, never form-encoded: the description carries `- [ ]` checkboxes, and
# URL-encoding them is how these POSTs come back 400/415.
jq -n --arg t "$TITLE" --arg d "$BODY" \
  '{title: $t, description: $d, labels: "security,security-assessment"}' \
  > "$WORK/issue.json"
created="$(curl -sS -f -X POST -H "$AUTH" -H "Content-Type: application/json" \
  --max-time 30 -d "@$WORK/issue.json" "${API}/issues")"
echo "Filed ${TITLE} — $(printf '%s' "$created" | jq -r '.web_url // "(no url)"')"
