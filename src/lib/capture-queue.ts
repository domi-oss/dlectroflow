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
 * and {@link applyOutcome}, which turns an outcome into a mark — and a
 * hand-copied list is what drifts the day a third refusal state is added. Same
 * shape as `OWNER_BREAKDOWN_ALLOWLIST` in `constants.ts`, which derives
 * `BreakdownModel` the same way.
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
   * `undefined` means not refused, or refused for a reason that has since cleared.
   *
   * **Validated on the way in, exactly as the other four fields are** — see
   * {@link isQueuedCapture}. It is the field a stored value is most likely to be
   * wrong about, because it is the only one this module writes AFTER the capture
   * was stored.
   */
  blockedBy?: CaptureBlockReason;
};

/** Why an enqueue was refused. Each maps to something the user is told. */
export type EnqueueRefusal =
  "empty" | "max-items" | "max-bytes" | "storage-unavailable";

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

/** Bytes of a UTF-8 string, not characters — the quota is measured in bytes. */
function byteLength(value: string): number {
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
    typeof c.capturedAt === "number" &&
    Number.isFinite(c.capturedAt) &&
    (c.blockedBy === undefined || isCaptureBlockReason(c.blockedBy))
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
    return { ok: false, reason: "max-bytes" };
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
    if (latest.length >= CAPTURE_QUEUE_MAX_ITEMS) {
      return { ok: false, reason: "max-items" };
    }
    const next = [...latest, entry];
    // One serialisation, measured against the cap and then committed — so the
    // 64 KB `JSON.stringify` is on this side of the final read, not inside it.
    const payload = serialise(next);
    if (byteLength(payload.serialised) > CAPTURE_QUEUE_MAX_BYTES) {
      return { ok: false, reason: "max-bytes" };
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
): ApplyFlushResult {
  if (!store) return { ok: false, reason: "storage-unavailable" };

  for (let attempt = 1; ; attempt++) {
    const { raw, queue: latest } = readStored(store);
    const next = applyOutcome(latest, clientKey, outcome);
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
 */
function applyOutcome(
  queue: QueuedCapture[],
  clientKey: string,
  outcome: FlushOutcome,
): QueuedCapture[] {
  if (outcome === "saved" || outcome === "duplicate") {
    return queue.filter((c) => c.clientKey !== clientKey);
  }
  return queue.map((c) => {
    if (c.clientKey !== clientKey) return c;
    if (outcome === "session-expired" || outcome === "account-revoked") {
      return { ...c, blockedBy: outcome };
    }
    // `retry` — reaching a retryable failure proves the guard is no longer what
    // is stopping this capture, so the mark must go. Left in place, the strip
    // would keep asking for a sign-in that has already happened.
    const { blockedBy: _cleared, ...rest } = c;
    return rest;
  });
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
 * The residual, stated rather than implied: two loads of a `crypto`-less runtime
 * starting inside the same millisecond would draw the same key. Nothing short of
 * randomness fixes that, it is the tier that needs no `crypto` at all to have been
 * present, and it is not worth a third mechanism.
 *
 * **Still never throws**, which is the property that matters most and now holds
 * more simply than it did: this function failing would take capture down with it,
 * and that is worse than a weak key. `Date.now`, `toString(36)` and `padStart`
 * cannot fail.
 */
export function newClientKey(): string {
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
