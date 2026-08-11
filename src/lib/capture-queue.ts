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
   */
  blockedBy?: "session-expired" | "account-revoked";
};

/** Why an enqueue was refused. Each maps to something the user is told. */
export type EnqueueRefusal =
  | "empty"
  | "max-items"
  | "max-bytes"
  | "storage-unavailable";

export type EnqueueResult =
  | { ok: true; queue: QueuedCapture[] }
  | { ok: false; reason: EnqueueRefusal };

/**
 * What the server said about one queued capture.
 *
 * Mirrors `POST /api/braindump` one-to-one: `201` → `saved`, `200` → `duplicate`,
 * `409` → `session-expired`, `403` → `account-revoked`, anything else → `retry`.
 * Deliberately one outcome per status rather than one per *behaviour*: 409 and 403
 * behave identically here (keep the capture) and still need telling apart, so
 * collapsing them at this boundary is what produced the bug the spec review found.
 */
export type FlushOutcome =
  | "saved"
  | "duplicate"
  | "session-expired"
  | "account-revoked"
  | "retry";

/** Bytes of a UTF-8 string, not characters — the quota is measured in bytes. */
function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

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
    Number.isFinite(c.capturedAt)
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
  let raw: string | null;
  try {
    raw = store.getItem(CAPTURE_QUEUE_STORAGE_KEY);
  } catch {
    return [];
  }
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isQueuedCapture);
  } catch {
    return [];
  }
}

function write(store: QueueStore, queue: QueuedCapture[]): boolean {
  try {
    if (queue.length === 0) {
      // Leave no empty array behind: the key's presence is a signal the strip
      // reads, and "[]" would keep it looking like there is something pending.
      store.removeItem(CAPTURE_QUEUE_STORAGE_KEY);
    } else {
      store.setItem(CAPTURE_QUEUE_STORAGE_KEY, JSON.stringify(queue));
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
 * words already promised to the user are the ones worth keeping.
 */
export function enqueue(
  store: QueueStore | null | undefined,
  capture: QueuedCapture,
): EnqueueResult {
  if (!store) return { ok: false, reason: "storage-unavailable" };

  const text = capture.text.trim();
  if (!text) return { ok: false, reason: "empty" };

  const entry: QueuedCapture = { ...capture, text };
  const existing = readQueue(store);

  if (existing.some((c) => c.clientKey === entry.clientKey)) {
    return { ok: true, queue: existing };
  }

  // Checked before the item cap so a single oversized paste is named as a size
  // problem even on an empty queue, which is the only place it can happen.
  if (byteLength(JSON.stringify([entry])) > CAPTURE_QUEUE_MAX_BYTES) {
    return { ok: false, reason: "max-bytes" };
  }
  if (existing.length >= CAPTURE_QUEUE_MAX_ITEMS) {
    return { ok: false, reason: "max-items" };
  }

  const next = [...existing, entry];
  if (byteLength(JSON.stringify(next)) > CAPTURE_QUEUE_MAX_BYTES) {
    return { ok: false, reason: "max-bytes" };
  }

  if (!write(store, next)) {
    return { ok: false, reason: "storage-unavailable" };
  }
  return { ok: true, queue: next };
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
 */
export function applyFlushOutcome(
  store: QueueStore | null | undefined,
  clientKey: string,
  outcome: FlushOutcome,
): QueuedCapture[] {
  if (!store) return [];
  const existing = readQueue(store);

  let next: QueuedCapture[];
  if (outcome === "saved" || outcome === "duplicate") {
    next = existing.filter((c) => c.clientKey !== clientKey);
  } else {
    next = existing.map((c) => {
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

  write(store, next);
  return next;
}

/**
 * A fresh idempotency key.
 *
 * `crypto.randomUUID()` where available, which is everywhere this app runs in a
 * secure context. The fallback exists because this function failing would take
 * capture down with it, and an insecure-context or older-runtime `undefined` is
 * cheaper to absorb than to diagnose. Both forms are URL- and JSON-safe and fit
 * the column comfortably.
 */
export function newClientKey(): string {
  const c: Crypto | undefined = globalThis.crypto;
  if (typeof c?.randomUUID === "function") return c.randomUUID();
  const bytes = new Uint8Array(16);
  if (typeof c?.getRandomValues === "function") {
    c.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
