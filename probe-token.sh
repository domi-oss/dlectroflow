#!/usr/bin/env bash
# TEMPORARY — answers #114's open question empirically, then gets deleted.
#
# "Which credential can delete registry tags? Verify empirically whether
#  CI_JOB_TOKEN suffices in this GitLab version."
#
# Staged so the cheapest, zero-side-effect probe runs first:
#   1. Can the job token READ the registry API at all? (the prune job's read path)
#   2. DELETE a tag name that does not exist. 401/403 answers the question with
#      no side effects whatsoever; only a 404 is ambiguous (authorized, but the
#      tag is missing) and needs step 3.
#   3. Only if step 2 is ambiguous: re-tag an EXISTING manifest under a
#      throwaway name via the registry v2 API, then attempt to delete THAT TAG
#      ONLY. Re-tagging cannot harm the source: deleting a tag removes the tag,
#      and the manifest stays referenced by its original tag.
#
# Never touches production's tag, never deletes anything it did not just create.
set -uo pipefail

API="${CI_API_V4_URL}/projects/${CI_PROJECT_ID}"
JT="JOB-TOKEN: ${CI_JOB_TOKEN}"
REPO="${CI_PROJECT_PATH}"
PROBE="zz-token-probe-${CI_PIPELINE_ID}"
# The oldest main-* tag — the one the prune plan would delete anyway.
SRC="${PROBE_SOURCE_TAG:-main-9ca1858c}"

echo "### 1. Can CI_JOB_TOKEN read the registry API?"
code="$(curl -sS -o /tmp/repos.json -w '%{http_code}' -H "$JT" "${API}/registry/repositories?per_page=100")"
echo "GET  registry/repositories                  -> ${code}"
[ "$code" = "200" ] && head -c 200 /tmp/repos.json && echo
RID="$(jq -r --arg p "$REPO" '.[]? | select(.path == $p) | .id' /tmp/repos.json 2>/dev/null)"
echo "resolved primary repository id: ${RID:-<none>}"
if [ -z "${RID:-}" ]; then
  echo "VERDICT: CI_JOB_TOKEN cannot even LIST registry repositories, so the prune job needs a stored token for reads as well as deletes."
  exit 0
fi
code="$(curl -sS -o /tmp/tags.json -D /tmp/tags.hdr -w '%{http_code}' -H "$JT" "${API}/registry/repositories/${RID}/tags?per_page=100&page=1")"
echo "GET  registry/.../tags                      -> ${code}  $(grep -i '^x-total:' /tmp/tags.hdr | tr -d '\r')"

echo
echo "### 2. DELETE a tag that does not exist (401/403 = not permitted, 404 = ambiguous)"
code="$(curl -sS -o /tmp/d1.json -w '%{http_code}' -X DELETE -H "$JT" \
  "${API}/registry/repositories/${RID}/tags/zz-nonexistent-${CI_PIPELINE_ID}")"
echo "DELETE (nonexistent tag)                    -> ${code}"
cat /tmp/d1.json
echo
if [ "$code" != "404" ]; then
  echo "VERDICT: CI_JOB_TOKEN is NOT permitted to delete registry tags (HTTP ${code}). Nothing was pushed."
  exit 0
fi

echo
echo "### 3. Ambiguous. Push a throwaway tag and delete that tag only."
BT="$(curl -sS -u "gitlab-ci-token:${CI_JOB_TOKEN}" \
  "${CI_SERVER_URL}/jwt/auth?service=container_registry&scope=repository:${REPO}:pull,push" | jq -r '.token // empty')"
if [ -z "$BT" ]; then
  echo "could not obtain a registry bearer token with the job token — stopping."
  exit 0
fi
ACCEPT='application/vnd.docker.distribution.manifest.v2+json,application/vnd.docker.distribution.manifest.list.v2+json,application/vnd.oci.image.manifest.v1+json,application/vnd.oci.image.index.v1+json'
code="$(curl -sS -o /tmp/man.json -D /tmp/man.hdr -w '%{http_code}' \
  -H "Authorization: Bearer ${BT}" -H "Accept: ${ACCEPT}" \
  "https://${CI_REGISTRY}/v2/${REPO}/manifests/${SRC}")"
echo "GET  v2 manifest ${SRC}              -> ${code}"
[ "$code" = "200" ] || {
  echo "could not read a source manifest — stopping."
  exit 0
}
CT="$(grep -i '^content-type:' /tmp/man.hdr | sed 's/^[^:]*: *//' | tr -d '\r')"
code="$(curl -sS -o /tmp/put.json -w '%{http_code}' -X PUT \
  -H "Authorization: Bearer ${BT}" -H "Content-Type: ${CT}" \
  --data-binary @/tmp/man.json \
  "https://${CI_REGISTRY}/v2/${REPO}/manifests/${PROBE}")"
echo "PUT  v2 manifest as ${PROBE}  -> ${code}"
[ "$code" = "201" ] || [ "$code" = "202" ] || {
  echo "could not push the throwaway tag — stopping. Nothing to clean up."
  cat /tmp/put.json
  exit 0
}
code="$(curl -sS -o /tmp/d2.json -w '%{http_code}' -X DELETE -H "$JT" \
  "${API}/registry/repositories/${RID}/tags/${PROBE}")"
echo "DELETE ${PROBE} with CI_JOB_TOKEN -> ${code}"
cat /tmp/d2.json
echo
case "$code" in
200 | 202 | 204) echo "VERDICT: CI_JOB_TOKEN CAN delete registry tags. No stored token needed." ;;
*) echo "VERDICT: CI_JOB_TOKEN is NOT permitted to delete registry tags (HTTP ${code}). The throwaway tag ${PROBE} is still there and must be removed by hand." ;;
esac
