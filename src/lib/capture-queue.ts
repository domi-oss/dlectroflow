// #175 — the persisted queue behind offline brain-dump capture.
//
// Design: `docs/design/specs/2026-08-11-offline-capture-queue-design.md`.
//
// ── Why this module is pure, and why the store is passed in ──────────────────
//
// Same shape as `hyper-focus.ts`: the `localStorage` subset is an argument, so
// every rule below is testable on a plain object and only the hook has to know
// `window.localStorage` exists. It matters more here than it does there, because
// this module is the last copy of words the user has been told are safe.
//
// ── The two rules that are easy to "improve" into bugs ───────────────────────
//
//  1. **At the cap, the NEWEST capture is refused. The queue is never shifted.**
//     Losing the newest with the user watching is honest; silently losing the
//     oldest is the exact bug #175 exists to fix, wearing a different hat.
//     `capture-queue.test.ts` asserts the 21st is refused AND that all 20
//     existing entries are byte-identical afterwards, so a shift fails the suite.
//
//  2. **Nothing here ever throws.** `getItem` throws behind a blocked-cookies
//     policy and `setItem` throws on a full quota or in private mode. A capture
//     bar that crashes is worse than one that reports "not saved", because the
//     bar is how the problem gets reported at all.
//
// ── Ordering ────────────────────────────────────────────────────────────────
//
// The queue is append-only and read oldest-first, which is also flush order. A
// capture keeps its position until the server accounts for it; nothing here
// re-sorts, because "the order I thought of them in" is the only order a brain
// dump has.
//
// Two tabs break the tie by **write order, not by `capturedAt`**: whatever is in
// the store keeps the order it has, and the incoming capture goes on the end. So
// a capture typed earlier on a phone can land after one typed later on a laptop.
// That is preferred to sorting the merged queue by `capturedAt`, for two reasons:
// the two clocks are independent and can be skewed by minutes, and a re-sort
// would move a capture the user is already watching in the strip.
//
// ── Two tabs, one origin: what the merge does, and what it does not ─────────
//
// `localStorage` is shared by every tab and window of the origin and has neither
// a compare-and-swap nor a lock, so a read-modify-write against it is not safe:
// the tab that writes second can drop what the tab that wrote first added. #233
// established that this is the one kind of concurrency this app genuinely has —
// two router instances, two tabs or a tab and a phone, which no in-memory guard
// can span. It is ordinary rather than exotic here, because the target is Android
// Chrome, which discards a backgrounded tab and reopens it, so overlapping
// lifetimes are the normal case.
//
// Both writers below therefore **reconcile against the store instead of writing a
// snapshot back over it**:
//
//  * Every cap check and every serialisation is done first, and only THEN is the
//    stored string re-read; if it moved, the write is abandoned and recomputed
//    against what is there now. So the only thing left inside the window is the
//    `setItem` itself. That ordering is the point: serialising a 64 KB queue on a
//    phone is the expensive part of this operation, and it used to sit in there.
//  * `enqueue` adds its one entry to whatever it finds. `applyFlushOutcome`
//    applies its own removal or mark to whatever it finds. Neither is a union of
//    two queues — see `applyOutcome`, where the difference is the difference
//    between losing a capture and RESURRECTING one the user was told had saved.
//  * The caps are measured against the MERGED queue, so merging cannot become a
//    way past 20 items or 64 KB. Over either, the incoming capture is the one
//    refused and nothing already queued is touched — the same contract as the cap
//    itself, including when another tab has already filled or overfilled the
//    queue on its own.
//
// **The residual, and where the rest of it lives.** This narrows the window; it
// does not close it, and no version of this module can. Two tabs can still
// interleave inside the one read-compare-write pair, and worse, `getItem` carries
// no ordering guarantee against another tab's `setItem` — a read can be out of
// date the instant it returns, and no amount of re-reading detects that. Closing
// it needs a tab to find out AFTER THE FACT that the queue no longer holds its own
// pending capture, and to put it back: a `storage` event subscription plus somewhere
// to keep "what I am still waiting on". `storage` fires only in the OTHER tabs and
// never in the one that wrote (see `HYPER_FOCUS_EVENT` in `hyper-focus.ts` for the
// same asymmetry), which is exactly what makes it the right signal — and it needs a
// component lifecycle to subscribe and unsubscribe, so it belongs to the hook.
//
// **Deferred to MR 2, which owns the hook — not overlooked.** Same call as "no
// flush-on-exit" above: named here so nobody later reads the gap as an oversight
// and nobody closes it by putting an event listener in a pure module.

/** The `localStorage` subset this needs. Lets tests hand over a plain object. */
export type QueueStore = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** Namespaced like `df-theme` and `df-hyper-focus`. */
export const CAPTURE_QUEUE_STORAGE_KEY = "df-capture-queue";

/**
 * Owner decision 2026-08-11: **20**, down from 200 in the first draft.
 *
 * This is not a storage bound — 20 short captures is a few kilobytes against
 * megabytes of quota. It keeps the waiting-to-save strip legible and the wait
 * comprehensible. The consequence, accepted deliberately, is that 20 is a limit
 * a genuine capture burst can actually reach, which makes the refusal
 * user-facing behaviour rather than a defensive branch.
 */
export const CAPTURE_QUEUE_MAX_ITEMS = 20;

/**
 * 64 KB across the whole serialised queue, and the bound that is load-bearing.
 *
 * Capture text has **no length limit anywhere in the app** — no `maxLength` on
 * the input, no check in `createBrainDumpItem`, and `BrainDumpItem.text` is an
 * unbounded Postgres `text`. So one pasted essay, not twenty thoughts, is the
 * realistic way to exhaust the quota and throw from the very write this design
 * depends on. Whether capture text should be bounded at all is a separate
 * question and deliberately not answered here.
 */
export const CAPTURE_QUEUE_MAX_BYTES = 64 * 1024;

/**
 * Every refusal a queued capture can be marked with — **the one place the set is
 * written down.**
 *
 * A list with the union derived from it, rather than a union with a list beside
 * it, and that direction is the whole point: three separate things need to agree
 * about these values — the type, the runtime guard in {@link isQueuedCapture},
 * and {@link BLOCK_PERSISTENCE}, which decides which of them a later refusal may
 * overwrite — and a hand-copied list is what drifts the day a third refusal state
 * is added. Same shape as `OWNER_BREAKDOWN_ALLOWLIST` in `constants.ts`, which
 * derives `BreakdownModel` the same way.
 *
 * Exported because `capture-queue.test.ts` asserts the guard accepts every member
 * from the outside — so a value added here is covered by that test the moment it
 * exists, rather than when somebody remembers.
 */
export const CAPTURE_BLOCK_REASONS = [
  "session-expired",
  "account-revoked",
] as const;

