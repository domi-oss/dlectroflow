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
- **A web app manifest, installability, or standalone mode.** Not needed by any part of this design.
  This boundary is now load-bearing in a way #175's description did not anticipate — see
  *If the Play Store route is taken* below.
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
| A **frozen** account can no longer write — `currentWorkspaceId` reads `User.status` and throws `RevokedAccountError` | `src/lib/workspace.ts:559-572` (#220, closed 10 Aug) |
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
  /** ms epoch, for ordering and for the age shown in the strip. */
  capturedAt: number;
};
```

`localStorage` over IndexedDB deliberately: the payload is short text, the repo already has a
synchronous-localStorage pattern with a `useSyncExternalStore` subscription (`src/lib/use-hyper-focus.ts`),
and an async store would make the write-before-network guarantee harder to hold. Chrome Android
applies no 7-day script-writable-storage eviction, so durability is measured in weeks.

**Cap: 20 items, or 64 KB total, whichever binds first** (owner decision 2026-08-11 — an earlier draft
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
`QuotaExceededError` on the write this whole design depends on being reliable. 64 KB total, checked
before enqueue, with an over-large single capture refused on the same message. Whether capture text
should have a limit *at all* is a separate question and not this issue's to answer.

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
| Resolved workspace ≠ declared `workspaceId` | `409` | **keep**, mark `needsSignIn` |
| Account frozen (`RevokedAccountError`) | `403` | **keep**, mark `needsSignIn` |
| Anything else | `5xx` / network failure | keep, retry later |

The foreground path uses this same route rather than the server action, so there is one write path and
one set of semantics to test. `createBrainDumpItem` stays for non-queued callers and is refactored to
share the route's core.

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
- `sw.js` gains a `sync` handler that drains `df-capture-queue` through the route

The worker cannot read `localStorage`. The queue is therefore mirrored into IndexedDB **for the
worker's benefit only** — a single object store, treated as a cache of the real thing.

The ordering matters and is the reason this is not simply "use IndexedDB": the `localStorage` write
completes synchronously inside `submit()`, and the IndexedDB write is *initiated* in the same block
but settles later. So the durability guarantee is carried entirely by `localStorage`, which is also
the source of truth for the UI. If the tab is discarded between the two writes, the foreground flush
recovers the item on next open and the background flush simply has nothing to find — the failure mode
is a delayed save, never a lost one. Reconciliation runs on mount: `localStorage` wins, and any
IndexedDB entry with no `localStorage` counterpart is deleted. On Safari and Firefox the `sync`
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

Accepted cost of docking it here: if a flush happens while the user is scrolled deep in the list, the
strip is off-screen. That is the trade for spending no fixed-position height on a viewport #253 just
decluttered, and it is recorded here so it is not rediscovered as a defect.

**Wording.** The strip never says "offline" — `navigator.onLine` is not trustworthy enough to assert
it. It says what is true: *"3 waiting to save"*, and on the `needsSignIn` state *"Your session
expired. Sign in to save these."*

**a11y.** The count strip is `role="status"` (polite — a background count is not an interruption); the
`needsSignIn` and cap-reached states are `role="alert"`. Retry carries `aria-disabled` while a flush
is in flight, mirroring #210's contract, and is ≥44×44 px (WCAG 2.5.5). When the strip unmounts on the
last item saving, focus returns to the input only if it was inside the strip — the one-shot ref pattern
at `inbox-view.tsx:866-880` (WCAG 2.4.3).

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

1. **Queue module** (`src/lib/capture-queue.ts`, pure) — enqueue, ordering, refusal at the 20-item
   bound, refusal at the 64 KB bound, refusal of a single over-large capture, removal on `200`/`201`,
   retention on `409`/`403`/`5xx`, corrupt-JSON recovery, `QuotaExceededError` recovery. The
   20th-and-21st capture is its own test: the 20th must save and the 21st must be refused **with the
   words still in the field**, which is the assertion that stops the cap becoming silent eviction in a
   later refactor. No React, no DOM.
2. **Route** (`src/app/api/braindump/route.ts`) — same `clientKey` twice yields **one** row;
   workspace mismatch yields `409` **and no row**; frozen account yields `403` and no row; the guest
   arm still works for a genuine guest.
3. **Migration** — the `@@unique([workspaceId, clientKey])` index exists and multiple null
   `clientKey`s coexist. Registered alongside the other constraint checks in
   `src/lib/enum-constraint-sync.integration.test.ts`.
4. **`inbox-view.tsx`** — the strip renders only when the queue is non-empty, its a11y contract, and
   the flush triggers. **`capture-failure-pile-up` in `inbox-view.test.tsx` will change**, which is
   intended and was predicted on #175 on 8 Aug: a second failure no longer displaces the first.
5. **Worker** — the `sync` handler drains the store, in a worker context, with the capability check
   exercised both ways.
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

## If the Play Store route is taken

Raised by the owner on 2026-08-11 while this spec was being written. Recorded because it changes one
of this document's non-goals from a settled boundary into a scheduled decision, not because it is in
scope here.

A Trusted Web Activity — the Google-blessed route, generated by Bubblewrap — **requires a web app
manifest**, which this repo deliberately does not have. Nothing in this spec needs one, and that stays
true. But the manifest question stops being "deliberately absent forever" and becomes "absent until the
TWA decision is taken".

Two consequences worth knowing now:

- **Background Sync becomes more valuable, not less.** An installed TWA keeps its service worker
  registration, so the background flush this spec adds is the mechanism that makes an installed app
  feel like an app rather than a bookmark. The decision to include it is consistent with that
  direction rather than incidental to it.
- **The Play Data safety declaration must match the privacy notice.** Since this MR edits the notice
  and moves `LEGAL_EFFECTIVE_DATE` anyway, getting the browser-storage sentence right the first time
  avoids a second legal-page churn later.

A TWA shares Chrome's cookie jar, so the auth-flow risk #175's description worried about does not
apply to it. That risk belongs to a **WebView** wrapper (Capacitor, Cordova), where cookies are not
shared and Google refuses OAuth in embedded WebViews. If an Android app happens, TWA is the route.
