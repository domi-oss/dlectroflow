# Offline capture — a persisted brain-dump queue (#175)

**Status:** design, owner-approved 2026-08-11
**Issue:** #175 · inherits the residual from #210 (!290) · sequenced behind #251 and #253
**Milestone:** v0.6.0
**Primary target:** Android Chrome on a phone, owner-stated

## Goal

A brain dump typed with no usable network must still be there later. Capture is the top of the
funnel and the only irreversible loss in the app: everything else can be retried against data still
on the server. This is the one place where a network failure destroys user input.

The promise this spec commits to, and nothing wider: **once the words are in the field and you press
Enter, they survive the tab closing, the browser being killed, and the phone rebooting — and they
save themselves when the network comes back, whether or not you reopen the app.**

⚠️ **One bound on the durability half, stated here rather than left to be discovered.** `localStorage` is
synchronous *to the page*, but its flush to disk is not: the browser acknowledges the write and persists it
shortly afterwards. A **graceful** shutdown is inside the promise — the tab closing, the browser being
killed, an ordinary reboot all give the browser its chance to flush, and Chrome's tab discard does too. A
**battery pull or a kernel panic inside that window** can lose the last write. **No better option exists
and that is why this is a bound rather than a bug**: IndexedDB is asynchronous, which would break the
write-before-network guarantee this whole design rests on, and it is used here only as a mirror that is
explicitly not the source of truth. So the promise is bounded rather than made unconditionally — this
document's rule is that a capture is either persisted or visibly refused, and this is the one case that can
be neither.

⚠️ **And _"whether or not you reopen the app"_ is Chromium-only, which the Goal did not say.** Background
Sync is the only mechanism that can flush with no tab open, and `registration.sync.register` **no-ops on
Safari and Firefox** — a fact this document already records under _Flush triggers_ and then contradicted by
promising the behaviour unconditionally three hundred lines earlier. On the stated primary target, Android
Chrome, the promise holds as written. Everywhere else the words are just as durable and just as
unlosable — they save on the **next open**, from the foreground triggers, which is the whole feature minus
the part nobody watches. That is worth being accurate about rather than generous: a promise that silently
does not apply to a reader's own browser is the kind this document has spent four sections removing.

## Non-goals

- **Triage, edit, delete and complete while offline.** Capture-only is a far smaller problem and
  most of the value. It is also the reason multi-device conflict resolution is not in this spec —
  see *Multi-device dissolves by construction* below.
- **Cache Storage or route caching.** Nothing here makes the inbox *render* offline. An offline
  reload still fails; only capture is insured.
- **A web app manifest, installability, or standalone mode.** Not needed by any part of this design —
  every trigger here works in an ordinary browser tab.

  **This is a scope boundary, not a judgement that a manifest is a bad idea.** The opposite: a manifest
  is probably the largest available reduction in capture friction, it needs no app store, and it
  would *help* this design (installation is one of Chrome's signals for granting
  `navigator.storage.persist()`, which makes the queue harder to evict — better odds, not a
  guarantee). It is excluded because it is its own feature with its own auth-testing surface, not
  because it is unwelcome. **Filed as #254 and scheduled into v0.6.0 on 2026-08-11.** See *The
  manifest question* below.