/** Why the server last refused a queued capture. Derived, never re-listed. */
export type CaptureBlockReason = (typeof CAPTURE_BLOCK_REASONS)[number];

export type QueuedCapture = {
  /** Client-generated idempotency key. Sent to the server; unique per workspace. */
  clientKey: string;
  /** Raw text as typed, inline note syntax included — the server splits it. */
  text: string;
  /**
   * The workspace this was captured under. **Compared, never trusted.** The
   * server derives the real workspace from the cookie and only ever uses this to
   * REFUSE a mismatch, so it can narrow access and never widen it.
   */
  workspaceId: string;
  /** ms epoch. Ordering, and the age shown in the strip. */
  capturedAt: number;
  /**
   * Why the server last refused this capture, if it did. The capture is kept
   * either way — the words are still the user's.
   *
   * **Persisted with the capture rather than held in component state**, because
   * the refusal has to survive the reload a discarded tab forces. A capture that
   * came back after a restart with no memory of why it was stuck would offer a
   * Retry that cannot work.
   *
   * ⚠️ **Two values, not one boolean.** These look alike — both keep the capture,
   * neither is retryable — but the remedy differs and so does the truth:
   *
   *  * `session-expired` (409): the session moved on. Signing in again FIXES it.
   *  * `account-revoked` (403): the account was revoked. Signing in again CANNOT
   *    fix it, and `currentWorkspaceId` (#220) has already cleared the session and
   *    bounced the user to /login. Telling this person to "sign in to save these"
   *    sends them into a loop and misstates what happened to them.
   *
   * A first draft of this module collapsed both into `needsSignIn: boolean` under
   * the 409 wording. Caught in review of the spec (!332); the distinction is the
   * whole reason this is a union.
   *
   * ⚠️ **The two are not interchangeable in time either: `account-revoked` is
   * sticky.** A later 409 or a retryable failure cannot downgrade it, because #220
   * makes exactly that sequence routine — see {@link applyOutcome} and
   * {@link BLOCK_PERSISTENCE}, where the mechanism is written out.
   *
   * `undefined` means not refused, or refused for a reason that has since cleared.
   *
   * **Validated on the way in, exactly as the other four fields are** — see
   * {@link isQueuedCapture}. It is the field a stored value is most likely to be
   * wrong about, because it is the only one this module writes AFTER the capture
   * was stored.
   */
  blockedBy?: CaptureBlockReason;
  /**
   * The workspace **the client was running under** when a 409 was last recorded.
   *
   * ⚠️ Not the capture's own `workspaceId` above — that is what the capture
   * declares and is the value the 409 disagreed with, and it never changes. This
   * is what the app's live session resolved to at the moment of the refusal,
   * which is the only thing the client has that changes when the user signs in.
   *
   * It exists because a 409 does not distinguish "that workspace isn't yours"
   * from "that workspace was purged" — deliberately, since answering that would
   * tell whoever supplied a `workspaceId` whether it exists. A purged guest
   * sandbox can never be resolved again, so *"sign in and these will save"*
   * becomes a promise the app cannot keep, repeated for ever.
   *
   * The client cannot ask which case it is in. What it CAN observe is that the
   * remedy it offered has already been taken and did not work: a fresh 409 while
   * the live session resolves to a DIFFERENT workspace means the session changed
   * between the two refusals and the capture is still refused. See
   * {@link partitionQueue}, which is where that comparison is made.
   *
   * Persisted for the same reason `blockedBy` is: otherwise the comparison dies
   * on the reload a discarded tab forces.
   *
   * ⚠️ **The worker never writes this**, and that is why a worker that sees a 409
   * leaves the entry unmarked rather than marking it — it has no session to
   * resolve, so it cannot compute the value, and a mark without it would leave
   * the strip reasoning with half its inputs missing.
   */
  blockedUnder?: string;
  /**
   * ms epoch. The first time a client observed this entry's `workspaceId` NOT
   * matching the live session's workspace. Cleared the moment it matches again.
   *
   * The reference instant orphan expiry needs — see {@link sweepUnresolvable}.
   * `capturedAt` cannot serve: it answers "when was this typed", and an entry
   * queued weeks ago under a workspace that resolved fine until yesterday is not
   * an orphan while one queued a minute ago into an already-purged sandbox is on
   * its way to being one.
   *
   * **A client observation, and both of its bounds are stated because neither is
   * obvious.** It is written and read by the same device, so the cross-device
   * clock skew that disqualifies `capturedAt` from ordering does not apply — there
   * is only ever one clock in the comparison. A user who moves their own device
   * clock can lengthen or shorten the window, and that is acceptable: expiry is a
   * **storage-limitation backstop, not a security boundary**.
   */
  unresolvableSince?: number;
};

/** Why an enqueue was refused. Each maps to something the user is told. */
export type EnqueueRefusal =
  | "empty"
  | "max-items"
  /**
   * THIS capture is over the byte bound on its own.
   *
   * ⚠️ **Split from a single `max-bytes` by #175's client half, because one reason
   * cannot select two remedies.** The spec gives these two states different
   * sentences and says why: *"shorten it"* is the right advice when the capture's
   * own length is the problem, and the wrong advice when the queue is full, where
   * shortening would not help at all. While both arms returned one reason the
   * strip could only ever have printed one of the two, so one of the spec's
   * sentences was unreachable and the other was wrong half the time.
   */
  | "too-long"
  /** The queue TOTAL is at the byte bound. This capture is fine; there is no room. */
  | "no-room"
  | "storage-unavailable";

/**
 * How long a capture whose workspace no longer resolves is kept before it is
 * removed. **A client constant, and it has to be ≥ the server's guest TTL.**
 *
 * The browser cannot read `GUEST_SANDBOX_TTL_HOURS`: it is a server variable
 * (`guestSandboxTtlHours`, `src/lib/purge.ts`) and this repo has no
 * `NEXT_PUBLIC_*` variables at all — the only mention of that prefix anywhere is
 * a comment in `settings/page.tsx` explaining why a client component cannot read
 * one. So this is a second surface stating the same fact, and
 * `capture-orphan-window.ts` is the drift gate that keeps the two in step. It
 * asserts `client >= server`, not equality: erring long only delays reclaiming
 * bytes, while erring short deletes a capture whose workspace was going to
 * resolve again, and that is the one outcome this module forbids everywhere.
 *
 * ⚠️ **An operator who sets `GUEST_SANDBOX_TTL_HOURS` above 24 moves the server
 * side of that comparison out of CI's reach**, and the gate says so rather than
 * implying coverage — the same boundary `log-retention` reports as undetermined
 * rather than clean. A self-host running a longer guest TTL should raise this
 * constant to match, or queued captures belonging to a sandbox that is still
 * alive will be swept a day early.
 *
 * It is user-facing, not internal: `/privacy` states the retention as three
 * triggers, and the third of them — *"until it can no longer be saved to any
 * account you can reach"* — **is** this number stated in prose.
 */
