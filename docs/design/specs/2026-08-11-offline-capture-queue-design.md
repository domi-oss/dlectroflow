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
  regressions from middleware edits (#119, and the PKCE/host loop documented at `src/proxy.ts:33-43`).
- **Rewards or streak changes.** A queued capture that flushes advances the streak exactly as an
  online one does, via the existing `touchStreakOnEngagement`. Nothing new.

## Current state

#210 (!290) gave the capture bar an honest failure path: no `captured ✓` before the write resolves,
the words restored into the field, a Retry, a Reload when the deployment moved on, and a bounded
wait. It deliberately holds **one** failure notice rather than a queue.

Verified against `main` at `8d5db9a`, 2026-08-11 — not inherited from the 2026-08-08 grounding note,
two of whose line references had already rotted:

| Fact | Where |
|---|---|
| `createBrainDumpItem(text: string)` takes **only text**; the row id is a server-side `cuid()` | `src/app/actions/braindump.ts:53`, `prisma/schema.prisma:327` |
| **A retry is therefore not idempotent.** No unique constraint, no client-supplied key | `prisma/schema.prisma:326-336` |
| A timed-out write **may still land** — `withActionTimeout` bounds the UI's wait, not the request | `src/lib/server-action-failure.ts:131` and its docblock |
| Capture's bounded wait is **10s** | `CAPTURE_TIMEOUT_MS`, `src/components/inbox/inbox-view.tsx:137` |
| `public/sw.js` is live, registered from the inbox, **notifications only** — no `fetch`, no `sync`, no Cache Storage | `public/sw.js`, `src/lib/notifications.ts:40` |
| **Nothing in `src/` reads `navigator.onLine`**, and there are no `online`, `visibilitychange` or `pagehide` listeners anywhere | verified by grep across `src/` |
| Client-side persistence today is five keys, **all flags and preferences** — no user-typed text is stored client-side anywhere | `df-theme`, `df-hyper-focus`, two day-keys, a guest-banner flag |
| The privacy notice names browser storage **once**, pinned to one key: *"your light/dark theme choice … never leaves your device"* | `src/app/privacy/page.tsx:1080` |
| Any prose edit to a legal page **reds CI** until `LEGAL_EFFECTIVE_DATE` is bumped | `src/lib/legal.ts:153`, `src/lib/legal-fingerprint.test.tsx` |
| A **frozen** account can no longer write — `currentWorkspaceId` reads `User.status`, calls `clearOwnerSession` and throws `RevokedAccountError` | the `WorkspaceKind.User` arm of `currentWorkspaceId`, `src/lib/workspace.ts` (#220, closed 10 Aug) |
| An **expired** owner cookie still falls through to the guest arm, skipping that status check, and the dump lands in an invisible sandbox purged within ~24h | `resolveWorkspace`, `src/lib/workspace.ts:129-141` |

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

`localStorage`, one key, following the repo's existing `df-` convention:

```
df-capture-queue → QueuedCapture[]
```

```ts
type QueuedCapture = {
  /** Client-generated. The idempotency key — see below. */
  clientKey: string;
  /** Raw text as typed, inline note syntax included; the server splits it. */
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
   * cleared". Cleared as soon as an attempt gets past the guard.
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

**Three things were established by measurement rather than argument, and each contradicts the obvious
answer:**

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
   **on exhaustion the caller gets the same refusal a failed `write` produces**, which keeps the words in
   the field and tells the user. There is no path on which the words are silently gone: every exit is
   either "persisted" or "refused, and you can still see it".
2. **Union by `clientKey` is the wrong primitive for `applyFlushOutcome`, and introduces a worse bug than
   it fixes.** Unioning "the queue I computed" with "the queue I now find" **resurrects the capture that
   just saved** — the computed queue lacks the key, the store still holds it because nothing has been
   written yet, so the union puts it back permanently after the user was told it saved. The correct
   primitive is **re-applying this tab's own delta to the fresh read**. Measured: a union implementation
   passes **37 of 39** tests, including all 31 that predate this work, and fails only the two resurrection
   cases.
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

⚠️ **The residual is real and belongs to MR 2, named here so it is not read as an oversight.** `getItem`
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

**Cap: 20 items, or 64 KB total, whichever binds first** — "64 KB" throughout this document means **64 Ki
UTF-8 bytes**, defined once under *"What '64 KB' is measured in"* below (owner decision 2026-08-11 — an earlier draft
said 200). At the cap a new capture is **refused with a visible message** and the words stay in the
field. It does not silently evict the oldest — losing the newest *with the user watching* is honest;
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

**64 KB is a bound on the total, and it therefore fails in two different ways — which is three refusal
states, not two.** An earlier draft of this section said "64 KB total … and a single capture over that
bound is refused with its own message", which reads as though there were one byte check. There are two,
they have different remedies, and the wording table below carries a separate sentence for each:

| Byte condition | Why it is different | Remedy the copy must offer |
|---|---|---|
| **One capture exceeds 64 KB on its own** | Nothing that is already queued is relevant; this capture cannot ever fit | Shorten *this* one, or copy it elsewhere |
| **The queue total is at 64 KB and a further capture, however short, does not fit** | This capture is fine; the queue is full | Wait for some to save — **shortening will not help** |

#### What "64 KB" is measured in — UTF-8 bytes, and this section had it wrong

**Review of this spec asked whether the bound is UTF-8 bytes or UTF-16 code units, and it was right to:
the document said "64 KB" eight times without ever saying, and the two differ by up to 2× on the
non-ASCII text this app's users type.** Unspecified, an implementer picks one and nobody finds out which.

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
  confusion reached the route's own body-size backstop — `MAX_BODY_CHARS`, derived from
  `CAPTURE_QUEUE_MAX_BYTES` but compared against `rawBody.length`, letting a Cyrillic or CJK body reach
  roughly 3× the intended budget. **Same defect, same document, two surfaces** — which is the argument for
  naming the unit once and reusing one helper rather than re-deriving the measurement.
- **There is exactly one measurement helper**, and both the module and the route must use it. Two
  independent answers to "how big is this" is how these drifted apart.

**Honest consequence, stated because a reader would otherwise discover it:** a queue of CJK or emoji text
reaches the bound after fewer visible characters than an ASCII one — CJK costs 3 bytes per character
against ASCII's 1. That is acceptable; the bound exists to stop one pasted essay exhausting the quota, not
to promise a character budget. **The user-facing copy names no unit at all** — *"too long to hold
safely"*, *"no room to hold more"* — and must keep not doing so, for the same reason the byte-total
sentence quotes no number while the item cap quotes 20: a byte total is not something anyone can count in
their own queue.

⚠️ **What this spec deliberately does not claim: how a given browser charges `localStorage` against its
quota.** Accounting is implementation-defined, so tying the constant to a real `QuotaExceededError`
threshold is an implementation-time **measurement**, not something to assert here. 64 KiB is comfortably
inside every engine's documented floor, and `QuotaExceededError` recovery is a tested path regardless —
see the testing section.

Collapsing them repeats round 1's defect in a new place: telling someone whose two-word capture was
refused to *"shorten it"* is advice that cannot work, in exactly the way telling someone who pasted one
essay that *"20 captures are already waiting"* was a number that may well be zero. **A refusal message
whose remedy the user cannot act on is the same defect as a refusal message with the wrong number in
it.**

Note the item cap and the total-byte cap are *not* the same state either, even though both mean "the
queue is full": the item cap can state a number the user recognises (20), and the byte cap cannot,
because a byte total is not something anyone can count in their own queue. So the byte-total copy says
what to do without quoting a figure.

**The two caps do not share a message.** An earlier draft said an over-large single
capture was "refused on the same message", which would tell someone who pasted one
long essay that *"20 captures are already waiting"* — a number that may well be zero.
The item cap is about how many are queued; the byte cap is about how big one of them
is. Separate sentences, in the wording table above.

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

**So the rule is: scope the VIEW, keep the DATA.**

- **The strip renders only entries whose `workspaceId` matches the live session's resolved workspace.** B
  never sees A's text. A's entries are inert for B — not displayed, not flushed, not retried.
- **Nothing is deleted on sign-out.** A's entries survive and flush when A signs back in, which is the
  behaviour the whole design promises.
- **The two caps split, and the split follows the purposes this document already gave them.** The
  **item cap counts per workspace**, because its stated job is keeping the strip legible and the wait
  comprehensible — both properties of what *this* user can see. The **byte cap counts every entry in the
  key**, because its job is preventing `QuotaExceededError` and the quota is charged per origin. Splitting
  them the other way round would either let the strip fill with rows the user cannot act on, or let two
  workspaces jointly exhaust the quota with neither seeing why.

⚠️ **Residual, named rather than left to be found:** B can still be refused by the byte cap because of A's
entries, and the refusal copy — *"no room to hold more until some of these save"* — will name captures B
cannot see. That is a **metadata** disclosure (that *something* is queued), never content. It is accepted
because the alternative is either deleting A's words or letting the origin's quota be exhausted, and both
are worse. The copy stays as it is: it is about room, and it remains true.

**This is not the same problem as the `409` path** and must not be collapsed into it. A `409` is the
*server* refusing a capture whose declared workspace no longer matches. This is the *client* showing text
to the wrong person, and it happens before any request is made.

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
| Anything else | `5xx` / network failure | keep, clear `blockedBy` — **but not `account-revoked`** — retry later |

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
only a successful outcome clears it** (by removing the entry). Why that is needed, and why the obvious
"latest refusal wins" is wrong here, is worked through under *"The `403` copy is reachable"* in **What
the user sees** below — the short version is that #220 deletes the owner cookie in the same response
that answered `403`, so the *next* attempt is made as a guest and necessarily `409`s.

**`409` and `403` must not share a state.** They look alike — both keep the capture
and neither is retryable — but the remedy differs and so does the truth:

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

- `requestOrigin(req)` from `@/lib/origin` gives the allowed origin;
- **reject when `Origin` is present and does not match**;
- **allow a missing `Origin`**, deliberately, for non-browser clients — POST-only plus `SameSite=lax`
  still bound it.

Copied from `src/app/api/auth/logout/route.ts`, which carries the same three rules under a CWE-352
comment, and cited there so the two cannot drift apart the way `focus-timer.tsx` and the inbox notice
already did once.

**Why it is worth doing when `SameSite=lax` already blocks a cross-site POST:** `logout/route.ts`'s own
comment is explicit that **lax does not block a *same-site* POST**, and the repo chose defence-in-depth
there for a route that merely ends a session. This one **creates rows in a user's inbox**, which is
strictly more valuable to an attacker, so the same reasoning applies at least as strongly.

**The rejection must not reuse the `409` or `403` copy.** Those two carry specific user-facing sentences
about signing in, and a request the user never made has no business producing either — that is the same
message-collapse this document has already been reviewed for twice.

⚠️ **The service worker's own `fetch` must still pass**, and that is asserted rather than reasoned about.
A worker's `fetch` carries the worker's own origin, which is the registering origin, so it does — but it
is the one caller whose breakage would be catastrophic and invisible, since it is the only path that works
while no tab is open.

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
| Anything left for a **retryable** reason (`5xx`, network, `401`) | **reject** | The only way to get another attempt while no tab is open |
| Everything left is marked **`account-revoked`** | **resolve** | ⚠️ **Rejecting here is the bug.** Those entries can never flush, so the platform would retry on its own schedule forever, burn battery, and eventually give up anyway — while the *user-facing* remedy is Discard, which only a foreground tab can offer |
| Mixed retryable and permanently blocked | **reject** | The retryable ones justify another attempt; the blocked ones are simply skipped on each pass |

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
requires one narrow, explicit exception to the rule above:

> `localStorage` wins in every disagreement — **except `blockedBy`, where a mark present in the mirror and
> absent in `localStorage` is copied INTO `localStorage`.**

**The exception is safe in exactly one direction and must not be generalised.** The worker is the only
writer that can learn a refusal while no tab is open, so for this one field the mirror can legitimately be
newer. Nothing else may flow that way: a mirror entry with no `localStorage` counterpart is still
**deleted**, never resurrected, because that rule is what stops the mirror putting back a capture the user
discarded or already saved.

**Precedence still decides the merge**, so this cannot downgrade anything: an `account-revoked` mark in the
mirror wins over an absent one, and a `session-expired` mark in the mirror loses to an `account-revoked`
already in `localStorage`.

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

⚠️ **`blockedBy` is the one field where the mirror may be newer, and it is a deliberate exception to the
line above** — see *"the worker must be able to WRITE a mark"* in the flush-triggers section. The worker is
the only writer that can learn a refusal while no tab is open, and it cannot write `localStorage`, so a
mark present only in the mirror is **copied in**. Membership is unaffected: this exception moves a *field*
onto an entry that already exists on both sides, and never adds or revives an entry.

Only the first direction is obvious, and stopping there would have left a real hole. The paragraph
above concedes that the IndexedDB write settles *after* the synchronous `localStorage` write, so a tab
discarded between the two — the exact thing Chrome Android does, and the whole reason this design is
not in-memory — leaves a capture that is durable but **invisible to the worker forever**, because
nothing else ever writes the mirror. That capture is not lost: the foreground flush still finds it on
next open. But it would silently fall out of Background Sync, so the *only* path that works while the
app is closed would cover an arbitrary subset of the queue, and no test asserting "the item survived"
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
a sign-in will not help. Those entries can never flush. With no way to remove them they sit in the queue
forever, and **twenty of them exhaust the 20-item cap permanently — the user can never capture again.**
The app would be bricked by its own safety mechanism.

It is also the missing half of copy this document already commits to. Three of the refusal messages say
*"copy them somewhere safe"*. **Advice to copy something out, with no way to then put it down, is not
advice.** The user does the copying and is left with the queue exactly as full as before.

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

**a11y.** The strip carries **two live regions, not one whose `role` changes.** A polite
`role="status"` announces the waiting count (a background count is not an interruption); an assertive
`role="alert"` announces **every refusal state** — the two `blockedBy` values, the `409`-after-sign-in
transition, and all three cap-reached states. Each element's `role` is **fixed for the lifetime of the
strip**, and each is **mounted empty from the strip's first paint** and then filled. (Stated as "every
refusal" rather than by counting them, because the count has now changed twice under review and a
sentence that enumerates states goes stale the moment one is added.)

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

Retry carries `aria-disabled` while a flush is in flight, mirroring #210's contract, and is ≥44×44 px
(WCAG 2.5.5). When the strip unmounts on the last item saving, focus returns to the input only if it
was inside the strip — the one-shot ref pattern at `inbox-view.tsx:866-880` (WCAG 2.4.3).

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

Required in the same MR:

- a companion sentence in the "your data lives on servers in the UK" section, saying a capture that
  cannot reach the server is held in this browser until it saves, and that it is sent to the same
  servers as any other capture
- `df-capture-queue` added to the storage list, with its retention (until saved, or until the user
  clears it)
- `LEGAL_EFFECTIVE_DATE` bumped

`src/lib/legal-fingerprint.test.tsx` hashes the rendered text of both legal pages, so CI reds until the
date moves. That gate is the reason this cannot be forgotten.

## Testing

TDD, failing test first, in this order:

1. **Queue module** (`src/lib/capture-queue.ts`, pure) — enqueue, ordering, removal on `200`/`201`,
   retention on `409`/`403`/`5xx` **with the two `blockedBy` values asserted separately** (a test that
   only checks "it was kept" would pass the collapsed-state bug this spec was reviewed for), clearing
   `blockedBy` on `5xx`, corrupt-JSON recovery, `QuotaExceededError` recovery. No React, no DOM.
   - **All three cap refusals are separate tests, because they have different remedies** and a single
     "the capture was refused" assertion passes a collapsed implementation: the 20-item bound, the
     queue **total** reaching 64 KB, and **one** capture exceeding 64 KB on its own. The middle one is
     the case an earlier draft of this spec did not have a message for at all.
   - The 20th-and-21st capture is its own test: the 20th must save and the 21st must be refused **with
     the words still in the field**, which is the assertion that stops the cap becoming silent eviction
     in a later refactor.
   - **The precedence is asserted in both directions, and `account-revoked`'s stickiness is asserted
     against all three of the outcomes that could erase it.** `403` then `409`, `403` then `5xx`, and
     `403` then `403` all leave `account-revoked` in place; `403` then `201`/`200` **removes the entry**,
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
   - **The mirror's `blockedBy` exception, in both directions.** A mark present in the mirror and absent in
     `localStorage` is **copied in**; a mirror entry with no `localStorage` counterpart is still **deleted,
     not resurrected**. The second is the control: an implementation that generalised the exception into
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
   - **CSRF, all three arms**: a mismatched `Origin` is refused **and writes no row**; a **missing**
     `Origin` is allowed, because that arm is a deliberate decision and a test is what stops someone
     "tightening" it later and breaking non-browser callers; and the **service worker's own request
     passes**. That last one is asserted rather than reasoned about — it is the only caller whose
     breakage is both catastrophic and invisible, since it is the sole path that runs while the app is
     closed.
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
4. **`inbox-view.tsx`** — the strip renders only when the queue is non-empty, and the flush triggers
   fire. **Discard is its own test**: it removes exactly one entry, takes the two-step confirm, reaches
   no network, and — the assertion that matters — **a queue of 20 permanently-blocked entries can be
   emptied back to a usable state**, which is the dead-end this control exists to prevent. Its a11y contract is asserted as **two sibling live regions with fixed roles**, both present
   and empty before the first message: that the polite region carries the count and the assertive one
   carries the refusals, that neither is nested in the other (`write-notice-hygiene` rule D also blocks
   that mechanically), and that **no element's `role` changes between renders** — the assertion that
   catches a later refactor collapsing them back into one. **`capture-failure-pile-up` in
   `inbox-view.test.tsx` will change**, which is intended and was predicted on #175 on 8 Aug: a second
   failure no longer displaces the first.
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
path that caused it. `canonicalOriginRedirect` (`src/proxy.ts`) has landed since, closing it a second
way.

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