- **Changing `proxy.ts` or the auth middleware.** The expired-session hole is closed here by a guard
  in the queue and in the new route, both of which can only *refuse* a write. Fixing the middleware's
  guest-sandbox minting is real but belongs to its own issue; this repo has recorded auth-flow
  regressions from middleware edits (#119, and the PKCE/host loop documented in the comment above
  `canonicalOriginRedirect`'s call site in `src/proxy.ts`).
- **Rewards or streak changes.** A queued capture that flushes advances the streak exactly as an
  online one does, via the existing `touchStreakOnEngagement`. Nothing new.

## Current state

#210 (!290) gave the capture bar an honest failure path: no `captured ✓` before the write resolves,
the words restored into the field, a Retry, a Reload when the deployment moved on, and a bounded
wait. It deliberately holds **one** failure notice rather than a queue.

Verified against `main` at `8d5db9a`, 2026-08-11, and **re-verified against `cb3aeee` on 2026-08-12** —
not inherited from the 2026-08-08 grounding note, two of whose line references had already rotted:

⚠️ **Two different kinds of claim live in this document and review of it was right to say they had been
blurred together. They are labelled from here on.**

- **`main`-verified** — the table immediately below. True of the deployed tree, checkable by anyone.
- **Sibling-branch verified** — anything describing `src/lib/capture-queue.ts`, `src/lib/capture-write.ts`
  or `POST /api/braindump` as *existing code*: `byteLength`, `COMMIT_ATTEMPTS`, `newClientKey`'s three
  tiers, `isQueuedCapture`, `MAX_BODY_BYTES`, and every measurement taken against them. **None of that is
  on `main`.** It lives on `feat/175-capture-queue-server` — the branch of **MR 1**, open as
  **!334 — _"offline capture queue — server half (module, migration, route)"_** — and **this document's own
  MR merges ahead of it**: **!332 — _"design the persisted offline brain-dump capture queue"_**. The three
  artefacts and their order are set out in _Sequencing_ below.
- **Not implemented anywhere yet** — ⚠️ **`blockedUnder`.** Verified at `fd768ff`, the sibling branch's
  head: the identifier appears nowhere in `src/`. `QueuedCapture` there carries `blockedBy` and nothing
  else, so every statement in this document about the `blockedUnder` comparison — the withdrawn sign-in
  offer, the *"these can't be saved to this account any more"* sentence, the worker's inability to compute
  it — describes **design, not code**. It is called out because this list exists precisely to flag claims
  a reader cannot check, and it omitted the one field that needed it: `blockedUnder` is the only member of
  the type that is not on the branch, so it was the only entry the list was for.

**So for a window after this document lands, its most concrete statements describe code a reader on `main`
cannot find**, which is the mirror image of the dangling-reference problem the merge order exists to
prevent: three files on `!334` cite *this* document. Both are resolved by `!334` following closely, and
neither is resolved by pretending the other side already exists. **Where this document says "the code
does X", read it as "the implementation on `!334` does X, and this design is what it was written
against."**

⚠️ **Every citation in this table names a symbol, not a line, and that is a correction rather than a
style choice.** This document's own preamble says it exists because an earlier grounding note's line
references had rotted — and then **five of its own rotted inside a single day**, between `8d5db9a` and
`cb3aeee`, which review of this spec caught and this pass re-verified against `cb3aeee`:
`braindump.ts:53` (`createBrainDumpItem` had moved to 55), `schema.prisma:327` (`BrainDumpItem.id`'s
`cuid()` line to 357), `schema.prisma:326-336` (`model BrainDumpItem` to 356-435), `workspace.ts:129-141`
(the owner→guest fallthrough to 133-145) and `inbox-view.tsx:866-880` (`returnFocusToInput` and its effect
to 879-886). **The six that had not rotted are converted too**, verified in the same pass: two conventions
in one table is how a reader learns which numbers to trust, and a line reference that happens to still be
right today is a rot claim waiting to be made.

| Fact | Where |
|---|---|
| `createBrainDumpItem(text: string)` takes **only text**; the row id is a server-side `cuid()` | `createBrainDumpItem`, `src/app/actions/braindump.ts`; `BrainDumpItem.id`'s `@default(cuid())`, `prisma/schema.prisma` |
| **A retry is therefore not idempotent.** No unique constraint, no client-supplied key | `model BrainDumpItem`, `prisma/schema.prisma` |
| A timed-out write **may still land** — `withActionTimeout` bounds the UI's wait, not the request | `withActionTimeout` and its docblock, `src/lib/server-action-failure.ts` |
| Capture's bounded wait is **10s** | `CAPTURE_TIMEOUT_MS`, `src/components/inbox/inbox-view.tsx` |
| `public/sw.js` is live, **notifications only** — no `fetch`, no `sync`, no Cache Storage | `public/sw.js`; `registerServiceWorker`, `src/lib/notifications.ts` |
| It is registered from **four** surfaces, not the inbox alone | `registerServiceWorker`'s callers: `inbox-view.tsx`, `review-nudge.tsx`, `roundup-card.tsx`, `notifications-section.tsx` |
| **Nothing in `src/` reads `navigator.onLine`**, and there are no `online`, `visibilitychange` or `pagehide` listeners anywhere | verified by grep across `src/` |
| Client-side persistence today is five keys, **all flags and preferences** — no user-typed text is stored client-side anywhere | `df-theme` (`theme-toggle.tsx`), `df-hyper-focus` (`hyper-focus.ts`), `df-guest-banner` (`guest-indicator.tsx`, in **`sessionStorage`**), and two `localStorage` day-keys, `dlectroflow-review-nudge-fired-<date>` (`reviewNudgeDayKey`) and `dlectroflow-roundup-fired-<date>` |
| The privacy notice names browser storage **once**, pinned to one key: *"your light/dark theme choice … never leaves your device"* | the `df-theme` paragraph in the cookies `LegalSection`, `src/app/privacy/page.tsx` |
| Any prose edit to a legal page **reds CI** until `LEGAL_EFFECTIVE_DATE` is bumped | `LEGAL_EFFECTIVE_DATE`, `src/lib/legal.ts`; `src/lib/legal-fingerprint.test.tsx` |
| A **frozen** account can no longer write — `currentWorkspaceId` reads `User.status`, calls `clearOwnerSession` and throws `RevokedAccountError` | the `WorkspaceKind.User` arm of `currentWorkspaceId`, `src/lib/workspace.ts` (#220, closed 10 Aug) |
| An **expired** owner cookie still falls through to the guest arm, skipping that status check, and the dump lands in an invisible sandbox purged within ~24h | `resolveWorkspace`'s owner arm falling through to its `input.guest` arm, `src/lib/workspace.ts` |

### The residual #210 handed over

Duo review round 7 on !290 sharpened this into the reason #175 exists rather than a code comment:

> **A second outstanding failure displaces the first, and the first's words are then in neither the
> notice nor the field.**

Submitting anything empties the field, so a second failure takes the notice *and* repopulates the
field with its own words. There is no arrangement in which both survive, and the loss lands on the
**second** failure, not the third. An offline stretch is precisely where consecutive failures are the
norm. Every fix available inside #210's scope traded the loss for a different silence — keeping the
older record leaves the newer failure unannounced; rescuing the older words into the field puts text
the user did not just type where they are looking. A persisted queue needs neither.

## Design

### Failure-driven, never `navigator.onLine`-driven

`navigator.onLine` reports attachment to a network, not reachability of the internet. On a phone it
reads `true` on a captive portal, in a lift, and at the edge of coverage — which are the ordinary
mobile failures, not exotic ones. So:

**A capture enters the queue because a write failed or timed out. Never because a flag said offline.**

`online` is used only as an *opportunistic flush hint*. It is never a gate, and a `false` reading
never prevents an attempt.

### The queue is written before the network call, and never on unload

The words go to storage synchronously inside `submit()`, before the write is attempted. There is no
flush-on-exit step in this design at all.

Chrome discards background tabs under memory pressure, and **a discarded tab fires no unload event**.
Chrome's own guidance is never to persist critical data from `beforeunload`. `pagehide` and
`visibilitychange` are more reliable but still not guaranteed on discard, so neither is load-bearing
here — they are only additional *flush* triggers.

### Storage

`localStorage`, one key, following the `df-` prefix three of the repo's five client-side keys already use:

⚠️ **This line said "the repo's existing `df-` convention" and overstated how settled that is.** Verified
at `cb3aeee`: `df-theme`, `df-hyper-focus` and `df-guest-banner` carry the prefix; the two day-keys are
`dlectroflow-review-nudge-fired-<date>` and `dlectroflow-roundup-fired-<date>` and do not. `df-guest-banner`
is also in **`sessionStorage`**, not `localStorage`, so it is a prefix sibling rather than a storage one.
**Both load-bearing halves of the original claim survive** — every existing key is a flag or a preference,
and none of them holds user-typed text, which is what makes `df-capture-queue` a new category for the
privacy notice. `df-` is still the right prefix to pick; it is a majority convention rather than a
universal one, and a reader auditing the five keys against this sentence would have found it false.


```
df-capture-queue → QueuedCapture[]
```

```ts
type QueuedCapture = {
  /** Client-generated. The idempotency key — see below. */
  clientKey: string;
  /**
   * The text as typed, inline note syntax included; the server splits it.
   *
   * ⚠️ This said "raw text as typed", which is not what happens: `enqueue`
   * stores `capture.text.trim()`. The route deliberately does **not** trim, so
   * the two write paths disagree by one transformation — harmless, because
   * leading and trailing whitespace is not content anyone typed on purpose, but
   * worth stating rather than leaving as a surprise to whoever compares a queued
   * capture against a directly-written one.
   */
  text: string;
  /** Workspace this was captured under. Compared, never trusted — see below. */
  workspaceId: string;
  /**
   * ms epoch, for the **age** shown beside an entry in the strip — and for
   * nothing else. **It does not order the queue**; see "Display order" below.
   *
   * An earlier draft of this comment said it drove ordering, which contradicted
   * that section outright. Caught in review of this spec, and it was the one
   * sentence here two readers could reasonably read two different ways.
   */
  capturedAt: number;
  /**
   * Why the server last refused this capture, if it did. Persisted with the
   * capture rather than held in component state, because the refusal has to
   * survive the reload that a discarded tab forces — a capture that comes back
   * after a restart with no memory of why it is stuck would offer a Retry that
   * cannot work.
   *
   * `undefined` means "not yet refused, or refused for a reason that has since
   * cleared", and a `session-expired` mark is cleared by **any retryable
   * outcome**. ⚠️ An earlier version of this line said "cleared as soon as an
   * attempt gets past the guard", which is false for the `401` arm: a `401` means
   * `currentWorkspaceId()` threw, so the declared-`workspaceId` comparison was
   * never reached — and it clears the mark anyway. `account-revoked` is cleared by
   * nothing short of success; see the precedence rule under the outcome table.
   */
  blockedBy?: "session-expired" | "account-revoked";
  /**
   * The workspace the CLIENT was running under when a `409` was last recorded.
   *
   * Not the capture's own `workspaceId` above — that is what the capture declares
   * and is what the `409` disagreed with. This is what the app's live session
   * resolved to at the moment of the refusal, which is the only thing the client
   * has that can change when the user signs in.
   *
   * It exists because a `409` does not distinguish "that workspace isn't yours"
   * from "that workspace was purged" — deliberately, since answering that would
   * tell whoever supplied a `workspaceId` whether it exists. A purged guest
   * sandbox can never be resolved again, so *"sign in and these will save"*
   * becomes a promise the app cannot keep, repeated forever.
   *
   * The client cannot ask which case it is in. What it CAN observe is that the
   * remedy it offered has already been taken and did not work: a fresh `409`
   * arriving while the live session resolves to a DIFFERENT workspace than
   * `blockedUnder` means the session changed between the two refusals — a sign-in,
   * or a new guest sandbox — and the capture is still refused. At that point the
   * copy withdraws the sign-in control.
   *
   * Persisted for the same reason `blockedBy` is: otherwise the comparison dies on
   * the reload a discarded tab forces, and the app tells the user to sign in when
   * it has already watched them do it.
   */
  blockedUnder?: string;
};
```

**`blockedBy` is a persisted field, and both of its values are needed.** An
earlier draft of this document had neither — it declared the type without it while
the flush table below said a refusal "marks `needsSignIn`", and it collapsed two
different refusals into that one mark. Both were caught in review of this spec and
are corrected here; the second is the more serious, because the two refusals need
**different words and a different remedy**.

#### Display order — the stored array's own order, and nothing else

**The single source of truth for display order is the position an entry holds in the stored array.**
The strip renders `readQueue`'s result in index order, oldest first. Nothing sorts, at any point, on
any path. Two consequences, each stated because each is a question an earlier draft left open:

- **`capturedAt` never orders anything.** It is rendered — the age beside an entry — and is otherwise
  inert. It cannot be the ordering key: two devices' clocks are skewed independently, so sorting by it
  could move a capture the user is already looking at, and this is a feature about words not moving.
- **"Write order" means the order `setItem` committed, which is the array's order.** That phrase is
  used below and was never defined, which is the gap this section closes. `enqueue` appends, so a
  tab's entry goes last in whatever array that tab's write committed; under the reconciliation below a
  re-applied delta appends to the *fresh* read. So the winner of a race is simply whichever `setItem`
  landed second, and the loser's re-run places its own entry after the other tab's. **There is no tie
  to break — an array has no ties**, which is why the rule needs no comparator at all.

**A restored queue is not a special case, and that is the other half of the question.** `JSON.parse`
preserves array order, so what survives a reload is the order the last `setItem` wrote — the same
rule, not a second one. Because no timestamp is consulted anywhere, a queue restored on a device
whose clock has since moved, or whose entries came from two devices with skewed clocks, comes back in
the order the user last saw it.

#### Two tabs on one storage key — a lost update, and what actually fixes it

`localStorage` is shared across every tab of the origin, and one key holds the whole queue, so a
read-modify-write can lose another tab's capture. Two tabs of the inbox is ordinary, and on the Android
Chrome target a discarded-and-reopened tab makes overlapping lifetimes normal rather than exceptional. A
lost capture is the exact failure this feature exists to prevent, so this is not deferrable in full.

**Three things are worth stating because each contradicts the obvious answer — and exactly one of them
was settled by measurement rather than argument.** ⚠️ **An earlier version of this sentence claimed all
three were**, which review of this spec was right to call out: (3) says outright that it *follows from*
(2), and (1)'s *"three `JSON.stringify` passes"* is a count of the code's passes, not a timing. Only
(2) carries a measurement, and it is labelled below as the sibling-branch evidence it is.

1. **"Re-read immediately before writing" is a no-op here.** Both `enqueue` and `applyFlushOutcome`
   *already* read immediately before writing, in one synchronous block. What was actually open was the CPU
   time between read and `setItem` — dominated by **three** `JSON.stringify` passes over as much as 64 KB.
   So the fix is: do all the expensive work **first**, then re-read, and abandon the write if the stored
   string moved. Only `setItem` stays inside the window.

   **The bound is three attempts** (`COMMIT_ATTEMPTS = 3`), and review of this spec was right that
   *"a bounded number of attempts"* without a number is not a specification. Two covers what this exists
   for — one other tab committing once while we measure the caps and serialise — and the third is a stop, so
   a store being written in a tight loop cannot spin us. ⚠️ **On the last attempt the write proceeds
   without the comparison, deliberately:** refusing would be a certain loss of the capture in hand, and an
   improbable clobber is the better of those two.

   ⚠️ **"Abandon" means recompute and retry, never drop — and an earlier draft of this line did not say
   so.** Read literally it describes exactly the failure this design exists to prevent: a capture
   discarded because another tab happened to write first. What actually happens is that the whole
   read-compute-write is **re-run against the new stored value**, because the delta being applied is
   still valid — it was never about *which* queue it was applied to. Three attempts (above), and
   ⚠️ **there is no exhaustion branch, so an earlier version of this line described one that cannot
   exist.** It said *"on exhaustion the caller gets the same refusal a failed `write` produces"*, which
   contradicts the paragraph immediately above: the last attempt writes **without** the comparison, so
   the loop cannot exit by running out of attempts. The refusal it was reaching for is real and has a
   different trigger — **a `setItem` that throws produces it** — and it keeps the words in the field and
   tells the user. The code and the test list already agree on this: the test below asserts the third
   attempt **writes** rather than refuses. There is no path on which the words are silently gone: every
   exit is either "persisted" or "refused, and you can still see it".
2. **Union by `clientKey` is the wrong primitive for `applyFlushOutcome`, and introduces a worse bug than
   it fixes.** Unioning "the queue I computed" with "the queue I now find" **resurrects the capture that
   just saved** — the computed queue lacks the key, the store still holds it because nothing has been
   written yet, so the union puts it back permanently after the user was told it saved. The correct
   primitive is **re-applying this tab's own delta to the fresh read**. Measured: a union implementation
   passes **37 of the 39** tests `src/lib/capture-queue.test.ts` held **at `2136f51`**, including all 31
   that predate this work, and fails only the two resurrection cases. ⚠️ **The commit is part of the
   measurement, not decoration.** This read *"37 of 39 tests"* against a reproduction recipe naming only
   the branch, and the number was true at exactly one commit: that file is up to **66** tests at the
   branch head (`fd768ff`), so anyone following the recipe as written gets a different denominator and
   concludes the document is wrong. The recipe is therefore: `git checkout 2136f51` on
   `feat/175-capture-queue-server` (!334) and replace `applyOutcome`'s delta with a union.
   ⚠️ **Sibling-branch evidence, and the label matters** — review of this spec correctly pointed out that
   a test count cited as evidence cannot be checked from a docs-only MR, and an unverifiable number reads
   as stronger than a described mechanism, which is the same trap as a citation to a file nobody opens.
   **The delta-vs-union argument above stands without either figure**; they are corroboration.
3. **No tombstones and no per-entry timestamps are needed** — which follows from (2). "Deliberately
   removed" never has to be *inferred*, because the only entry ever added is the one `enqueue` was handed,
   and the tab doing the removing removes from a read it took itself. A capture another tab flushed is
   simply absent, so the filter and the map are no-ops on it.

**Caps are evaluated against the merged result, not the stale read**, or the reconciliation becomes a way
to exceed the bound. If the merge would breach a cap, the **incoming** capture is the one refused, with the
words kept in the field.

**The merged queue keeps the array's own order** — see "Display order" above. The re-applied delta
appends to the fresh read, so the merge neither sorts nor consults `capturedAt`, and no comparator is
needed to describe the result.

⚠️ **The residual is real and belongs to MR 2 (defined in _Sequencing_), named here so it is not read as an
oversight.** `getItem`
carries **no ordering guarantee** against another tab's `setItem`, so a read can be stale the instant it
returns and **no amount of re-reading detects that**. The `storage` event does not fix it by letting a tab
learn before writing; it fixes it by letting the **losing** tab notice, after the fact, that the queue no
longer holds its own pending capture — and re-enqueue. That needs "what I am still waiting on" in memory
plus subscribe/unsubscribe, i.e. a component lifecycle. **Do not close this by putting a listener in a pure
module.**

`localStorage` over IndexedDB deliberately: the payload is short text, the repo already has a
synchronous-localStorage pattern with a `useSyncExternalStore` subscription (`src/lib/use-hyper-focus.ts`),
and an async store would make the write-before-network guarantee harder to hold. Chrome Android
applies no 7-day script-writable-storage eviction, so durability is measured in weeks.

**Cap: 20 items per workspace, or 64 KB across the whole origin, whichever binds first** — "64 KB"
throughout this document means **64 Ki UTF-8 bytes**, defined once under *"What '64 KB' is measured in"*
below (owner decision 2026-08-11 — an earlier draft said 200). ⚠️ **This headline read "20 items, or
64 KB total" and was never updated when the two caps split**, which review of this spec caught: the
split is set out under *"A shared browser"* below, and it is what makes the item cap a property of what
*this* user can see and the byte cap a property of the origin's quota. At the cap a new capture is
**refused with a visible message** and the words stay in the field. It does not silently evict the oldest — losing the newest *with the user watching* is honest;
losing the oldest quietly is the bug this issue exists to fix, in a new costume.

**20 makes the cap a limit the user can actually meet, and that changes what it is.** At 200 it is a
runaway guard nobody reaches; at 20 a genuine capture burst on a long journey can hit it, so the
refusal is user-facing UX rather than a defensive branch. It therefore has to say what to do, not just
that it failed:

> *"20 captures are already waiting to save — that's the limit until some of them go through. Your
> words are still in the box; copy them somewhere safe if you need to."*

The bound is not about storage size. 20 short captures is a few kilobytes and `localStorage` has
megabytes; the item cap exists to keep the strip legible and the wait comprehensible.

**The byte bound is doing a different job, and it is load-bearing.** Verified 2026-08-11: there is **no
length limit on capture text anywhere** — no `maxLength` on the input, no check in
`createBrainDumpItem`, and `BrainDumpItem.text` is an unbounded Postgres `text`. So one pasted essay
can be arbitrarily large, and without a byte bound a single capture could exhaust the quota and throw
`QuotaExceededError` on the write this whole design depends on being reliable. Whether capture text
should have a limit *at all* is a separate question and not this issue's to answer.

**64 KB is a bound on the total, and it therefore fails in two different ways — so the item cap and the
byte cap are three refusal states between them, not two.** An earlier draft of this section said "64 KB total … and a single capture over that
bound is refused with its own message", which reads as though there were one byte check. There are two,
they have different remedies, and the wording table below carries a separate sentence for each:

| Byte condition | Why it is different | Remedy the copy must offer |
|---|---|---|
| **One capture exceeds 64 KB on its own** | Nothing that is already queued is relevant; this capture cannot ever fit | Shorten *this* one, or copy it elsewhere |
| **The queue total is at 64 KB and a further capture, however short, does not fit** | This capture is fine; the queue is full | Wait for some to save — **shortening will not help** |

**So no two of these refusals share a message, and this is the one place that argument is made.**
Collapsing any two repeats round 1's defect in a new place: telling someone whose two-word capture was
refused to *"shorten it"* is advice that cannot work, and telling someone who pasted one essay that
*"20 captures are already waiting"* quotes a number that may well be zero. **A refusal message whose
remedy the user cannot act on is the same defect as a refusal message with the wrong number in it.** The
item cap can quote a figure the user recognises (20); neither byte condition can, because a byte total is
not something anyone can count in their own queue — so the byte copy says what to do without quoting a
figure. **The rule, not the count**: every refusal state in the cap family gets its own sentence in the
wording table below, which is why a fourth arriving later (`QuotaExceededError`, under *"When storage
itself fails"*) needed no argument of its own.

⚠️ **That argument appeared four times in seventy lines and is now made only here** — review of this
spec counted them, and two were near-verbatim seventeen lines apart. Worse, one copy sat *under* the
heading below while reading as a continuation of the text above it: it opened *"Collapsing them"* with
no antecedent in its own subsection. Three copies of an argument is how one of them ends up describing
a rule the other two no longer follow, which is precisely the drift the copy for these states has
already been corrected for twice.

#### What "64 KB" is measured in — UTF-8 bytes, and this section had it wrong

**Review of this spec asked whether the bound is UTF-8 bytes or UTF-16 code units, and it was right to:
the document said "64 KB" eight times without ever saying, and the two differ by up to 3× on the
non-ASCII text this app's users type.** ⚠️ **This sentence said "2×" and that was wrong** — a BMP CJK
character is **3** UTF-8 bytes to **1** UTF-16 code unit, which is the ratio this document already
quotes twice below. Unspecified, an implementer picks one and nobody finds out which.

⚠️ **CORRECTED. An earlier version of this section answered "UTF-16 code units", and that was wrong — it
contradicted the code it was describing.** `src/lib/capture-queue.ts` measures **UTF-8 bytes**, via a
`byteLength(value) => new TextEncoder().encode(value).length` helper, against a constant named
`CAPTURE_QUEUE_MAX_BYTES`. **The bound is on UTF-8 bytes**, and the constant's existing name is already
right.

**The argument that produced the wrong answer is worth recording, because it was wrong on its own
premise.** It reasoned that adding a `TextEncoder().encode()` pass would widen the read-compare-write
window the two-tab reconciliation exists to narrow — so code units were preferable because
`JSON.stringify(queue).length` is free. **The code already makes that `TextEncoder` pass.** The cost being
avoided had already been paid, so the trade being weighed did not exist. A design claim about
implementation cost has to be checked against the implementation; this one was not.

**Why UTF-8 bytes is also the better answer on the merits, now that it is the actual one:**

- **The bound's whole job is preventing `QuotaExceededError`**, which is about storage, and storage is
  charged in bytes. Code units are a property of the JavaScript string, not of what gets stored.
- **The constant is called `..._BYTES`.** A name that contradicts its unit is precisely how the same
  confusion reached the route's own body-size backstop: it **was** `MAX_BODY_CHARS`, derived from
  `CAPTURE_QUEUE_MAX_BYTES` but compared against `rawBody.length`, which let a Cyrillic or CJK body reach
  roughly 3× the intended budget. **Same defect, same document, two surfaces** — which is the argument for
  naming the unit once and reusing one helper rather than re-deriving the measurement. ⚠️ **Past tense:
  fixed on !334, and the constant is now `MAX_BODY_BYTES = 2 * CAPTURE_QUEUE_MAX_BYTES`, compared with
  `byteLength(rawBody)`.** This paragraph described it in the present tense and would have read as a live
  defect on the day it landed. ⚠️ **And it is not the only `MAX_BODY_CHARS` in the repo** —
  `src/app/api/breakdown/route.ts` has its own, `10_000`, compared against `rawBody.length` and reported
  to the caller as *"max 10000 characters"*. **That one is correct**: it is a picked number rather than a
  byte budget in disguise, its name and its comparand agree, and it says "characters" to the user. Do not
  read the paragraph above as a finding against it.
- ⚠️ **And the route's headroom must stay strict: `MAX_BODY_BYTES = 2 * CAPTURE_QUEUE_MAX_BYTES`, with both
  ends measured by the same helper.** That factor of two is what makes `413` **unreachable from the
  queue** — a capture the queue's own byte check accepted cannot then produce a body over the route's, even
  carrying the JSON envelope plus `clientKey` and `workspaceId` on top of the text. **Set them equal and a
  capture at the limit `413`s forever:** the queue accepts it, the route refuses it, and the outcome table
  classifies `413` as retryable *on purpose*, so it retries for the life of that browser profile while the
  strip says only *"waiting to save"*. This is a constraint on the constant, not an observation about it,
  and it is stated because `2 *` reads like slack that a later tidy-up could reclaim.
- **There is exactly one measurement helper**, and both the module and the route must use it. Two
  independent answers to "how big is this" is how these drifted apart.

**Honest consequence, stated because a reader would otherwise discover it:** a queue of CJK or emoji text
reaches the bound after fewer visible characters than an ASCII one — CJK costs 3 bytes per character
against ASCII's 1. That is acceptable; the bound exists to stop one pasted essay exhausting the quota, not
to promise a character budget. **The user-facing copy names no unit at all** — *"too long to hold
safely"*, *"no room to hold more"* — and must keep not doing so, for the reason given with the
byte-condition table above.

⚠️ **What this spec deliberately does not claim: how a given browser charges `localStorage` against its
quota.** Accounting is implementation-defined, so tying the constant to a real `QuotaExceededError`
threshold is an implementation-time **measurement**, not something to assert here. 64 KiB is comfortably
inside every engine's documented floor, and `QuotaExceededError` recovery is a tested path regardless —
specified in the next section.

#### When storage itself fails — the fourth refusal, which was a test with no specification

⚠️ **`QuotaExceededError` recovery was listed as a test and specified nowhere**, and no row in the wording
table covered *"this browser can no longer store anything"* — so at the one point where the mechanism this
entire design rests on fails, the document did not say which of its two exits it takes. Review of this spec
found the hole, and it is the worst place in the design to have one.

**It is reachable, and by nothing the byte cap can prevent.** The cap bounds *this key*; the quota is
charged per **origin** and exhausted by **device** conditions — an origin already at the browser's ceiling
for reasons that have nothing to do with this key, a full disk, a profile where the user has restricted
site data. `setItem` can therefore throw on a queue comfortably inside 64 KB, which is precisely why the
cap is not the answer to this and a separate exit is needed.

**The exit is the refusal, and it is the same exit every other failure here takes.** `write` catches the
throw and reports failure, `enqueue` returns a refusal, the words stay in the field, and nothing already
queued is touched or evicted — the design does not trade someone's older capture for this one, for the same
reason the item cap does not. What was missing is only the sentence, and it is the one refusal whose remedy
is not about this app at all:

> *"This browser can't store anything more right now, so this one isn't safe to hold. Your words are still
> in the box — copy them somewhere safe."*

**It quotes no cap and offers no wait, deliberately.** Unlike the byte-total refusal there is nothing
queued whose saving would free the space, so *"wait for some to save"* would be the
remedy-the-user-cannot-act-on defect again. It also does not tell the user to change a storage setting: the
app cannot see which condition it is in, and a wrong instruction is worse than none.

⚠️ **This is a fourth cap-family refusal, which makes the cap-refusal count four rather than three** —
another reason the a11y section now says "every refusal state" instead of counting.

#### A shared browser — the queue is per-origin, and that is a privacy gap

⚠️ **Raised in review of this spec and it is real, verified against the code rather than reasoned about.**
`localStorage` is scoped to the **origin**, not to a session or a workspace. `readQueue` returns every
stored entry with **no workspace filter** — `workspaceId` appears in the module only for validation and for
the server's `409` comparison. So: user A queues text, signs out, user B signs in on the same browser, and
**the strip renders A's unsaved words to B.** Nothing in this document previously addressed it, so it was
an omission rather than a decision.

**The obvious fix is wrong.** Clearing the queue on sign-out destroys exactly what this feature exists to
protect: unsaved words, belonging to someone who has not necessarily finished with them. A capture queue
that empties itself on sign-out is a capture queue that loses words on the most ordinary event there is.

**So the rule is: scope the TEXT, account for the REST.** Owner decision, 2026-08-12.

⚠️ **An earlier version of this section said only "scope the view, keep the data", and that was not enough
— it broke the feature.** Three independent reviews of this document converged on the same defect, and it
is recorded because the fix is not obvious from the broken version:

**With a bare match-or-hide filter, every state this section exists to serve becomes unreachable.** #220
deletes the owner cookie in the same response that answers `403`, so the next boot resolves a **fresh guest
sandbox**. The owner's entries then match nothing, which means:

- the `403` copy can never render — dead by the filter, not by #220's behaviour;
- the *"Your session expired. Sign in and these will save"* sentence is hidden **exactly when it is the one
  thing the user needs**, leaving a silent empty strip over stranded words;
- `blockedUnder` becomes dead code — for any *visible* entry it equals the live workspace by construction,
  so the row that fires when they differ never fires;
- **Discard cannot reach the stranded entries at all**, because it lives on an expanded row in the filtered
  list. The release valve disappears precisely for the entries that need it.

And two paths produce entries that can **never** match again: a **guest sandbox purged** by
`prisma/scheduled-purge.ts` past its TTL, and an **account deleted** (`Workspace.userId` is
`onDelete: Cascade`). Those are neither persisted nor visible — the one outcome this document forbids —
while still consuming the origin-wide byte cap forever.

**The rule, therefore:**

- **Entries matching the live workspace render in full**, as before.
- **Entries that do not match are represented, never revealed** — one collapsed row: *"N captures from an
  earlier sign-in are still held in this browser."* No text, no author, no workspace. **B never reads A's
  words**, and A is told something recoverable exists rather than meeting an empty strip.
- **That row carries a discard-without-revealing control.** It is the release valve, and it is the only
  reason the byte cap cannot become a permanent denial of capture (below). ⚠️ **It cannot use the ordinary
  two-step confirm**, which exists so the confirm is made against words the user can read — here they may
  not. It confirms against the **count and the origin** instead, and says plainly that the text cannot be
  shown.
- **Nothing is deleted on sign-out.** Matching entries survive and flush when their owner returns.
- **Orphans expire.** A stored entry whose workspace has been unresolvable for longer than the guest TTL is
  removed, because the privacy notice's retention promise — *"until saved, or until the user clears it"* —
  is **false** for an entry where neither trigger can ever fire. Storage limitation is not optional.

**The two caps split, and the split follows the purposes this document already gave them.** The **item cap
counts per workspace**, because its stated job is keeping the strip legible and the wait comprehensible —
properties of what *this* user can see. The **byte cap counts every entry in the key**, because its job is
preventing `QuotaExceededError` and the quota is charged per origin.

⚠️ **The byte cap's residual is a denial of capture, not merely a disclosure, and the earlier version of
this paragraph missed that.** A can leave a long capture stranded and B's first offline capture is refused
with *"no room to hold more until some of these save"* — an event that **cannot occur** while A is signed
out. Without the discard control above, B has permanently lost offline capture on that browser and is told
to wait for something impossible. **The control is what makes the residual survivable**, which is why it is
part of this rule and not a nicety.

The disclosure that remains is **size, not just presence**: B can measure the stranded volume to the byte
by probing with captures of known length. Accepted — it is B's own storage quota being consumed, and B has
a control to reclaim it.

**One honest bound on the privacy property:** it is scoped to a **workspace**, not to a person. Two people
sharing the browser as guests resolve the *same* guest workspace, so B does see A's queued text. That is
not a new disclosure — B already sees A's *saved* inbox in that case.

**This is not the same problem as the `409` path** and must not be collapsed into it. A `409` is the
*server* refusing a capture whose declared workspace no longer matches. This is the *client* deciding what
to put on screen, and it happens before any request is made.

### Idempotency — a separate column, not a client-chosen primary key

```prisma
model BrainDumpItem {
  // ...
  /// #175 — idempotency key for a replayed offline capture. Nullable: existing
  /// rows and every non-queued write leave it null, and Postgres treats nulls as
  /// distinct in a unique index, so they coexist freely.
  clientKey String?

  @@unique([workspaceId, clientKey])
}
```

**How the `clientKey` is generated — three tiers, and review of this spec was right that leaving it
unstated was a gap.** A collision does not error (the index is per-workspace, so it silently makes a
distinct capture look like a replay and **loses it**), which is exactly why the generation method belongs
in the spec rather than being left to the implementer:

1. **`crypto.randomUUID()`** where available. The whole answer on every target browser.
2. **`crypto.getRandomValues()`** into 16 bytes, hex-encoded. Same entropy, for contexts that have the
   CSPRNG but not the convenience method.
3. **A clock-and-counter fallback**, `clk-<base36 ms, padded to 9>-<base36 sequence, padded to 6>`, for a
   browser with no CSPRNG at all. The module-scoped counter is what makes two calls in the same
   millisecond distinct — two capture bars on one page, or a flush racing a fresh capture.

⚠️ **`Math.random()` is deliberately not a tier**, and this is a decision rather than an oversight: it was
in an earlier implementation and was replaced after a SAST finding. The `clk-` prefix on tier 3 is also
deliberate — a key that reaches the database is then recognisable as having come from a browser with no
CSPRNG, which is worth knowing and is otherwise indistinguishable from tier 2's hex.

`id` stays a server-side `cuid()`. A client-chosen primary key would let a caller probe row existence
through unique-violation timing and pre-empt ids; a separate scoped column has neither property.

**On unique violation the route returns success and the item leaves the queue.** That is the whole
payoff: with `CAPTURE_TIMEOUT_MS = 10_000` and a mobile connection, a write that times out at 10s and
lands at 14s is ordinary. Without the key every auto-flush would duplicate it. `withActionTimeout`'s
own docblock is the citation — *"A server action cannot be aborted from the client, so the request
itself carries on."*

One migration serves two purposes: replay-on-reconnect, and the late-write duplicate #210 documented
as its own residual.

### `POST /api/braindump` — a route, because a worker cannot replay a server action

Background Sync requires the service worker to make the request. Next server actions are
framework-shaped POSTs with their own headers and encoding; replaying one from a worker is fragile
and would break on a framework upgrade. So the queue flushes through a plain route:

```
POST /api/braindump
body: { clientKey, text, workspaceId }
```

| Outcome | Response | Queue action |
|---|---|---|
| Written | `201` | remove |
| `clientKey` already present for this workspace | `200` | remove — already saved |
| Resolved workspace ≠ declared `workspaceId` | `409` | **keep**, `blockedBy: "session-expired"` — unless already `account-revoked`, which wins |
| Account frozen (`RevokedAccountError`) | `403` | **keep**, `blockedBy: "account-revoked"` |
| **No resolvable workspace at all** — `MissingWorkspaceError`, and not its `RevokedAccountError` subclass | **`401`** | keep, treat as **retryable**, clear `blockedBy` — **but not `account-revoked`** |
| **Origin not allowed** (the rule under *CSRF*, **below**), or a body this route cannot parse or accept | **`400`** | keep, **retryable** |
| **Body over the size backstop** | **`413`** | keep, **retryable** |
| Anything else — including any status not listed here | `5xx`, network failure, **anything unrecognised** | keep, clear `blockedBy` — **but not `account-revoked`** — retry later |

⚠️ **`400` and `413` were missing and the table claimed to be exhaustive in the same breath** — review of
this spec caught it, and the sentence below asserting that the queue *"must classify every status the route
can return"* was written one paragraph away from a table that did not. The route returns `400` on five
conditions and `413` on one.

**The default arm is `keep` and `retry`, never `drop`, and that is the load-bearing part.** An unlisted
status must not be able to discard words, so the last row is written to catch *anything* rather than to
describe `5xx`. `400` and `413` are classified retryable knowing they will not clear on their own — a
misconfigured origin rule or a body genuinely over the cap retries forever — because the alternative is a
client that deletes a capture on a status the server may be returning for a reason the client cannot see.
**A wasted retry is recoverable; a dropped capture is not.**

⚠️ **A terminal mark is taken from the parsed body, never from the status line.** The route answers
`{ "status": "account-revoked" }` alongside its `403`, and the mark is set only when the body carries a
recognised `FlushOutcome`. This matters because a `403` the app did not send — an auth proxy in front of a
self-host, an ingress rule, a corporate filter — would otherwise permanently mark a perfectly good capture
*"This account can no longer save"*, whose only exit is deliberately destroying the words.

⚠️ **And the CSRF refusal is `400`, not `403`, deliberately.** `403` already means `account-revoked` in this
vocabulary, so reusing it would collapse two states with different remedies — the same defect this document
has been reviewed for twice. The implementation made that call; it is recorded here because this document
merges first and tells a reader to copy `logout/route.ts`, which returns `403`.

⚠️ **`401` was missing from this table and is added here** — it was referenced as retryable in the
Background Sync section while never being defined as an outcome, so the document named a status its own
contract did not have.

⚠️ **And the first version of this paragraph then got its trigger wrong, in a way this document's own
worked example contradicted two sections later.** It said `401` fires immediately after a `403`, because
#220 deletes the owner cookie in that response. **It does not, and the walkthrough below is the correct
one: that request returns `409`.** `src/proxy.ts` mints a **guest sandbox** for any request arriving
without a session, so the next request resolves a workspace perfectly well — it is just the *wrong* one, so
the declared-`workspaceId` comparison refuses it with `409`. `currentWorkspaceId()` never throws on that
path, and `401` is what the route returns only when it *does* throw `MissingWorkspaceError`.

**So `401` is rare on the ordinary browser path, and the honest reason to keep it in the table is not that
users hit it.** Guest minting means a browser almost always has *something* to resolve; `401` belongs to a
caller that does not pass through that minting. It is listed because the queue must classify every status
the route can return, and an unlisted one would fall through to whatever the client's default branch is.

**Retryable is the right classification, and that part was never in doubt.** A `401` says nothing about the
capture — only that *this* request arrived without a usable session — and the condition clears by itself.
Terminal would strand a perfectly saveable capture. It must still not clear an `account-revoked` mark, for
the same reason `5xx` must not: a missing session is no evidence an account was un-frozen.

**The mark is a precedence, not an assignment: `account-revoked` > `session-expired` > unmarked, and
only a successful outcome clears `account-revoked`** (by removing the entry). ⚠️ **That last clause read
"only a successful outcome clears *it*"**, which contradicted four other statements in this document and
two rows of the table directly above: a `401` and a `5xx` both clear a `session-expired` mark. It is
`account-revoked`, and only that, which nothing but success clears. Why that is needed, and why the obvious
"latest refusal wins" is wrong here, is worked through under *"The `403` copy is reachable"* in **What
the user sees** below — the short version is that #220 deletes the owner cookie in the same response
that answered `403`, so the *next* attempt is made as a guest and necessarily `409`s.

**`409` and `403` must not share a state.** They look alike — both keep the capture and **neither is
fixed by retrying as-is** — but the remedy differs and so does the truth. ⚠️ **That clause said
"neither is retryable", which is flush vocabulary being used to make a remedy claim**, and it
contradicted the worker contract above, where every `409` *is* retryable. Retryability is about whether
another attempt is worth making; this bullet pair is about whether *the same attempt* can ever succeed
without something changing first:

- **`409`** means the session moved on. Signing in again **fixes it**, and the queued
  words then save.
- **`403`** means the account was revoked. Signing in again **cannot fix it**, and #220 has already
  cleared the session — so telling this person to "sign in to save these" misstates what happened and
  sends them at a remedy that cannot work.

⚠️ **An earlier draft of that second bullet also said #220 "bounced the user to `/login`". It does
not**, and the error mattered: review of this spec reasonably concluded from it that the `403` copy
could never be seen. #220 clears the cookie and the app carries on as a signed-out visitor — the
`/login` bounce is the acknowledged *missing* half of it, tracked as **#231 — "A frozen account now
meets Next default error screen, not a real page"**. Corrected here and verified against
`src/lib/workspace.ts` and `src/proxy.ts` rather than restated.

`5xx` clears a `session-expired` mark rather than leaving it: reaching a retryable failure proves the
guard is no longer what is stopping the capture, and a stale mark would keep asking for a sign-in that
already happened. It does **not** clear `account-revoked` — a `5xx` is no evidence an account was
un-frozen.

The foreground path uses this same route rather than the server action, so there is one write path and
one set of semantics to test. `createBrainDumpItem` stays for non-queued callers and is refactored to
share the route's core.

#### CSRF — the protection that was lost in the trade, and has to be put back by hand

**Next gives server actions automatic CSRF protection. A plain route handler gets none.** That matters
here more than anywhere, because the *entire reason* this route exists is that a service worker cannot
replay a server action — so the guard was given up deliberately, and **nothing recorded replaced it.**
This was missing from an earlier draft of this spec **and from the first implementation of the route**,
which is exactly the shape of gap that reaches production: the trade was reasoned about carefully and its
consequence was never enumerated.

⚠️ **"Nothing recorded" is doing real work in that sentence, and the first framing of this got it wrong.
A forged POST could not have created a row even before the guard existed.** The body must declare the
victim's own `workspaceId`, which is unguessable and unreadable cross-origin, so a forgery takes the
`409`. Both cookies are `SameSite=lax` and host-only, so cross-site the cookie is not sent at all and the
request resolves to a fresh guest sandbox, which also will not match.

**So the workspace comparison has been acting as a CSRF token by accident** — and that relocates the
finding rather than dissolving it, into a form worth more than the original:

- **The live exposure was unauthenticated database work.** A forged request still resolved the session:
  two queries, including #220's owner-status re-read. Any page on the internet could cause that. Putting
  the `Origin` check **first** removes it.
- **The two controls are independent, both load-bearing, and each looks redundant while the other
  stands.** That is a drift trap, and the dangerous direction is concrete: the comparison exists to close
  the expired-cookie hole, nothing recorded it as a CSRF control, and a reasonable future change —
  *deriving* the workspace instead of declaring it — would remove the protection with **no test going
  red**.

Both directions are therefore stated at the call site with a *"read this before simplifying either"*
warning. **This is why "we forgot CSRF" is the wrong lesson.** The guard's absence was survivable; what
was actually missing was any record that a second thing depended on the comparison, and no amount of
re-reading the trade surfaces that — only asking "what did we give up, and what is quietly standing in
for it?" does.

The route therefore carries the house pattern, which the repo already has and documents:

- the allowed origin is **the origin the request arrived on** — see the ⚠️ below, which is the whole
  content of this bullet and the thing an implementation must not get wrong;
- **reject when `Origin` is present and does not match**;
- **allow a missing `Origin`**, deliberately, for non-browser clients — POST-only plus `SameSite=lax`
  still bound it.

Copied from `src/app/api/auth/logout/route.ts`, which carries the same three rules under a CWE-352
comment, and cited there so the two cannot drift apart the way `focus-timer.tsx` and the inbox notice
already did once.

#### ⚠️ The allowed origin is NOT `PUBLIC_ORIGIN` — production serves more than one host on purpose

**An earlier version of this section said `requestOrigin(req)` gives the allowed origin. That would break
capture completely on one of the two hostnames production serves, online and offline alike, and `!334`
implemented it.** Found by an independent review of this document and then measured rather than argued:

| Check | Result |
| --- | --- |
| `curl https://dlectroflow.dev/` | **`200`, no redirect** |
| `curl https://work.dlectroflow.dev/` | `200`, no redirect |
| `PUBLIC_ORIGIN` on the production deployment | **`https://work.dlectroflow.dev`** |
| Ingress hosts | `work.dlectroflow.dev`, `dlectroflow.dev`, `dlectroflow.dlectronique.dev` |

**And the apex is served without a redirect deliberately.** `.gitlab-ci.yml` records it as
`legacyHosts[1]`, *"served WITHOUT a redirect … That is deliberate"*, and `src/lib/auth/gate.ts` states
that `/` must keep answering `200` on every hostname the ingress serves. `/api/braindump` is **not** in
`CANONICAL_ORIGIN_PREFIXES`, so nothing moves the request onto the canonical host first.

`requestOrigin` pins `PUBLIC_ORIGIN` in production, so a capture typed on `https://dlectroflow.dev` sends
`Origin: https://dlectroflow.dev`, which does not match, and **every capture is refused** — the foreground
write too, since this design routes it through the same handler. The queue then fills to its cap with words
that can never leave it.

**So the comparand is the origin the request arrived on** — `inboundHost(req.headers)` — or an explicit
allowlist of the hosts the ingress serves. **That still blocks cross-site**, which is the whole job: a
forged POST carries the attacker's `Origin` against the victim's `Host`, and ingress-nginx overwrites
`x-forwarded-host`, so the header cannot be spoofed past it. `inboundHost`'s own docblock forbids
*echoing* it into a served URL; a comparison is not that. `requestOrigin`'s `PUBLIC_ORIGIN` pinning exists
for OAuth **redirect URIs**, which is a different job with a different failure mode.

⚠️ **This was a regression rather than a pre-existing hole, and the mechanism is worth keeping.** Capture
works on the apex today because the write is a **server action**, and Next's action guard compares `Origin`
against the request's own `Host`/`x-forwarded-host`. Moving the write to a route handler changed the
comparand from *"the host the browser used"* to *"the one canonical host"*. **Any future route handler that
replaces a server action inherits this trap.**

**And a misconfiguration here must be legible.** A wrong allowed-origin refuses every capture with a `400`
that the queue maps to a retry, so it presents to the user as *"waiting to save"* forever and to an
operator as nothing at all. The `400` therefore carries a **distinct** reason from the body-shaped `400`s —
not for the caller, who learns nothing, but so the log line names the origin rule rather than the queue.

**Why it is worth doing when `SameSite=lax` already blocks a cross-site POST:** `logout/route.ts`'s own
comment is explicit that **lax does not block a *same-site* POST**, and the repo chose defence-in-depth
there for a route that merely ends a session. This one **creates rows in a user's inbox**, which is
strictly more valuable to an attacker, so the same reasoning applies at least as strongly.

**The rejection must not reuse the `409` or `403` copy.** Those two carry specific user-facing sentences
about signing in, and a request the user never made has no business producing either — that is the same
message-collapse this document has already been reviewed for twice.

⚠️ **So it needs a sentence of its own, and the wording table had no row for it** — the document required
the copy not to be reused without ever saying what to use instead, which is how a "must not reuse" ends up
reusing. The row is in the table under _What the user sees_, and its shape follows from what the user can
actually do about it: **nothing**. A misconfigured origin rule is an operator's problem, not theirs, and the
`400` is classified retryable, so the honest sentence says the words are still held and will try again, and
names neither an account nor a remedy. The **operator's** legibility comes from the distinct log reason
above, not from this sentence.

⚠️ **The service worker's own `fetch` must still pass.** A worker's `fetch` carries the worker's own
origin, which is the registering origin, so it does — and that means at this route's boundary it is **the
same case as a matching-`Origin` request from a tab**, not a third thing to check. It is called out
because it is the one caller whose breakage would be catastrophic and invisible, being the only path that
works while no tab is open; why a route-level test cannot add anything here is in the testing section.

⚠️ **An earlier draft of that sentence said "from the installed app", and installation is an explicit
non-goal of this spec** — caught in review, and it mattered as more than a wording slip. A service worker
registers from an **ordinary browser tab** on any secure origin; nothing here needs a manifest,
installability or standalone mode, and the non-goals section says every trigger works in a plain tab.
Writing "installed" implies a precondition this design does not have, and a reader could reasonably
conclude the background path is dead until #254 lands. It is not. The same care applies to the phrase
*"while the app is closed"*, which is corrected above to **"while no tab is open"** — an app that was
never installed cannot be closed.

**The `workspaceId` in the body is client-supplied and is never trusted for authorization.** The route
derives the workspace from the cookie exactly as today, then *compares*. A mismatch can only produce a
refusal, never a grant — so the input cannot widen access, only narrow it. This is what closes the
expired-cookie hole without touching the middleware: a queued owner capture flushing into a fresh
guest sandbox now 409s instead of silently landing somewhere invisible.

### Flush triggers

Foreground, in the inbox:

- on mount
- on `visibilitychange` → visible
- on the `online` event
- after any successful submit

Background, Chrome Android:

- `registration.sync.register("capture-flush")` on every enqueue
- `sw.js` gains a `sync` handler that drains **the IndexedDB mirror** through the route

#### The `sync` handler's resolve/reject contract — the platform retries on rejection, and only then

**Unspecified, this decides whether Background Sync works at all, and review of this spec was right to
ask.** The browser retries a `sync` event only if the promise passed to `event.waitUntil()` **rejects**;
resolve and the platform considers the work done and will not come back. So "drain the mirror" is not a
sufficient description of the handler — it needs a rule, and the rule is not "reject on any failure":

| After a drain pass | `waitUntil` | Why |
|---|---|---|
| Mirror empty | **resolve** | Done. Nothing to come back for |
| Anything left for a **retryable** reason (`5xx`, network, `401`, **`409`**) | **reject** | The only way to get another attempt while no tab is open |
| Everything left is marked **`account-revoked`** | **resolve** | ⚠️ **Rejecting here is the bug.** Those entries can never flush, so the platform would retry on its own schedule forever, burn battery, and eventually give up anyway — while the *user-facing* remedy is Discard, which only a foreground tab can offer |
| Mixed retryable and permanently blocked | **reject** | The retryable ones justify another attempt; the blocked ones are simply skipped on each pass |

⚠️ **`409` was missing from that retryable enumeration, and the document then stated its retryability
three different ways** — review of this spec found all three. The enumeration read *"(`5xx`, network,
`401`)"*, a bullet below says *"every `409` is retryable as far as the worker is concerned"*, and the
`409`/`403` split further down said *"neither is retryable"*. **The bullet below is the right answer**:
nothing the worker can read distinguishes a first `409` from a hundredth, so the worker retries it, and
a pass with a `409` left in it therefore has retryable work remaining. The other two are corrected.

**So the handler's exit condition is "no retryable work remains", not "the mirror is empty".** That
distinction is the whole content of this section, and it is the reason the terminal-mark precedence
established for `blockedBy` is load-bearing *outside* the strip too: the worker needs the same "this can
never succeed" signal the copy does, read from the mirrored entry, or it cannot tell the two exits apart.

⚠️ **The worker READS the mark. It never computes one — and this spec previously implied it could.**
Review asked how the worker is supposed to obtain "the live session's resolved workspace" needed to tell a
fresh `409` from one already shown to be unfixable, since that comparison is described elsewhere as
available only to the foreground app. **It cannot, and it must not try.** Resolving a session means reading
a cookie and a workspace the worker has no access to, so:

- **The `blockedUnder` comparison is the foreground's alone.** It runs at render time out of state the app
  is already holding — that is the property that made it better than a `signInTried` flag in the first
  place, and it does not survive being moved into a worker.
- **The worker's input is the persisted `blockedBy` on the mirrored entry**, written by a foreground tab —
  and ⚠️ **`account-revoked` is the ONLY value it treats as terminal.**

  An earlier version of this section said a `session-expired` entry the foreground had judged unfixable
  would be "marked as such before it is mirrored". **There is no such mark.** `QueuedCapture` carries
  `blockedBy` and `blockedUnder`, and neither is a verdict: `blockedBy` says *which* refusal, and
  `blockedUnder` is the raw input to a comparison, not its result. So that table row was unreachable as
  written, which review of this spec caught — and the fix is **not** to add a field.
- **The unfixable-`409` judgement is a COPY decision, not a flush decision, and is deliberately not
  mirrored.** It changes which sentence the strip shows; it never changes whether a flush is worth trying.
  Keeping it out of the worker's input costs one thing, named here so it is a trade rather than an
  oversight: **a capture that will `409` forever keeps drawing background retries until the user discards
  it.** That is acceptable — those retries are cheap, invisible, and bounded by the platform's own backoff,
  whereas a persisted "give up" verdict is a new field that can go stale, and a stale one would abandon a
  capture that a later sign-in *would* have saved. Between a wasted request and an abandoned capture, this
  design has already chosen, everywhere else, to waste the request.
- **So every `409` is retryable as far as the worker is concerned** — the first one and the hundredth
  alike, since nothing it can read distinguishes them. That is the correct outcome rather than a
  compromise: the worker retrying a capture that a later sign-in *will* save is exactly the behaviour
  wanted, and the only thing the worker's ignorance costs is background attempts nobody sees.

⚠️ **And the worker must be able to WRITE a mark, not only read one — which the paragraphs above do not
allow for.** Review of this spec found the hole: they assume every mark is written by a foreground tab, but
a capture's **first** failure can happen purely in the background. The worker flushes, gets a `403`, and
now knows the capture is terminal — with no tab open to record it and no ability to write `localStorage`.
Left there, the worker retries a permanently-refused capture on every sync forever, and the user's strip
eventually shows it as merely *"waiting"* with no explanation, because nothing ever persisted the reason.

**The worker records the mark in the mirror, which it CAN write, and reconciliation propagates it.** That
needs one narrow, explicit carve-out from the reconciliation rule set out **below**, under *"Reconciliation
on mount runs in both directions"*:

> `localStorage` wins on **membership** — which captures exist. **`blockedBy` is not membership, so it
> falls outside that rule rather than contradicting it:** a mark present in the mirror and absent in
> `localStorage` is copied **into** `localStorage`.

⚠️ **This blockquote reproduced the un-narrowed rule it exists to qualify, and pointed the wrong way.** It
read *"`localStorage` wins in every disagreement"* — the form the reconciliation section has since narrowed
to membership — and the sentence introducing it said *"the rule above"* while that rule sits some fifty
lines **below** it. Both are corrected, and the consequence is worth stating rather than leaving as a
wording fix: **under the narrowed rule `blockedBy` was never in the rule's scope at all**, so calling it an
"exception" overstated what is being carved out and invited exactly the generalisation the next paragraph
forbids.

**It is safe in exactly one direction and must not be generalised.** The worker is the only writer that can
learn a refusal while no tab is open, so for this one field the mirror can legitimately be newer. Nothing
else may flow that way: a mirror entry with no `localStorage` counterpart is still **deleted**, never
resurrected, because that rule is what stops the mirror putting back a capture the user discarded or
already saved.

**Precedence still decides the merge**, so this cannot downgrade anything: an `account-revoked` mark in the
mirror wins over an absent one, and a `session-expired` mark in the mirror loses to an `account-revoked`
already in `localStorage`.

⚠️ **The worker may only write `account-revoked`, and never `session-expired`.** Review of this spec found
the gap: a `session-expired` mark is only useful alongside `blockedUnder`, which is *"the workspace the
CLIENT was running under"* — and the worker has no session to resolve, so it cannot compute that value. A
worker writing the mark without it would produce an entry the strip must reason about with half its inputs
missing, and the natural repair (persisting a workspace the worker guessed) is worse than the gap.

**So a `409` the worker observes is left unmarked and simply retried.** It costs one wasted background
attempt per pass and it is self-correcting: the next foreground flush records the mark properly, with
`blockedUnder`, from a session it actually has. `account-revoked` needs no such context — it is terminal on
the status alone — which is exactly why it is the one mark the worker can be trusted with.

**Which means the mirrored entry has to carry `blockedBy`, not just the capture.** Stated here because the
mirror is described above as "a cache of the real thing" and a reader could reasonably mirror only the
fields the `POST` body needs, which would silently remove the worker's only way to skip a terminal entry —
and put it straight back into rejecting forever.

**Failures are per-entry, not per-pass.** One capture's `5xx` must not stop the pass from trying the rest —
otherwise a single stuck entry blocks the queue behind it, which is the head-of-line failure this design's
whole premise refuses. Drain everything, then decide the promise.

⚠️ **An earlier draft of that second bullet said the handler drains `df-capture-queue`, which is the
`localStorage` key.** It cannot: the next paragraph says so in the same breath, and review of this spec
caught the contradiction. The worker's *only* view of the queue is the mirror.

The worker cannot read `localStorage`. The queue is therefore mirrored into IndexedDB **for the
worker's benefit only** — a single object store, treated as a cache of the real thing.

**And it cannot write `localStorage` either, which has a consequence worth stating rather than
discovering.** When the worker flushes a capture successfully it can remove that entry from the mirror
and nothing more; `localStorage` still lists it as waiting until a foreground tab next runs. So on the
next open, reconciliation re-mirrors it (the second direction below), the foreground flush re-`POST`s it,
and the route answers `200` — *already saved* — which removes it from both stores.

**The `clientKey` idempotency column is what makes that safe, and it is load-bearing in a way that is
invisible from either side.** Without it the worker's success would become a duplicate row on the next
open. Read this paragraph before simplifying either the mirror reconciliation or the idempotency column:
each looks redundant while the other stands. The cost of the arrangement is **one redundant `POST` per
worker-flushed capture**, paid once, and that is the right trade against the worker being unable to
report back at all.

The ordering matters and is the reason this is not simply "use IndexedDB": the `localStorage` write
completes synchronously inside `submit()`, and the IndexedDB write is *initiated* in the same block
but settles later. So the durability guarantee is carried entirely by `localStorage`, which is also
the source of truth for the UI. If the tab is discarded between the two writes, the foreground flush
recovers the item on next open and the background flush simply has nothing to find — the failure mode
is a delayed save, never a lost one.

**Reconciliation on mount runs in both directions, and the second one is the point.** `localStorage`
wins on **membership** — which captures exist — and "wins" resolves to two different actions:

- an IndexedDB entry with **no** `localStorage` counterpart is **deleted** — it was already saved, or
  the user cleared it, and a mirror is not allowed to resurrect it;
- a `localStorage` entry **missing** from IndexedDB is **re-mirrored**, and `sync` is re-registered
  for it.

⚠️ **`blockedBy` is the one field where the mirror may be newer, and it sits outside the line above rather
than contradicting it** — see *"the worker must be able to WRITE a mark"* in the flush-triggers section. The
worker is the only writer that can learn a refusal while no tab is open, and it cannot write
`localStorage`, so a mark present only in the mirror is **copied in**. Membership is unaffected: the
carve-out moves a *field* onto an entry that already exists on both sides, and never adds or revives an
entry.

Only the first direction is obvious, and stopping there would have left a real hole. The paragraph
above concedes that the IndexedDB write settles *after* the synchronous `localStorage` write, so a tab
discarded between the two — the exact thing Chrome Android does, and the whole reason this design is
not in-memory — leaves a capture that is durable but **invisible to the worker forever**, because
nothing else ever writes the mirror. That capture is not lost: the foreground flush still finds it on
next open. But it would silently fall out of Background Sync, so the *only* path that works while no tab
is open would cover an arbitrary subset of the queue, and no test asserting "the item survived"
could see it. Re-mirroring is what makes the mirror eventually complete rather than best-effort.

Both directions are asserted, and separately — the delete direction passes on its own against a
one-way implementation, which is how this gap survived the first draft of this spec.

On Safari and Firefox the `sync`
registration no-ops and the foreground triggers are the whole mechanism; the feature degrades to the
foreground-only design with no code branch of its own beyond a capability check.

### What the user sees

A collapsed strip **docked directly under the capture bar**, in the slot #210's failure notice already
occupies. It costs zero height when the queue is empty.

```
+----------------------------+
| Inbox                      |
|                            |
| [ Brain dump anything... ] |
|  [!] 3 waiting to save  v  |
|      [ Retry now ]         |
|                            |
| o ring mum re: boiler      |
| o find the passport        |
+----------------------------+
```

Expanded, it lists the queued text so the words are always readable and copyable. Nothing queued ever
appears in the inbox list itself: a dimmed row still reads as *"in my inbox"* to someone scanning, and
that is the shape of the lie #210 was filed for.

#### Each expanded entry has a Discard control — without it the feature dead-ends

**An earlier draft of this document assumed a way to clear a queued capture and never designed one, and
that is not a missing nicety, it is a dead end.** Two of the refusal states are **permanent**: an
`account-revoked` `403`, and a `session-expired` `409` whose `blockedUnder` comparison has already shown
a sign-in will not help. Those entries can never flush, and with no way to remove them they sit in the
queue forever.

⚠️ **The reason this paragraph gave was wrong, and the real one is worse.** It said *"twenty of them
exhaust the 20-item cap permanently — the user can never capture again"*, which the cap split under *"A
shared browser"* contradicts: **the item cap counts per workspace**, and a permanently-blocked entry
belongs to a workspace the live session no longer resolves to, so it is not counted against the capture
being attempted now. Two other properties strand the user instead, and Discard is still the only exit:

- **The byte cap counts every entry in the key, origin-wide.** A stranded long capture consumes it
  forever, so the next offline capture that does not fit is refused with *"no room to hold more until some
  of these save"* — a wait for something that can never happen. That is a **denial of capture**, and it is
  the residual the shared-browser section names. Orphan expiry bounds it only for a workspace that has
  become *unresolvable*; a **frozen** account's workspace still resolves perfectly well, so an
  `account-revoked` entry is never collected by it.
- **They are stranded *and* invisible.** An entry whose workspace can never resolve again is neither
  saved nor shown as text — the one outcome this document forbids — while still being held.

The app would still be bricked by its own safety mechanism. The mechanism doing the bricking is the byte
cap, not the item cap.

It is also the missing half of copy this document already commits to. **The refusal messages tell the user
to copy their words out.** ⚠️ **This sentence said "three of the refusal messages"** — four of the rows in
the wording table below carry that exact phrase and a fifth offers the same advice in different words, so
the count was stale the moment a row was added. It is not a number this argument needs. **Advice to copy
something out, with no way to then put it down, is not advice.** The user does the copying and is left with the queue exactly as full as before.

So each expanded entry carries a **Discard** control:

- It is **destructive and irreversible**, so it takes the app's two-step confirm — the same pattern every
  other delete uses, and it is the reason the entry's text is displayed rather than truncated: the
  confirm has to be made against words the user can actually read.
- It removes **one** entry. There is no "clear all": the cap is 20, the states that strand entries strand
  them individually, and a single control that discards twenty captures at one press is the wrong thing
  to put next to a queue whose entire purpose is not losing words.
- **It is not a flush and does not reach the network.** A discarded capture was never saved and is not
  being deleted from the server — the copy must not imply either.
- ⚠️ **Discard must delete from the IndexedDB mirror FIRST, then from `localStorage`, and the order is the
  whole fix.** Review of this spec found that as written the promise above is false: the mirror is cleaned
  only by mount-time reconciliation, so a `sync` event firing between the discard and the next mount would
  find the entry still there and **`POST` a capture the user had just discarded.** Nothing in the design
  stopped that, and it is the one outcome a Discard control must never produce.

  **Mirror first, because the two failure directions are not equally bad:**

  | If the second delete does not land | Result |
  |---|---|
  | **Mirror deleted, `localStorage` not** | The capture is still queued and still visible. It gets re-mirrored on next mount. Annoying, honest, recoverable — the words are on screen |
  | **`localStorage` deleted, mirror not** | The worker flushes a capture the user was told was discarded. **A silent save after an explicit refusal, unrecoverable, and a broken promise** |

  So the residual after this ordering is *"a discard may not stick if the tab dies mid-press"*, which is
  the same shape as every other exit in this design: **persisted, or refused and still visible.** There is
  no ordering that makes both deletes atomic, and pretending otherwise is what produced the gap.
- ⚠️ **Mirror-first closed the worker path and left the foreground's own flush open, in both directions.**
  Found in review of this spec. The ordering above is about a `sync` event firing between the two deletes;
  this is about the tab the user is looking at already having a `POST` in flight for the very entry they
  are confirming, which the two-step confirm makes *likelier* rather than rarer by putting a human pause
  in the middle of it:

  | The confirm resolves… | What happens as written |
  | --- | --- |
  | **after that entry's flush returned `201`** | The entry has already left the queue, so Discard is a **silent no-op** — over a capture that is now in the inbox, which the user will find later having been told it was thrown away |
  | **while a `POST` for it is in flight** | Both deletes land, the request returns `201`, and the row is written. That is *"a silent save after an explicit refusal"* — the outcome the table above calls unrecoverable and a broken promise |

  **So Discard is refused for an entry with a flush in flight**, and the reason is said rather than the
  control silently disabled: the flush is bounded at `CAPTURE_TIMEOUT_MS`, so the wait is short and
  nameable. **And when the confirm resolves against an entry that is no longer queued, the strip says it
  saved** — *"that one saved just before you discarded it; it's in your inbox now"* — rather than doing
  nothing. Silence there is the same defect as a silent save, one step further along: the user pressed a
  destructive control, was shown nothing, and the words are somewhere they were told they would not be.

- **The confirm is what makes the ordering affordable.** Discard already takes the app's two-step confirm,
  so there is a natural point at which to start the mirror delete and await it before touching
  `localStorage` — no user-visible latency is being added to a single press.
- The polite live region announces the new count; the entry's removal is not itself an alert, because the
  user asked for it. (See the a11y section: an assertive region is for things that happen *to* the user.)

⚠️ **The cap deliberately still counts blocked entries.** Exempting them would let the queue grow without
bound, which reintroduces the `QuotaExceededError` the byte cap exists to prevent. Discard is the release
valve, and it is the user's to pull — the design does not silently evict on their behalf, which is the
rule the item cap is built on.

Accepted cost of docking it here: if a flush happens while the user is scrolled deep in the list, the
strip is off-screen. That is the trade for spending no fixed-position height on a viewport #253 just
decluttered, and it is recorded here so it is not rediscovered as a defect.

**Wording.** The strip never says "offline" — `navigator.onLine` is not trustworthy enough to assert
it. It says what is true, and each state gets its own sentence because each has a different remedy:

| State | What it says |
|---|---|
| waiting | *"3 waiting to save"* |
| `blockedBy: "session-expired"` (409), live session still resolves to `blockedUnder` | *"Your session expired. Sign in and these will save."* |
| `blockedBy: "session-expired"` (409), **live session resolves to something other than `blockedUnder`** | *"These can't be saved to this account any more. Your words are still here — copy them somewhere safe."* — no sign-in offered, because it has already been tried and did not work |
| `blockedBy: "account-revoked"` (403) | *"This account can no longer save. Your words are still here — copy them somewhere safe."* — no sign-in offered, because signing in will not help |
| item cap reached | *"20 captures are already waiting to save — that's the limit until some of them go through. Your words are still in the box; copy them somewhere safe if you need to."* |
| **one capture** over the byte bound | *"That capture is too long to hold safely while offline. Your words are still in the box — shorten it, or copy it somewhere safe."* |
| **queue total** at the byte bound | *"There's no room to hold more until some of these save. Your words are still in the box; copy them somewhere safe if you need to."* — no "shorten it", because the capture's own length is not the problem |
| **storage refuses the write** (`QuotaExceededError`) | *"This browser can't store anything more right now, so this one isn't safe to hold. Your words are still in the box — copy them somewhere safe."* — no wait offered, because nothing queued here would free the space |
| **the origin check refused the request** (`400`, CSRF) | *"Something blocked this from reaching the server, so it's still waiting here. Nothing is lost — it'll try again."* — no sign-in offered and no account mentioned, because the user did nothing wrong and nothing about their account is implicated |

**Why `409` needs two sentences and not one: a purged guest sandbox makes the sign-in promise false.**
A guest workspace is a real workspace **with a TTL**. If it is purged, signing in does not restore it —
a fresh guest sandbox gets a **new** `workspaceId`, so the queued capture's declared `workspaceId` can
never be resolved again and the flush 409s **forever**. *"Sign in and these will save"* is then a
promise the app cannot keep, and repeating it indefinitely is the same defect as the `409`/`403`
collapse round 1 caught: **copy that sends the user to a remedy which cannot work.**

**The fix is client-side, and deliberately so.** The server must not distinguish "that workspace was
purged" from "that workspace isn't yours" in its response — the two are the same `409` precisely because
telling a caller which one it is would leak the existence of a workspace to someone who supplied its id,
and this route's whole security property is that the declared `workspaceId` can only ever *narrow*
access. So the server keeps saying `409` and says nothing more.

**How the client detects that a sign-in has happened — an earlier draft of this section leaned on the
notion without specifying it, which is a gap that would have reached implementation.** It does not detect
a sign-in as an *event*: there is no event to hook, because a sign-in leaves the app by full navigation to
`/login` and returns as a fresh boot. What it compares is **the workspace the live session resolves to**,
which the app already holds because it needs it to make a capture at all:

- when a `409` is recorded, store that live value on the entry as `blockedUnder`. **Not** the capture's own
  `workspaceId` — that is the value the `409` disagreed with, and it never changes;
- on any later `409`, if the live session now resolves to something **other than** `blockedUnder`, the
  session changed between the two refusals and the capture is *still* refused. The remedy has been taken
  and has failed, so the copy withdraws it.

No new server state, no new response code, no existence oracle — just refusing to repeat a claim the app
has already watched fail.

⚠️ **This replaced a `signInTried` boolean, and the derived form is better for a reason worth keeping.** A
flag has to be *set* by whichever code path notices the sign-in — and that is exactly the code path that
does not exist, since there is no sign-in event in the app. A flag nothing sets reads false forever, which
is **precisely the forever-promise bug it was added to fix**. `blockedUnder` cannot fail that way: the
comparison is made at render time out of state the app is already holding, so there is no moment at which
someone has to remember to write it.

⚠️ **And it is not the same as `403`**, even though the two second sentences are nearly identical. `403`
knows on the *first* attempt that signing in cannot help. This state can only be **learned by trying**,
which is why it is a comparison rather than something the server could ever hand over, and why `blockedBy`
alone cannot encode it. `blockedUnder` is persisted for the same reason `blockedBy` is: otherwise the
comparison dies on the reload a discarded tab forces.

#### The `403` copy is reachable — #220 does not bounce a frozen account anywhere, but it *does* sign them out

**Review of this spec asked whether the `403` copy is dead**, on the reading that #220 already clears the
session and redirects a revoked account to `/login`, so nobody would ever be looking at the strip when it
appeared. **Checked in the tree rather than reasoned about, and the premise does not hold** — but the
check turned up a different problem, in the flush table rather than the copy.

**#220 clears the session; it redirects nothing.** `clearOwnerSession` (`src/lib/workspace.ts`) deletes
the owner cookie and says outright what happens next: *"The next request carries no owner cookie,
`src/proxy.ts` mints a guest sandbox, and the app works normally for a signed-out visitor."* The only
`/login` redirects in `src/proxy.ts` are the two gate checks, and they fire on `OWNER_ONLY_PREFIXES` —
**currently empty** — and `AUTHENTICATED_PREFIXES`, which is `/api/account/` and `/api/google/oauth/`.
The inbox is in neither, so it renders. Bouncing a frozen person to `/login` with an explanation is the
**missing** half of #220, recorded in that function's own comment as needing a gate that can read a
status, and tracked as **#231 — "A frozen account now meets Next default error screen, not a real page"**.
So the `403` sentence is on screen, in front of a user who is still on the page. It is not dead copy.

⚠️ **What the check did find: the clear happens inside the same Route Handler that answered `403`, and
that turns the next refusal into a `409`.** `clearOwnerSession` is best-effort only during a Server
Component render, where Next seals the cookie jar; in a **Route Handler the delete lands**, and
`POST /api/braindump` is a Route Handler. So the sequence is:

1. flush → `403` → the entry is marked `account-revoked`, and the owner cookie is deleted in that same
   response;
2. next flush → no owner cookie → a fresh guest sandbox, which cannot resolve the capture's declared
   `workspaceId` → **`409`**;
3. the entry's mark is overwritten with `session-expired`, and the strip goes back to *"Your session
   expired. Sign in and these will save."*

**That is the forever-promise defect again**, arriving by a route neither the `403`/`409` split nor
`blockedUnder` covers: `blockedUnder` compares two `409`s, and here the first refusal was a `403`.

**So `account-revoked` is terminal, and the flush table's mark rule is a precedence rather than an
assignment:** `account-revoked` > `session-expired` > unmarked. A `409` over `account-revoked` leaves it
alone; a `403` over `session-expired` upgrades; and a `retry` — which clears a `session-expired` mark,
because reaching a retryable failure proves the guard is no longer what is stopping the capture — does
**not** clear `account-revoked`, since a `5xx` is no evidence an account was un-frozen.

**Stickiness is not a trap, and the reason belongs next to the rule.** The mark is not what blocks the
flush; the server is. If an owner un-freezes the account and the user signs in again, the flush answers
`201`/`200`, and **a successful outcome removes the entry outright regardless of its mark** — so the only
thing terminality costs is a wrong sentence, which is exactly what it buys back. Discard remains the
user's release valve either way.

#### a11y — two live regions, and what each of them is allowed to say

The strip carries **two live regions, not one whose `role` changes.** A polite
`role="status"` announces the waiting count and the in-flight wait (neither is an interruption); an
assertive `role="alert"` announces **every refusal state that occurs while the page is open** — the
qualifier is load-bearing and is the subject of *"A refusal restored from storage"* below, because a
refusal read back out of `localStorage` must not be announced at all. Each element's `role` is **fixed for the lifetime of the
strip**, and each is **mounted empty from the strip's first paint** and then filled. (Stated as "every
refusal" rather than by counting them, because the count has now changed twice under review and a
sentence that enumerates states goes stale the moment one is added. ⚠️ **This parenthesis was followed by
an enumeration of the states** — the two `blockedBy` values, the `409`-after-sign-in transition and "all
three cap-reached states" — which is the thing it says it is avoiding, and it was already stale: there is
now a fourth cap-family refusal, the storage one below.)

Both halves of that are load-bearing:

- **Swapping one element's `role` between `status` and `alert` is not a reliable announcement.** A live
  region's politeness is registered when the element is recognised as a region; mutating the attribute
  on an element that is already one leaves whether the change takes effect — and whether the new text
  re-announces at all — down to the screen reader. The observable failure is the worst kind: silence,
  on the states that most need to be heard (a revoked account, a refused capture).
- **The two regions are siblings, never nested.** `write-notice-hygiene` rule D exists for this: a
  polite `role="status"` inside an assertive `role="alert"` inherits the container's politeness across
  the whole subtree, so "will it announce politely" has no answer. That was #218's defect and the gate
  now blocks it, so a single role-swapping element would not have survived CI anyway — the sibling
  pair is the repo's existing contract, not a new pattern.
- **Mounted empty, for the reason `inbox-view.tsx`'s notice already documents:** a region that arrives
  together with its first message is silent. Kept identical in shape to that notice and
  `focus-timer.tsx`'s on purpose — those two drifted apart once already, which is what produced #236.

#### A refusal restored from storage is static text, never an assertive announcement

⚠️ **Raised in review of this spec, and it is a real defect in the design as written.** `blockedBy` is
persisted precisely so the reason survives the reload a discarded tab forces — which means on **every**
page load the assertive region goes from empty to filled. A screen reader treats that as a live change and
**interrupts** with *"Your session expired. Sign in and these will save."* The user did nothing, and
nothing happened. This section's own rule is that an assertive region is for things that happen *to* the
user, and a state read back out of `localStorage` did not just happen to anybody.

So the refusal copy has two homes and only one of them is a live region:

- **A restored refusal is static text**, rendered with the entry and associated with it — and, because the
  refusal is also why the capture bar's submission failed, associated with the **input** through
  `aria-describedby` (**WCAG 3.3.1 Error Identification**, which wants the error available *with the
  field*, not only announced once and gone). Readable on demand, at any time, by anyone navigating the
  strip.
- **The assertive region carries transitions only** — a refusal arriving while this page is open. It is
  filled by a flush outcome and never by a mount.

**The polite region takes the same rule and needs it less.** A restored count is not an interruption
either, but a screen reader reading *"3 waiting to save"* once on load is at worst noise rather than a
false alarm. Assert it anyway: the mechanism is identical and the assertion is one line.

#### The in-flight wait must be announced — `write-notice-hygiene` rule E

⚠️ **`write-notice-hygiene` has five rules, this document named one, and the rule it did not name is
violated by the design as written.** Rule D is cited above. **Rule E is the gap: _"the in-flight wait is
announced by a live region, not by a description."_** Nothing here announces the wait — Retry takes
`aria-disabled`, the flush runs, and a screen-reader user gets silence between the press and the outcome.
That is the failure the repo records as having **shipped green four times** (#210, #218, #225, #246),
because every other check in the suite is per-file and none of them can see a *missing* message. This gate
is the only thing in the repo that can, which is exactly why naming rule D and stopping was not enough.

**So the wait is announced, and the polite region carries it.** *"Saving 3 captures…"* into the
`role="status"` region when a flush starts, replaced by the count when it resolves or by the refusal in the
assertive one when it does not. **Deliberately not a third region:** the count and the wait are the same
channel — background progress the user did not ask to be interrupted by — and they are mutually exclusive
in time, whereas two polite regions competing on one strip is its own drift trap. `aria-describedby` from
Retry to that region **as well** is what #210 does and is welcome; what rule E rejects is a description
*instead of* a region. The shape to copy is `capture-saving-announcer` in
`src/components/inbox/inbox-view.tsx`, and `focus-timer.tsx`'s equivalent, which #236 records as having
drifted apart once already.

**And `a11y-class-hygiene` applies to this strip, which the document also did not say.** Two of its rules
land here, and both cover things no other check in the repo can see:

- **The refusal copy only paints when a refusal occurs.** That is #109's blind spot exactly — axe measures
  what is on screen during the scan, and every sentence in the wording table above is state-dependent, so
  a shade-discipline failure in any of them is structurally invisible to the contrast gate and the axe
  baseline alike.
- **`outline-none` on the new controls** — Retry, the collapse toggle, Discard, the two-step confirm, and
  the discard-without-revealing control on the collapsed row. **Every one of them needs an author-drawn
  focus indicator**, and **axe does not implement the check at all**. A focus indicator that is only a
  background swap passes every other gate in the suite; #117 is the precedent.

  ⚠️ **The criterion, stated correctly — and an earlier version of this bullet had it wrong in exactly the
  way this document already caught once for target size.** It said *"WCAG 2.4.11 Focus Appearance, AA"*,
  which conflates a number with a different criterion's name:

  | Criterion | Name | Level | What it is about |
  | --- | --- | --- | --- |
  | **2.4.7** | Focus Visible | **AA** (WCAG 2.0) | **An indicator exists at all — this is the bar these controls must meet** |
  | 2.4.11 | Focus **Not Obscured** (Minimum) | AA (WCAG 2.2) | The focused control is not hidden behind other content. A different concern; nothing here measures it |
  | 2.4.13 | Focus **Appearance** | **AAA** (WCAG 2.2) | The indicator's size and contrast. The stronger bar, and not AA |

  So: **`outline-none` without a replacement fails 2.4.7 at AA.** A replacement that is *only* a colour
  swap is what `a11y-class-hygiene` additionally rejects, and that reach is toward **2.4.13 at AAA** — a
  bar this project has chosen to hold, which is worth knowing is a choice rather than a requirement.

  ⚠️ **The same mislabel is in the repo's own control**, not just here — `src/lib/a11y-class-hygiene.ts`
  names *"WCAG 2.4.11 Focus Appearance"* in five places including *"is AA in WCAG 2.2"*, and `CLAUDE.md`
  repeats it. **That is a compensating control misnaming the criterion it enforces**, which matters because
  it is read precisely when somebody is deciding whether a change is compliant, and it reports the wrong
  level. Filed separately — it is the repo's control, not this design's, and correcting it here would make
  a docs-only MR touch `src/`.

#### Target size, the disabled Retry, and the announcements that do not repeat

Retry carries `aria-disabled` while a flush is in flight, mirroring #210's contract, and is ≥44×44 px.
⚠️ **The criterion cited for that size was wrong: `2.5.5` is AAA.** The AA target-size criterion in WCAG
2.2 is **`2.5.8` Target Size (Minimum), 24×24 CSS px**. Committing to 44×44 is right and is kept — it
clears both — but citing an AAA number as the AA bar, in the document that *is* this feature's a11y
contract, is the defect rather than a pedantic one: a later reader either reads 44×44 as the line and
treats a legitimate 32×32 control as a regression, or reads `2.5.5` as the standard this repo holds and
mis-scopes everything else against it.

Four more contracts, each of which fails silently if it is left to the implementer:

- ⚠️ **`aria-disabled` does not prevent activation — the handler must refuse as well.** It is an ARIA
  attribute, not the `disabled` property, and that is deliberate for the reason `inbox-view.tsx`'s own
  comment gives: *"a disabled element cannot hold focus, so the browser would drop it to `<body>` the
  moment the retry starts."* The consequence is that the button stays activatable, so Enter or Space on a
  "disabled" Retry fires **a second flush** over the first. #210 guards the press in the handler; this
  design inherits the attribute and must inherit the guard with it, or the attribute is decoration.
- ⚠️ **An identical assertive message re-set is not reliably re-announced.** Two consecutive cap refusals
  carry the *same* sentence, so writing it into `role="alert"` twice leaves the second **silent** — the
  user presses Enter against a full queue, is refused, and hears nothing at all. The region must be
  cleared and set on a later tick so the text genuinely changes. Same class of failure as the role-swap
  above: the DOM holds the right words and the screen reader never said them.
- **`aria-expanded` on the collapse toggle** (**WCAG 4.1.2 Name, Role, Value**). The strip's whole premise
  is that the words stay readable on demand, and a toggle that does not report its state leaves a
  screen-reader user unable to tell whether the queue is on screen.
- **Debounce the polite region.** A drain of twenty entries emits twenty count changes, and twenty polite
  announcements queued back to back is a screen reader talking for a long time about a background event.
  Coalesce on a short timer and announce the count the drain settled on.

#### Focus, on unmount and on Discard

When the strip unmounts on the last item saving, focus returns to the input only if it was inside the
strip — the one-shot ref pattern of `returnFocusToInput` and its effect in
`src/components/inbox/inbox-view.tsx` (**WCAG 2.4.3 Focus Order**).

⚠️ **That was this document's only focus commitment, and it leaves Discard destroying focus.** Discarding
entry 3 of 5 removes the focused element while the strip stays mounted, so the unmount path never runs and
the browser drops focus to `<body>` — the user's place in the page is gone, and on a screen reader the next
key press starts from the top of the document. It is also the *more* common press of the two, since the
unmount case needs the queue to empty. So:

- **Discard moves focus to a stable anchor as the entry goes** — the next entry's Discard control, or the
  strip's collapse toggle if the discarded entry was the last expanded one, or the capture input if the
  strip is about to unmount. Never `<body>`.
- **The two-step confirm needs an accessible name, and focus moved into it.** A confirm that appears
  without taking focus is invisible to a screen reader until it is hunted for, and the name has to say what
  is being discarded. For the collapsed stranded row that name is the **count and the origin**, never the
  text — the whole point of that control is that the words cannot be shown.
- **Focus returns to a stable anchor on both confirm and cancel.** Cancel returns it to the Discard control
  it came from; confirm follows the rule above. Both arms, because a cancel that drops focus is the same
  defect arriving on the path where the user chose to change nothing.

### Multi-device dissolves by construction

A phone and a laptop both queueing offline is the ordinary case, and capture-only makes it a non-event:
two devices produce two different `clientKey`s and insert two different rows. There is nothing to
merge, no last-write-wins, no vector clock. This is the strongest argument for the capture-only
boundary and the reason the multi-device question in #175's description needs no answer rather than a
clever one.

### Privacy notice

User-typed text in browser storage is a new category for this app, and the notice currently promises
the opposite by omission — it names browser storage once and pins it to a theme preference that
"never leaves your device".

Required in **MR 2**, the MR that first writes user text to storage (see _Sequencing_):

- a companion sentence in the "your data lives on servers in the UK" section, saying a capture that
  cannot reach the server is held in this browser until it saves, and that it is sent to the same
  servers as any other capture
- `df-capture-queue` added to the storage list, with its retention (until saved, or until the user
  clears it)
- ⚠️ **the IndexedDB mirror named too, and this list omitted it.** Found in review of this spec. The mirror
  is not an implementation detail of the `localStorage` key — it is a **second at-rest copy of the same
  user-typed text**, in a different store, written on a different schedule, and deleted on a different
  trigger (mount-time reconciliation, or the worker's own success). A notice that lists one and not the
  other is **inaccurate on the day it ships**, on the page UK GDPR Art. 13 makes load-bearing. Its
  retention is *"until the entry saves, or until reconciliation finds it gone from the queue"*, which is
  not the same sentence as the key's and cannot be covered by it.
- `LEGAL_EFFECTIVE_DATE` bumped

`src/lib/legal-fingerprint.test.tsx` hashes the rendered text of both legal pages, so CI reds until the
date moves. That gate is the reason this cannot be forgotten. ⚠️ **It is not a reason the sentence will be
right.** A fingerprint greens a wrong sentence exactly as happily as a right one — it can only tell that
the prose changed, never that it became true. The mirror bullet above is the case in point: a notice
listing `df-capture-queue` and nothing else would have shipped green.

## Testing

TDD, failing test first, in this order:

1. **Queue module** (`src/lib/capture-queue.ts`, pure) — enqueue, ordering, removal on `200`/`201`,
   retention on `409`/`403`/`5xx` **with the two `blockedBy` values asserted separately** (a test that
   only checks "it was kept" would pass the collapsed-state bug this spec was reviewed for), clearing
   `blockedBy` on `5xx`, corrupt-JSON recovery, `QuotaExceededError` recovery. No React, no DOM.
   - **All four refusals in the cap family get separate tests** — the 20-item bound, the queue **total**
     reaching 64 KB, **one** capture exceeding 64 KB on its own, and a `setItem` that **throws
     `QuotaExceededError`** — because a single "the capture was refused" assertion passes a collapsed
     implementation, and each of the four carries a different sentence. The storage one asserts the two
     things it must not do as well as the refusal: **nothing already queued is evicted**, and the copy
     offers no wait. ⚠️ **Why they are distinct states is argued once, in the byte-condition table above
     and the storage section beneath it; it is deliberately not restated here.** Review of this spec
     flagged that reasoning as appearing in three places, which is a drift trap: the copy for these states
     has already been corrected twice, and three copies of the argument is how one of them ends up
     describing a rule the other two no longer follow. ⚠️ **This item said "three", which was correct
     until `QuotaExceededError` acquired a specification and a sentence** — it was listed as a test on the
     line above with neither.
   - The 20th-and-21st capture is its own test: the 20th must save and the 21st must be refused **with
     the words still in the field**, which is the assertion that stops the cap becoming silent eviction
     in a later refactor.
   - **The precedence is asserted in both directions, and `account-revoked`'s stickiness is asserted
     against all three of the outcomes that could erase it.** ⚠️ **This list named the wrong three** —
     review of this spec caught it. It said *"`403` then `409`, `403` then `5xx`, and `403` then `403`"*,
     but a second `403` re-asserts the same mark and so can erase nothing, and **`401` was missing** even
     though it is one of the two outcomes that clear a `session-expired` mark. The three that could erase
     `account-revoked` are the three that clear its weaker sibling: `403` then `409`, `403` then `5xx`,
     and `403` then `401` all leave `account-revoked` in place; `403` then `201`/`200` **removes the entry**,
     which is the test that proves stickiness is not a permanent trap. The unchanged direction needs its
     own tests or a "never overwrite anything" implementation passes: `409` then `403` must **upgrade**,
     and `409` then `5xx` must still **clear**. The sequence that makes this non-optional is #220's —
     the owner cookie is deleted in the same response that answered `403`, so the very next attempt is a
     guest and `409`s, and a plain last-write-wins therefore re-offers a sign-in to a revoked account on
     the *second* flush, every time.
   - **The strip is scoped to the live workspace, and the caps split.** A queue holding entries for two
     workspaces renders only the current one's — asserted with a **non-empty** other-workspace set present,
     so a filter that returns nothing cannot pass. The **item** cap counts per workspace (20 of A's entries
     do not block B's first capture); the **byte** cap counts every entry in the key (A's bulk *does*
     refuse B, with the room-not-ownership copy). Both directions, because getting the split backwards
     passes any test that only checks "a cap fired".
   - **`clientKey` generation, per tier.** Tier 1 and 2 exercised where `crypto` is present; tier 3 driven
     by removing `crypto` from the global, asserting the `clk-` prefix, the padded widths, and — the one
     that matters — that **two calls in the same millisecond differ**. A collision silently makes a distinct
     capture look like a replay and loses it, so the counter is the assertion, not the format.
   - **The mirror's `blockedBy` carve-out, in both directions.** A mark present in the mirror and absent in
     `localStorage` is **copied in**; a mirror entry with no `localStorage` counterpart is still **deleted,
     not resurrected**. The second is the control: an implementation that generalised the carve-out into
     "the mirror can be newer" would pass the first test and fail this one.
   - **The CAS bound is three.** A store that changes under every read must produce a write on the third
     attempt rather than a refusal — the deliberate last-attempt behaviour, and the thing a reader is most
     likely to "fix" into a refusal.
   - **`isQueuedCapture` validates `blockedBy`, with a passing control.** A stored entry carrying a value
     outside the union is rejected; entries carrying **each** valid value, and entries carrying none, are
     kept. The kept cases are the point — a guard that rejected everything would satisfy a test that only
     asserted rejection, and this is the field that selects the user-facing sentence.
   - **`blockedUnder` is asserted as a comparison, not a flag:** a `409` sets
     `blockedBy: "session-expired"` plus `blockedUnder` = the live session's workspace, and offers a
     sign-in; a later `409` arriving while the live session resolves to a *different* workspace
     withdraws the offer. Both arms are separate tests, **and one of them asserts that the offer is
     still made when the live workspace is unchanged** — without that, an implementation that withdraws
     the sign-in immediately passes, and a user whose session merely expired is told their words can
     never be saved. A test that only checks "a 409 keeps the capture" passes both bugs.
2. **Route** (`src/app/api/braindump/route.ts`) — same `clientKey` twice yields **one** row;
   workspace mismatch yields `409` **and no row**; frozen account yields `403` and no row; the guest
   arm still works for a genuine guest.
   - **CSRF, both arms**: a mismatched `Origin` is refused **and writes no row**; a **missing** `Origin`
     is allowed, because that arm is a deliberate decision and a test is what stops someone "tightening"
     it later and breaking non-browser callers.
   - ⚠️ **There is no third arm, and asking for one was a request for coverage the test could not
     have.** This item said *"all three arms"* and named *"the service worker's own request passes"* as
     the third. In the `node` test environment a worker's `fetch` is byte-identical to a same-origin
     `fetch` from a tab: it carries the registering origin in `Origin`, so the request under test **is**
     the matching-origin case the first arm already covers. A third test would assert the same thing
     twice while reading as though it had exercised the worker — the shape of false coverage this repo's
     hygiene tests exist to catch. The worker path is a claim about which `Origin` a worker sends, which
     is a platform guarantee, not a branch in this route; it is asserted in the worker tests (5) where
     there is a worker to assert about.
   - The CSRF refusal **does not** carry the `409` or `403` user-facing copy. Asserted, because those
     sentences tell the user to sign in, and a request they never made must not.
3. **Migration** — the `@@unique([workspaceId, clientKey])` index exists, the same `clientKey` in two
   different workspaces yields two rows, and multiple null `clientKey`s coexist. This gets **its own
   integration test** (`src/lib/braindump-client-key-unique.integration.test.ts`) and is **not**
   registered in `enum-constraint-sync.integration.test.ts` — an earlier draft of this section said it
   was, and that was wrong. That test queries `pg_constraint WHERE contype = 'c'`: it polices CHECK
   constraints and the enum, array-containment, numeric-range and text-length registries. A unique
   *index* is not a CHECK and is invisible to it, so adding a line to its registry would have asserted
   nothing while reading as covered.
4. **`inbox-view.tsx`** — the strip's **content** renders only when the queue is non-empty, and the
   flush triggers fire. ⚠️ **This item said "the strip renders only when the queue is non-empty", and
   that contradicted the a11y contract in the same breath as asserting it.** If the live regions arrive
   with the strip then the strip's first paint *is* their first message, which is exactly the
   silent-region failure the a11y section cites. The correct reading is the one *What the user sees*
   already gives — *"it costs zero height when the queue is empty"*: **the region pair mounts
   unconditionally at zero height**, and only the count, the entries and the controls are conditional.
   Assert both halves, because an implementation that gates the whole strip passes a test that only
   checks the empty case is invisible.
   - **Discard is its own test**: it removes exactly one entry, takes the two-step confirm, reaches no
     network, deletes from the **mirror before `localStorage`**, and — the assertion that matters —
     **a queue of 20 permanently-blocked entries can be emptied back to a usable state**, which is the
     dead-end this control exists to prevent.
   - **Discard against a flush in flight, both directions.** An entry with a `POST` outstanding **refuses**
     the discard and says so; a confirm resolving against an entry that has already left the queue **says
     it saved** rather than silently doing nothing. Both are assertions about what the user is told, not
     just about the store, because in both cases the store ends up in the state a naive implementation
     would also reach.
   - **Two sibling live regions with fixed roles**, both present and empty before the first message: the
     polite one carries the count, the assertive one carries the refusals, neither is nested in the other
     (`write-notice-hygiene` rule D also blocks that mechanically), and **no element's `role` changes
     between renders** — the assertion that catches a later refactor collapsing them back into one.
   - **A refusal restored from storage does not reach the assertive region.** Mount with a `blockedBy`
     already in the queue and assert the alert is **empty** while the sentence is present as static text
     associated with the entry and with the input. Then assert the transition case fills it, because a
     region that is never filled would pass the first half on its own.
   - **The wait is announced** (`write-notice-hygiene` rule E, which also checks this mechanically): a
     flush in flight puts the saving sentence inside the polite region, not only in a description.
   - **Enter on an `aria-disabled` Retry fires nothing.** The handler guard, asserted by counting flushes
     rather than by reading the attribute — the attribute is what a test that only checks the DOM sees, and
     it is not the control.
   - **Two consecutive identical cap refusals both announce.** Assert the region is cleared between them,
     because an implementation that sets the same string twice passes any assertion made on final content.
   - **Focus after Discard is on a named control, never `<body>`** — asserted on entry 3 of 5, where the
     strip stays mounted, and on both the confirm and the cancel arm.
   - **`aria-expanded` tracks the collapse toggle**, both values.
   - **`capture-failure-pile-up` in `inbox-view.test.tsx` will change**, which is intended and was
     predicted on #175 on 8 Aug: a second failure no longer displaces the first.
5. **Worker and the mirror** — the `sync` handler drains the store, in a worker context, with the
   capability check exercised both ways. Mount reconciliation is asserted in **both directions
   separately**: an IndexedDB entry with no `localStorage` counterpart is deleted, **and** a
   `localStorage` entry missing from IndexedDB is re-mirrored and re-registered for `sync`. One test
   covering "the queue still matches after mount" passes a one-way implementation, which is exactly
   how the missing direction survived this spec's first draft.
6. **e2e** — extend `e2e/smoke/brain-dump.spec.ts` using Playwright's `context.setOffline(true)`:
   capture offline, reload the page, assert the words are still queued, go online, assert exactly one
   row lands.

## Sequencing

Behind **#251** and **#253**. All three live in `src/components/inbox/**` and two concurrent streams in
`inbox-view.tsx` is the collision this project has a standing rule against.

The parts that do **not** touch `inbox-view.tsx` — the migration, the route, and the pure queue module
— can land as a first MR in parallel with #251/#253. That is the recommended split: two MRs, the
server half first.

⚠️ **"MR 1" and "MR 2" are used throughout this document and were defined nowhere**, which review of this
spec caught: this section is the one that decides the split and it did not name a single merge request,
while the preamble asserted *"this spec's own sequencing says !332 merges first"* about an MR that appeared
nowhere below. **Three artefacts, in this order:**

| Order | Name | What it is |
| --- | --- | --- |
| 1 | **This document** — !332 — _"design the persisted offline brain-dump capture queue"_ | Docs only. First, because three files on !334 cite it, and a citation to an unmerged path is the dangling reference the order exists to prevent |
| 2 | **MR 1 — the server half** — !334 — _"offline capture queue — server half (module, migration, route)"_ | The migration, `POST /api/braindump`, and the pure queue module. Touches no `inbox-view.tsx`, so it lands in parallel with #251/#253 |
| 3 | **MR 2 — the strip** — not yet opened | The strip and its live regions, Discard, the flush triggers, the service worker and the IndexedDB mirror, the `storage`-event re-enqueue, and the privacy-notice edit. Behind #251/#253, because it is all in `inbox-view.tsx` |

**The privacy notice belongs to MR 2 rather than MR 1, and that follows from the notice's own subject
matter:** nothing puts user-typed text into browser storage until the strip calls `enqueue` from
`submit()`. MR 1 ships the module that *could*, with no caller. A notice describing storage that is not
yet written to would be the mirror image of the omission it exists to fix.

⚠️ **The two are not independent, and MR 2 carries MR 1's safety net.** Found in review of this spec. The
last CAS attempt writes **without** the comparison (see *"Two tabs on one storage key"*), so an improbable
clobber is accepted deliberately — and the reason it is acceptable is not "the loss is small". **The
clobbered tab has already told its user the words are queued.** That makes it a silent loss *after a
positive acknowledgement*, which is the one outcome this design forbids everywhere else, and the only thing
that recovers it is the `storage`-event re-enqueue that the same section explicitly defers to MR 2.

**So either they ship together, or the Goal's promise softens until MR 2 lands.** Shipping MR 1 alone
behind the unconditional promise is the shape of claim this document has already been reviewed for twice: a
guarantee whose recovery path is in a different merge request. The choice is cheap either way — the clobber
needs two tabs committing inside one CPU window, and softening is a wording change to one sentence — but it
has to be made rather than inherited.

## Considered and declined

| Option | Why not |
|---|---|
| **In-memory queue, tab lifetime only** (the "degraded-network guard" #175's move-in note sized for v0.6.0) | Chrome discards background tabs under memory pressure, so on the target device this is a queue that evaporates. It fixes the #210 pile-up but does not keep the promise. |
| **Offline-first: `fetch` handler, Cache Storage, offline triage/edit/delete** | Reopens the manifest and standalone questions, needs an id on every write path, and makes multi-device conflict resolution mandatory. A milestone of its own, not an issue. |
| **Client-chosen primary key** instead of a `clientKey` column | Lets a caller probe row existence via unique-violation behaviour and pre-empt ids. A scoped nullable column has neither property and the same idempotency. |
| **Flush on `beforeunload` / `pagehide`** | A discarded tab fires neither. Writing at submit makes both unnecessary. |
| **`navigator.onLine` as the gate** | Reads `true` on captive portals, in lifts, and at the edge of coverage. Failure-driven is the only honest trigger. |
| **Replaying the server action from the worker** | Framework-shaped POST; fragile, and would break on a Next upgrade. Hence the plain route. |
| **Fixing `proxy.ts`'s guest-sandbox minting here** | Correct, and wider than this issue. The queue's `409` closes the hole for this path without an auth-middleware change. Own issue. |
| **IndexedDB as the source of truth** | Async, which would break the write-before-network guarantee. It is present as a worker-readable mirror only. |

## The manifest question

Raised by the owner on 2026-08-11 while this spec was being written — first as "how hard is a Play
Store release", then as the sharper version: *is there better mobile usability available without going
down the store route?* There is. **Filed as #254 — No way to capture from the home screen or another
app's Share, scheduled into v0.6.0 the same day.** Recorded here because it turns one of this
document's non-goals from a settled boundary into scheduled work. **None of it is in scope for #175**;
this section is the handover to #254, whose own brainstorm has not yet been held.

### A manifest alone, no store involved

Ranked by how much capture friction each removes, which is the only axis that matters for a capture
tool:

| Capability | What it gives | Needs |
|---|---|---|
| **`share_target`** | Share text from *any* Android app straight into the inbox as a brain dump. Read something, hit Share, pick the app, captured | manifest + a handler route |
| **Home screen icon, `display: standalone`** | Tap to capture rather than Chrome → tab → URL. Also reclaims the ~100px of browser chrome — the same phone vertical space #253 is fighting for | manifest + icons |
| **App shortcuts** | Long-press the icon → "New brain dump", straight into the field | manifest |
| **Durable storage** | Installation is one of Chrome's signals for granting `navigator.storage.persist()`, making this spec's queue harder to evict. **Improves the odds; not a guarantee** | installation |
| **Splash screen** | No white flash on cold start | manifest icons + theme colour |

The **only** thing a Play listing adds on top of all of that is store discoverability.

### The auth risk is narrower than #175's description assumed

#175's description warned that a manifest has consequences "including for the auth flow, where a
standalone browser context is a known source of sign-in failures", and **#174 used the absence of a
manifest as an eliminating fact** — its description rules out the "installed to home screen runs in a
separate browser context" trap on exactly that basis.

Reading #174's resolution changes the picture. Its root cause was **not** a browser-context problem:
the app answered on more than one hostname while `PUBLIC_ORIGIN` named only one, and the host-only
PKCE/state cookies returned to a host where they did not exist. A phone's collapsed URL bar is what
hid the hostname change and made it look like a hang.

So a manifest with an absolute `start_url` on `PUBLIC_ORIGIN` **hardens against #174's cause rather
than reopening it** — an installed app always launches on the canonical origin, which removes the entry
path that caused it. `canonicalOriginRedirect` has landed since, closing it a second way. ⚠️ **It is
defined in `src/lib/origin.ts`, not `src/proxy.ts`** — an earlier version of this sentence cited the
proxy, which only *calls* it. The distinction matters here rather than being pedantry: `origin.ts` is
where `inboundHost` and `requestOrigin` live too, and the origin rule this spec argues about at length is
a choice between those two.

**The residual risk is real, narrow and testable:** `scope`. If it does not cover
`/api/auth/gitlab/callback`, the callback opens outside the app window and the user is signed in *in a
browser tab* while the installed app still reads signed-out. `scope: "/"` covers it. That is the one
thing an implementation must get right and pin with a test.

### If the Play Store route is taken as well

A Trusted Web Activity — the Google-blessed route, generated by Bubblewrap — **requires the manifest
above**, so the two are sequential rather than alternative. Additionally: a `$25` one-off developer
account, a signing key, `/.well-known/assetlinks.json` to prove domain ownership, and listing assets.

Two consequences worth knowing now:

- **Background Sync becomes load-bearing rather than a bonus.** Play review rejects an "app" that is
  visibly just a website, and an offline dinosaur is the clearest possible tell. The background flush
  this spec adds is part of what makes an installed app pass as an app.
- **The Play Data safety declaration must match the privacy notice.** Since this MR edits the notice
  and moves `LEGAL_EFFECTIVE_DATE` anyway, getting the browser-storage sentence right the first time
  avoids a second legal-page churn.

A TWA shares Chrome's cookie jar, so the auth concern does not apply to it either. That risk belongs to
a **WebView** wrapper (Capacitor, Cordova), where cookies are not shared and Google refuses OAuth in
embedded WebViews. If an Android app happens, TWA is the route.