export const CAPTURE_ORPHAN_WINDOW_HOURS = 24;

/** {@link CAPTURE_ORPHAN_WINDOW_HOURS} in ms, so no caller re-does the sum. */
export const CAPTURE_ORPHAN_WINDOW_MS = CAPTURE_ORPHAN_WINDOW_HOURS * 3_600_000;

/**
 * The sentence a collapsed group of stranded captures carries.
 *
 * **This is the group KEY, and it is a state rather than a workspace on
 * purpose.** Grouping by workspace would leak how many distinct prior sessions
 * this browser has held; grouping by state leaks nothing the sentence does not
 * already say, since none of the sentences contains user-typed text.
 *
 * `session-changed` is not a `blockedBy` value and deliberately is not one: it is
 * the RESULT of comparing `blockedUnder` against the live session, computed at
 * render time out of state the app already holds. A persisted verdict is the
 * `signInTried` flag the spec replaced — a flag nothing sets reads false for
 * ever, which is precisely the forever-promise bug it was added to fix.
 */
export const STRANDED_STATES = [
  /** No refusal recorded. Neutral copy: "from an earlier sign-in". */
  "unmarked",
  /** 409, and the live session still resolves to `blockedUnder`. Offer the sign-in. */
  "session-expired",
  /**
   * 409, and the live session resolves to something ELSE. The remedy has already
   * been taken and did not work, so the copy withdraws it.
   */
  "session-changed",
  /** 403. Signing in cannot help, so no sign-in is offered. */
  "account-revoked",
] as const;

export type StrandedState = (typeof STRANDED_STATES)[number];

/**
 * One collapsed row: how many, which entries, and which sentence.
 *
 * `clientKeys` rather than the captures themselves, and that is the privacy
 * property rather than an efficiency one — **the words must not be in what the
 * strip is handed**, or a later render can leak them by accident. The keys are
 * what the group's discard-without-revealing control needs and nothing more.
 */
export type StrandedGroup = {
  state: StrandedState;
  count: number;
  clientKeys: string[];
};

/**
 * Split the stored queue into what this session may show and what it may only
 * count.
 *
 * `localStorage` is scoped to the **origin**, not to a session or a workspace, so
 * user A queues text, signs out, user B signs in on the same browser, and without
 * this the strip renders A's unsaved words to B.
 *
 * ⚠️ **Scoping the text is necessary and not sufficient, which is why this
 * returns groups and not just a number.** A bare match-or-hide filter makes every
 * state the scoping rule exists to serve unreachable: a 409 means the resolved
 * workspace already disagrees with the entry, so the entry is non-matching in the
 * very render that is supposed to say *"Your session expired. Sign in and these
 * will save."* Hiding the row takes the copy with it, and `blockedUnder` becomes
 * dead code — for any visible entry it equals the live workspace by construction.
 *
 * So a group carries the **state** as well as the count. The words stay hidden in
 * every one of them.
 *
 * An unresolved `liveWorkspaceId` (the empty string — the strip can render before
 * the prop settles) matches nothing. Showing nothing is the safe direction;
 * treating it as a wildcard would reveal every entry on the origin.
 */
export function partitionQueue(
  queue: QueuedCapture[],
  liveWorkspaceId: string,
): { mine: QueuedCapture[]; stranded: StrandedGroup[] } {
  const mine: QueuedCapture[] = [];
  // A Map keeps first-seen insertion order, which is the array's own order — the
  // single source of truth for display order. Nothing here sorts.
  const stranded = new Map<StrandedState, StrandedGroup>();

  for (const entry of queue) {
    if (liveWorkspaceId !== "" && entry.workspaceId === liveWorkspaceId) {
      mine.push(entry);
      continue;
    }
    const state = strandedStateOf(entry, liveWorkspaceId);
    const group = stranded.get(state);
    if (group) {
      group.count += 1;
      group.clientKeys.push(entry.clientKey);
    } else {
      stranded.set(state, {
        state,
        count: 1,
        clientKeys: [entry.clientKey],
      });
    }
  }

  return { mine, stranded: [...stranded.values()] };
}

/**
 * Which sentence one stranded entry belongs under.
 *
 * The `session-expired` → `session-changed` step is the whole reason
 * `blockedUnder` is persisted: otherwise the comparison dies on the reload a
 * discarded tab forces, and the app tells the user to sign in when it has already
 * watched them do it.
 *
 * A missing `blockedUnder` on a `session-expired` entry keeps the sign-in offer.
 * That is the conservative direction — the mark is only written together with the
 * workspace, so an absent one means "written by something that could not compute
 * it", which is the worker (see the mirror carve-out), and the worker's own rule
 * is that a 409 it observes is left for a foreground tab to record properly.
 */
function strandedStateOf(
  entry: QueuedCapture,
  liveWorkspaceId: string,
): StrandedState {
  if (entry.blockedBy === "account-revoked") return "account-revoked";
  if (entry.blockedBy === "session-expired") {
    // ⚠️ **An unresolved live workspace (`""`) is not evidence that the session
    // changed, and this guard is the whole point of the branch.** Found by Duo
    // review round 1 on `!348`. `partitionQueue` sends EVERY entry down this path
    // while the workspace is unknown, so without the check a comparison against
    // any real `blockedUnder` reads as "changed" and **withdraws the sign-in
    // offer** for as long as the prop takes to settle — on the one screen whose
    // job is to say how the words get saved.
    //
    // Same rule `applySweep` states for the same sentinel: a render that knows
    // nothing must not act. Withdrawal is a conclusion, and it is only ever
    // reachable from a workspace this client has actually resolved.
    const sessionKnown = liveWorkspaceId !== "";
    return sessionKnown &&
      entry.blockedUnder !== undefined &&
      entry.blockedUnder !== liveWorkspaceId
      ? "session-changed"
      : "session-expired";
  }
  return "unmarked";
}

/**
 * Age out captures whose workspace this browser can no longer reach, and keep the
 * clock that decides when they have.
 *
 * Three jobs, and the middle one is the one an implementation gets wrong:
 *
 *  * **stamp** `unresolvableSince` the first time an entry's workspace does not
 *    match the live session;
 *  * **leave an existing stamp alone** on a later read that still does not match.
 *    Rewriting it on every read means nothing ever expires, and the test for that
 *    is the only thing standing between this and a promise on `/privacy` that
 *    cannot be kept;
 *  * **clear it** the moment the workspace matches again — an entry queued weeks
 *    ago under a workspace that resolved fine until yesterday is not an orphan.
 *
 * Then an entry past {@link CAPTURE_ORPHAN_WINDOW_MS} is removed, because the
 * notice's retention promise — until it saves, or the user clears it, or it can no
 * longer be saved to any account they can reach — is **false** for an entry where
 * neither of the first two can ever fire. Storage limitation is not optional.
 *
 * ⚠️ **`capturedAt` cannot serve as the reference instant** and this deliberately
 * does not consult it: it answers "when was this typed", which is a different
 * question with a different answer, and reusing it would also contradict its own
 * rule (the age display and nothing else).
 *
 * **Writes nothing when nothing changed.** This runs on every mount, so a no-op
 * that still committed would put a `JSON.stringify` of as much as 64 KB and a
 * `setItem` on the load path of every page view, and would fire a `storage` event
 * in every other tab for no reason.
 */
