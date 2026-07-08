# Handoff

## State
- Phase 1 (voice foundation) SHIPPED — MR !24 merged to main (30e037b); Duo-approved.
- Phase 2 plan written + committed on branch `feat/inbox-ia-freshness` (docs/superpowers/plans/2026-07-08-inbox-ia-freshness.md, 11 TDD tasks: Inbox IA + 4-tier freshness + 24h prompt + capture/delete UX + ☰ menu). NOT executed yet.
- Subgroup move DONE: both projects now under `gl-demo-ultimate-dtop/domi-oss` (public); policy project linked. dlectroflow id 84020916, policy id 84119955 (IDs stable).
- MR !25 (dlectroflow, DRAFT): move-prep path fixes (values.yaml image.repo, .gitlab-ci.yml AGENT_CONTEXT, agent config, docs) → now safe to un-draft + merge post-transfer.
- MR !2 (policy project): fixed invalid policy YAML — `newly_detected` (removed GL 17.0) → `new_needs_triage`+`new_dismissed`. NOT merged.
- Secrets-in-history scan: CLEAN (gitleaks: 4 hits, all the test fixture "test-secret-…-xxxxx"; no rotation needed).

## Next
1. Merge MR !2 (policy fix) — blocks security-policy enforcement while invalid. Duo review was BROKEN today.
2. Un-draft + merge MR !25 (path fixes) → CI rebuilds/redeploys on new registry path.
3. Repoint local git remote to …/domi-oss/dlectroflow; then execute Phase 2 plan (subagent-driven, TDD).

## Context
- Duo review is currently broken (user's words) — don't block merges waiting on it today.
- Before making the APP project public: turn OFF "Public pipelines" + verify all CI secrets Masked+Protected. History is clean so no secret rotation required.
- Merges need explicit owner OK. Update work-item DESCRIPTIONS via JSON PUT + Content-Type header (glab api --input, not -f). .superpowers/ is gitignored; docs/superpowers/ is tracked.
