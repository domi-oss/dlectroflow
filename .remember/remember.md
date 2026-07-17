# Handoff

## State
#25 task-row redesign COMPLETE on `feat/task-row-redesign` → **MR !70, un-drafted, awaiting Duo + owner merge** (479/479; final review "Ready to un-draft", 0 correctness findings). Design = owner's v5 revision (visible inline actions + end cluster [📅][🗑][▾], pencil beside title, review rows schedulable) — spec/plan/mockups in `docs/superpowers/`, SDD ledger `.superpowers/sdd/progress.md`. !66 (touch drag + floating-row overlay + source dim) MERGED, #26 CLOSED. #21 P1–P4 done earlier; #22/#24 closed.

## Next
1. !70: owner phone-verify (capture items first on the review app; 📅 is prod-only) + answer 2 cosmetic calls on the MR (review-row CTA red vs primary; exact label strings) → approve/merge → then verify 📅 end-to-end on prod as owner.
2. !65 (jsdom v29, devDep major) — reviewed safe, awaiting owner GO to merge.
3. Then: #21 P5 concurrency/hygiene (incl. lazy-Task-create transactionality + ensureFocusStep sibling), P6 docs, #23 lint burn-down, #25 fast-follows (reward parity for single-task scheduling; per-row "Scheduled ✓" indicator; seed demo items in review apps).

## Context
Saved-bucket membership is STORED via snooze semantics (`ACTION_FOR_BUCKET.savedLater === "snooze"`) — "Save for later" must route `dropPlan`, never call snooze directly; routing spies in inbox-view.test.tsx guard this. Review apps: owner OAuth impossible (dummy creds), fresh guest workspace = empty inbox. Duo re-reviews race pushes — compare note timestamps to push times before trusting a verdict; re-trigger = remove+re-add reviewer 21826781. Tailwind opacity classes don't compose (higher number wins cascade) — use ternaries. Renovate: majors deferred via allowedVersions rules (eslint <10, typescript <6.1); dashboard #17.