export function sweepUnresolvable(
  store: QueueStore | null | undefined,
  liveWorkspaceId: string,
  now: number,
): ApplyFlushResult {
  if (!store) return { ok: false, reason: "storage-unavailable" };

  for (let attempt = 1; ; attempt++) {
    const { raw, queue: latest } = readStored(store);
    const next = applySweep(latest, liveWorkspaceId, now);
    const payload = serialise(next);

    // Nothing to do — and reporting `ok` on a write that never happened is
    // correct here in a way it would not be for a flush: the store already holds
    // exactly this value, so no caller is being told a write landed that did not.
    if (raw !== null && payload.serialised === raw) {
      return { ok: true, queue: next };
    }
    if (raw === null && payload.empty) return { ok: true, queue: next };

    // Same reasoning as `enqueue` and `applyFlushOutcome`: recompute rather than
    // write a queue built on a value another tab has already replaced.
    if (attempt < COMMIT_ATTEMPTS && readRaw(store) !== raw) continue;

    if (!write(store, payload)) {
      return { ok: false, reason: "storage-unavailable" };
    }
    return { ok: true, queue: next };
  }
}

/** The sweep as a delta on a fresh read — never a snapshot written back over it. */
function applySweep(
  queue: QueuedCapture[],
  liveWorkspaceId: string,
  now: number,
): QueuedCapture[] {
  const next: QueuedCapture[] = [];
  for (const entry of queue) {
    const resolves =
      liveWorkspaceId !== "" && entry.workspaceId === liveWorkspaceId;
    if (resolves) {
      if (entry.unresolvableSince === undefined) {
        next.push(entry);
      } else {
        const { unresolvableSince: _cleared, ...rest } = entry;
        next.push(rest);
      }
      continue;
    }
    // ⚠️ An unresolved live workspace (`""`) must not START the clock. The strip
    // can render before its prop settles, and a boot that stamps every entry
    // would begin expiring the whole origin on a render that knows nothing.
    if (liveWorkspaceId === "") {
      next.push(entry);
      continue;
    }
    const since = entry.unresolvableSince ?? now;
    if (now - since > CAPTURE_ORPHAN_WINDOW_MS) continue;
    next.push(
      entry.unresolvableSince === since
        ? entry
        : { ...entry, unresolvableSince: since },
    );
  }
  return next;
}

/**
 * Throw a capture away, at the user's explicit request. **The only path in this
 * module that drops words the server has not accounted for.**
 *
 * It exists because two refusal states are permanent — an `account-revoked` 403,
 * and a 409 whose `blockedUnder` comparison has already shown a sign-in will not
 * help — and without it those entries sit in the key for ever, consuming the
 * origin-wide byte cap. That is a **denial of capture**: the next capture that
 * does not fit is refused with "no room until some of these save", a wait for
 * something that can never happen. Every refusal message tells the user to copy
 * their words out, and advice to copy something out with no way to then put it
 * down is not advice.
 *
 * Takes one key or several, because a collapsed stranded group is discarded as a
 * group — its entries cannot be shown individually, so they cannot be discarded
 * individually either. It is still not a "clear all": the caller passes the keys
 * of one group, never the queue.
 *
 * **Not a flush. Reaches no network.** A discarded capture was never saved and is
 * not being deleted from the server.
 *
 * ⚠️ **The caller must delete from the IndexedDB mirror FIRST and await it**, then
 * call this — see `capture-mirror.ts`. The reverse order lets a `sync` event
 * between the two `POST` a capture the user has just discarded, which is the one
 * outcome a Discard control must never produce.
 */
export function discardCapture(
  store: QueueStore | null | undefined,
  clientKeys: string | readonly string[],
): ApplyFlushResult {
  if (!store) return { ok: false, reason: "storage-unavailable" };
  const doomed = new Set(
    typeof clientKeys === "string" ? [clientKeys] : clientKeys,
  );

  for (let attempt = 1; ; attempt++) {
    const { raw, queue: latest } = readStored(store);
    const next = latest.filter((c) => !doomed.has(c.clientKey));
    const payload = serialise(next);

    if (attempt < COMMIT_ATTEMPTS && readRaw(store) !== raw) continue;

    if (!write(store, payload)) {
      return { ok: false, reason: "storage-unavailable" };
    }
    return { ok: true, queue: next };
  }
}

export type EnqueueResult =
  { ok: true; queue: QueuedCapture[] } | { ok: false; reason: EnqueueRefusal };

/**
 * What `applyFlushOutcome` did, or why it could not.
 *
 * **Deliberately the same shape as `EnqueueResult`, and deliberately NOT
 * `{ queue, persisted }`.** Both writers can fail the same way and for the same
 * reason, so they answer in the same vocabulary — and more to the point, `queue`
 * exists only on the `ok: true` arm, so it cannot be read without checking first.
 * A flag beside an always-present queue would have left the original bug's exact
 * shape available to any caller that ignored it, which is not a contract, only a
 * suggestion.
 *
 * There is no queue on the refusal arm because there is nothing new to report: a
 * write that did not land leaves the store exactly as it was, so a caller that
 * needs the current queue calls `readQueue` — the same thing `enqueue`'s refusals
 * already require of it.
 *
 * One reason rather than a union: unlike an enqueue, recording an outcome has no
 * caps and no emptiness rule to fail. The only way it does not land is the store
 * refusing the write.
 */
export type ApplyFlushResult =
  | { ok: true; queue: QueuedCapture[] }
  | { ok: false; reason: "storage-unavailable" };

/**
 * What the server said about one queued capture.
 *
 * Mirrors `POST /api/braindump` one-to-one: `201` → `saved`, `200` → `duplicate`,
 * `409` → `session-expired`, `403` → `account-revoked`, anything else → `retry`.
 * Deliberately one outcome per status rather than one per *behaviour*: 409 and 403
 * behave identically here (keep the capture) and still need telling apart, so
 * collapsing them at this boundary is what produced the bug the spec review found.
 *
 * The two refusals are spliced in from {@link CAPTURE_BLOCK_REASONS} rather than
 * spelled again: an outcome that marks a capture and the mark it writes are the
 * same value, and writing them twice is how one side would gain a third state the
 * other had never heard of.
 */
export type FlushOutcome = "saved" | "duplicate" | CaptureBlockReason | "retry";

/**
 * Bytes of a UTF-8 string, not characters — the quota is measured in bytes.
 *
 * Exported so that **everything judging a body against
 * {@link CAPTURE_QUEUE_MAX_BYTES} measures it the same way**, `/api/braindump`'s
 * request guard included. It was module-private, the route reached for
 * `rawBody.length` instead, and the two silently disagreed by up to 3× on
 * non-Latin text — one BMP character is up to three UTF-8 bytes, so a body the
 * queue calls oversized read as comfortably inside the route's budget (found in
 * review of !334). Two implementations of "how big is this" is how those units
 * drifted apart, so there is one.
 */
export function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

/**
 * Is this one of the refusals {@link CAPTURE_BLOCK_REASONS} names?
 *
 * Narrowed through the list rather than by comparing the two literals a second
 * time, so the guard cannot fall behind the union it is guarding.
 */
function isCaptureBlockReason(value: unknown): value is CaptureBlockReason {
  return (
    typeof value === "string" &&
    CAPTURE_BLOCK_REASONS.some((reason) => reason === value)
  );
}

/**
 * Is this stored value really a `QueuedCapture`?
 *
 * Every field is checked, `blockedBy` included, because the answer is a **type
 * predicate**: saying `true` for a value that is not one tells the compiler
 * something false, and from there every exhaustive branch downstream is reasoning
 * about a shape that does not exist. `blockedBy` is the field where that bites
 * hardest — it selects the strip's copy AND the remedy offered, so a value with no
 * branch leaves a capture on screen with nothing said about it and nothing to do.
 *
 * **Absent is valid and means "not yet refused"** — the field is optional, and the
 * overwhelming majority of entries have never been refused at all.
 *
 * ## All three required strings are checked for EMPTINESS, not only for type
 *
 * `workspaceId` was type-checked and not length-checked while `clientKey` and
 * `text` beside it were both (Duo review round 7, `!334`). That is not a tidiness
 * point, because a blank one produces the one outcome this module exists to
 * prevent and cannot report: `parseCapture` in `/api/braindump` refuses a
 * zero-length `workspaceId` with **400**, 400 is outside the status map so
 * {@link applyFlushOutcome} reads it as `retry`, and `retry` keeps the capture and
 * clears any mark. The entry would then be re-sent on every flush for ever, while
 * the strip says it is waiting to save and nothing says why — a silent permanent
 * stall, which `/api/braindump`'s `CLIENT_KEY_SHAPE` comment names as strictly
 * worse than a refusal somebody can see.
 *
 * It is also the one required field whose blank value this module can produce
 * itself, which is why it is the one that was worth a test rather than a cast.
 * `clientKey` comes from {@link newClientKey} and `text` is emptiness-checked by
 * {@link enqueue} before anything is stored, but `enqueue` stores whatever
 * `workspaceId` its caller hands it — so a caller reading the id from a prop that
 * has not resolved yet reaches this with no tampering at all.
 *
 * **Anything else, `null` included, loses the entry.** That is the deliberate
 * choice and it is not free: this module drops words nowhere else. Two things make
 * it the right one. A value outside the union cannot come from this module —
 * `JSON.stringify` omits an absent optional and only ever writes what
 * {@link applyOutcome} put there — so it means the stored value was edited,
 * truncated, or written by something else on the origin, and there is nothing
 * about such an entry left to trust. And the alternative, silently dropping just
 * the mark, is worse in the one case that matters: an `account-revoked` capture
 * would come back looking unrefused, be offered a Retry, and produce exactly the
 * "sign in and these will save" promise #220 makes impossible to keep.
 */
function isQueuedCapture(value: unknown): value is QueuedCapture {
  if (typeof value !== "object" || value === null) return false;
  const c = value as Record<string, unknown>;
  return (
    typeof c.clientKey === "string" &&
    c.clientKey.length > 0 &&
    typeof c.text === "string" &&
    c.text.length > 0 &&
    typeof c.workspaceId === "string" &&
    c.workspaceId.length > 0 &&
    typeof c.capturedAt === "number" &&
    Number.isFinite(c.capturedAt) &&
    (c.blockedBy === undefined || isCaptureBlockReason(c.blockedBy)) &&
    // Emptiness-checked like the three required strings, and for the same reason
    // one step along: a blank `blockedUnder` compares unequal to every real
    // workspace id, so it would read as "the session has changed" for ever and
    // withdraw a sign-in that would have worked.
    (c.blockedUnder === undefined ||
      (typeof c.blockedUnder === "string" && c.blockedUnder.length > 0)) &&
    // ⚠️ Finiteness, not just `typeof number`. A stored `NaN` (or a `null`, which
    // is `typeof "object"` but is the shape a truncated write leaves) makes the
    // expiry comparison silently `NaN`, and `NaN` compares false — so a corrupt
    // entry would become PERMANENT rather than loud, which is the opposite of
    // what this guard is for.
    (c.unresolvableSince === undefined ||
      (typeof c.unresolvableSince === "number" &&
        Number.isFinite(c.unresolvableSince)))
  );
}

/**
 * The queue, oldest first. **`[]` for every failure**, including corrupt JSON,
 * the wrong shape, and a `getItem` that throws.
 *
 * Entry-level rather than all-or-nothing validation: a single malformed entry
 * loses one capture, where rejecting the whole array would lose all twenty. Both
 * are bad; one is nineteen times worse.
 */
export function readQueue(
  store: QueueStore | null | undefined,
): QueuedCapture[] {
  if (!store) return [];
  return readStored(store).queue;
}

/**
 * The stored string as well as the queue it parses to.
 *
 * The raw string is what a write compares against to find out whether another
 * tab committed while it was working — `localStorage` has no compare-and-swap,
 * so the value it read is the only version marker available.
 */
type StoredQueue = { raw: string | null; queue: QueuedCapture[] };

/** `null` for absent AND for a `getItem` that throws — same contract as `readQueue`. */
function readRaw(store: QueueStore): string | null {
  try {
    return store.getItem(CAPTURE_QUEUE_STORAGE_KEY);
  } catch {
    return null;
  }
}

function readStored(store: QueueStore): StoredQueue {
  const raw = readRaw(store);
  if (!raw) return { raw, queue: [] };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return { raw, queue: [] };
    return { raw, queue: parsed.filter(isQueuedCapture) };
  } catch {
    return { raw, queue: [] };
  }
}

/**
 * How many times a write recomputes against a store that moved under it.
 *
 * Two covers what this exists for — one other tab committing once while we check
 * the caps and serialise — and the third is a stop so a store being written in a
 * tight loop cannot spin us. **On the last attempt the write goes ahead without
 * the check**, deliberately: refusing would be a certain loss of the capture in
 * hand, and an improbable clobber is the better of those two.
 */
const COMMIT_ATTEMPTS = 3;

/**
 * A queue already turned into the two things a write needs, and nothing else.
 *
 * Serialised ahead of the write rather than inside it, so that on a 64 KB queue —
 * where `JSON.stringify` is the expensive part of the whole operation — the only
 * thing left between the final read and the `setItem` is the `setItem`. Carrying
 * the string and the emptiness together is what stops them disagreeing.
 */
type QueuePayload = { serialised: string; empty: boolean };

function serialise(queue: QueuedCapture[]): QueuePayload {
  return { serialised: JSON.stringify(queue), empty: queue.length === 0 };
}

function write(store: QueueStore, payload: QueuePayload): boolean {
  try {
    if (payload.empty) {
      // Leave no empty array behind: the key's presence is a signal the strip
      // reads, and "[]" would keep it looking like there is something pending.
      store.removeItem(CAPTURE_QUEUE_STORAGE_KEY);
    } else {
      store.setItem(CAPTURE_QUEUE_STORAGE_KEY, payload.serialised);
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Add a capture, or say why not.
 *
 * Called synchronously from `submit()` **before** the network is attempted, so
 * the durability guarantee does not depend on any later event. Chrome discards
 * background tabs under memory pressure and a discarded tab fires no unload
 * event, so there is deliberately no flush-on-exit path anywhere in this design.
 *
 * Re-enqueueing a `clientKey` already present succeeds without duplicating, and
 * **the first entry's text wins**. Reachable by double-tapping Retry, and the
 * words already promised to the user are the ones worth keeping. "Present" means
 * present in the STORE, not in any queue the caller is holding — see the two-tabs
 * note at the top of this file.
 */
export function enqueue(
  store: QueueStore | null | undefined,
  capture: QueuedCapture,
): EnqueueResult {
  if (!store) return { ok: false, reason: "storage-unavailable" };

  const text = capture.text.trim();
  if (!text) return { ok: false, reason: "empty" };

  const entry: QueuedCapture = { ...capture, text };

  // Before the store is read at all, and before the item cap: a paste that cannot
  // fit on its own is a size problem whatever any other tab has done, so naming
  // it here both keeps the message right on an empty queue and keeps the
  // serialisation of a 64 KB text out of the read/write window below.
  if (byteLength(JSON.stringify([entry])) > CAPTURE_QUEUE_MAX_BYTES) {
    return { ok: false, reason: "too-long" };
  }

  for (let attempt = 1; ; attempt++) {
    const { raw, queue: latest } = readStored(store);

    // Judged against the STORE, not against a snapshot, so a key another tab has
    // already queued is not queued a second time.
    if (latest.some((c) => c.clientKey === entry.clientKey)) {
      return { ok: true, queue: latest };
    }

    // Both caps are measured against the MERGED queue, so the merge cannot become
    // a way past 20 items or 64 KB. Over either, the INCOMING capture is the one
    // refused and nothing already queued is touched — the same contract as the
    // cap itself, which is why these paths write nothing at all.
    //
    // ⚠️ **The two caps count different populations, and the split follows the
    // purpose each was given** (owner decision 2026-08-12, spec: *"A shared
    // browser"*). The ITEM cap counts **this workspace's** entries, because its
    // stated job is keeping the strip legible and the wait comprehensible —
    // properties of what this user can see, and they cannot see another
    // workspace's. The BYTE cap below counts **every entry in the key**, because
    // its job is preventing `QuotaExceededError` and the quota is charged per
    // origin. Getting the split backwards passes any test that only checks "a cap
    // fired", which is why both directions have one.
    const mine = latest.filter((c) => c.workspaceId === entry.workspaceId);
    if (mine.length >= CAPTURE_QUEUE_MAX_ITEMS) {
      return { ok: false, reason: "max-items" };
    }
    const next = [...latest, entry];
    // One serialisation, measured against the cap and then committed — so the
    // 64 KB `JSON.stringify` is on this side of the final read, not inside it.
    const payload = serialise(next);
    if (byteLength(payload.serialised) > CAPTURE_QUEUE_MAX_BYTES) {
      return { ok: false, reason: "no-room" };
    }

    // Everything above is work done against a value we have only read. If it moved
    // while we were doing it, `next` is built on a queue that no longer exists and
    // writing it would drop whatever the other tab added — so recompute against
    // what is there now instead.
    if (attempt < COMMIT_ATTEMPTS && readRaw(store) !== raw) continue;

    if (!write(store, payload)) {
      return { ok: false, reason: "storage-unavailable" };
    }
    return { ok: true, queue: next };
  }
}

/**
 * Record what the server said about one capture, and return the queue after.
 *
 * `duplicate` removes exactly as `saved` does, and that is the point of the
 * idempotency key rather than a leniency: `withActionTimeout` bounds how long
 * the UI waits, not the request, so a write that timed out at 10s and landed at
 * 14s comes back as a duplicate. Treating it as a failure would either duplicate
 * the row on retry or strand a capture that is already saved.
 *
 * `session-expired`, `account-revoked` and `retry` all KEEP the capture. Nothing in
 * this module ever drops words the server has not accounted for.
 *
 * ⚠️ **The mark is not a plain overwrite.** `account-revoked` outranks both of the
 * others and only a successful outcome clears it — see `applyOutcome` below for
 * the #220 sequence that makes a later 409 a certainty rather than a possibility.
 *
 * The removal or the mark is applied to the queue as it is in the store, not to
 * the one this tab last saw — `applyOutcome` below is where that matters and why.
 *
 * ⚠️ **Reports whether the write actually landed**, and the caller has to look. A
 * refused `setItem` or `removeItem` means the capture is still queued, so a caller
 * told only "here is the queue after" would drop it from the strip and report
 * somebody's words as safe on the strength of a write that never happened. It does
 * self-heal — the next flush gets a 200 duplicate and removes it — but a
 * self-healing lie is still a lie until it heals, and "were my words saved?" is
 * the one question this feature exists to answer.
 */
export function applyFlushOutcome(
  store: QueueStore | null | undefined,
  clientKey: string,
  outcome: FlushOutcome,
  liveWorkspaceId?: string,
): ApplyFlushResult {
  if (!store) return { ok: false, reason: "storage-unavailable" };

  for (let attempt = 1; ; attempt++) {
    const { raw, queue: latest } = readStored(store);
    const next = applyOutcome(latest, clientKey, outcome, liveWorkspaceId);
    const payload = serialise(next);

    // Same reasoning as `enqueue`: recompute rather than write a queue built on a
    // value another tab has already replaced.
    if (attempt < COMMIT_ATTEMPTS && readRaw(store) !== raw) continue;

    if (!write(store, payload)) {
      return { ok: false, reason: "storage-unavailable" };
    }
    return { ok: true, queue: next };
  }
}

/**
 * This tab's one change, applied to whatever the queue turned out to be.
 *
 * ⚠️ **A delta applied to the fresh read, never a union of two queues.** Unioning
 * "the queue I computed" with "the queue I now find" is the obvious way to write
 * the merge and it is worse than the bug it fixes: the removal above produces a
 * queue *without* the key that just saved, the store still holds that key because
 * nothing has been written yet, and a union puts it straight back — permanently,
 * after the user has been told it saved. Marking has the same shape and reads
 * worse still, offering a sign-in for work that is already done.
 *
 * Because the only entry this module ever ADDS is the one `enqueue` was handed, a
 * tombstone and a per-entry version are both unnecessary: nothing ever has to
 * tell "deliberately removed" apart from "not yet known to me". A capture another
 * tab flushed is simply absent from `queue`, so the filter and the map below are
 * each a no-op on it, which is exactly right.
 *
 * ── ⚠️ `account-revoked` is STICKY, and #220 is why (#175) ───────────────────
 *
 * Precedence is **`account-revoked` > `session-expired` > unmarked**, and only a
 * SUCCESSFUL outcome clears the top of it. Written as a plain overwrite — which is
 * what this was — a later refusal downgrades the mark in either direction, and
 * #220 does not merely allow that sequence, it **guarantees** it:
 *
 *  1. A revoked owner's capture flushes, `currentWorkspaceId()` finds
 *     `status !== active`, and the route answers **403** → `account-revoked`. The
 *     strip offers no sign-in, deliberately, because signing in cannot help.
 *  2. **#220 deletes the owner cookie inside that same request** —
 *     `clearOwnerSession(jar)` runs immediately before the throw in
 *     `src/lib/workspace.ts`, and `POST /api/braindump` is a Route Handler, where
 *     the delete lands (it is only the sealed jar of a Server Component render
 *     that refuses it).
 *  3. So the **next** flush carries no owner cookie. `/api/braindump` is neither
 *     public nor gated, so `src/proxy.ts` mints a guest sandbox — which cannot be
 *     the capture's declared `workspaceId`, so the route answers **409**.
 *  4. A plain overwrite then replaces `account-revoked` with `session-expired`,
 *     and the strip goes back to "Your session expired. Sign in and these will
 *     save." **That is a promise the app cannot keep, made to an account that can
 *     never save again** — the exact collapse the spec split 403 from 409 to
 *     prevent, arrived at from the one direction nothing was watching.
 *
 * A `retry` (5xx, or the connection dropping) is the same bug in a milder costume:
 * a failed request is no evidence an account was un-revoked.
 *
 * **It is not a trap, and that is what `saved`/`duplicate` above are doing.** If
 * the owner un-freezes the account and the person signs in, the flush returns 201
 * or 200 and the entry leaves the queue whatever it was marked with — so nothing
 * needs a way to un-revoke a mark, and no capture can be stranded by one. The mark
 * survives failure; it does not survive success.
 */
function applyOutcome(
  queue: QueuedCapture[],
  clientKey: string,
  outcome: FlushOutcome,
  liveWorkspaceId?: string,
): QueuedCapture[] {
  if (outcome === "saved" || outcome === "duplicate") {
    return queue.filter((c) => c.clientKey !== clientKey);
  }
  return queue.map((c) => {
    if (c.clientKey !== clientKey) return c;

    // A sticky mark outranks every unsuccessful outcome, including another copy
    // of itself, so the entry is returned untouched.
    if (isStickyBlock(c.blockedBy)) return c;

    if (isCaptureBlockReason(outcome)) {
      // ⚠️ `blockedUnder` is recorded with the 409 that produced it, and is
      // re-pointed at the CURRENT session on every later 409. It has to follow
      // the session rather than being written once: the comparison the strip
      // makes is "does the live workspace still equal `blockedUnder`", so a value
      // frozen at the first refusal makes the withdrawal permanent after a single
      // sign-in — the forever-promise bug with the sign reversed.
      //
      // Only for `session-expired`. A 403 is terminal on the status alone and its
      // copy offers no sign-in, so there is nothing for the comparison to decide
      // and a second at-rest copy of the live workspace would have no reader.
      if (outcome === "session-expired" && liveWorkspaceId) {
        return { ...c, blockedBy: outcome, blockedUnder: liveWorkspaceId };
      }
      // ⚠️ **And the spread must not carry a `blockedUnder` an earlier 409 left
      // behind.** `session-expired` is transient, so a 403 legitimately supersedes
      // it — and the field is the raw input to a comparison that is now over, so
      // it means nothing without the mark it belonged to. Exactly the reasoning the
      // `retry` arm below already gives for clearing both together; a 403 ends the
      // comparison just as finally as a retryable failure does.
      //
      // No visible symptom today: `strandedStateOf` returns on `account-revoked`
      // before any `blockedUnder` is read, and the mark is sticky, so nothing but a
      // success clears it and a success removes the entry. Fixed anyway, because
      // leaving it makes the stored shape contradict this field's stated invariant
      // — that it follows the session — and because inheriting the wrong default by
      // omission is the failure `BLOCK_PERSISTENCE` is an exhaustive `Record` to
      // prevent one decision away from here.
      //
      // Duo review round 9 on `!348`.
      const { blockedUnder: _stale, ...withoutUnder } = c;
      return { ...withoutUnder, blockedBy: outcome };
    }
    // `retry` — reaching a retryable failure proves the SESSION guard is no
    // longer what is stopping this capture, so a `session-expired` mark must go.
    // Left in place, the strip would keep asking for a sign-in that has already
    // happened. It does NOT prove anything about a revoked account, which is why
    // the sticky check above comes first.
    //
    // `blockedUnder` goes with it: it is the raw input to the 409 comparison and
    // means nothing without the mark. Left behind, it would be compared against a
    // future 409's session and could withdraw a sign-in on the strength of a
    // refusal that has since been superseded.
    const { blockedBy: _cleared, blockedUnder: _under, ...rest } = c;
    return rest;
  });
}

/**
 * How firmly each refusal is held once written.
 *
 * `"sticky"` — only a successful outcome may clear it. `"transient"` — any later
 * outcome may replace or clear it.
 *
 * A `Record<CaptureBlockReason, …>` rather than a second list of literals, and the
 * exhaustiveness is the point: adding a third refusal state to
 * {@link CAPTURE_BLOCK_REASONS} makes this object fail to compile until somebody
 * says where it sits. That is the decision that actually matters — a hand-copied
 * `=== "account-revoked"` somewhere in {@link applyOutcome} is precisely what lets
 * the next state inherit "transient" by silence, which is how this bug reads: the
 * default is the wrong one, so it must not be reachable by omission.
 */
const BLOCK_PERSISTENCE: Record<CaptureBlockReason, "sticky" | "transient"> = {
  // 409 — the session moved on, and signing in again fixes it. A later outcome
  // knows more than this one does: a 403 supersedes it, and a retryable failure
  // proves the session is no longer the obstacle.
  "session-expired": "transient",
  // 403 — the account was revoked. Nothing short of the account being un-frozen
  // changes that, and the only proof of THAT reaching this module is a 201 or a
  // 200, both of which remove the entry outright.
  "account-revoked": "sticky",
};

/** Is the mark this entry already carries one only a success may clear? */
function isStickyBlock(held: CaptureBlockReason | undefined): boolean {
  return held !== undefined && BLOCK_PERSISTENCE[held] === "sticky";
}

/**
 * Sequence behind the third tier of `newClientKey`.
 *
 * Module-scoped, exactly as `breakdown-chat.tsx`'s `stepKeySeq` is and for the
 * same reason: two callers in one page — two capture bars, or a flush racing a
 * fresh capture — must not be able to draw the same value.
 */
let clockKeySeq = 0;

/**
 * A fresh idempotency key. Three tiers, in order of preference:
 *
 *  1. `crypto.randomUUID()` — 36 chars, lowercase hex and dashes. Everywhere this
 *     app runs in a secure context.
 *  2. `crypto.getRandomValues` — 32 lowercase hex chars. An insecure context still
 *     has this when it has no `randomUUID`.
 *  3. `clk-<ms base36, 9>-<counter base36, ≥6>` — 20 chars, lowercase base36 and
 *     dashes. A clock and a counter, **not** a PRNG.
 *
 * All three are URL- and JSON-safe, sit inside `CLIENT_KEY_SHAPE` in
 * `src/app/api/braindump/route.ts` (whose comment describes all three — keep the
 * two in step), and fit the column comfortably.
 *
 * ── Why the third tier is a clock and a counter ──────────────────────────────
 *
 * It filled 16 bytes from `Math.random` until Semgrep flagged it MEDIUM
 * (CWE-338) on `!334`. **The fix is not a dismissal, and that is a maintenance
 * decision rather than a security one.** `pick-one.ts` records the reasoning at
 * length: the finding's fingerprint includes the LINE NUMBER, so one statement in
 * `focus-timer.tsx` was dismissed five separate times as unrelated changes moved
 * it down the file. Every dismissal was correct and none stayed true. A fix is
 * permanent; a dismissal is a tax on every future MR that shifts the line.
 *
 * ⚠️ **The security reading is the weaker argument and is not the one to rely on.**
 * A `clientKey` is an idempotency key, not a secret: it is not authorization, and
 * predicting one grants nothing without the victim's `workspaceId`, which the
 * route only ever compares and which no cross-origin page can read. Nor was this
 * ever a live hole — the tier needs BOTH `crypto` members absent, so it is close
 * to unreachable on any runtime this app supports.
 *
 * The **correctness** argument is the real one. `BrainDumpItem` carries
 * `@@unique([workspaceId, clientKey])`, so a collision does not error — it makes
 * the second capture take the `200 duplicate` arm and be dropped from the queue as
 * already saved. Words lost, silently, in the one module whose entire premise is
 * that nothing here ever loses words. A clock plus a monotonic counter is
 * collision-**free** within a session, and separated across sessions by the
 * millisecond, which is strictly better than anything probabilistic.
 *
 * ── `taken`: the cross-tab guard, added in MR 2 (#175) ──────────────────────
 *
 * The module counter is scoped to a **JS realm**, so it is per-TAB and not
 * per-origin: two tabs each load their own instance, each counter starts at zero,
 * and two tier-3 realms minting in the same millisecond draw the **same key**.
 * Under `@@unique([workspaceId, clientKey])` the second is then read as a replay,
 * the route answers `200 — already saved`, and the capture is **silently lost**.
 *
 * That is not reachable by one person — it needs two Enter presses in two tabs
 * inside one millisecond, and a flush mints nothing (replaying the existing key
 * IS the idempotency mechanism). **The guard is taken anyway** because it costs
 * one set membership test and removes the argument: pass the `clientKey`s already
 * in the queue and a candidate colliding with any of them is redrawn. Collision-
 * free across tabs for every entry still queued, which is exactly the window in
 * which a collision loses words.
 *
 * ⚠️ **It is not a proof of uniqueness and must not be described as one.** A
 * collision against a twin that has already flushed and left the queue still
 * resolves to `200`. Same same-millisecond coincidence, so the reachability is
 * unchanged and no further guard is warranted.
 *
 * ⚠️ **Divergence from the spec, stated rather than hidden.** The spec has tier 3
 * compare against the fresh read `enqueue` already holds inside its CAS window,
 * *"at no extra read"*. It is done here instead, one call earlier, because
 * `enqueue` deliberately treats a colliding `clientKey` as **the same capture
 * replayed** and returns `ok` without storing — which is right for a double-tapped
 * Retry and is precisely the silent drop this guard exists to prevent, so the two
 * cannot share one comparison. The cost is one `readQueue` in the hook that mints
 * the key. Tiers 1 and 2 get the same treatment for uniformity; for them it never
 * fires.
 *
 * The residual, stated rather than implied: two loads of a `crypto`-less runtime
 * starting inside the same millisecond would draw the same key **and neither
 * would be in the other's queue read**. Nothing short of randomness fixes that,
 * it is the tier that needs no `crypto` at all to have been present, and it is not
 * worth a third mechanism.
 *
 * **Still never throws**, which is the property that matters most and now holds
 * more simply than it did: this function failing would take capture down with it,
 * and that is worse than a weak key. `Date.now`, `toString(36)` and `padStart`
 * cannot fail.
 */
export function newClientKey(taken?: Iterable<string>): string {
  const rivals = taken instanceof Set ? taken : new Set(taken ?? []);
  // Bounded, not `while (true)`. For tiers 1 and 2 a second collision is a
  // ~2^-128 event and a loop that cannot terminate is a worse failure than a
  // duplicate key would be; tier 3 is a monotonic counter, so it needs at most
  // one step per rival and this bound is generous against a full queue.
  for (let attempt = 0; attempt < CAPTURE_QUEUE_MAX_ITEMS + 2; attempt++) {
    const candidate = drawClientKey();
    if (!rivals.has(candidate)) return candidate;
  }
  return drawClientKey();
}

/** One draw, before the collision check. The three tiers live here. */
function drawClientKey(): string {
  const c: Crypto | undefined = globalThis.crypto;
  if (typeof c?.randomUUID === "function") return c.randomUUID();

  if (typeof c?.getRandomValues === "function") {
    const bytes = new Uint8Array(16);
    c.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  }

  // Padded to fixed widths so the shape is stable rather than drifting with the
  // clock, and prefixed so a key that reached the database is recognisable as
  // having come from a browser with no CSPRNG at all — which is worth knowing, and
  // is otherwise indistinguishable from tier 2's hex.
  const stamp = Date.now().toString(36).padStart(9, "0");
  const seq = (++clockKeySeq).toString(36).padStart(6, "0");
  return `clk-${stamp}-${seq}`;
}
